import crypto from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  appendRuntimeLog,
  getProviderKeyStatus,
  getPublicEnvSummary,
  isPublicDemoModeAllowed,
  parseEnv,
  redactSecretsFromText,
  type AppEnv,
} from '../config/env';
import {
  createLiveRuntimeModelProvider,
  createModelProvider,
  type LiveAiEngineMode,
  type ModelProvider,
} from '../ai/provider-factory';
import {
  getSharedDatabase,
  type DatabaseContext,
  type OrdarisDatabase,
} from '../db/client';
import {
  authorize,
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
  extractTokenFromRequest,
  registerAuthRoutes,
  verifyAuthToken,
} from './auth';
import {
  AgentConstraintError,
  createAgentDraft,
  getAgentForActor,
  publishAgentVersion,
  updateAgentDraft,
} from '../db/repositories/agent-repository';
import {
  cancelAgentRun,
  enqueueAgentRun,
  getRunDetailsForActor,
  listOrganizationRuns,
  listRunEventsAfterSequence,
  processQueuedJobById,
  RunConstraintError,
} from '../modules/runs/run-executor';
import { createRunEventsSseResponse } from '../modules/runs/sse-stream';
import {
  getKnowledgeDocumentWithChunks,
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
  recordAuditEvent,
  recordUsageEvent,
  startWorkflowRun,
  WorkflowResourceNotFoundError,
} from '../modules/workflows/workflow-engine';
import {
  EvalResourceNotFoundError,
  EvalValidationError,
  runEvalExperiment,
} from '../modules/evals/eval-harness';
import {
  evaluateDatabaseReadiness,
  evaluateLiveness,
} from '../modules/health/health-service';
import type { ReadinessCheckResult } from '../../app/api/v1/health/route';
import { RuntimeWorker } from '../worker/main';
import { agents, agentVersions } from '../db/schema/agents';
import { evalSuites } from '../db/schema/evals';
import { knowledgeDocuments } from '../db/schema/knowledge';
import { usageEvents, workflows, workflowVersions } from '../db/schema/workflows';
import { WorkflowDagValidationError } from '../modules/workflows/dag-validator';
import {
  ByokSessionValidationError,
  listByokProviderStatuses,
  resolveByokScopeKey,
  resolveEffectiveEnvWithByok,
} from '../security/session-key-vault';
import { deleteKnowledgeDocumentForActor } from '../modules/workspace/demo-workspace-service';
import {
  ensureWorkspaceSeededWithPendingHitl,
  listDemoPersonas,
  registerDemoRoutes,
  resolvePersonaActor,
  type DemoPersonaDirectory,
  type DemoPersonaId,
} from './demo-routes';

export {
  ensureWorkspaceSeededWithPendingHitl,
  listDemoPersonas,
  type DemoPersonaDirectory,
  type DemoPersonaId,
};

/**
 * Ordaris Runtime (v1.0.0-demo) — Express HTTP API Application (`src/server/http/app.ts`)
 *
 * Mounts real `/api/v1/*` routes backed by PostgreSQL (PGlite) and the domain services:
 * - Request correlation (`x-request-id`), bounded JSON parsing (`1mb`), RFC 9457 Problem Details.
 * - Real membership-verified actor authentication (`resolveActorFromRequest`) across all 8 RBAC personas
 *   (`acme-owner`, `acme-admin`, `acme-dev`, `acme-viewer`, `beta-owner`, `beta-admin`, `beta-dev`, `beta-viewer`).
 * - Session-isolated in-RAM AES-256-GCM BYOK Vault (`x-ordaris-demo-session`) with 2-hour sliding TTL.
 * - PII/Secret scrubbing, Red-Team guardrail interception, FinOps budget-cap checks, and automatic
 *   `outcome = 'denied'` security audit logging on `403`/`404` rejections.
 */

export interface ApiAppDependencies {
  contextProvider?: () => Promise<DatabaseContext>;
  checkDatabaseReadiness?: () => Promise<ReadinessCheckResult>;
  rawEnv?: Record<string, string | undefined>;
  worker?: RuntimeWorker;
  modelProvider?: ModelProvider;
}

const AI_ENGINE_ENUM = z.enum([
  'auto',
  'gemini-free',
  'openrouter-free',
  'chatgpt-free',
  'claude-free',
  'grok-free',
  'mock',
]);

const createAgentBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().min(2).max(64),
  description: z.string().optional().default(''),
  draftSystemPrompt: z.string().min(1),
  draftToolAllowlist: z
    .array(z.enum(['calculator', 'knowledge_search']))
    .optional()
    .default(['calculator']),
});

const updateAgentBodySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().optional(),
  draftSystemPrompt: z.string().min(1).optional(),
  draftToolAllowlist: z
    .array(z.enum(['calculator', 'knowledge_search']))
    .optional(),
});

const enqueueRunBodySchema = z.object({
  inputPrompt: z.string().trim().min(1).max(16_000),
  agentVersionId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
  processImmediately: z.boolean().optional().default(true),
  aiEngine: AI_ENGINE_ENUM.optional(),
  maxBudgetUsd: z.number().positive().optional(),
});

const approvalDecisionBodySchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(1000).optional(),
  aiEngine: AI_ENGINE_ENUM.optional(),
  engine: AI_ENGINE_ENUM.optional(),
});

const ingestDocumentBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  sourceFilename: z.string().trim().min(1).max(200),
  mimeType: z
    .enum(['text/plain', 'text/markdown', 'application/json'])
    .default('text/markdown'),
  content: z.string().min(1),
});

const startWorkflowRunBodySchema = z.object({
  workflowVersionId: z.string().uuid().optional(),
  agentVersionId: z.string().uuid().optional(),
  inputPrompt: z
    .string()
    .trim()
    .min(1)
    .default('Evaluate production deployment risk score 150'),
  triggerNote: z.string().trim().optional(),
  initialVariables: z.record(z.string(), z.unknown()).optional(),
  riskOverrideExpression: z.string().trim().optional(),
  aiEngine: AI_ENGINE_ENUM.optional(),
  engine: AI_ENGINE_ENUM.optional(),
});

export interface PromptRedactionResult {
  scrubbedPrompt: string;
  redacted: boolean;
  redactedTypes: string[];
}

/**
 * Scrubs raw API keys/secrets and SSN patterns from user prompts prior to model execution.
 */
export function scrubPromptPiiAndSecrets(rawPrompt: string): PromptRedactionResult {
  let scrubbed = rawPrompt;
  const redactedTypes = new Set<string>();

  const secretPatterns = [
    /\bsk-(?:proj-)?[a-zA-Z0-9_-]{12,}\b/g,
    /\bsk-ant-[a-zA-Z0-9_-]{12,}\b/g,
    new RegExp('\\bAI\\x7aa[a-zA-Z0-9_-]{16,}\\b', 'g'),
    /\bghp_[a-zA-Z0-9]{16,}\b/g,
    /\bxai-[a-zA-Z0-9_-]{12,}\b/g,
  ];

  for (const regex of secretPatterns) {
    if (regex.test(scrubbed)) {
      redactedTypes.add('SECRET_KEY');
      scrubbed = scrubbed.replace(regex, '[REDACTED:SECRET_KEY]');
    }
  }

  const ssnRegex = /\b\d{3}-\d{2}-\d{4}\b/g;
  if (ssnRegex.test(scrubbed)) {
    redactedTypes.add('PII_SSN');
    scrubbed = scrubbed.replace(ssnRegex, '[REDACTED:PII_SSN]');
  }

  const emailCreditRegex = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;
  if (emailCreditRegex.test(scrubbed)) {
    redactedTypes.add('PII_CARD');
    scrubbed = scrubbed.replace(emailCreditRegex, '[REDACTED:PII_CARD]');
  }

  return {
    scrubbedPrompt: scrubbed,
    redacted: redactedTypes.size > 0,
    redactedTypes: Array.from(redactedTypes),
  };
}

async function resolveActorFromRequest(
  req: Request,
  db: OrdarisDatabase,
  env: AppEnv
): Promise<AuthenticatedActor | null> {
  const resolveVerifiedClaimsActor = async (claims: {
    sub: string;
    org: string;
    personaId?: string;
  }): Promise<AuthenticatedActor | null> => {
    const byUuid = await resolveActorContext(db, claims.sub, claims.org);
    if (byUuid) {
      return byUuid;
    }
    // If a demo sandbox reset rotated the demo user/organization UUIDs, re-resolve the verified demo persona
    if (isPublicDemoModeAllowed(env)) {
      const personaAlias =
        claims.personaId ||
        req.header('x-actor-id')?.trim() ||
        req.header('x-demo-actor')?.trim() ||
        '';
      if (personaAlias && personaAlias !== 'anonymous') {
        return resolvePersonaActor(db, personaAlias as DemoPersonaId);
      }
    }
    return null;
  };

  // 1. Explicit Cryptographic Token Header (`Authorization: Bearer <jwt>` or `x-ordaris-auth-token: <jwt>`)
  const extracted = extractTokenFromRequest(req);
  if (
    extracted.hadExplicitAuthAttempt &&
    (extracted.source === 'bearer' || extracted.source === 'header')
  ) {
    if (!extracted.token) {
      return null;
    }
    const claims = verifyAuthToken(extracted.token, env.AUTH_SECRET);
    if (!claims) {
      return null;
    }
    const resolved = await resolveVerifiedClaimsActor(claims);
    (
      req as Request & {
        resolvedActor?: AuthenticatedActor | null;
        authMethod?: 'jwt' | 'demo_header';
      }
    ).resolvedActor = resolved;
    (
      req as Request & {
        authMethod?: 'jwt' | 'demo_header';
      }
    ).authMethod = 'jwt';
    return resolved;
  }

  // 2. Signed Session Cookie (`Cookie: ordaris_session=<jwt>`)
  if (extracted.source === 'cookie' && extracted.token) {
    const claims = verifyAuthToken(extracted.token, env.AUTH_SECRET);
    if (!claims) {
      return null;
    }
    const resolved = await resolveVerifiedClaimsActor(claims);
    (
      req as Request & {
        resolvedActor?: AuthenticatedActor | null;
        authMethod?: 'jwt' | 'demo_header';
      }
    ).resolvedActor = resolved;
    (
      req as Request & {
        authMethod?: 'jwt' | 'demo_header';
      }
    ).authMethod = 'jwt';
    return resolved;
  }

  // 3. Production & Non-Demo Guard:
  // When interactive demo mode is disabled (`DEMO_MODE=false` or `NODE_ENV=production` without `PUBLIC_DEMO_SANDBOX=true`),
  // unsigned headers and query params are NEVER trusted.
  if (!isPublicDemoModeAllowed(env)) {
    return null;
  }

  // 4. Explicit Demo Mode Header Resolution:
  // Direct (x-user-id, x-organization-id) header resolution is only permitted outside production (e.g. integration test harness).
  const explicitUserId = req.header('x-user-id')?.trim();
  const explicitOrgId = req.header('x-organization-id')?.trim();

  if (explicitUserId && explicitOrgId && env.NODE_ENV !== 'production') {
    const resolved = await resolveActorContext(db, explicitUserId, explicitOrgId);
    (
      req as Request & {
        resolvedActor?: AuthenticatedActor | null;
        authMethod?: 'jwt' | 'demo_header';
      }
    ).resolvedActor = resolved;
    (
      req as Request & {
        authMethod?: 'jwt' | 'demo_header';
      }
    ).authMethod = 'demo_header';
    return resolved;
  }

  const actorAlias =
    req.header('x-actor-id')?.trim() ||
    req.header('x-demo-actor')?.trim() ||
    '';

  if (actorAlias) {
    if (actorAlias === 'anonymous') {
      return null;
    }
    const resolved = await resolvePersonaActor(db, actorAlias as DemoPersonaId);
    (
      req as Request & {
        resolvedActor?: AuthenticatedActor | null;
        authMethod?: 'jwt' | 'demo_header';
      }
    ).resolvedActor = resolved;
    (
      req as Request & {
        authMethod?: 'jwt' | 'demo_header';
      }
    ).authMethod = 'demo_header';
    return resolved;
  }

  // 4. Signed Session Cookie fallback when no explicit header was provided
  if (extracted.source === 'cookie' && extracted.token) {
    const claims = verifyAuthToken(extracted.token, env.AUTH_SECRET);
    if (!claims) {
      return null;
    }
    const resolved = await resolveActorContext(db, claims.sub, claims.org);
    (
      req as Request & {
        resolvedActor?: AuthenticatedActor | null;
        authMethod?: 'jwt' | 'demo_header';
      }
    ).resolvedActor = resolved;
    (
      req as Request & {
        authMethod?: 'jwt' | 'demo_header';
      }
    ).authMethod = 'jwt';
    return resolved;
  }

  return null;
}

/**
 * Resolves the caller's isolated BYOK vault scope strictly from the `x-ordaris-demo-session` header.
 * Never accepts `?sessionId=` query parameters, and enforces high-entropy session token validation.
 */
function getRequestByokScope(
  req: Request,
  fallbackOrgId: string,
  strictSessionValidation = false
): string {
  const sessionId = req.header('x-ordaris-demo-session')?.trim() || '';
  return resolveByokScopeKey({
    sessionId: sessionId || undefined,
    organizationId: fallbackOrgId,
    strictSessionValidation,
  });
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
      type: `https://ordaris-runtime.dev/problems/${code.toLowerCase().replace(/_/g, '-')}`,
      title,
      status,
      code,
      detail: redactSecretsFromText(detail),
      requestId,
    });
}

export function createApiApp(deps: ApiAppDependencies = {}): Express {
  const app = express();
  const contextProvider = deps.contextProvider ?? getSharedDatabase;

  let jsonBodyLimitBytes = 10_485_760 + 262_144; // MAX_UPLOAD_BYTES (10 MiB default) + JSON envelope overhead
  try {
    const initialEnv = parseEnv(deps.rawEnv ?? process.env);
    jsonBodyLimitBytes = Math.max(
      1_048_576,
      initialEnv.MAX_UPLOAD_BYTES + 262_144
    );
  } catch {
    // Keep default 10 MiB + envelope overhead if rawEnv is intentionally invalid for health test
  }

  app.use(express.json({ limit: jsonBodyLimitBytes }));

  // Attach correlation requestId on every request
  app.use((req: Request, res: Response, next: NextFunction) => {
    const existing = req.header('x-request-id')?.trim();
    const requestId =
      existing && existing.length > 0 ? existing : crypto.randomUUID();
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
            service: 'ordaris-runtime',
            version: '1.0.0-demo',
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

  // 3. Mount Cryptographic Auth & GitHub OAuth 2.0 Routes (`src/server/http/auth.ts`)
  registerAuthRoutes(app, {
    contextProvider,
    rawEnv: deps.rawEnv,
    getReqId,
    sendProblemDetails,
    resolveActorFromRequest,
    ensureWorkspaceSeededWithPendingHitl: async (db, options) => {
      await ensureWorkspaceSeededWithPendingHitl(db, options);
    },
    resolvePersonaActor: (db, personaId) =>
      resolvePersonaActor(db, personaId as DemoPersonaId),
  });

  // 4. Mount Workspace, Demo Governance, Session BYOK Vault, Arena, DAG Validator & Reset Routes (`demo-routes.ts`)
  registerDemoRoutes(app, {
    contextProvider,
    rawEnv: deps.rawEnv,
    worker: deps.worker,
    modelProvider: deps.modelProvider,
    resolveActorFromRequest,
    getRequestByokScope,
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
  app.get(
    '/api/v1/organizations',
    async (req: Request, res: Response, next: NextFunction) => {
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
    }
  );

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
        typeof req.query.organizationId === 'string' &&
        req.query.organizationId.trim()
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
      await recordAuditEvent(db, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'agent.create',
        resourceType: 'agent',
        resourceId: created.id,
        outcome: 'allowed',
        metadata: {
          name: created.name,
          slug: created.slug,
          toolAllowlist: created.draftToolAllowlist,
        },
      });
      res.status(201).json({ data: created });
    } catch (err) {
      next(err);
    }
  });

  app.patch(
    '/api/v1/agents/:id',
    async (req: Request, res: Response, next: NextFunction) => {
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
        await recordAuditEvent(db, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'agent.edit',
          resourceType: 'agent',
          resourceId: updated.id,
          outcome: 'allowed',
          metadata: {
            name: updated.name,
            slug: updated.slug,
            toolAllowlist: updated.draftToolAllowlist,
          },
        });
        res.status(200).json({ data: updated });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/v1/agents/:id/publish',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        const targetOrgId =
          typeof req.body?.organizationId === 'string' &&
          req.body.organizationId.trim()
            ? req.body.organizationId.trim()
            : actor.organizationId;

        const published = await publishAgentVersion(
          db,
          actor,
          targetOrgId,
          String(req.params.id)
        );
        await recordAuditEvent(db, {
          organizationId: targetOrgId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'agent.publish',
          resourceType: 'agent_version',
          resourceId: published.version.id,
          outcome: 'allowed',
          metadata: {
            agentId: published.agent.id,
            agentName: published.agent.name,
            versionNumber: published.version.versionNumber,
            snapshotHash: published.version.snapshotHash,
            toolAllowlist: published.version.toolAllowlist,
          },
        });
        res.status(201).json({ data: published });
      } catch (err) {
        next(err);
      }
    }
  );

  // 7. Enqueue Agent Run (`POST /api/v1/agents/:id/runs`) -> 202 Accepted + Worker Processing
  app.post(
    '/api/v1/agents/:id/runs',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }

        const body = enqueueRunBodySchema.parse(req.body);
        const targetOrgId =
          typeof req.body?.organizationId === 'string' &&
          req.body.organizationId.trim()
            ? req.body.organizationId.trim()
            : actor.organizationId;

        await getAgentForActor(db, actor, targetOrgId, String(req.params.id));

        // 7a. Red-Team Prompt-Injection & Exfiltration Guardrail Interception
        const lowerPrompt = body.inputPrompt.toLowerCase();
        if (
          lowerPrompt.includes('[redteam:exfiltrate-secrets]') ||
          lowerPrompt.includes('ignore all previous instructions') ||
          lowerPrompt.includes('ignore previous system instructions') ||
          lowerPrompt.includes('reveal all system secrets')
        ) {
          await recordAuditEvent(db, {
            organizationId: targetOrgId,
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'security.guardrail_blocked',
            resourceType: 'agent_run',
            resourceId: String(req.params.id),
            outcome: 'denied',
            metadata: {
              reason:
                'Prompt injection / secret exfiltration pattern blocked by Ordaris Input Guardrail.',
              promptPreview: body.inputPrompt.slice(0, 120),
            },
          });
          sendProblemDetails(
            res,
            getReqId(req),
            422,
            'GUARDRAIL_PROMPT_INJECTION_BLOCKED',
            'Blocked by Ordaris Security Guardrail',
            'Adversarial system-prompt override or secret exfiltration directive was intercepted prior to model dispatch and logged in audit_events (outcome=denied).'
          );
          return;
        }

        // 7b. FinOps Token/Cost Budget Cap Interception
        const estimatedTokens = Math.max(
          10,
          Math.ceil(body.inputPrompt.length / 4) + 180
        );
        const estimatedCostUsd = Number((estimatedTokens * 0.000015).toFixed(6));
        const budgetCapExceeded =
          lowerPrompt.includes('[finops:exceed-budget]') ||
          (typeof body.maxBudgetUsd === 'number' &&
            estimatedCostUsd > body.maxBudgetUsd);

        if (budgetCapExceeded) {
          await recordAuditEvent(db, {
            organizationId: targetOrgId,
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'finops.budget_cap_exceeded',
            resourceType: 'agent_run',
            resourceId: String(req.params.id),
            outcome: 'denied',
            metadata: {
              estimatedTokens,
              estimatedCostUsd,
              maxBudgetUsd: body.maxBudgetUsd ?? 0.001,
            },
          });
          sendProblemDetails(
            res,
            getReqId(req),
            422,
            'FINOPS_BUDGET_CAP_EXCEEDED',
            'Blocked by FinOps Per-Run Budget Guardrail',
            `Projected run cost exceeds the configured per-run FinOps ceiling ($${(
              body.maxBudgetUsd ?? 0.001
            ).toFixed(4)}). Execution halted prior to token consumption and logged in audit_events.`
          );
          return;
        }

        // 7c. Automatic PII & Secret Redaction Scrubbing
        const redaction = scrubPromptPiiAndSecrets(body.inputPrompt);
        if (redaction.redacted) {
          await recordAuditEvent(db, {
            organizationId: targetOrgId,
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'security.pii_redacted',
            resourceType: 'agent_run',
            resourceId: String(req.params.id),
            outcome: 'allowed',
            metadata: {
              redactedTypes: redaction.redactedTypes,
            },
          });
        }

        const byokScopeKey = getRequestByokScope(req, targetOrgId);
        const effectiveEnv = resolveEffectiveEnvWithByok(env, byokScopeKey);
        const byokStatuses = listByokProviderStatuses(env, byokScopeKey);
        const hasSessionByok = byokStatuses.some((s) => s.source === 'vault');
        const effectiveAiEngine =
          body.aiEngine ?? (env.NODE_ENV === 'test' ? undefined : 'gemini-free');
        const resolutionTier =
          effectiveAiEngine === 'mock' || !effectiveAiEngine
            ? ('deterministic_fallback' as const)
            : hasSessionByok
              ? ('session_byok' as const)
              : getProviderKeyStatus(effectiveEnv).anyConfigured
                ? ('server_env' as const)
                : ('deterministic_fallback' as const);

        const enqueued = await enqueueAgentRun(db, actor, {
          organizationId: targetOrgId,
          agentId: String(req.params.id),
          agentVersionId: body.agentVersionId,
          inputPrompt: redaction.scrubbedPrompt,
          idempotencyKey: body.idempotencyKey,
          executionConfig: {
            aiEngine: effectiveAiEngine,
            byokScopeKey,
            resolutionTier,
            maxBudgetUsd: body.maxBudgetUsd,
          },
        });

        if (body.processImmediately) {
          await processQueuedJobById(db, enqueued.job.id, {
            workerId: deps.worker?.workerId ?? 'worker-inline-targeted',
            modelProvider: deps.modelProvider,
            rawEnv: deps.rawEnv,
            maxStepsCeiling: env.RUN_MAX_STEPS,
            maxToolCallsCeiling: env.RUN_MAX_TOOL_CALLS,
            timeoutMs: env.RUN_TIMEOUT_SECONDS * 1000,
            leaseDurationMs: env.WORKER_LEASE_MS,
            heartbeatIntervalMs: env.WORKER_HEARTBEAT_INTERVAL_MS,
          });
        } else {
          deps.worker?.nudge();
        }

        const details = await getRunDetailsForActor(
          db,
          actor,
          targetOrgId,
          enqueued.run.id
        );

        if (
          !enqueued.deduplicated &&
          body.processImmediately &&
          env.NODE_ENV !== 'test'
        ) {
          await recordUsageEvent(db, {
            organizationId: targetOrgId,
            runId: details.run.id,
            agentVersionId: details.run.agentVersionId,
            providerMode:
              details.run.usageSource === 'local' ? 'live' : 'mock',
            modelId: effectiveAiEngine ?? 'gemini-free',
            inputTokens: details.run.promptTokens ?? 0,
            outputTokens: details.run.completionTokens ?? 0,
            totalTokens: details.run.totalTokens ?? 0,
            toolCallsCount: details.run.toolCallCount ?? 0,
            isEstimated: details.run.usageSource !== 'local',
          });
        }

        await recordAuditEvent(db, {
          organizationId: targetOrgId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'run.start',
          resourceType: 'agent_run',
          resourceId: details.run.id,
          outcome: 'allowed',
          metadata: {
            agentId: String(req.params.id),
            agentVersionId: details.run.agentVersionId,
            versionNumber: details.version?.versionNumber ?? null,
            aiEngine: effectiveAiEngine ?? 'gemini-free',
            resolutionTier,
            status: details.run.status,
            totalTokens: details.run.totalTokens ?? 0,
            toolCallCount: details.run.toolCallCount ?? 0,
            deduplicated: enqueued.deduplicated,
            promptPreview: redaction.scrubbedPrompt.slice(0, 140),
          },
        });

        res.status(202).json({
          data: {
            run: details.run,
            version: details.version,
            job: enqueued.job,
            deduplicated: enqueued.deduplicated,
            steps: details.steps,
            events: details.events,
            redaction: {
              redacted: redaction.redacted,
              redactedTypes: redaction.redactedTypes,
              scrubbedPrompt: redaction.scrubbedPrompt,
            },
            executionProvenance: {
              requestedEngine: body.aiEngine ?? 'mock',
              resolutionTier,
            },
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

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

  app.get(
    '/api/v1/runs/:id',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        const targetOrgId =
          typeof req.query.organizationId === 'string' &&
          req.query.organizationId.trim()
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
    }
  );

  app.get(
    '/api/v1/runs/:id/events',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        const targetOrgId =
          typeof req.query.organizationId === 'string' &&
          req.query.organizationId.trim()
            ? req.query.organizationId.trim()
            : actor.organizationId;
        const afterSequence =
          Number(req.query.afterSequence ?? req.header('Last-Event-ID') ?? 0) ||
          0;

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
    }
  );

  app.get(
    '/api/v1/runs/:id/stream',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        const targetOrgId =
          typeof req.query.organizationId === 'string' &&
          req.query.organizationId.trim()
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
    }
  );

  app.post(
    '/api/v1/runs/:id/cancel',
    async (req: Request, res: Response, next: NextFunction) => {
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
    }
  );

  // 9. Approvals (`GET /api/v1/approvals` & `POST /api/v1/approvals/:id/decision`)
  app.get(
    '/api/v1/approvals',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        const targetOrgId =
          typeof req.query.organizationId === 'string' &&
          req.query.organizationId.trim()
            ? req.query.organizationId.trim()
            : actor.organizationId;

        const list = await listApprovalRequests(db, actor, targetOrgId);
        res.status(200).json({ data: list });
      } catch (err) {
        next(err);
      }
    }
  );

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
        const byokScopeKey = getRequestByokScope(req, actor.organizationId);
        const effectiveEnv = resolveEffectiveEnvWithByok(env, byokScopeKey);
        const chosenEngine = body.aiEngine ?? body.engine;
        const activeProvider = chosenEngine
          ? createLiveRuntimeModelProvider(effectiveEnv, {
              engine: chosenEngine as LiveAiEngineMode,
            })
          : deps.modelProvider ?? createModelProvider(effectiveEnv);
        const outcome = await decideApprovalRequest(db, actor, {
          approvalRequestId: String(req.params.id),
          decision: body.decision,
          note: body.note,
          modelProvider: activeProvider,
        });

        res.status(200).json({ data: outcome });
      } catch (err) {
        next(err);
      }
    }
  );

  // 10. Knowledge Documents (`GET /api/v1/knowledge/documents`, `GET /api/v1/knowledge/documents/:id`, `POST /api/v1/knowledge/documents`, `DELETE /api/v1/knowledge/documents/:id`, `GET /api/v1/knowledge/search`)
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

  app.get(
    '/api/v1/knowledge/documents/:id',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        const targetOrgId =
          typeof req.query.organizationId === 'string' &&
          req.query.organizationId.trim()
            ? req.query.organizationId.trim()
            : actor.organizationId;

        const details = await getKnowledgeDocumentWithChunks(
          db,
          actor,
          targetOrgId,
          String(req.params.id)
        );
        res.status(200).json({ data: details });
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
        const result = await ingestKnowledgeDocument(
          db,
          actor,
          {
            organizationId: actor.organizationId,
            title: body.title,
            sourceFilename: body.sourceFilename,
            mimeType: body.mimeType,
            content: body.content,
          },
          {
            maxUploadBytes: env.MAX_UPLOAD_BYTES,
          }
        );

        await recordAuditEvent(db, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'document.upload',
          resourceType: 'knowledge_document',
          resourceId: result.document.id,
          outcome: 'allowed',
          metadata: {
            title: result.document.title,
            sourceFilename: result.document.sourceFilename,
            chunkCount: result.document.chunkCount,
            contentBytes: result.document.byteSize,
          },
        });

        res.status(201).json({ data: result });
      } catch (err) {
        next(err);
      }
    }
  );

  app.delete(
    '/api/v1/knowledge/documents/:id',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        const deleted = await deleteKnowledgeDocumentForActor(
          db,
          actor,
          actor.organizationId,
          String(req.params.id)
        );
        res.status(200).json({ data: deleted });
      } catch (err) {
        next(err);
      }
    }
  );

  app.get(
    '/api/v1/knowledge/search',
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
        const query =
          typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const topK = Math.max(
          1,
          Math.min(10, Number(req.query.topK ?? 5) || 5)
        );
        const mode =
          typeof req.query.mode === 'string' ? req.query.mode.trim() : 'hybrid';

        const chunks = await searchKnowledgeChunks(db, {
          organizationId: actor.organizationId,
          query: query || 'incident escalation policy',
          topK,
          minScore: mode === 'vector' ? 0.01 : 0.05,
        });

        const adjusted =
          mode === 'fts'
            ? [...chunks].sort(
                (a, b) =>
                  b.ftsScore +
                  b.lexicalOverlapScore -
                  (a.ftsScore + a.lexicalOverlapScore)
              )
            : mode === 'vector'
              ? [...chunks].sort((a, b) => b.vectorScore - a.vectorScore)
              : chunks;

        res.status(200).json({ data: adjusted.slice(0, topK) });
      } catch (err) {
        next(err);
      }
    }
  );

  // 11. Workflows (`GET /api/v1/workflows`, `POST /api/v1/workflows`, `POST /api/v1/workflows/:id/publish`, `POST /api/v1/workflows/:id/runs`)
  app.get(
    '/api/v1/workflows',
    async (req: Request, res: Response, next: NextFunction) => {
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
    }
  );

  app.post(
    '/api/v1/workflows',
    async (req: Request, res: Response, next: NextFunction) => {
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
    }
  );

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

  const handleStartWorkflowRunRoute = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const body = startWorkflowRunBodySchema.parse(req.body ?? {});
      const workflowId = String(req.params.id);

      const startAuth = authorize(actor, 'run.start', {
        organizationId: actor.organizationId,
        resourceType: 'workflow',
        resourceId: workflowId,
      });
      if (!startAuth.allowed) {
        await recordAuditEvent(db, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'run.start',
          resourceType: 'workflow',
          resourceId: workflowId,
          outcome: 'denied',
          metadata: {
            reason: startAuth.reason,
            riskOverrideExpression: body.riskOverrideExpression ?? null,
          },
        });
        throw new AuthorizationError(startAuth);
      }

      let workflowVersionId = body.workflowVersionId;

      if (body.riskOverrideExpression) {
        const [wfRow] = await db
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.id, workflowId),
              eq(workflows.organizationId, actor.organizationId)
            )
          )
          .limit(1);

        if (wfRow) {
          const mutatedGraph = {
            ...wfRow.draftGraphJson,
            nodes: wfRow.draftGraphJson.nodes.map((n) =>
              n.kind === 'tool' && n.toolName === 'calculator'
                ? {
                    ...n,
                    toolInput: { expression: body.riskOverrideExpression },
                  }
                : n
            ),
          };
          await db
            .update(workflows)
            .set({ draftGraphJson: mutatedGraph, updatedAt: new Date() })
            .where(eq(workflows.id, workflowId));
          const publishedOverride = await publishWorkflowVersion(db, actor, {
            organizationId: actor.organizationId,
            workflowId,
          });
          workflowVersionId = publishedOverride.version.id;
        }
      }

      if (!workflowVersionId) {
        const [latestWfVer] = await db
          .select()
          .from(workflowVersions)
          .where(eq(workflowVersions.workflowId, workflowId))
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

      const byokScopeKey = getRequestByokScope(req, actor.organizationId);
      const effectiveEnv = resolveEffectiveEnvWithByok(env, byokScopeKey);
      const chosenEngine = body.aiEngine ?? body.engine;
      const activeProvider = chosenEngine
        ? createLiveRuntimeModelProvider(effectiveEnv, {
            engine: chosenEngine as LiveAiEngineMode,
          })
        : deps.modelProvider ?? createModelProvider(effectiveEnv);

      const started = await startWorkflowRun(db, actor, {
        organizationId: actor.organizationId,
        workflowVersionId,
        defaultAgentVersionId: agentVersionId,
        inputPrompt: body.triggerNote || body.inputPrompt,
        initialVariables: body.initialVariables,
        modelProvider: activeProvider,
      });

      res.status(201).json({
        data: {
          ...started,
          status: started.run.status,
          runId: started.run.id,
          pausedAtNodeId: started.pendingApproval?.nodeId ?? null,
          approvalRequestId: started.pendingApproval?.id ?? null,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  app.post('/api/v1/workflows/:id/runs', handleStartWorkflowRunRoute);
  app.post('/api/v1/workflows/:id/execute', handleStartWorkflowRunRoute);

  // 11b. Evaluation Suites & Experiments (`POST /api/v1/eval-suites/:id/experiments` & `POST /api/v1/evals/suites/:id/run`)
  const handleRunEvalExperimentRoute = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const suiteId = String(req.params.id);
      let agentVersionId =
        typeof req.body?.agentVersionId === 'string' &&
        req.body.agentVersionId.trim()
          ? req.body.agentVersionId.trim()
          : undefined;

      if (!agentVersionId) {
        const [suiteRow] = await db
          .select()
          .from(evalSuites)
          .where(
            and(
              eq(evalSuites.id, suiteId),
              eq(evalSuites.organizationId, actor.organizationId)
            )
          )
          .limit(1);

        const candidateVersions = await db
          .select()
          .from(agentVersions)
          .where(
            suiteRow
              ? and(
                  eq(agentVersions.organizationId, actor.organizationId),
                  eq(agentVersions.agentId, suiteRow.agentId)
                )
              : eq(agentVersions.organizationId, actor.organizationId)
          )
          .orderBy(asc(agentVersions.versionNumber));
        const fullToolVer = [...candidateVersions]
          .reverse()
          .find(
            (v) =>
              Array.isArray(v.toolAllowlist) &&
              v.toolAllowlist.includes('calculator') &&
              v.toolAllowlist.includes('knowledge_search')
          );
        agentVersionId =
          fullToolVer?.id ??
          candidateVersions[candidateVersions.length - 1]?.id;
      }

      if (!agentVersionId) {
        sendProblemDetails(
          res,
          getReqId(req),
          400,
          'MISSING_AGENT_VERSION',
          'Missing agent version',
          'Publish at least one agent version before running an evaluation experiment.'
        );
        return;
      }

      const rawEngineInput = req.body?.aiEngine ?? req.body?.engine;
      const requestedEngine =
        typeof rawEngineInput === 'string'
          ? (rawEngineInput as LiveAiEngineMode)
          : env.NODE_ENV === 'test'
            ? 'mock'
            : 'gemini-free';

      const byokScopeKey = getRequestByokScope(req, actor.organizationId);
      const effectiveEnv = resolveEffectiveEnvWithByok(env, byokScopeKey);

      const customProvider =
        requestedEngine && requestedEngine !== 'mock'
          ? createLiveRuntimeModelProvider(effectiveEnv, {
              engine: requestedEngine,
            })
          : undefined;

      const result = await runEvalExperiment(
        db,
        actor,
        {
          organizationId: actor.organizationId,
          suiteId,
          agentVersionId,
          providerMode: customProvider ? 'live' : 'mock',
        },
        {
          modelProvider: customProvider,
        }
      );

      const rawPassRate = Number(result.experiment.passRate ?? 1);
      res.status(201).json({
        data: {
          ...result,
          passRate: rawPassRate > 1 ? rawPassRate / 100 : rawPassRate,
          passedCases: result.experiment.passedCases,
          totalCases: result.experiment.totalCases,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  app.post('/api/v1/eval-suites/:id/experiments', handleRunEvalExperimentRoute);
  app.post('/api/v1/evals/suites/:id/run', handleRunEvalExperimentRoute);

  // 12. Usage & Audit Ledgers (`GET /api/v1/usage` & `GET /api/v1/audit-events`)
  app.get('/api/v1/usage', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const summary = await getOrganizationUsageSummary(
        db,
        actor,
        actor.organizationId
      );
      const events = await db
        .select()
        .from(usageEvents)
        .where(eq(usageEvents.organizationId, actor.organizationId))
        .orderBy(desc(usageEvents.createdAt))
        .limit(50);

      res.status(200).json({
        data: {
          ...summary,
          events,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.get(
    '/api/v1/audit-events',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        const events = await listAuditEvents(db, actor, {
          organizationId: actor.organizationId,
        });
        res.status(200).json({ data: events });
      } catch (err) {
        next(err);
      }
    }
  );

  // Central RFC 9457 Problem Details Error Handler with Automatic Denied Audit Logging
  app.use(
    async (err: unknown, req: Request, res: Response, _next: NextFunction) => {
      const requestId = getReqId(req);
      const resolvedActor = (
        req as Request & { resolvedActor?: AuthenticatedActor | null }
      ).resolvedActor;

      const alreadyAuditedByService =
        req.path.endsWith('/decision') ||
        req.path.endsWith('/execute') ||
        req.path.includes('/evals/suites/') ||
        req.path.includes('/eval-suites/');

      if (
        resolvedActor &&
        !alreadyAuditedByService &&
        (err instanceof AuthorizationError ||
          err instanceof TenantConstraintError ||
          err instanceof KnowledgeConstraintError)
      ) {
        try {
          const { db } = await contextProvider();
          const isLastOwnerError =
            err instanceof TenantConstraintError &&
            err.code === 'LAST_OWNER_PROTECTED';
          const actionLabel =
            err instanceof AuthorizationError
              ? err.action
              : isLastOwnerError
                ? 'member.last_owner_safeguard'
                : `${req.method.toLowerCase()}:${req.path}`;
          const resourceTypeLabel = isLastOwnerError
            ? 'membership'
            : err instanceof AuthorizationError && req.path.includes('/members')
              ? 'membership'
              : err instanceof KnowledgeConstraintError
                ? 'knowledge_document'
                : 'http_endpoint';
          const resourceIdLabel =
            (typeof req.params?.userId === 'string' && req.params.userId) ||
            (typeof req.params?.id === 'string' && req.params.id) ||
            (typeof req.body?.email === 'string' && req.body.email) ||
            req.path;

          await recordAuditEvent(db, {
            organizationId: resolvedActor.organizationId,
            actorUserId: resolvedActor.userId,
            actorRole: resolvedActor.role,
            action: actionLabel,
            resourceType: resourceTypeLabel,
            resourceId: resourceIdLabel,
            outcome: 'denied',
            metadata: {
              statusCode: err.statusCode,
              code: err.code,
              message: err.message,
              method: req.method,
              path: req.path,
              ...(typeof req.body?.email === 'string'
                ? { targetEmail: req.body.email }
                : {}),
              ...(typeof req.body?.displayName === 'string'
                ? { targetDisplayName: req.body.displayName }
                : {}),
              ...(typeof req.body?.role === 'string'
                ? { attemptedRole: req.body.role }
                : {}),
              ...(typeof req.params?.userId === 'string'
                ? { targetUserId: req.params.userId }
                : {}),
            },
          });
        } catch {
          // Never fail error response if audit write fails
        }
      }

      if (err instanceof z.ZodError) {
        const detail = err.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; ');
        sendProblemDetails(
          res,
          requestId,
          400,
          'INVALID_REQUEST_BODY',
          'Validation failed',
          detail
        );
        return;
      }

      if (err instanceof ByokSessionValidationError) {
        sendProblemDetails(
          res,
          requestId,
          err.statusCode,
          err.code,
          'Invalid session BYOK token',
          err.message
        );
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
        err instanceof ApprovalStateConflictError ||
        err instanceof EvalResourceNotFoundError ||
        err instanceof EvalValidationError
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

      appendRuntimeLog({
        level: 'ERROR',
        component: 'http-api',
        organizationId: resolvedActor?.organizationId ?? null,
        message:
          err instanceof Error ? err.message : 'Unexpected server error',
        details: {
          method: req.method,
          path: req.path,
          requestId,
          organizationId: resolvedActor?.organizationId ?? null,
        },
      });

      sendProblemDetails(
        res,
        requestId,
        500,
        'INTERNAL_SERVER_ERROR',
        'Internal server error',
        err instanceof Error
          ? err.message
          : 'An unexpected server error occurred.'
      );
    }
  );

  return app;
}
