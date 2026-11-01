import crypto from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  appendRuntimeLog,
  clearRuntimeLogs,
  getProviderKeyStatus,
  getPublicEnvSummary,
  getRuntimeLogs,
  LOG_FILE_PATH,
  parseEnv,
  type AppEnv,
} from '../config/env';
import {
  createLiveRuntimeModelProvider,
  createModelProvider,
  type LiveAiEngineMode,
  type ModelProvider,
} from '../ai/model-provider';
import {
  getSharedDatabase,
  type AegisDatabase,
  type DatabaseContext,
} from '../db/client';
import {
  AuthorizationError,
  listRolePermissions,
  requireAuthorization,
  type AuthenticatedActor,
} from '../policies/authorization';
import {
  createOrganizationWithOwner,
  ensureUser,
  listUserOrganizations,
  listOrganizationMembers,
  resolveActorContext,
  TenantConstraintError,
} from '../db/repositories/tenant-repository';
import {
  extractTokenFromRequest,
  parseCookies,
  signAuthToken,
  signOAuthState,
  verifyAuthSecretHeader,
  verifyAuthToken,
  verifyOAuthState,
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
  startWorkflowRun,
  WorkflowResourceNotFoundError,
} from '../modules/workflows/workflow-engine';
import {
  compareEvalExperiments,
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
import { seedFlagshipWorkspace, type FlagshipSeedReport } from '../seed/demo-seed';
import { agents, agentVersions } from '../db/schema/agents';
import { knowledgeDocuments } from '../db/schema/knowledge';
import { organizations, users, memberships } from '../db/schema/tenant';
import { usageEvents, workflows, workflowVersions } from '../db/schema/workflows';
import { evalCases, evalExperiments, evalSuites } from '../db/schema/evals';
import {
  validateWorkflowDag,
  WorkflowDagValidationError,
} from '../modules/workflows/dag-validator';
import {
  clearByokScope,
  listByokProviderStatuses,
  normalizeByokProviderId,
  recordByokVerificationResult,
  resolveByokScopeKey,
  resolveEffectiveEnvWithByok,
  saveByokProviderKey,
  type ByokProviderId,
} from '../ai/byok-vault';
import {
  deleteKnowledgeDocumentForActor,
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

/**
 * Ordaris (v1.0.0-demo) — Express HTTP API Application (`src/server/http/app.ts`)
 *
 * Mounts real `/api/v1/*` routes backed by PostgreSQL (PGlite) and the domain services:
 * - Request correlation (`x-request-id`), bounded JSON parsing (`1mb`), RFC 9457 Problem Details.
 * - Real membership-verified actor authentication (`resolveActorFromRequest`) across all 8 RBAC personas
 *   (`acme-owner`, `acme-admin`, `acme-dev`, `acme-viewer`, `beta-owner`, `beta-admin`, `beta-dev`, `beta-viewer`).
 * - Session-isolated BYOK Vault (`x-ordaris-demo-session`) with 3-tier AI resolution provenance.
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
  content: z.string().min(1).max(500_000),
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
    /\bAIza[a-zA-Z0-9_-]{16,}\b/g,
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

export async function ensureWorkspaceSeededWithPendingHitl(
  db: AegisDatabase,
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
    // Upgrade legacy 5-persona DB to full 8-persona Ordaris DB
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

  if (pending) {
    return {
      seedReport,
      pendingApprovalId: pending.id,
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
  db: AegisDatabase
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

async function resolvePersonaActor(
  db: AegisDatabase,
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

async function resolveActorFromRequest(
  req: Request,
  db: AegisDatabase,
  env: AppEnv
): Promise<AuthenticatedActor | null> {
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

  // 2. Production & Non-Demo Guard:
  // When NODE_ENV === "production" or DEMO_MODE === false, unsigned headers and query params are NEVER trusted.
  // Only a valid signed `ordaris_session` cookie (or Bearer token above) is accepted.
  if (env.NODE_ENV === 'production' || !env.DEMO_MODE) {
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

  // 3. Explicit Non-Production Demo Mode Header Resolution:
  // Note: Query parameters (?actor=...) and silent default fallbacks ('acme-admin') are strictly prohibited
  // so unauthenticated requests always receive 401 UNAUTHENTICATED.
  const explicitUserId = req.header('x-user-id')?.trim();
  const explicitOrgId = req.header('x-organization-id')?.trim();

  if (explicitUserId && explicitOrgId) {
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

function getRequestByokScope(req: Request, fallbackOrgId: string): string {
  const sessionId =
    req.header('x-ordaris-demo-session')?.trim() ||
    (typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '');
  return resolveByokScopeKey({
    sessionId: sessionId || undefined,
    organizationId: fallbackOrgId,
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
      type: `https://ordaris.dev/problems/${code.toLowerCase().replace(/_/g, '-')}`,
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
            service: 'ordaris',
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

  // 2b. Cryptographic Authentication & GitHub OAuth 2.0 Endpoints (`/api/v1/auth/*`)
  app.get(
    '/api/v1/auth/status',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        const authMethod =
          (req as Request & { authMethod?: string }).authMethod ?? 'none';

        res.status(200).json({
          data: {
            authenticated: Boolean(actor),
            actor,
            authMethod: actor ? authMethod : 'none',
            demoMode: env.DEMO_MODE && env.NODE_ENV !== 'production',
            githubOAuthConfigured: Boolean(
              env.AUTH_GITHUB_ID?.trim() && env.AUTH_GITHUB_SECRET?.trim()
            ),
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/v1/auth/token',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();

        const providedSecret =
          req.header('x-auth-secret') ??
          (typeof req.body?.authSecret === 'string'
            ? req.body.authSecret
            : undefined);
        const hasValidPreSharedSecret = verifyAuthSecretHeader(
          providedSecret,
          env.AUTH_SECRET
        );

        // In production or when DEMO_MODE is disabled, issuing a token without a verified pre-shared AUTH_SECRET is forbidden.
        if (
          (env.NODE_ENV === 'production' || !env.DEMO_MODE) &&
          !hasValidPreSharedSecret
        ) {
          sendProblemDetails(
            res,
            getReqId(req),
            403,
            'DEMO_AUTH_DISABLED',
            'Demo authentication disabled in production',
            'Unauthenticated demo persona token issuance is disabled when DEMO_MODE=false or NODE_ENV=production. Authenticate via GitHub OAuth (/api/v1/auth/github/login) or supply a valid x-auth-secret header.'
          );
          return;
        }

        await ensureWorkspaceSeededWithPendingHitl(db, { forceReset: false });

        const rawPersonaId =
          typeof req.body?.personaId === 'string' && req.body.personaId.trim()
            ? (req.body.personaId.trim() as DemoPersonaId)
            : undefined;
        const rawUserId =
          typeof req.body?.userId === 'string' && req.body.userId.trim()
            ? req.body.userId.trim()
            : undefined;
        const rawOrgId =
          typeof req.body?.organizationId === 'string' &&
          req.body.organizationId.trim()
            ? req.body.organizationId.trim()
            : undefined;

        let actor: AuthenticatedActor | null = null;
        if (rawUserId && rawOrgId) {
          actor = await resolveActorContext(db, rawUserId, rawOrgId);
        } else if (rawPersonaId) {
          actor = await resolvePersonaActor(db, rawPersonaId);
        }

        if (!actor) {
          sendProblemDetails(
            res,
            getReqId(req),
            401,
            'INVALID_AUTH_SUBJECT',
            'Invalid authentication subject',
            'Provide a valid personaId or verified (userId, organizationId) membership pair.'
          );
          return;
        }

        const expiresIn = 8 * 3600;
        const token = signAuthToken(
          {
            userId: actor.userId,
            organizationId: actor.organizationId,
            role: actor.role,
            personaId: rawPersonaId,
            expiresInSeconds: expiresIn,
          },
          env.AUTH_SECRET
        );

        const secureFlag = env.NODE_ENV === 'production' ? '; Secure' : '';
        res.setHeader(
          'Set-Cookie',
          `ordaris_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${expiresIn}${secureFlag}`
        );

        res.status(200).json({
          data: {
            token,
            tokenType: 'Bearer',
            expiresIn,
            actor,
            personaId: rawPersonaId ?? null,
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post('/api/v1/auth/logout', (_req: Request, res: Response) => {
    res.setHeader(
      'Set-Cookie',
      'ordaris_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'
    );
    res.status(200).json({ data: { loggedOut: true } });
  });

  app.get(
    '/api/v1/auth/github/login',
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const clientId = env.AUTH_GITHUB_ID?.trim();
        const clientSecret = env.AUTH_GITHUB_SECRET?.trim();

        if (!clientId || !clientSecret) {
          sendProblemDetails(
            res,
            getReqId(req),
            501,
            'GITHUB_OAUTH_NOT_CONFIGURED',
            'GitHub OAuth is not configured',
            'Set AUTH_GITHUB_ID and AUTH_GITHUB_SECRET in the server environment to enable GitHub OAuth 2.0 login.'
          );
          return;
        }

        const redirectAfter =
          typeof req.query.redirect === 'string' &&
          req.query.redirect.startsWith('/')
            ? req.query.redirect
            : '/';
        const state = signOAuthState(redirectAfter, env.AUTH_SECRET);
        const callbackUrl = `${env.APP_URL.replace(/\/$/, '')}/api/v1/auth/github/callback`;
        const secureFlag = env.NODE_ENV === 'production' ? '; Secure' : '';

        res.setHeader(
          'Set-Cookie',
          `ordaris_oauth_state=${encodeURIComponent(state)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${secureFlag}`
        );

        const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
        authorizeUrl.searchParams.set('client_id', clientId);
        authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
        authorizeUrl.searchParams.set('scope', 'read:user user:email');
        authorizeUrl.searchParams.set('state', state);

        res.redirect(302, authorizeUrl.toString());
      } catch (err) {
        next(err);
      }
    }
  );

  app.get(
    '/api/v1/auth/github/callback',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const clientId = env.AUTH_GITHUB_ID?.trim();
        const clientSecret = env.AUTH_GITHUB_SECRET?.trim();

        if (!clientId || !clientSecret) {
          sendProblemDetails(
            res,
            getReqId(req),
            501,
            'GITHUB_OAUTH_NOT_CONFIGURED',
            'GitHub OAuth is not configured',
            'Set AUTH_GITHUB_ID and AUTH_GITHUB_SECRET in the server environment to enable GitHub OAuth 2.0 login.'
          );
          return;
        }

        const code =
          typeof req.query.code === 'string' ? req.query.code.trim() : '';
        const stateParam =
          typeof req.query.state === 'string' ? req.query.state.trim() : '';
        const cookies = parseCookies(req.header('cookie'));
        const verifiedState = verifyOAuthState(stateParam, env.AUTH_SECRET);

        if (
          !code ||
          !verifiedState ||
          (cookies.ordaris_oauth_state &&
            cookies.ordaris_oauth_state !== stateParam)
        ) {
          sendProblemDetails(
            res,
            getReqId(req),
            400,
            'INVALID_OAUTH_STATE',
            'Invalid or expired OAuth state',
            'The GitHub OAuth callback was missing a valid code or failed HMAC-SHA256 CSRF state verification.'
          );
          return;
        }

        const tokenRes = await fetch(
          'https://github.com/login/oauth/access_token',
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              client_id: clientId,
              client_secret: clientSecret,
              code,
            }),
          }
        );

        const tokenJson = (await tokenRes.json()) as {
          access_token?: string;
          error?: string;
          error_description?: string;
        };

        if (!tokenRes.ok || !tokenJson.access_token) {
          sendProblemDetails(
            res,
            getReqId(req),
            401,
            'OAUTH_TOKEN_EXCHANGE_FAILED',
            'GitHub OAuth token exchange failed',
            tokenJson.error_description ||
              tokenJson.error ||
              'Could not exchange GitHub authorization code for an access token.'
          );
          return;
        }

        const profileRes = await fetch('https://api.github.com/user', {
          headers: {
            authorization: `Bearer ${tokenJson.access_token}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'ordaris-server',
          },
        });

        if (!profileRes.ok) {
          sendProblemDetails(
            res,
            getReqId(req),
            401,
            'OAUTH_PROFILE_FETCH_FAILED',
            'Failed to fetch GitHub user profile',
            'GitHub API rejected the access token when querying /user.'
          );
          return;
        }

        const ghUser = (await profileRes.json()) as {
          id?: number | string;
          login?: string;
          name?: string;
          email?: string | null;
        };

        if (!ghUser.id || !ghUser.login) {
          sendProblemDetails(
            res,
            getReqId(req),
            401,
            'OAUTH_PROFILE_INVALID',
            'Invalid GitHub profile payload',
            'GitHub profile did not include a user ID and login.'
          );
          return;
        }

        const { db } = await contextProvider();
        const userRecord = await ensureUser(db, {
          authSubject: `github:${ghUser.id}`,
          email: ghUser.email ?? `${ghUser.login}@users.noreply.github.com`,
          displayName: ghUser.name ?? ghUser.login,
        });

        let userOrgs = await listUserOrganizations(db, userRecord.id);
        if (userOrgs.length === 0) {
          const slugBase = `gh-${ghUser.login
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .slice(0, 32)}-${String(ghUser.id).slice(-4)}`;
          await createOrganizationWithOwner(db, {
            name: `${ghUser.name || ghUser.login} Workspace`,
            slug: slugBase,
            creatorUserId: userRecord.id,
          });
          userOrgs = await listUserOrganizations(db, userRecord.id);
        }

        const primaryOrg = userOrgs[0]!;
        const actor: AuthenticatedActor = {
          userId: userRecord.id,
          organizationId: primaryOrg.organization.id,
          role: primaryOrg.role,
        };

        const expiresIn = 8 * 3600;
        const sessionJwt = signAuthToken(
          {
            userId: actor.userId,
            organizationId: actor.organizationId,
            role: actor.role,
            expiresInSeconds: expiresIn,
          },
          env.AUTH_SECRET
        );

        const secureFlag = env.NODE_ENV === 'production' ? '; Secure' : '';
        res.setHeader(
          'Set-Cookie',
          `ordaris_session=${encodeURIComponent(sessionJwt)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${expiresIn}${secureFlag}`
        );

        if ((req.header('accept') ?? '').includes('text/html')) {
          res.redirect(302, verifiedState.redirectAfter || '/');
          return;
        }

        res.status(200).json({
          data: {
            token: sessionJwt,
            tokenType: 'Bearer',
            expiresIn,
            actor,
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // 3. Seed / 3-Choice Reset Flagship Demo Workspace (`POST /api/v1/workspace/seed` & `POST /api/v1/workspace/reset`)
  const handleSeedOrReset = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const env = parseEnv(deps.rawEnv ?? process.env);
      const { db } = await contextProvider();

      // Ensure baseline seed exists before resolving actor so first-boot authenticated calls can resolve membership
      await ensureWorkspaceSeededWithPendingHitl(db, { forceReset: false });

      const actor = await resolveActorFromRequest(req, db, env);
      if (!actor) {
        throw new AuthorizationError({
          allowed: false,
          code: 'UNAUTHENTICATED',
          action: 'org.manage',
          reason: 'Authentication required to reset or re-seed the workspace.',
        });
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

      const clearAllByok = req.body?.clearAllByok === true;

      if (resetMode === 'factory_reset' || clearAllByok) {
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
        message: `Executed demo workspace reset (mode=${resetMode}, clearedKeys=${result.clearedByokKeysCount})`,
        details: {
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

  // 4. Get Persisted Workspace Snapshot for Active Actor (`GET /api/v1/workspace`)
  app.get('/api/v1/workspace', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawEnv = parseEnv(deps.rawEnv ?? process.env);
      const ctx = await contextProvider();
      const { db } = ctx;

      await ensureWorkspaceSeededWithPendingHitl(db, { forceReset: false });
      const personas = await listDemoPersonas(db);
      const actor = await resolveActorFromRequest(req, db, rawEnv);

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
      const effectiveEnv = resolveEffectiveEnvWithByok(rawEnv, byokScopeKey);

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
      const byokProviders = listByokProviderStatuses(rawEnv, byokScopeKey);
      const quotas = await getWorkspaceQuotaStatus(db, requestedOrgId);

      // Expose the 23-action RBAC matrix metadata for the interactive RBAC Policy Matrix Modal
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
          storageMode: ctx.storageMode,
          aiMode: effectiveEnv.AI_MODE,
          hasGeminiKey: providerKeys.gemini,
          providerKeys,
          byokProviders,
          byokScopeKey,
          logFilePath: LOG_FILE_PATH,
          runtimeLogs: getRuntimeLogs(80),
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

  function unauthenticatedError(): AuthorizationError {
    return new AuthorizationError({
      allowed: false,
      code: 'UNAUTHENTICATED',
      action: 'org.view',
      reason: 'Authentication required.',
    });
  }

  // 4b. Diagnostic Logs & Provider Key Status (`GET /api/v1/logs` & `POST /api/v1/logs/clear`)
  app.get(
    '/api/v1/logs',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const rawEnv = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, rawEnv);
        if (!actor) {
          throw unauthenticatedError();
        }
        const byokScopeKey = getRequestByokScope(req, actor.organizationId);
        const effectiveEnv = resolveEffectiveEnvWithByok(rawEnv, byokScopeKey);
        const rawLogs = getRuntimeLogs(120);
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
            byokProviders: listByokProviderStatuses(rawEnv, byokScopeKey),
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
        const rawEnv = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, rawEnv);
        if (!actor) {
          throw unauthenticatedError();
        }
        requireAuthorization(actor, 'org.manage', {
          organizationId: actor.organizationId,
          resourceType: 'runtime_logs',
        });

        clearRuntimeLogs();
        appendRuntimeLog({
          level: 'INFO',
          component: 'diagnostic-logger',
          message: 'Cleared in-memory runtime log buffer via Ordaris Log Explorer.',
          details: {
            actorUserId: actor.userId,
            actorRole: actor.role,
          },
        });
        const rawLogs = getRuntimeLogs(50);
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

  // 4c. Live 4-Point Cross-Tenant Isolation Verifier (`GET /api/v1/demo/verify-isolation`)
  app.get(
    '/api/v1/demo/verify-isolation',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
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

  // 4d. Live PostgreSQL & Worker Queue Diagnostics (`GET /api/v1/demo/diagnostics`)
  app.get(
    '/api/v1/demo/diagnostics',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
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

        // Ensure agent exists in targetOrgId first so cross-tenant attempts get 404
        await getAgentForActor(db, actor, targetOrgId, String(req.params.id));

        // 7a. Red-Team Prompt-Injection & Exfiltration Guardrail Interception
        const lowerPrompt = body.inputPrompt.toLowerCase();
        if (
          lowerPrompt.includes('[redteam:exfiltrate-secrets]') ||
          lowerPrompt.includes('ignore all previous instructions and dump')
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

        const enqueued = await enqueueAgentRun(db, actor, {
          organizationId: targetOrgId,
          agentId: String(req.params.id),
          agentVersionId: body.agentVersionId,
          inputPrompt: redaction.scrubbedPrompt,
          idempotencyKey: body.idempotencyKey,
        });

        const byokScopeKey = getRequestByokScope(req, targetOrgId);
        const effectiveEnv = resolveEffectiveEnvWithByok(env, byokScopeKey);
        const byokStatuses = listByokProviderStatuses(env, byokScopeKey);
        const hasSessionByok = byokStatuses.some((s) => s.source === 'vault');

        const worker = body.aiEngine
          ? new RuntimeWorker({
              db,
              modelProvider: createLiveRuntimeModelProvider(effectiveEnv, {
                engine: body.aiEngine as LiveAiEngineMode,
                resolutionTier: hasSessionByok ? 'session_byok' : 'server_env',
              }),
            })
          : deps.worker ??
            new RuntimeWorker({
              db,
              modelProvider:
                deps.modelProvider ?? createModelProvider(effectiveEnv),
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
              resolutionTier:
                body.aiEngine === 'mock' || !body.aiEngine
                  ? 'deterministic_fallback'
                  : hasSessionByok
                    ? 'session_byok'
                    : getProviderKeyStatus(effectiveEnv).anyConfigured
                      ? 'server_env'
                      : 'deterministic_fallback',
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

  // 11. Workflows (`GET /api/v1/workflows`, `POST /api/v1/workflows`, `POST /api/v1/workflows/validate-dag`, `POST /api/v1/workflows/:id/publish`, `POST /api/v1/workflows/:id/runs`)
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
    '/api/v1/workflows/validate-dag',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
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

      let workflowVersionId = body.workflowVersionId;

      // If user requested a Low-Risk branch override (e.g. expression "20 * 3" = 60 <= 100),
      // create or reuse a published low-risk version so they can watch the condition node auto-bypass the HITL gate!
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
        const [latestVer] = await db
          .select()
          .from(agentVersions)
          .where(eq(agentVersions.organizationId, actor.organizationId))
          .orderBy(desc(agentVersions.versionNumber))
          .limit(1);
        agentVersionId = latestVer?.id;
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
          : 'mock';

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

  // 13. Session-Scoped BYOK Encrypted Vault & Provider Live Verification (`/api/v1/providers/*`)
  app.get(
    '/api/v1/providers/keys',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }
        const byokScopeKey = getRequestByokScope(req, actor.organizationId);
        const statuses = listByokProviderStatuses(env, byokScopeKey);
        res.status(200).json({ data: statuses });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/v1/providers/keys',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }

        const byokScopeKey = getRequestByokScope(req, actor.organizationId);
        // If no session header is present, require member.manage to mutate org-wide secrets
        if (!byokScopeKey.startsWith('session:')) {
          requireAuthorization(actor, 'member.manage', {
            organizationId: actor.organizationId,
            resourceType: 'organization_secret',
          });
        }

        const providerSchema = z.object({
          provider: z.string().min(1),
          rawKey: z.string(),
        });
        const body = providerSchema.parse(req.body);
        const providerId: ByokProviderId =
          normalizeByokProviderId(body.provider) ?? 'gemini';
        const updated = saveByokProviderKey({
          scopeKey: byokScopeKey,
          provider: providerId,
          apiKey: body.rawKey,
          authSecret: env.AUTH_SECRET,
        });

        appendRuntimeLog({
          level: 'INFO',
          component: 'byok-vault',
          message: body.rawKey.trim()
            ? `Saved AES-256-GCM encrypted Session BYOK key for ${providerId}`
            : `Removed Session BYOK override for ${providerId}`,
          details: {
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
    }
  );

  app.delete(
    '/api/v1/providers/keys',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }

        const byokScopeKey = getRequestByokScope(req, actor.organizationId);
        const cleared = clearByokScope(byokScopeKey);

        appendRuntimeLog({
          level: 'INFO',
          component: 'byok-vault',
          message: `Wiped ${cleared.clearedCount} Session BYOK key(s) from scope ${byokScopeKey}`,
          details: {
            byokScopeKey,
            clearedCount: cleared.clearedCount,
            actorUserId: actor.userId,
          },
        });

        res.status(200).json({
          data: {
            clearedCount: cleared.clearedCount,
            scopeKey: byokScopeKey,
            providers: listByokProviderStatuses(env, byokScopeKey),
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/v1/providers/test',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(deps.rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        if (!actor) {
          throw unauthenticatedError();
        }

        const providerId: ByokProviderId =
          normalizeByokProviderId(String(req.body?.provider ?? 'gemini')) ??
          'gemini';
        const engineMap: Record<ByokProviderId, LiveAiEngineMode> = {
          gemini: 'gemini-free',
          openrouter: 'openrouter-free',
          chatgpt: 'chatgpt-free',
          claude: 'claude-free',
          grok: 'grok-free',
        };
        const engine = engineMap[providerId] ?? 'auto';
        const byokScopeKey = getRequestByokScope(req, actor.organizationId);
        const effectiveEnv = resolveEffectiveEnvWithByok(env, byokScopeKey);
        const testProvider = createLiveRuntimeModelProvider(effectiveEnv, {
          engine,
        });

        const result = await testProvider.generate({
          systemPrompt:
            'Respond concisely in one short sentence confirming the API connection is active.',
          modelConfig: {
            provider: 'google',
            model: 'gemini-3-flash-preview',
            temperature: 0,
            maxSteps: 2,
            maxToolCalls: 0,
          },
          allowedTools: [],
          messages: [
            {
              role: 'user',
              content: 'Verify live BYOK API connection health.',
            },
          ],
          stepIndex: 0,
        });

        const answerText = result.answer ?? result.reasoningSummary ?? '';
        const isFallback =
          result.usage.isSimulated ||
          result.usage.source === 'mock' ||
          result.resolutionTier === 'deterministic_fallback' ||
          result.modelName.includes('fallback') ||
          result.modelName.includes('mock');

        const verifyMessage = isFallback
          ? `Tier 3 Deterministic Fallback used (${result.providerName} / ${result.modelName})`
          : `Verified live (${result.providerName} / ${result.modelName})`;

        recordByokVerificationResult({
          scopeKey: byokScopeKey,
          provider: providerId,
          verified: !isFallback,
          message: verifyMessage,
        });

        res.status(200).json({
          data: {
            provider: providerId,
            verified: !isFallback,
            message: verifyMessage,
            outputPreview: answerText.slice(0, 240),
            providers: listByokProviderStatuses(env, byokScopeKey),
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // 14. Team RBAC Membership & Workspace Bundle Export/Import (`/api/v1/members/*` & `/api/v1/workspace/*`)
  const handleInviteOrUpdateMember = async (
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
      const env = parseEnv(deps.rawEnv ?? process.env);
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
      const env = parseEnv(deps.rawEnv ?? process.env);
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
        const env = parseEnv(deps.rawEnv ?? process.env);
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

  // Central RFC 9457 Problem Details Error Handler with Automatic Denied Audit Logging
  app.use(
    async (err: unknown, req: Request, res: Response, _next: NextFunction) => {
      const requestId = getReqId(req);
      const resolvedActor = (
        req as Request & { resolvedActor?: AuthenticatedActor | null }
      ).resolvedActor;

      // Record outcome='denied' in audit_events when an authenticated actor hits a 403/404 RBAC or tenant boundary
      // (Skip approval.decide because decideApprovalRequest already writes its own denied audit event)
      if (
        resolvedActor &&
        !req.path.endsWith('/decision') &&
        (err instanceof AuthorizationError ||
          err instanceof TenantConstraintError ||
          err instanceof KnowledgeConstraintError)
      ) {
        try {
          const { db } = await contextProvider();
          const actionLabel =
            err instanceof AuthorizationError
              ? err.action
              : `${req.method.toLowerCase()}:${req.path}`;
          await recordAuditEvent(db, {
            organizationId: resolvedActor.organizationId,
            actorUserId: resolvedActor.userId,
            actorRole: resolvedActor.role,
            action: actionLabel,
            resourceType: 'http_endpoint',
            resourceId: req.path,
            outcome: 'denied',
            metadata: {
              statusCode: err.statusCode,
              code: err.code,
              message: err.message,
              method: req.method,
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
        message:
          err instanceof Error ? err.message : 'Unexpected server error',
        details: {
          method: req.method,
          path: req.path,
          requestId,
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
