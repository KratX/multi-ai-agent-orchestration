
import type { Express, NextFunction, Request, Response } from 'express';
import { asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  appendRuntimeLog,
  clearRuntimeLogs,
  getProviderKeyStatus,
  getRuntimeLogs,
  LOG_FILE_PATH,
  parseEnv,
  type AppEnv,
} from '../config/env';
import {
  createLiveRuntimeModelProvider,
  createModelProvider,
  testProviderConnection,
  type LiveAiEngineMode,
  type ModelProvider,
} from '../ai/provider-factory';
import type { DatabaseContext, OrdarisDatabase } from '../db/client';
import { verifyAuthSecretHeader } from './auth';
import {
  AuthorizationError,
  listRolePermissions,
  requireAuthorization,
  type AuthenticatedActor,
} from '../policies/authorization';
import {
  listOrganizationMembers,
  resolveActorContext,
} from '../db/repositories/tenant-repository';
import { getAgentForActor } from '../db/repositories/agent-repository';
import {
  enqueueAgentRun,
  getRunDetailsForActor,
  listOrganizationRuns,
  processQueuedJobById,
} from '../modules/runs/run-executor';
import { RuntimeWorker } from '../worker/main';
import {
  validateWorkflowDag,
  WorkflowDagValidationError,
} from '../modules/workflows/dag-validator';
import {
  ByokSessionValidationError,
  clearByokScope,
  listByokProviderStatuses,
  normalizeByokProviderId,
  resolveByokScopeKey,
  resolveEffectiveEnvWithByok,
  saveByokProviderKey,
  type ByokProviderId,
} from '../security/session-key-vault';
import {
  exportWorkspaceDataBundle,
  getSystemDiagnostics,
  getWorkspaceQuotaStatus,
  importWorkspaceDataBundle,
  inviteOrUpdateWorkspaceMember,
  removeWorkspaceMemberForActor,
  resetDemoSandboxOnly,
  verifyMultiTenantIsolation,
  type DemoResetMode,
} from '../modules/workspace/demo-workspace-service';
import {
  getOrganizationUsageSummary,
  listApprovalRequests,
  listAuditEvents,
  startWorkflowRun,
} from '../modules/workflows/workflow-engine';
import { compareEvalExperiments } from '../modules/evals/eval-harness';
import { seedFlagshipWorkspace, type FlagshipSeedReport } from '../seed';
import { agents, agentVersions } from '../db/schema/agents';
import { knowledgeDocuments } from '../db/schema/knowledge';
import { memberships, organizations, users } from '../db/schema/tenant';
import { usageEvents, workflows, workflowVersions } from '../db/schema/workflows';
import { evalCases, evalExperiments, evalSuites } from '../db/schema/evals';

/**
 * Ordaris Demo Governance, Session BYOK Vault, 2-Engine Arena, Workspace & Diagnostics HTTP Routes
 * (`src/server/http/demo-routes.ts`)
 *
 * Implements Checkpoints 5 & 6:
 * - Session-Scoped AES-256-GCM BYOK Vault endpoints (`/api/v1/providers/keys`, `/api/v1/providers/test`, `/api/v1/demo/byok`)
 *   with strict high-entropy session validation (`x-ordaris-demo-session`) and zero URL query-param leakage.
 * - Workspace Snapshot (`GET /api/v1/workspace`) & 3-Mode Sandbox Reset (`POST /api/v1/workspace/reset`, `POST /api/v1/workspace/seed`).
 * - Side-by-Side 2-Engine Comparison Arena (`POST /api/v1/agents/:id/arena`).
 * - Live 4-Point Cross-Tenant & RBAC Isolation Verifier (`GET /api/v1/demo/verify-isolation`).
 * - Live PostgreSQL 20-Table & Worker Queue Diagnostics (`GET /api/v1/demo/diagnostics`).
 * - 3-Color DFS Workflow DAG Cycle Validator (`POST /api/v1/workflows/validate-dag`).
 * - Team RBAC Member Management & Workspace Bundle Export/Import (`/api/v1/members`, `/api/v1/workspace/export`, `/api/v1/workspace/import`).
 */

export type DemoPersonaId =
  | 'acme-owner'
  | 'acme-admin'
  | 'acme-dev'
  | 'acme-viewer'
  | 'beta-owner'
  | 'beta-admin'
  | 'beta-dev'
  | 'beta-viewer';

export interface DemoPersonaDirectory {
  id: DemoPersonaId;
  label: string;
  email: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  userId: string;
  role: 'owner' | 'admin' | 'developer' | 'viewer';
  permissionsCount: number;
}

const ACTOR_AUTH_SUBJECT_MAP: Record<
  DemoPersonaId,
  { authSubject: string; orgSlug: string }
> = {
  'acme-owner': { authSubject: 'seed_acme_owner', orgSlug: 'acme-cyber-defense' },
  'acme-admin': { authSubject: 'seed_acme_admin', orgSlug: 'acme-cyber-defense' },
  'acme-dev': { authSubject: 'seed_acme_dev', orgSlug: 'acme-cyber-defense' },
  'acme-viewer': { authSubject: 'seed_acme_viewer', orgSlug: 'acme-cyber-defense' },
  'beta-owner': { authSubject: 'seed_beta_owner', orgSlug: 'beta-logistics' },
  'beta-admin': { authSubject: 'seed_beta_admin', orgSlug: 'beta-logistics' },
  'beta-dev': { authSubject: 'seed_beta_dev', orgSlug: 'beta-logistics' },
  'beta-viewer': { authSubject: 'seed_beta_viewer', orgSlug: 'beta-logistics' },
};

export async function ensureWorkspaceSeededWithPendingHitl(
  db: OrdarisDatabase,
  options?: {
    forceReset?: boolean;
    onlyDemo?: boolean;
    resetMode?: DemoResetMode;
    clearByokScopeKey?: string;
    clearAllByok?: boolean;
  }
): Promise<{
  seedReport: FlagshipSeedReport | null;
  pendingApprovalId: string | null;
  clearedByokKeysCount: number;
  resetMode: DemoResetMode;
}> {
  const resetMode: DemoResetMode =
    options?.resetMode ??
    (options?.onlyDemo
      ? 'workspace_only'
      : options?.forceReset
        ? 'workspace_only'
        : 'workspace_only');

  let clearedByokKeysCount = 0;

  if (options?.resetMode === 'keys_only') {
    const res = await resetDemoSandboxOnly(db, {
      mode: 'keys_only',
      clearByokScopeKey: options.clearByokScopeKey,
      clearAllByok: options.clearAllByok,
    });
    clearedByokKeysCount = res.clearedByokKeysCount;
  } else if (
    options?.resetMode === 'factory_reset' ||
    options?.onlyDemo ||
    options?.forceReset
  ) {
    const res = await resetDemoSandboxOnly(db, {
      mode: options?.resetMode === 'factory_reset' ? 'factory_reset' : 'workspace_only',
      clearByokScopeKey: options?.clearByokScopeKey,
      clearAllByok: options?.clearAllByok,
    });
    clearedByokKeysCount = res.clearedByokKeysCount;
  }

  const [existingAcme] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, 'acme-cyber-defense'))
    .limit(1);

  const [existingBetaAdmin] = await db
    .select()
    .from(users)
    .where(eq(users.authSubject, 'seed_beta_admin'))
    .limit(1);

  let seedReport: FlagshipSeedReport | null = null;

  if (!existingAcme) {
    seedReport = await seedFlagshipWorkspace(db);
  } else if (!existingBetaAdmin) {
    await resetDemoSandboxOnly(db, { mode: 'workspace_only' });
  }

  const [acmeOrg] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, 'acme-cyber-defense'))
    .limit(1);

  if (!acmeOrg) {
    return {
      seedReport,
      pendingApprovalId: null,
      clearedByokKeysCount,
      resetMode,
    };
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
    return {
      seedReport,
      pendingApprovalId: null,
      clearedByokKeysCount,
      resetMode,
    };
  }

  const acmeOwnerActor: AuthenticatedActor = {
    userId: acmeOwnerUser.id,
    organizationId: acmeOrg.id,
    role: 'owner',
  };

  const existingApprovals = await listApprovalRequests(
    db,
    acmeOwnerActor,
    acmeOrg.id
  );
  const pending = existingApprovals.find((a) => a.status === 'pending');

  if (pending || (!options?.forceReset && existingApprovals.length > 0)) {
    return {
      seedReport,
      pendingApprovalId: pending?.id ?? null,
      clearedByokKeysCount,
      resetMode,
    };
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
      clearedByokKeysCount,
      resetMode,
    };
  }

  return {
    seedReport,
    pendingApprovalId: null,
    clearedByokKeysCount,
    resetMode,
  };
}

export async function listDemoPersonas(
  db: OrdarisDatabase
): Promise<DemoPersonaDirectory[]> {
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

  const reverseMap: Record<string, DemoPersonaId> = {
    seed_acme_owner: 'acme-owner',
    seed_acme_admin: 'acme-admin',
    seed_acme_dev: 'acme-dev',
    seed_acme_viewer: 'acme-viewer',
    seed_beta_owner: 'beta-owner',
    seed_beta_admin: 'beta-admin',
    seed_beta_dev: 'beta-dev',
    seed_beta_viewer: 'beta-viewer',
  };

  const order: DemoPersonaId[] = [
    'acme-owner',
    'acme-admin',
    'acme-dev',
    'acme-viewer',
    'beta-owner',
    'beta-admin',
    'beta-dev',
    'beta-viewer',
  ];

  const mapped: DemoPersonaDirectory[] = [];
  for (const row of rows) {
    const id = reverseMap[row.authSubject];
    if (id) {
      const permissionsCount = listRolePermissions(row.role).length;
      mapped.push({
        id,
        label: row.displayName ?? row.email ?? id,
        email: row.email ?? '',
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        organizationSlug: row.organizationSlug,
        userId: row.userId,
        role: row.role,
        permissionsCount,
      });
    }
  }

  return mapped.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

export async function resolvePersonaActor(
  db: OrdarisDatabase,
  personaId: DemoPersonaId
): Promise<AuthenticatedActor | null> {
  const mapping = ACTOR_AUTH_SUBJECT_MAP[personaId];
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

export interface DemoRoutesContext {
  contextProvider: () => Promise<DatabaseContext>;
  rawEnv?: Record<string, string | undefined>;
  worker?: RuntimeWorker;
  modelProvider?: ModelProvider;
  resolveActorFromRequest: (
    req: Request,
    db: OrdarisDatabase,
    env: AppEnv
  ) => Promise<AuthenticatedActor | null>;
  getRequestByokScope: (
    req: Request,
    fallbackOrgId: string,
    strictSessionValidation?: boolean
  ) => string;
}

function unauthenticatedError(action: 'org.view' | 'org.manage' = 'org.view'): AuthorizationError {
  return new AuthorizationError({
    allowed: false,
    code: 'UNAUTHENTICATED',
    action,
    reason: 'Authentication required.',
  });
}

export function registerDemoRoutes(app: Express, ctx: DemoRoutesContext): void {
  const {
    contextProvider,
    rawEnv,
    resolveActorFromRequest,
    getRequestByokScope,
  } = ctx;

  // 0. Persisted Workspace Snapshot for Active Actor (`GET /api/v1/workspace`)
  app.get('/api/v1/workspace', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const env = parseEnv(rawEnv ?? process.env);
      const dbCtx = await contextProvider();
      const { db } = dbCtx;

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

      const requestedOrgId =
        typeof req.query.organizationId === 'string' &&
        req.query.organizationId.trim()
          ? req.query.organizationId.trim()
          : actor.organizationId;

      requireAuthorization(actor, 'org.view', {
        organizationId: requestedOrgId,
        resourceType: 'organization',
        resourceId: requestedOrgId,
      });

      const byokScopeKey = getRequestByokScope(req, requestedOrgId);
      const effectiveEnv = resolveEffectiveEnvWithByok(env, byokScopeKey);

      const [orgRow] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, requestedOrgId))
        .limit(1);

      let orgMembers: Awaited<ReturnType<typeof listOrganizationMembers>> = [];
      try {
        orgMembers = await listOrganizationMembers(db, actor, requestedOrgId);
      } catch {
        orgMembers = [];
      }

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

      const orgCases = await db
        .select()
        .from(evalCases)
        .where(eq(evalCases.organizationId, requestedOrgId))
        .orderBy(asc(evalCases.caseIndex));

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

      const usageSummary = await getOrganizationUsageSummary(
        db,
        actor,
        requestedOrgId
      );

      const recentUsageEvents = await db
        .select()
        .from(usageEvents)
        .where(eq(usageEvents.organizationId, requestedOrgId))
        .orderBy(desc(usageEvents.createdAt))
        .limit(40);

      let auditLog: Awaited<ReturnType<typeof listAuditEvents>> = [];
      let canViewAudit = false;
      try {
        auditLog = await listAuditEvents(db, actor, {
          organizationId: requestedOrgId,
        });
        canViewAudit = true;
      } catch {
        canViewAudit = false;
      }

      const providerKeys = getProviderKeyStatus(effectiveEnv);
      const byokProviders = listByokProviderStatuses(env, byokScopeKey);
      const quotas = await getWorkspaceQuotaStatus(db, requestedOrgId);

      const rbacMatrix = {
        owner: listRolePermissions('owner'),
        admin: listRolePermissions('admin'),
        developer: listRolePermissions('developer'),
        viewer: listRolePermissions('viewer'),
        activeActorPermissions: listRolePermissions(actor.role),
      };

      res.status(200).json({
        data: {
          actor,
          organization: orgRow ?? null,
          members: orgMembers,
          quotas,
          rbacMatrix,
          storageMode: dbCtx.storageMode,
          aiMode: effectiveEnv.AI_MODE,
          hasGeminiKey: providerKeys.gemini,
          providerKeys,
          byokProviders,
          byokScopeKey,
          logFilePath: LOG_FILE_PATH,
          runtimeLogs: canViewAudit
            ? getRuntimeLogs(80, { organizationId: requestedOrgId })
            : [],
          personas,
          agents: orgAgents,
          agentVersions: orgVersions,
          runs: orgRuns,
          approvals: orgApprovals,
          workflows: orgWorkflows,
          workflowVersions: orgWorkflowVersions,
          documents: orgDocuments,
          evalSuites: orgSuites,
          evalCases: orgCases,
          evalExperiments: orgExperiments,
          evalComparison,
          usageSummary,
          usageEvents: recentUsageEvents,
          auditEvents: auditLog,
          canViewAudit,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // 1. 3-Choice Sandbox Reset & Seed (`POST /api/v1/workspace/seed` & `POST /api/v1/workspace/reset`)
  const handleSeedOrReset = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const env = parseEnv(rawEnv ?? process.env);
      const { db } = await contextProvider();

      await ensureWorkspaceSeededWithPendingHitl(db, { forceReset: false });

      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError('org.manage');
      }

      const onlyDemo = req.body?.onlyDemo === true;
      const forceReset = req.body?.forceReset !== false && !onlyDemo;
      const rawMode = req.body?.resetMode as DemoResetMode | undefined;
      const resetMode: DemoResetMode =
        rawMode === 'factory_reset' ||
        rawMode === 'keys_only' ||
        rawMode === 'workspace_only'
          ? rawMode
          : 'workspace_only';

      const requestedClearAllByok = req.body?.clearAllByok === true;
      const hasPreSharedSecret = verifyAuthSecretHeader(
        req.header('x-auth-secret'),
        env.AUTH_SECRET
      );
      const clearAllByok = requestedClearAllByok && hasPreSharedSecret;

      if (resetMode === 'factory_reset' || requestedClearAllByok) {
        requireAuthorization(actor, 'org.delete', {
          organizationId: actor.organizationId,
          resourceType: 'organization',
          resourceId: actor.organizationId,
        });
      } else if (resetMode !== 'keys_only') {
        requireAuthorization(actor, 'org.manage', {
          organizationId: actor.organizationId,
          resourceType: 'organization',
          resourceId: actor.organizationId,
        });
      }

      const byokScopeKey = getRequestByokScope(req, actor.organizationId);

      const result = await ensureWorkspaceSeededWithPendingHitl(db, {
        forceReset,
        onlyDemo,
        resetMode: rawMode,
        clearByokScopeKey: byokScopeKey,
        clearAllByok,
      });
      const personas = await listDemoPersonas(db);
      const byokProviders = listByokProviderStatuses(env, byokScopeKey);

      appendRuntimeLog({
        level: 'INFO',
        component: 'workspace-reset',
        organizationId: actor.organizationId,
        message: `Executed demo workspace reset (mode=${resetMode}, clearedKeys=${result.clearedByokKeysCount})`,
        details: {
          organizationId: actor.organizationId,
          resetMode,
          clearedByokKeysCount: result.clearedByokKeysCount,
          byokScopeKey,
          actorUserId: actor.userId,
          actorRole: actor.role,
        },
      });

      res.status(200).json({
        data: {
          status: 'seeded',
          scope: 'demo-sandbox-only',
          resetMode,
          defaultEngine: 'gemini-free',
          alwaysAvailableEngines: ['gemini-free', 'openrouter-free'],
          clearedByokKeysCount: result.clearedByokKeysCount,
          pendingApprovalId: result.pendingApprovalId,
          personas,
          byokProviders,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  app.post('/api/v1/workspace/seed', handleSeedOrReset);
  app.post('/api/v1/workspace/reset', handleSeedOrReset);

  // 2. Runtime Diagnostic Logs (`GET /api/v1/logs` & `POST /api/v1/logs/clear`)
  app.get(
    '/api/v1/logs',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        requireAuthorization(actor, 'audit.view', {
          organizationId: actor.organizationId,
          resourceType: 'runtime_logs',
        });

        const byokScopeKey = getRequestByokScope(req, actor.organizationId);
        const effectiveEnv = resolveEffectiveEnvWithByok(env, byokScopeKey);
        const rawLogs = getRuntimeLogs(120, {
          organizationId: actor.organizationId,
        });
        const entries = rawLogs.map((l) => ({
          timestamp: l.timestamp,
          level: String(l.level || 'info').toLowerCase(),
          event: `[${l.component}] ${l.message}`,
          context: l.details,
        }));
        res.status(200).json({
          data: {
            logFilePath: LOG_FILE_PATH,
            providerKeys: getProviderKeyStatus(effectiveEnv),
            byokProviders: listByokProviderStatuses(env, byokScopeKey),
            logs: rawLogs,
            entries,
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/v1/logs/clear',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        requireAuthorization(actor, 'org.delete', {
          organizationId: actor.organizationId,
          resourceType: 'runtime_logs',
        });

        clearRuntimeLogs({ organizationId: actor.organizationId });
        appendRuntimeLog({
          level: 'INFO',
          component: 'diagnostic-logger',
          organizationId: actor.organizationId,
          message: 'Cleared organization-scoped runtime log buffer via Ordaris Log Explorer.',
          details: {
            organizationId: actor.organizationId,
            actorUserId: actor.userId,
            actorRole: actor.role,
          },
        });
        const rawLogs = getRuntimeLogs(50, {
          organizationId: actor.organizationId,
        });
        res.status(200).json({
          data: {
            cleared: true,
            logs: rawLogs,
            entries: rawLogs.map((l) => ({
              timestamp: l.timestamp,
              level: String(l.level || 'info').toLowerCase(),
              event: `[${l.component}] ${l.message}`,
              context: l.details,
            })),
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // 3. Live 4-Point Cross-Tenant Isolation Verifier (`GET /api/v1/demo/verify-isolation`)
  app.get(
    '/api/v1/demo/verify-isolation',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        const report = await verifyMultiTenantIsolation(db);
        res.status(200).json({ data: report });
      } catch (err) {
        next(err);
      }
    }
  );

  // 4. Live PostgreSQL & Worker Queue Diagnostics (`GET /api/v1/demo/diagnostics`)
  app.get(
    '/api/v1/demo/diagnostics',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        const diagnostics = await getSystemDiagnostics(db);
        res.status(200).json({ data: diagnostics });
      } catch (err) {
        next(err);
      }
    }
  );

  // 5. 3-Color DFS Workflow DAG Cycle Validator (`POST /api/v1/workflows/validate-dag`)
  app.post(
    '/api/v1/workflows/validate-dag',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        let graph = req.body?.graph;
        if (!graph && Array.isArray(req.body?.nodes)) {
          const rawNodes = req.body.nodes as Array<{
            id: string;
            label?: string;
            type?: string;
            kind?: string;
            dependsOn?: string[];
          }>;
          const edges: Array<{ id: string; source: string; target: string }> = [];
          for (const n of rawNodes) {
            if (Array.isArray(n.dependsOn)) {
              for (const dep of n.dependsOn) {
                edges.push({
                  id: `e_${dep}_${n.id}`,
                  source: String(dep),
                  target: String(n.id),
                });
              }
            }
          }
          const incomingCount = new Map<string, number>();
          const outgoingCount = new Map<string, number>();
          for (const n of rawNodes) {
            incomingCount.set(n.id, 0);
            outgoingCount.set(n.id, 0);
          }
          for (const e of edges) {
            incomingCount.set(e.target, (incomingCount.get(e.target) ?? 0) + 1);
            outgoingCount.set(e.source, (outgoingCount.get(e.source) ?? 0) + 1);
          }
          const mappedNodes = rawNodes.map((n, idx) => {
            const rawKind = n.kind ?? n.type ?? 'tool';
            let kind = String(rawKind);
            if (kind === 'human_approval') {
              kind = 'approval';
            }
            if (!['start', 'end', 'agent', 'tool', 'approval'].includes(kind)) {
              kind = 'tool';
            }
            const label = String(n.label ?? n.id ?? `Node ${idx + 1}`);
            return {
              id: String(n.id),
              kind,
              label,
              ...(kind === 'approval' ? { approvalTitle: label } : {}),
            };
          });
          if (!mappedNodes.some((n) => n.kind === 'start') && mappedNodes.length > 0) {
            const rootCandidate =
              mappedNodes.find((n) => (incomingCount.get(n.id) ?? 0) === 0) ??
              mappedNodes[0]!;
            rootCandidate.kind = 'start';
          }
          if (!mappedNodes.some((n) => n.kind === 'end') && mappedNodes.length > 1) {
            const leafCandidates = mappedNodes.filter(
              (n) => n.kind !== 'start' && (outgoingCount.get(n.id) ?? 0) === 0
            );
            const leaf =
              leafCandidates[leafCandidates.length - 1] ??
              mappedNodes[mappedNodes.length - 1]!;
            if (leaf.kind !== 'start') {
              leaf.kind = 'end';
            }
          }
          graph = { nodes: mappedNodes, edges };
        }

        const result = validateWorkflowDag(graph);
        res.status(200).json({
          data: {
            valid: result.valid,
            topologicalOrder: result.topologicalOrder,
            errors: result.errors,
            error: result.errors?.[0] ?? null,
            cyclePath: result.cyclePath,
            nodeCount: Array.isArray(graph?.nodes) ? graph.nodes.length : 0,
            edgeCount: Array.isArray(graph?.edges) ? graph.edges.length : 0,
          },
        });
      } catch (err) {
        if (err instanceof AuthorizationError) {
          next(err);
          return;
        }
        if (err instanceof WorkflowDagValidationError) {
          res.status(200).json({
            data: {
              valid: false,
              code: err.code,
              message: err.message,
              error: err.message,
              errors: err.errors,
              cyclePath: err.cyclePath,
            },
          });
          return;
        }
        res.status(400).json({
          data: {
            valid: false,
            code: 'INVALID_DAG_INPUT',
            error:
              err instanceof Error ? err.message : 'Invalid workflow DAG payload.',
            message:
              err instanceof Error ? err.message : 'Invalid workflow DAG payload.',
          },
        });
      }
    }
  );

  // 6. Side-by-Side 2-Engine Comparison Arena (`POST /api/v1/agents/:id/arena`)
  app.post(
    '/api/v1/agents/:id/arena',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }

        const arenaSchema = z.object({
          inputPrompt: z.string().trim().min(1).max(16_000),
          leftEngine: z.string().default('gemini-free'),
          rightEngine: z.string().default('openrouter-free'),
          agentVersionId: z.string().uuid().optional(),
        });
        const body = arenaSchema.parse(req.body ?? {});
        const agentId = String(req.params.id);

        await getAgentForActor(db, actor, actor.organizationId, agentId);

        const byokScopeKey = getRequestByokScope(req, actor.organizationId);
        const effectiveEnv = resolveEffectiveEnvWithByok(env, byokScopeKey);
        const byokStatuses = listByokProviderStatuses(env, byokScopeKey);
        const hasSessionByok = byokStatuses.some((s) => s.source === 'vault');

        const executeEngineRun = async (engine: string) => {
          const resolutionTier =
            engine === 'mock'
              ? ('deterministic_fallback' as const)
              : hasSessionByok
                ? ('session_byok' as const)
                : ('server_env' as const);
          const enqueued = await enqueueAgentRun(db, actor, {
            organizationId: actor.organizationId,
            agentId,
            agentVersionId: body.agentVersionId,
            inputPrompt: body.inputPrompt,
            executionConfig: {
              aiEngine: engine,
              byokScopeKey,
              resolutionTier,
            },
          });
          await processQueuedJobById(db, enqueued.job.id, {
            workerId: `worker-arena-${engine}`,
            rawEnv,
            modelProvider:
              engine === 'mock'
                ? createModelProvider(effectiveEnv)
                : createLiveRuntimeModelProvider(effectiveEnv, {
                    engine: engine as LiveAiEngineMode,
                    resolutionTier: hasSessionByok
                      ? 'session_byok'
                      : 'server_env',
                  }),
          });
          return getRunDetailsForActor(
            db,
            actor,
            actor.organizationId,
            enqueued.run.id
          );
        };

        const leftDetails = await executeEngineRun(body.leftEngine);
        const rightDetails = await executeEngineRun(body.rightEngine);

        res.status(200).json({
          data: {
            left: {
              engine: body.leftEngine,
              ...leftDetails,
            },
            right: {
              engine: body.rightEngine,
              ...rightDetails,
            },
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // 7. Session-Scoped AES-256-GCM BYOK Vault (`/api/v1/providers/*` & `/api/v1/demo/byok*`)
  const handleGetByokKeys = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const env = parseEnv(rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const byokScopeKey = getRequestByokScope(req, actor.organizationId, true);
      const statuses = listByokProviderStatuses(env, byokScopeKey);
      res.status(200).json({ data: statuses });
    } catch (err) {
      next(err);
    }
  };

  const handleSaveByokKey = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const env = parseEnv(rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }

      const byokScopeKey = getRequestByokScope(req, actor.organizationId, true);
      if (!byokScopeKey.startsWith('session:')) {
        requireAuthorization(actor, 'member.manage', {
          organizationId: actor.organizationId,
          resourceType: 'organization_secret',
        });
      }

      const providerSchema = z.object({
        provider: z.string().min(1),
        rawKey: z.string().optional(),
        apiKey: z.string().optional(),
      });
      const body = providerSchema.parse(req.body ?? {});
      const keyValue = body.rawKey ?? body.apiKey ?? '';
      const providerId: ByokProviderId =
        normalizeByokProviderId(body.provider) ?? 'gemini';
      const updated = saveByokProviderKey({
        scopeKey: byokScopeKey,
        provider: providerId,
        apiKey: keyValue,
      });

      appendRuntimeLog({
        level: 'INFO',
        component: 'session-key-vault',
        organizationId: actor.organizationId,
        message: keyValue.trim()
          ? `Saved AES-256-GCM encrypted Session BYOK key in RAM for ${providerId}`
          : `Removed Session BYOK override for ${providerId}`,
        details: {
          organizationId: actor.organizationId,
          byokScopeKey,
          provider: providerId,
          actorUserId: actor.userId,
        },
      });

      res.status(200).json({
        data: {
          updated,
          providers: listByokProviderStatuses(env, byokScopeKey),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  const handleDeleteByokKeys = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const env = parseEnv(rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }

      const byokScopeKey = getRequestByokScope(req, actor.organizationId, true);
      const providerParam = req.params.provider;
      let clearedCount = 0;

      if (providerParam) {
        const providerId = normalizeByokProviderId(String(providerParam));
        if (providerId) {
          saveByokProviderKey({
            scopeKey: byokScopeKey,
            provider: providerId,
            apiKey: '',
          });
          clearedCount = 1;
        }
      } else {
        clearedCount = clearByokScope(byokScopeKey).clearedCount;
      }

      appendRuntimeLog({
        level: 'INFO',
        component: 'session-key-vault',
        organizationId: actor.organizationId,
        message: `Wiped ${clearedCount} Session BYOK key(s) from RAM scope ${byokScopeKey}`,
        details: {
          organizationId: actor.organizationId,
          byokScopeKey,
          clearedCount,
          actorUserId: actor.userId,
        },
      });

      res.status(200).json({
        data: {
          clearedCount,
          scopeKey: byokScopeKey,
          providers: listByokProviderStatuses(env, byokScopeKey),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  app.get('/api/v1/providers/keys', handleGetByokKeys);
  app.get('/api/v1/demo/byok', handleGetByokKeys);
  app.post('/api/v1/providers/keys', handleSaveByokKey);
  app.post('/api/v1/demo/byok', handleSaveByokKey);
  app.delete('/api/v1/providers/keys', handleDeleteByokKeys);
  app.delete('/api/v1/demo/byok', handleDeleteByokKeys);
  app.delete('/api/v1/demo/byok/:provider', handleDeleteByokKeys);

  app.post(
    '/api/v1/providers/test',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }

        const byokScopeKey = getRequestByokScope(req, actor.organizationId, true);
        const probeResult = await testProviderConnection(env, {
          provider: String(req.body?.provider ?? 'gemini'),
          scopeKey: byokScopeKey,
        });

        res.status(200).json({
          data: probeResult,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // 8. Team RBAC Membership & Workspace Bundle Export/Import (`/api/v1/members/*` & `/api/v1/workspace/*`)
  const handleInviteOrUpdateMember = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const env = parseEnv(rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const schema = z.object({
        email: z.string().email(),
        displayName: z.string().min(1).max(120),
        role: z.enum(['owner', 'admin', 'member', 'developer', 'viewer']),
      });
      const body = schema.parse(req.body);
      const normalizedRole = body.role === 'member' ? 'developer' : body.role;
      const updatedMembers = await inviteOrUpdateWorkspaceMember(db, actor, {
        organizationId: actor.organizationId,
        email: body.email,
        displayName: body.displayName,
        role: normalizedRole,
      });
      res.status(201).json({ data: updatedMembers });
    } catch (err) {
      next(err);
    }
  };

  const handleRemoveMember = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const env = parseEnv(rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const updatedMembers = await removeWorkspaceMemberForActor(
        db,
        actor,
        actor.organizationId,
        String(req.params.userId)
      );
      res.status(200).json({ data: updatedMembers });
    } catch (err) {
      next(err);
    }
  };

  const handleExportWorkspace = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const env = parseEnv(rawEnv ?? process.env);
      const { db } = await contextProvider();
      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw unauthenticatedError();
      }
      const bundle = await exportWorkspaceDataBundle(
        db,
        actor,
        actor.organizationId
      );
      res.status(200).json({ data: bundle });
    } catch (err) {
      next(err);
    }
  };

  app.post('/api/v1/members', handleInviteOrUpdateMember);
  app.post('/api/v1/saas/members', handleInviteOrUpdateMember);
  app.delete('/api/v1/members/:userId', handleRemoveMember);
  app.delete('/api/v1/saas/members/:userId', handleRemoveMember);
  app.get('/api/v1/workspace/export', handleExportWorkspace);
  app.get('/api/v1/saas/export', handleExportWorkspace);

  app.post(
    '/api/v1/workspace/import',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        const imported = await importWorkspaceDataBundle(
          db,
          actor,
          actor.organizationId,
          req.body ?? {}
        );
        res.status(201).json({ data: imported });
      } catch (err) {
        next(err);
      }
    }
  );

}

export { ByokSessionValidationError, resolveByokScopeKey };
