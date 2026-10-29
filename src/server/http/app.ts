import crypto from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getPublicEnvSummary, parseEnv, type AppEnv } from '../config/env';
import { createModelProvider, type ModelProvider } from '../ai/model-provider';
import {
  getSharedDatabase,
  type AegisDatabase,
  type DatabaseContext,
} from '../db/client';
import {
  AuthorizationError,
  requireAuthorization,
  type AuthenticatedActor,
} from '../policies/authorization';
import {
  listUserOrganizations,
  resolveActorContext,
  TenantConstraintError,
} from '../db/repositories/tenant-repository';
import {
  AgentConstraintError,
  createAgentDraft,
  getAgentForActor,
  listAgentVersions,
  publishAgentVersion,
  updateAgentDraft,
} from '../db/repositories/agent-repository';
import {
  cancelAgentRun,
  enqueueAgentRun,
  getRunDetailsForActor,
  listOrganizationRuns,
  listRunEventsAfterSequence,
  RunConstraintError,
} from '../modules/runs/run-executor';
import { createRunEventsSseResponse } from '../modules/runs/sse-stream';
import {
   ingestKnowledgeDocument,
  KnowledgeConstraintError,
  searchKnowledgeChunks,
} from '../modules/knowledge/knowledge-service';
import {
  ApprovalStateConflictError,
  createWorkflowDraft,
  decideApprovalRequest,
  getOrganizationUsageSummary,
  listApprovalRequests,
  listAuditEvents,
  publishWorkflowVersion,
  startWorkflowRun,
  WorkflowResourceNotFoundError,
} from '../modules/workflows/workflow-engine';
import { compareEvalExperiments } from '../modules/evals/eval-harness';
import {
  evaluateDatabaseReadiness,
  evaluateLiveness,
} from '../modules/health/health-service';
import type { ReadinessCheckResult } from '../../app/api/v1/health/route';
import { RuntimeWorker } from '../worker/main';
import { seedFlagshipWorkspace, type FlagshipSeedReport } from '../seed/demo-seed';
import { agents, agentVersions } from '../db/schema/agents';
import { knowledgeDocuments } from '../db/schema/knowledge';
import { organizations, users, memberships } from '../db/schema/tenant';
import { workflows, workflowVersions } from '../db/schema/workflows';
import { evalExperiments, evalSuites } from '../db/schema/evals';
import { WorkflowDagValidationError } from '../modules/workflows/dag-validator';

/**
 * Phase C: Express HTTP API Application (`src/server/http/app.ts`)
 *
 * Mounts real `/api/v1/*` routes backed by PostgreSQL (PGlite) and the domain services:
 * - Request correlation (`x-request-id`), bounded JSON parsing (`1mb`), RFC 9457 Problem Details.
 * - Real membership-verified actor authentication (`resolveActorFromRequest`) supporting both
 *   explicit `x-user-id` + `x-organization-id` headers and seeded demo persona aliases (`x-actor-id`).
 * - Real background worker integration (`RuntimeWorker`) for asynchronous run execution.
 */

export interface ApiAppDependencies {
  contextProvider?: () => Promise<DatabaseContext>;
  checkDatabaseReadiness?: () => Promise<ReadinessCheckResult>;
  rawEnv?: Record<string, string | undefined>;
  worker?: RuntimeWorker;
  modelProvider?: ModelProvider;
}

export interface DemoPersonaDirectory {
  id: 'acme-owner' | 'acme-admin' | 'acme-dev' | 'acme-viewer' | 'beta-owner';
  label: string;
  email: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  userId: string;
  role: 'owner' | 'admin' | 'developer' | 'viewer';
}

const createAgentBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().min(2).max(64),
  description: z.string().optional().default(''),
  draftSystemPrompt: z.string().min(1),
  draftToolAllowlist: z.array(z.enum(['calculator', 'knowledge_search'])).optional().default(['calculator']),
});

const updateAgentBodySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().optional(),
  draftSystemPrompt: z.string().min(1).optional(),
  draftToolAllowlist: z.array(z.enum(['calculator', 'knowledge_search'])).optional(),
});

const enqueueRunBodySchema = z.object({
  inputPrompt: z.string().trim().min(1).max(16_000),
  agentVersionId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
  processImmediately: z.boolean().optional().default(true),
});

const approvalDecisionBodySchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(1000).optional(),
});

const ingestDocumentBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  sourceFilename: z.string().trim().min(1).max(200),
  mimeType: z.enum(['text/plain', 'text/markdown', 'application/json']).default('text/markdown'),
  content: z.string().min(1).max(500_000),
});

const startWorkflowRunBodySchema = z.object({
  workflowVersionId: z.string().uuid().optional(),
  agentVersionId: z.string().uuid().optional(),
  inputPrompt: z.string().trim().min(1).default('Evaluate production deployment risk score 150'),
  initialVariables: z.record(z.string(), z.unknown()).optional(),
});

const ACTOR_AUTH_SUBJECT_MAP: Record<string, { authSubject: string; orgSlug: string }> = {
  'acme-owner': { authSubject: 'seed_acme_owner', orgSlug: 'acme-cyber-defense' },
  'acme-admin': { authSubject: 'seed_acme_admin', orgSlug: 'acme-cyber-defense' },
  'acme-dev': { authSubject: 'seed_acme_dev', orgSlug: 'acme-cyber-defense' },
  'acme-viewer': { authSubject: 'seed_acme_viewer', orgSlug: 'acme-cyber-defense' },
  'beta-owner': { authSubject: 'seed_beta_owner', orgSlug: 'beta-logistics' },
};

export async function ensureWorkspaceSeededWithPendingHitl(
  db: AegisDatabase,
  options?: { forceReset?: boolean }
): Promise<{ seedReport: FlagshipSeedReport | null; pendingApprovalId: string | null }> {
  if (options?.forceReset) {
    await db.execute(
      sql`TRUNCATE TABLE organizations, users RESTART IDENTITY CASCADE;`
    );
  }

  const existingOrgs = await db.select().from(organizations).limit(1);
  let seedReport: FlagshipSeedReport | null = null;

  if (existingOrgs.length === 0) {
    seedReport = await seedFlagshipWorkspace(db);
  }

  // Ensure there is at least one active 'pending' approval request in Acme Cyber Defense
  // so interactive users and browser E2E tests can exercise real HITL approval/rejection.
  const [acmeOrg] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, 'acme-cyber-defense'))
    .limit(1);

  if (!acmeOrg) {
    return { seedReport, pendingApprovalId: null };
  }

  const [acmeOwnerUser] = await db
    .select()
    .from(users)
    .where(eq(users.authSubject, 'seed_acme_owner'))
    .limit(1);

  const [wf] = await db
    .select()
    .from(workflows)
    .where(eq(workflows.organizationId, acmeOrg.id))
    .limit(1);

  if (!acmeOwnerUser || !wf) {
    return { seedReport, pendingApprovalId: null };
  }

  const acmeOwnerActor: AuthenticatedActor = {
    userId: acmeOwnerUser.id,
    organizationId: acmeOrg.id,
    role: 'owner',
  };

  const existingApprovals = await listApprovalRequests(db, acmeOwnerActor, acmeOrg.id);
  const pending = existingApprovals.find((a) => a.status === 'pending');

  if (pending) {
    return { seedReport, pendingApprovalId: pending.id };
  }

  const [wfVersion] = await db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, wf.id))
    .orderBy(desc(workflowVersions.versionNumber))
    .limit(1);

  const [agentV1] = await db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.organizationId, acmeOrg.id))
    .orderBy(asc(agentVersions.versionNumber))
    .limit(1);

  if (wfVersion && agentV1) {
    const livePausedRun = await startWorkflowRun(db, acmeOwnerActor, {
      organizationId: acmeOrg.id,
      workflowVersionId: wfVersion.id,
      defaultAgentVersionId: agentV1.id,
      inputPrompt:
        'Execute production firewall rotation for SEV-1 incident #409 (risk score 150 > threshold 100)',
    });
    return {
      seedReport,
      pendingApprovalId: livePausedRun.pendingApproval?.id ?? null,
    };
  }

  return { seedReport, pendingApprovalId: null };
}

export async function listDemoPersonas(db: AegisDatabase): Promise<DemoPersonaDirectory[]> {
  const rows = await db
    .select({
      userId: users.id,
      authSubject: users.authSubject,
      email: users.email,
      displayName: users.displayName,
      organizationId: organizations.id,
      organizationName: organizations.name,
      organizationSlug: organizations.slug,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .innerJoin(organizations, eq(memberships.organizationId, organizations.id));

  const reverseMap: Record<string, DemoPersonaDirectory['id']> = {
    seed_acme_owner: 'acme-owner',
    seed_acme_admin: 'acme-admin',
    seed_acme_dev: 'acme-dev',
    seed_acme_viewer: 'acme-viewer',
    seed_beta_owner: 'beta-owner',
  };

  const order: DemoPersonaDirectory['id'][] = [
    'acme-owner',
    'acme-admin',
    'acme-dev',
    'acme-viewer',
    'beta-owner',
  ];

  const mapped: DemoPersonaDirectory[] = [];
  for (const row of rows) {
    const id = reverseMap[row.authSubject];
    if (id) {
      mapped.push({
        id,
        label: row.displayName ?? row.email ?? id,
        email: row.email ?? '',
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        organizationSlug: row.organizationSlug,
        userId: row.userId,
        role: row.role,
      });
    }
  }

  return mapped.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

async function resolveActorFromRequest(
  req: Request,
  db: AegisDatabase,
  env: AppEnv
): Promise<AuthenticatedActor | null> {
  const explicitUserId = req.header('x-user-id')?.trim();
  const explicitOrgId = req.header('x-organization-id')?.trim();

  if (explicitUserId && explicitOrgId) {
    return resolveActorContext(db, explicitUserId, explicitOrgId);
  }

  const actorAlias =
    req.header('x-actor-id')?.trim() ||
    (typeof req.query.actor === 'string' ? req.query.actor.trim() : '') ||
    (env.DEMO_MODE ? 'acme-admin' : '');

  if (!actorAlias || actorAlias === 'anonymous') {
    return null;
  }

  const mapping = ACTOR_AUTH_SUBJECT_MAP[actorAlias];
  if (!mapping) {
    return null;
  }

  const [userRow] = await db
    .select()
    .from(users)
    .where(eq(users.authSubject, mapping.authSubject))
    .limit(1);

  const [orgRow] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, mapping.orgSlug))
    .limit(1);

  if (!userRow || !orgRow) {
    return null;
  }

  return resolveActorContext(db, userRow.id, orgRow.id);
}

function sendProblemDetails(
  res: Response,
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string
): void {
  res
    .status(status)
    .setHeader('x-request-id', requestId)
    .setHeader('cache-control', 'no-store')
    .json({
      type: `https://aegis-runtime.dev/problems/${code.toLowerCase().replace(/_/g, '-')}`,
      title,
      status,
      code,
      detail,
      requestId,
    });
}

export function createApiApp(deps: ApiAppDependencies = {}): Express {
  const app = express();
  const contextProvider = deps.contextProvider ?? getSharedDatabase;

  app.use(express.json({ limit: '1mb' }));

  // Attach correlation requestId on every request
  app.use((req: Request, res: Response, next: NextFunction) => {
    const existing = req.header('x-request-id')?.trim();
    const requestId = existing && existing.length > 0 ? existing : crypto.randomUUID();
    (req as Request & { requestId: string }).requestId = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  });

  const getReqId = (req: Request): string =>
    (req as Request & { requestId?: string }).requestId ?? crypto.randomUUID();

  // 1. Liveness Probe (`GET /api/v1/health/live`) — independent of database
  app.get('/api/v1/health/live', (req: Request, res: Response) => {
    const requestId = getReqId(req);
    res
      .status(200)
      .setHeader('cache-control', 'no-store')
      .json({
        data: {
          ...evaluateLiveness(),
          requestId,
        },
      });
  });

  // 2. Readiness Probe (`GET /api/v1/health/ready` and `GET /api/v1/health`)
  const handleReadiness = async (req: Request, res: Response) => {
    const requestId = getReqId(req);
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const envSummary = getPublicEnvSummary(env);
      const checkDb =
        deps.checkDatabaseReadiness ??
        (() => evaluateDatabaseReadiness(contextProvider));
      const dbStatus = await checkDb();

      if (!dbStatus.databaseReady) {
        sendProblemDetails(
          res,
          requestId,
          503,
          'DATABASE_UNREADY',
          'Service dependency not ready',
          'The database readiness probe did not succeed.'
        );
        return;
      }

      let storageMode: 'file' | 'memory' = 'file';
      try {
        const ctx = await contextProvider();
        storageMode = ctx.storageMode;
      } catch {
        // Ignore if custom readiness check was injected without full context
      }

      res
        .status(200)
        .setHeader('cache-control', 'no-store')
        .json({
          data: {
            status: 'ok',
            service: 'aegis-runtime',
            version: '0.1.0',
            timestamp: new Date().toISOString(),
            requestId,
            readiness: {
              database: 'ready',
              engine: dbStatus.engine,
              storageMode,
              latencyMs: dbStatus.latencyMs,
            },
            runtime: envSummary,
          },
        });
    } catch (error) {
      const safeDetail =
        error instanceof Error &&
        error.message.startsWith('Invalid environment configuration:')
          ? error.message
          : 'Runtime health check failed due to an internal configuration error.';
      sendProblemDetails(
        res,
        requestId,
        503,
        'HEALTH_CHECK_FAILED',
        'Health check failed',
        safeDetail
      );
    }
  };

  app.get('/api/v1/health', (req, res, next) => {
    handleReadiness(req, res).catch(next);
  });
  app.get('/api/v1/health/ready', (req, res, next) => {
    handleReadiness(req, res).catch(next);
  });

  // 3. Seed / Reset Flagship Workspace (`POST /api/v1/workspace/seed`)
  app.post('/api/v1/workspace/seed', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = await contextProvider();
      const forceReset = req.body?.forceReset !== false;
      const result = await ensureWorkspaceSeededWithPendingHitl(db, { forceReset });
      const personas = await listDemoPersonas(db);

      res.status(200).json({
        data: {
          status: 'seeded',
          pendingApprovalId: result.pendingApprovalId,
          personas,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // 4. Get Persisted Workspace Snapshot for Active Actor (`GET /api/v1/workspace`)
  app.get('/api/v1/workspace', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const ctx = await contextProvider();
      const { db } = ctx;

      await ensureWorkspaceSeededWithPendingHitl(db, { forceReset: false });
      const personas = await listDemoPersonas(db);
      const actor = await resolveActorFromRequest(req, db, env);

      if (!actor) {
        throw new AuthorizationError({
          allowed: false,
          code: 'UNAUTHENTICATED',
          action: 'org.view',
          reason: 'Authentication required to inspect workspace state.',
        });
      }

      // Target organization can be overridden by ?organizationId=... to test cross-tenant 404 isolation
      const requestedOrgId =
        typeof req.query.organizationId === 'string' && req.query.organizationId.trim()
          ? req.query.organizationId.trim()
          : actor.organizationId;

      requireAuthorization(actor, 'org.view', {
        organizationId: requestedOrgId,
        resourceType: 'organization',
        resourceId: requestedOrgId,
      });

      const orgAgents = await db
        .select()
        .from(agents)
        .where(eq(agents.organizationId, requestedOrgId))
        .orderBy(desc(agents.updatedAt));

      const orgVersions = await db
        .select()
        .from(agentVersions)
        .where(eq(agentVersions.organizationId, requestedOrgId))
        .orderBy(desc(agentVersions.versionNumber));

      const orgRuns = await listOrganizationRuns(db, actor, requestedOrgId, 25);
      const orgApprovals = await listApprovalRequests(db, actor, requestedOrgId);

      const orgWorkflows = await db
        .select()
        .from(workflows)
        .where(eq(workflows.organizationId, requestedOrgId))
        .orderBy(desc(workflows.updatedAt));

      const orgWorkflowVersions = await db
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.organizationId, requestedOrgId))
        .orderBy(desc(workflowVersions.versionNumber));

      const orgDocuments = await db
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.organizationId, requestedOrgId))
        .orderBy(desc(knowledgeDocuments.createdAt));

      const orgSuites = await db
        .select()
        .from(evalSuites)
        .where(eq(evalSuites.organizationId, requestedOrgId));

      const orgExperiments = await db
        .select()
        .from(evalExperiments)
        .where(eq(evalExperiments.organizationId, requestedOrgId))
        .orderBy(asc(evalExperiments.createdAt));

      let evalComparison = null;
      if (orgExperiments.length >= 2) {
        try {
          evalComparison = await compareEvalExperiments(db, actor, {
            organizationId: requestedOrgId,
            baselineExperimentId: orgExperiments[0]!.id,
            candidateExperimentId: orgExperiments[orgExperiments.length - 1]!.id,
          });
        } catch {
          evalComparison = null;
        }
      }

      const usageSummary = await getOrganizationUsageSummary(db, actor, requestedOrgId);

      let auditLog: Awaited<ReturnType<typeof listAuditEvents>> = [];
      let canViewAudit = false;
      try {
        auditLog = await listAuditEvents(db, actor, { organizationId: requestedOrgId });
        canViewAudit = true;
      } catch {
        canViewAudit = false;
      }

      res.status(200).json({
        data: {
          actor,
          storageMode: ctx.storageMode,
          aiMode: env.AI_MODE,
          personas,
          agents: orgAgents,
          agentVersions: orgVersions,
          runs: orgRuns,
          approvals: orgApprovals,
          workflows: orgWorkflows,
          workflowVersions: orgWorkflowVersions,
          documents: orgDocuments,
          evalSuites: orgSuites,
          evalExperiments: orgExperiments,
          evalComparison,
          usageSummary,
          auditEvents: auditLog,
          canViewAudit,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  function unauthenticatedError(): AuthorizationError {
    return new AuthorizationError({
      allowed: false,
      code: 'UNAUTHENTICATED',
      action: 'org.view',
      reason: 'Authentication required.',
    });
  }

  // 5. Organizations (`GET /api/v1/organizations`)
  app.get('/api/v1/organizations', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const orgs = await listUserOrganizations(db, actor.userId);
      res.status(200).json({ data: orgs });
    } catch (err) {
      next(err);
    }
  });

  // 6. Agents (`GET /api/v1/agents`, `POST /api/v1/agents`, `PATCH /api/v1/agents/:id`, `POST /api/v1/agents/:id/publish`)
  app.get('/api/v1/agents', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const targetOrgId =
        typeof req.query.organizationId === 'string' && req.query.organizationId.trim()
          ? req.query.organizationId.trim()
          : actor.organizationId;

      requireAuthorization(actor, 'agent.view', {
        organizationId: targetOrgId,
        resourceType: 'agent',
      });

      const list = await db
        .select()
        .from(agents)
        .where(eq(agents.organizationId, targetOrgId))
        .orderBy(desc(agents.updatedAt));

      res.status(200).json({ data: list });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/agents', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const body = createAgentBodySchema.parse(req.body);
      const created = await createAgentDraft(db, actor, {
        organizationId: actor.organizationId,
        name: body.name,
        slug: body.slug,
        description: body.description,
        draftSystemPrompt: body.draftSystemPrompt,
        draftToolAllowlist: body.draftToolAllowlist,
      });
      res.status(201).json({ data: created });
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/v1/agents/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const body = updateAgentBodySchema.parse(req.body);
      const updated = await updateAgentDraft(db, actor, {
        organizationId: actor.organizationId,
        agentId: String(req.params.id),
        ...body,
      });
      res.status(200).json({ data: updated });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/agents/:id/publish', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const targetOrgId =
        typeof req.body?.organizationId === 'string' && req.body.organizationId.trim()
          ? req.body.organizationId.trim()
          : actor.organizationId;

      const published = await publishAgentVersion(
        db,
        actor,
        targetOrgId,
        String(req.params.id)
      );
      res.status(201).json({ data: published });
    } catch (err) {
      next(err);
    }
  });

  // 7. Enqueue Agent Run (`POST /api/v1/agents/:id/runs`) -> 202 Accepted + Worker Processing
  app.post('/api/v1/agents/:id/runs', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }

      const body = enqueueRunBodySchema.parse(req.body);
      const targetOrgId =
        typeof req.body?.organizationId === 'string' && req.body.organizationId.trim()
          ? req.body.organizationId.trim()
          : actor.organizationId;

      // Ensure agent exists in targetOrgId first so cross-tenant attempts get 404
      await getAgentForActor(db, actor, targetOrgId, String(req.params.id));

      const enqueued = await enqueueAgentRun(db, actor, {
        organizationId: targetOrgId,
        agentId: String(req.params.id),
        agentVersionId: body.agentVersionId,
        inputPrompt: body.inputPrompt,
        idempotencyKey: body.idempotencyKey,
      });

      const worker =
        deps.worker ??
        new RuntimeWorker({
          db,
          modelProvider: deps.modelProvider ?? createModelProvider(env),
        });

      if (body.processImmediately) {
        await worker.tickOnce();
      } else {
        void worker.tickOnce();
      }

      const details = await getRunDetailsForActor(
        db,
        actor,
        targetOrgId,
        enqueued.run.id
      );

      res.status(202).json({
        data: {
          run: details.run,
          job: enqueued.job,
          deduplicated: enqueued.deduplicated,
          steps: details.steps,
          events: details.events,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // 8. Runs, Events, SSE Stream & Cancel (`/api/v1/runs/*`)
  app.get('/api/v1/runs', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const list = await listOrganizationRuns(db, actor, actor.organizationId, 50);
      res.status(200).json({ data: list });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/runs/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const targetOrgId =
        typeof req.query.organizationId === 'string' && req.query.organizationId.trim()
          ? req.query.organizationId.trim()
          : actor.organizationId;

      const details = await getRunDetailsForActor(
        db,
        actor,
        targetOrgId,
        String(req.params.id)
      );
      res.status(200).json({ data: details });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/runs/:id/events', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const targetOrgId =
        typeof req.query.organizationId === 'string' && req.query.organizationId.trim()
          ? req.query.organizationId.trim()
          : actor.organizationId;
      const afterSequence = Number(req.query.afterSequence ?? req.header('Last-Event-ID') ?? 0) || 0;

      const events = await listRunEventsAfterSequence(
        db,
        actor,
        targetOrgId,
        String(req.params.id),
        Math.max(0, afterSequence)
      );
      res.status(200).json({ data: events });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/runs/:id/stream', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const targetOrgId =
        typeof req.query.organizationId === 'string' && req.query.organizationId.trim()
          ? req.query.organizationId.trim()
          : actor.organizationId;

      const queryAfterSeq =
        typeof req.query.afterSequence === 'string'
          ? req.query.afterSequence
          : undefined;

      const sseResponse = await createRunEventsSseResponse(db, actor, {
        organizationId: targetOrgId,
        runId: String(req.params.id),
        lastEventIdHeader: req.header('Last-Event-ID') ?? null,
        afterSequenceParam: queryAfterSeq,
      });

      const bodyText = await sseResponse.text();
      res
        .status(sseResponse.status)
        .setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        .setHeader('Cache-Control', 'no-cache, no-transform')
        .setHeader('Connection', 'keep-alive')
        .setHeader(
          'X-Accel-Buffering',
          sseResponse.headers.get('X-Accel-Buffering') ?? 'no'
        )
        .send(bodyText);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/runs/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const cancelled = await cancelAgentRun(
        db,
        actor,
        actor.organizationId,
        String(req.params.id)
      );
      res.status(200).json({ data: cancelled });
    } catch (err) {
      next(err);
    }
  });

  // 9. Approvals (`GET /api/v1/approvals` & `POST /api/v1/approvals/:id/decision`)
  app.get('/api/v1/approvals', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const targetOrgId =
        typeof req.query.organizationId === 'string' && req.query.organizationId.trim()
          ? req.query.organizationId.trim()
          : actor.organizationId;

      const list = await listApprovalRequests(db, actor, targetOrgId);
      res.status(200).json({ data: list });
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/v1/approvals/:id/decision',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }

        const body = approvalDecisionBodySchema.parse(req.body);
        const outcome = await decideApprovalRequest(db, actor, {
          approvalRequestId: String(req.params.id),
          decision: body.decision,
          note: body.note,
          modelProvider: deps.modelProvider ?? createModelProvider(env),
        });

        res.status(200).json({ data: outcome });
      } catch (err) {
        next(err);
      }
    }
  );

  // 10. Knowledge Documents (`GET /api/v1/knowledge/documents`, `POST /api/v1/knowledge/documents`, `GET /api/v1/knowledge/search`)
  app.get(
    '/api/v1/knowledge/documents',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        requireAuthorization(actor, 'document.view', {
          organizationId: actor.organizationId,
          resourceType: 'knowledge_document',
        });

        const docs = await db
          .select()
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.organizationId, actor.organizationId))
          .orderBy(desc(knowledgeDocuments.createdAt));

        res.status(200).json({ data: docs });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/v1/knowledge/documents',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }

        const body = ingestDocumentBodySchema.parse(req.body);
        const result = await ingestKnowledgeDocument(db, actor, {
          organizationId: actor.organizationId,
          title: body.title,
          sourceFilename: body.sourceFilename,
          mimeType: body.mimeType,
          content: body.content,
        });

        res.status(201).json({ data: result });
      } catch (err) {
        next(err);
      }
    }
  );

  app.get('/api/v1/knowledge/search', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      requireAuthorization(actor, 'document.view', {
        organizationId: actor.organizationId,
        resourceType: 'knowledge_document',
      });
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const chunks = await searchKnowledgeChunks(db, {
        organizationId: actor.organizationId,
        query: query || 'incident escalation policy',
        topK: 5,
      });
      res.status(200).json({ data: chunks });
    } catch (err) {
      next(err);
    }
  });

  // 11. Workflows (`GET /api/v1/workflows`, `POST /api/v1/workflows`, `POST /api/v1/workflows/:id/publish`, `POST /api/v1/workflows/:id/runs`)
  app.get('/api/v1/workflows', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      requireAuthorization(actor, 'workflow.view', {
        organizationId: actor.organizationId,
        resourceType: 'workflow',
      });

      const list = await db
        .select()
        .from(workflows)
        .where(eq(workflows.organizationId, actor.organizationId))
        .orderBy(desc(workflows.updatedAt));

      res.status(200).json({ data: list });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/workflows', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const created = await createWorkflowDraft(db, actor, {
        organizationId: actor.organizationId,
        slug: String(req.body?.slug ?? '').trim(),
        name: String(req.body?.name ?? '').trim(),
        description: String(req.body?.description ?? ''),
        graph: req.body?.draftGraph ?? req.body?.graph,
      });
      res.status(201).json({ data: created });
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/v1/workflows/:id/publish',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        const published = await publishWorkflowVersion(db, actor, {
          organizationId: actor.organizationId,
          workflowId: String(req.params.id),
        });
        res.status(201).json({ data: published });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/v1/workflows/:id/runs',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        const body = startWorkflowRunBodySchema.parse(req.body ?? {});
        const workflowId = String(req.params.id);

        let workflowVersionId = body.workflowVersionId;
        if (!workflowVersionId) {
          const [latestWfVer] = await db
            .select()
            .from(workflowVersions)
            .where(
              eq(workflowVersions.workflowId, workflowId)
            )
            .orderBy(desc(workflowVersions.versionNumber))
            .limit(1);
          workflowVersionId = latestWfVer?.id;
        }

        let agentVersionId = body.agentVersionId;
        if (!agentVersionId) {
          const [latestAgentVer] = await db
            .select()
            .from(agentVersions)
            .where(eq(agentVersions.organizationId, actor.organizationId))
            .orderBy(asc(agentVersions.versionNumber))
            .limit(1);
          agentVersionId = latestAgentVer?.id;
        }

        if (!workflowVersionId || !agentVersionId) {
          sendProblemDetails(
            res,
            getReqId(req),
            400,
            'MISSING_WORKFLOW_OR_AGENT_VERSION',
            'Missing published workflow or agent version',
            'Publish a workflow version and an agent version before starting a workflow run.'
          );
          return;
        }

        const started = await startWorkflowRun(db, actor, {
          organizationId: actor.organizationId,
          workflowVersionId,
          defaultAgentVersionId: agentVersionId,
          inputPrompt: body.inputPrompt,
          initialVariables: body.initialVariables,
          modelProvider: deps.modelProvider ?? createModelProvider(env),
        });

        res.status(201).json({ data: started });
      } catch (err) {
        next(err);
      }
    }
  );

  // 12. Usage & Audit Ledgers (`GET /api/v1/usage` & `GET /api/v1/audit-events`)
  app.get('/api/v1/usage', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const summary = await getOrganizationUsageSummary(db, actor, actor.organizationId);
      res.status(200).json({ data: summary });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/audit-events', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const events = await listAuditEvents(db, actor, { organizationId: actor.organizationId });
      res.status(200).json({ data: events });
    } catch (err) {
      next(err);
    }
  });

  // Central RFC 9457 Problem Details Error Handler
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = getReqId(req);

    if (err instanceof z.ZodError) {
      const detail = err.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      sendProblemDetails(res, requestId, 400, 'INVALID_REQUEST_BODY', 'Validation failed', detail);
      return;
    }

    if (err instanceof AuthorizationError) {
      sendProblemDetails(
        res,
        requestId,
        err.statusCode,
        err.code,
        err.statusCode === 404
          ? 'Resource not found'
          : err.statusCode === 401
            ? 'Authentication required'
            : 'Insufficient permissions',
        err.message
      );
      return;
    }

    if (
      err instanceof TenantConstraintError ||
      err instanceof AgentConstraintError ||
      err instanceof RunConstraintError ||
      err instanceof KnowledgeConstraintError ||
      err instanceof WorkflowResourceNotFoundError ||
      err instanceof ApprovalStateConflictError
    ) {
      sendProblemDetails(
        res,
        requestId,
        err.statusCode,
        err.code,
        'Domain constraint violation',
        err.message
      );
      return;
    }

    if (err instanceof WorkflowDagValidationError) {
      sendProblemDetails(
        res,
        requestId,
        422,
        err.code,
        'Invalid workflow DAG',
        err.message
      );
      return;
    }

    sendProblemDetails(
      res,
      requestId,
      500,
      'INTERNAL_SERVER_ERROR',
      'Internal server error',
      err instanceof Error ? err.message : 'An unexpected server error occurred.'
    );
  });

  return app;
}
