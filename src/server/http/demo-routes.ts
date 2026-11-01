import type { Express, NextFunction, Request, Response } from 'express';
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
import type { AegisDatabase, DatabaseContext } from '../db/client';
import {
  AuthorizationError,
  requireAuthorization,
  type AuthenticatedActor,
} from '../policies/authorization';
import { getAgentForActor } from '../db/repositories/agent-repository';
import {
  enqueueAgentRun,
  getRunDetailsForActor,
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
  importWorkspaceDataBundle,
  inviteOrUpdateWorkspaceMember,
  removeWorkspaceMemberForActor,
  verifyMultiTenantIsolation,
  type DemoResetMode,
} from '../modules/workspace/demo-workspace-service';
import type { DemoPersonaDirectory } from './app';

/**
 * Aegis Demo Governance, Session BYOK Vault, 2-Engine Arena & Diagnostics HTTP Routes
 * (`src/server/http/demo-routes.ts`)
 *
 * Implements Checkpoints 5 & 6:
 * - Session-Scoped AES-256-GCM BYOK Vault endpoints (`/api/v1/providers/keys`, `/api/v1/providers/test`, `/api/v1/demo/byok`)
 *   with strict high-entropy session validation (`x-aegis-demo-session`) and zero URL query-param leakage.
 * - Side-by-Side 2-Engine Comparison Arena (`POST /api/v1/agents/:id/arena`).
 * - Live 4-Point Cross-Tenant & RBAC Isolation Verifier (`GET /api/v1/demo/verify-isolation`).
 * - Live PostgreSQL 18-Table & Worker Queue Diagnostics (`GET /api/v1/demo/diagnostics`).
 * - 3-Color DFS Workflow DAG Cycle Validator (`POST /api/v1/workflows/validate-dag`).
 * - 3-Mode Sandbox Reset (`POST /api/v1/workspace/reset`, `POST /api/v1/workspace/seed`).
 * - Team RBAC Member Management & Workspace Bundle Export/Import (`/api/v1/members`, `/api/v1/workspace/export`, `/api/v1/workspace/import`).
 */

export interface DemoRoutesContext {
  contextProvider: () => Promise<DatabaseContext>;
  rawEnv?: Record<string, string | undefined>;
  worker?: RuntimeWorker;
  modelProvider?: ModelProvider;
  resolveActorFromRequest: (
    req: Request,
    db: AegisDatabase,
    env: AppEnv
  ) => Promise<AuthenticatedActor | null>;
  ensureWorkspaceSeededWithPendingHitl: (
    db: AegisDatabase,
    options?: {
      forceReset?: boolean;
      onlyDemo?: boolean;
      resetMode?: DemoResetMode;
      clearByokScopeKey?: string;
      clearAllByok?: boolean;
    }
  ) => Promise<{
    pendingApprovalId: string | null;
    clearedByokKeysCount: number;
    resetMode: DemoResetMode;
  }>;
  listDemoPersonas: (db: AegisDatabase) => Promise<DemoPersonaDirectory[]>;
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
    ensureWorkspaceSeededWithPendingHitl,
    listDemoPersonas,
    getRequestByokScope,
  } = ctx;

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
        const byokScopeKey = getRequestByokScope(req, actor.organizationId);
        const effectiveEnv = resolveEffectiveEnvWithByok(env, byokScopeKey);
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
        requireAuthorization(actor, 'org.manage', {
          organizationId: actor.organizationId,
          resourceType: 'runtime_logs',
        });

        clearRuntimeLogs();
        appendRuntimeLog({
          level: 'INFO',
          component: 'diagnostic-logger',
          message: 'Cleared in-memory runtime log buffer via Aegis Log Explorer.',
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
          leftEngine: z.string().default('mock'),
          rightEngine: z.string().default('gemini-free'),
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
          const enqueued = await enqueueAgentRun(db, actor, {
            organizationId: actor.organizationId,
            agentId,
            agentVersionId: body.agentVersionId,
            inputPrompt: body.inputPrompt,
          });
          const worker = new RuntimeWorker({
            db,
            modelProvider:
              engine === 'mock'
                ? createModelProvider(effectiveEnv)
                : createLiveRuntimeModelProvider(effectiveEnv, {
                    engine: engine as LiveAiEngineMode,
                    resolutionTier: hasSessionByok ? 'session_byok' : 'server_env',
                  }),
          });
          await worker.tickOnce();
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
        message: keyValue.trim()
          ? `Saved AES-256-GCM encrypted Session BYOK key in RAM for ${providerId}`
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
        message: `Wiped ${clearedCount} Session BYOK key(s) from RAM scope ${byokScopeKey}`,
        details: {
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
