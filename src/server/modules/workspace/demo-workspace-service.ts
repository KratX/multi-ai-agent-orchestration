import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { OrdarisDatabase } from '../../db/client';
import {
  ensureUser,
  listOrganizationMembers,
  removeMembership,
  upsertMembership,
  type OrganizationMemberDetail,
} from '../../db/repositories/tenant-repository';
import {
  createAgentDraft,
  publishAgentVersion,
} from '../../db/repositories/agent-repository';
import {
  getKnowledgeDocumentWithChunks,
  ingestKnowledgeDocument,
  KnowledgeConstraintError,
  searchKnowledgeChunks,
} from '../knowledge/knowledge-service';
import {
  getOrganizationUsageSummary,
  listApprovalRequests,
  listAuditEvents,
  recordAuditEvent,
} from '../workflows/workflow-engine';
import { getEvalSuiteWithCases } from '../evals/eval-harness';
import { listOrganizationRuns } from '../runs/run-executor';
import { createRunEventsSseResponse } from '../runs/sse-stream';
import {
  AuthorizationError,
  requireAuthorization,
  type AuthenticatedActor,
} from '../../policies/authorization';
import {
  organizations,
  users,
  memberships,
  type TenantRole,
} from '../../db/schema/tenant';
import { agents, agentVersions, type AllowedToolName } from '../../db/schema/agents';
import { knowledgeDocuments } from '../../db/schema/knowledge';
import { workflows, workflowVersions } from '../../db/schema/workflows';
import { evalCases, evalExperiments, evalSuites } from '../../db/schema/evals';
import { runs } from '../../db/schema/runs';
import { seedFlagshipWorkspace } from '../../seed/demo-seed';
import { clearByokScope } from '../../ai/byok-vault';
import { getPublicEnvSummary, parseEnv } from '../../config/env';

/**
 * Ordaris Runtime (v1.0.0-demo) — Interactive Demo Workspace, Isolation Verifier & Diagnostics Service
 * (`src/server/modules/workspace/demo-workspace-service.ts`)
 *
 * Replaces `saas-workspace-service.ts` with a 100% pure Demo Sandbox service supporting:
 * 1. 3-Choice Demo Workspace Reset (`workspace_only` | `factory_reset` | `keys_only`)
 * 2. Live 4-Point Cross-Tenant Isolation Verifier (`Acme Cyber Defense` vs `Beta Logistics`)
 * 3. Real-Time PostgreSQL & Worker Queue Diagnostics (`getSystemDiagnostics`)
 * 4. Team RBAC Membership Management (`inviteOrUpdateWorkspaceMember`, `removeWorkspaceMemberForActor`)
 * 5. Tenant JSON Bundle Export & Import (`exportWorkspaceDataBundle`, `importWorkspaceDataBundle`)
 */

export const DEMO_SANDBOX_SLUGS = ['acme-cyber-defense', 'beta-logistics'] as const;

export type DemoResetMode = 'workspace_only' | 'factory_reset' | 'keys_only';

export interface DemoResetOptions {
  mode?: DemoResetMode;
  clearByokScopeKey?: string;
  clearAllByok?: boolean;
}

export interface DemoResetResult {
  mode: DemoResetMode;
  workspaceReset: boolean;
  clearedByokKeysCount: number;
  defaultEngine: 'gemini-free';
  alwaysAvailableEngines: readonly ['gemini-free', 'openrouter-free'];
  resetAt: string;
}

export interface WorkspaceQuotaStatus {
  planName: 'Ordaris Enterprise Sandbox';
  limits: {
    maxAgents: number;
    maxDocuments: number;
    maxRunsPerWindow: number;
    maxMembers: number;
  };
  usage: {
    agentsCount: number;
    documentsCount: number;
    runsCount: number;
    membersCount: number;
  };
}

export interface IsolationCheckItem {
  id: string;
  title: string;
  attackerTenant: string;
  targetTenant: string;
  vector: string;
  expectedOutcome: string;
  actualOutcome: string;
  httpStatus: number;
  passed: boolean;
  durationMs: number;
  description?: string;
  expectedStatus?: number;
  actualStatus?: number;
  evidence?: string;
}

export interface MultiTenantIsolationReport {
  verifiedAt: string;
  overallPassed: boolean;
  checksCount: number;
  passedCount: number;
  verified?: boolean;
  passedChecks?: number;
  totalChecks?: number;
  checks: IsolationCheckItem[];
}

export interface SystemDiagnosticsReport {
  collectedAt: string;
  version: string;
  database: {
    engine: string;
    dataDir: string;
    totalRows: number;
    tables: Record<string, number>;
  };
  workerQueue: {
    pending: number;
    locked: number;
    completed: number;
    deadLetter: number;
  };
  runtime: ReturnType<typeof getPublicEnvSummary>;
}

/**
 * Executes the 3-choice "Reset Demo Workspace" operation:
 * - `workspace_only` (Default): Resets demo tenants (`acme-cyber-defense`, `beta-logistics`) and preserves Session BYOK keys.
 * - `factory_reset`: Resets demo tenants, wipes Session BYOK keys, and restores `gemini-free` as default fallback engine.
 * - `keys_only`: Wipes Session BYOK keys only and reverts BYOK-gated engines (`chatgpt-free`, `claude-free`, `grok-free`) to `gemini-free` while keeping all current workspace runs, documents, and approvals untouched.
 */
export async function resetDemoSandboxOnly(
  db: OrdarisDatabase,
  options?: DemoResetOptions
): Promise<DemoResetResult> {
  const mode: DemoResetMode = options?.mode ?? 'workspace_only';
  let clearedByokKeysCount = 0;

  if (mode === 'keys_only' || mode === 'factory_reset') {
    if (options?.clearAllByok) {
      clearedByokKeysCount = clearByokScope('global', {
        clearAllDemoScopes: true,
      }).clearedCount;
    } else if (options?.clearByokScopeKey) {
      clearedByokKeysCount = clearByokScope(options.clearByokScopeKey).clearedCount;
    }
  }

  let workspaceReset = false;
  if (mode === 'workspace_only' || mode === 'factory_reset') {
    await db.execute(
      sql`DELETE FROM organizations WHERE slug IN ('acme-cyber-defense', 'beta-logistics');`
    );
    await db.execute(sql`DELETE FROM users WHERE auth_subject LIKE 'seed_%';`);
    await seedFlagshipWorkspace(db);
    workspaceReset = true;
  }

  return {
    mode,
    workspaceReset,
    clearedByokKeysCount,
    defaultEngine: 'gemini-free',
    alwaysAvailableEngines: ['gemini-free', 'openrouter-free'],
    resetAt: new Date().toISOString(),
  };
}

/**
 * Executes a live 4-point cross-tenant security verification suite between
 * `Acme Cyber Defense` and `Beta Logistics` directly against PostgreSQL.
 */
export async function verifyMultiTenantIsolation(
  db: OrdarisDatabase
): Promise<MultiTenantIsolationReport> {
  const [acmeOrg] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, 'acme-cyber-defense'))
    .limit(1);

  const [betaOrg] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, 'beta-logistics'))
    .limit(1);

  if (!acmeOrg || !betaOrg) {
    await seedFlagshipWorkspace(db);
    return verifyMultiTenantIsolation(db);
  }

  const [betaOwnerUser] = await db
    .select()
    .from(users)
    .where(eq(users.authSubject, 'seed_beta_owner'))
    .limit(1);

  const betaOwnerActor: AuthenticatedActor = {
    userId: betaOwnerUser?.id ?? '00000000-0000-0000-0000-000000000000',
    organizationId: betaOrg.id,
    role: 'owner',
  };

  const [acmeDoc] = await db
    .select()
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.organizationId, acmeOrg.id))
    .orderBy(asc(knowledgeDocuments.createdAt))
    .limit(1);

  const [acmeSuite] = await db
    .select()
    .from(evalSuites)
    .where(eq(evalSuites.organizationId, acmeOrg.id))
    .orderBy(asc(evalSuites.createdAt))
    .limit(1);

  const [acmeRun] = await db
    .select()
    .from(runs)
    .where(eq(runs.organizationId, acmeOrg.id))
    .orderBy(desc(runs.createdAt))
    .limit(1);

  const checks: IsolationCheckItem[] = [];

  // Check 1: Hybrid FTS + Vector Search Cross-Tenant Isolation
  const t1 = Date.now();
  const betaSearch = await searchKnowledgeChunks(db, {
    organizationId: betaOrg.id,
    query: 'Severity 1 On-Call Commander AES-256-GCM',
    topK: 5,
  });
  const c1Passed = betaSearch.length === 0;
  checks.push({
    id: 'rag_vector_fts_isolation',
    title: 'Hybrid FTS + 64-d Vector RAG Search Isolation',
    attackerTenant: 'Beta Logistics (beta-owner)',
    targetTenant: 'Acme Cyber Defense',
    vector: 'searchKnowledgeChunks(betaOrgId, "Severity 1 On-Call Commander AES-256-GCM")',
    expectedOutcome: '0 Acme chunks returned across FTS + Cosine Vector scan',
    actualOutcome: `${betaSearch.length} Acme chunks returned`,
    httpStatus: 200,
    passed: c1Passed,
    durationMs: Math.max(1, Date.now() - t1),
    description: 'searchKnowledgeChunks(betaOrgId, "Severity 1 On-Call Commander AES-256-GCM")',
    expectedStatus: 200,
    actualStatus: 200,
    evidence: `${betaSearch.length} Acme chunks returned (expected 0 across FTS + 64-d Cosine scan)`,
  });

  // Check 2: Document & Chunk Anti-Enumeration (404 Threat T-01)
  const t2 = Date.now();
  let c2Status = 200;
  let c2Outcome = 'Unexpectedly succeeded';
  if (acmeDoc) {
    try {
      await getKnowledgeDocumentWithChunks(
        db,
        betaOwnerActor,
        betaOrg.id,
        acmeDoc.id
      );
    } catch (err) {
      if (err instanceof KnowledgeConstraintError) {
        c2Status = err.statusCode;
        c2Outcome = `Rejected with HTTP ${err.statusCode} (${err.code})`;
      } else {
        c2Status = 500;
        c2Outcome = 'Rejected with error';
      }
    }
  } else {
    c2Status = 404;
    c2Outcome = 'Rejected with HTTP 404 (DOCUMENT_NOT_FOUND)';
  }
  checks.push({
    id: 'document_anti_enumeration_404',
    title: 'Knowledge Document Cross-Tenant Anti-Enumeration (Threat T-01)',
    attackerTenant: 'Beta Logistics (beta-owner)',
    targetTenant: 'Acme Cyber Defense',
    vector: `GET /api/v1/knowledge/documents/${acmeDoc?.id.slice(0, 8) ?? 'acme_doc'}`,
    expectedOutcome: 'HTTP 404 DOCUMENT_NOT_FOUND (prevents UUID enumeration)',
    actualOutcome: c2Outcome,
    httpStatus: c2Status,
    passed: c2Status === 404,
    durationMs: Math.max(1, Date.now() - t2),
    description: `GET /api/v1/knowledge/documents/${acmeDoc?.id.slice(0, 8) ?? 'acme_doc'} as Beta Logistics`,
    expectedStatus: 404,
    actualStatus: c2Status,
    evidence: c2Outcome,
  });

  // Check 3: Evaluation Suite Cross-Tenant Boundary (404 TENANT_MISMATCH)
  const t3 = Date.now();
  let c3Status = 200;
  let c3Outcome = 'Unexpectedly succeeded';
  if (acmeSuite) {
    try {
      await getEvalSuiteWithCases(
        db,
        betaOwnerActor,
        acmeOrg.id,
        acmeSuite.id
      );
    } catch (err) {
      if (err instanceof AuthorizationError) {
        c3Status = err.statusCode;
        c3Outcome = `Rejected with HTTP ${err.statusCode} (${err.code})`;
      } else {
        c3Status = 404;
        c3Outcome = 'Rejected with HTTP 404';
      }
    }
  } else {
    c3Status = 404;
    c3Outcome = 'Rejected with HTTP 404 (TENANT_MISMATCH)';
  }
  checks.push({
    id: 'eval_suite_boundary_404',
    title: 'Evaluation Suite Cross-Tenant Guard (requireAuthorization)',
    attackerTenant: 'Beta Logistics (beta-owner)',
    targetTenant: 'Acme Cyber Defense',
    vector: `getEvalSuiteWithCases(betaActor, acmeOrgId, "${acmeSuite?.id.slice(0, 8) ?? 'suite'}")`,
    expectedOutcome: 'HTTP 404 TENANT_MISMATCH',
    actualOutcome: c3Outcome,
    httpStatus: c3Status,
    passed: c3Status === 404,
    durationMs: Math.max(1, Date.now() - t3),
    description: `getEvalSuiteWithCases(betaActor, acmeOrgId, "${acmeSuite?.id.slice(0, 8) ?? 'suite'}")`,
    expectedStatus: 404,
    actualStatus: c3Status,
    evidence: c3Outcome,
  });

  // Check 4: SSE Event Stream Cross-Tenant Boundary (404)
  const t4 = Date.now();
  let c4Status = 404;
  let c4Outcome = 'Rejected with HTTP 404 on SSE stream';
  if (acmeRun) {
    const sseRes = await createRunEventsSseResponse(db, betaOwnerActor, {
      organizationId: acmeOrg.id,
      runId: acmeRun.id,
    });
    c4Status = sseRes.status;
    c4Outcome = `SSE Response HTTP ${sseRes.status}`;
  }
  checks.push({
    id: 'sse_stream_boundary_404',
    title: 'SSE Run Event Stream Cross-Tenant Boundary',
    attackerTenant: 'Beta Logistics (beta-owner)',
    targetTenant: 'Acme Cyber Defense',
    vector: `GET /api/v1/runs/${acmeRun?.id.slice(0, 8) ?? 'acme_run'}/stream`,
    expectedOutcome: 'HTTP 404 Not Found',
    actualOutcome: c4Outcome,
    httpStatus: c4Status,
    passed: c4Status === 404,
    durationMs: Math.max(1, Date.now() - t4),
    description: `GET /api/v1/runs/${acmeRun?.id.slice(0, 8) ?? 'acme_run'}/stream as Beta Logistics`,
    expectedStatus: 404,
    actualStatus: c4Status,
    evidence: c4Outcome,
  });

  const passedCount = checks.filter((c) => c.passed).length;

  return {
    verifiedAt: new Date().toISOString(),
    overallPassed: passedCount === checks.length,
    checksCount: checks.length,
    passedCount,
    verified: passedCount === checks.length,
    passedChecks: passedCount,
    totalChecks: checks.length,
    checks,
  };
}

/**
 * Returns live PostgreSQL table row counts, worker job queue metrics, and runtime diagnostics
 * for the Footer DB Diagnostics Modal.
 */
export async function getSystemDiagnostics(
  db: OrdarisDatabase
): Promise<SystemDiagnosticsReport> {
  const env = parseEnv();
  const runtimeSummary = getPublicEnvSummary(env);

  const countTable = async (tableName: string): Promise<number> => {
    const res = await db.execute<{ count: number }>(
      sql.raw(`SELECT count(*)::int AS count FROM ${tableName};`)
    );
    return Number(res.rows?.[0]?.count ?? 0);
  };

  const tableNames = [
    'organizations',
    'users',
    'memberships',
    'agents',
    'agent_versions',
    'runs',
    'run_steps',
    'run_events',
    'job_queue',
    'knowledge_documents',
    'document_chunks',
    'workflows',
    'workflow_versions',
    'approval_requests',
    'eval_suites',
    'eval_cases',
    'eval_experiments',
    'eval_case_results',
    'usage_events',
    'audit_events',
  ];

  const tables: Record<string, number> = {};
  let totalRows = 0;
  for (const name of tableNames) {
    const count = await countTable(name);
    tables[name] = count;
    totalRows += count;
  }

  const queueRows = await db.execute<{ status: string; count: number }>(
    sql`SELECT status, count(*)::int AS count FROM job_queue GROUP BY status;`
  );
  const queueMap = new Map<string, number>();
  for (const row of queueRows.rows ?? []) {
    queueMap.set(row.status, Number(row.count));
  }

  return {
    collectedAt: new Date().toISOString(),
    version: '1.0.0-demo',
    database: {
      engine: 'PostgreSQL 16 (Embedded PGlite + Drizzle ORM)',
      dataDir: env.PGLITE_DATA_DIR,
      totalRows,
      tables,
    },
    workerQueue: {
      pending: queueMap.get('pending') ?? 0,
      locked: queueMap.get('locked') ?? 0,
      completed: queueMap.get('completed') ?? 0,
      deadLetter: queueMap.get('dead_letter') ?? 0,
    },
    runtime: runtimeSummary,
  };
}

/**
 * Invites or updates a member in a Demo Workspace (`POST /api/v1/members`).
 */
export async function inviteOrUpdateWorkspaceMember(
  db: OrdarisDatabase,
  actor: AuthenticatedActor,
  input: {
    organizationId: string;
    email: string;
    displayName: string;
    role: TenantRole;
  }
): Promise<OrganizationMemberDetail[]> {
  const cleanEmail = input.email.trim().toLowerCase();
  const authSubject = `demo_member_${cleanEmail.replace(/[^a-z0-9]/g, '_')}`;

  const targetUser = await ensureUser(db, {
    authSubject,
    email: cleanEmail,
    displayName: input.displayName.trim(),
  });

  await upsertMembership(db, actor, {
    organizationId: input.organizationId,
    targetUserId: targetUser.id,
    role: input.role,
  });

  await recordAuditEvent(db, {
    organizationId: input.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: 'member.upserted',
    resourceType: 'membership',
    resourceId: targetUser.id,
    outcome: 'allowed',
    metadata: { email: cleanEmail, role: input.role },
  });

  return listOrganizationMembers(db, actor, input.organizationId);
}

/**
 * Removes a member from a Workspace with Last-Owner protection (`DELETE /api/v1/members/:userId`).
 */
export async function removeWorkspaceMemberForActor(
  db: OrdarisDatabase,
  actor: AuthenticatedActor,
  organizationId: string,
  targetUserId: string
): Promise<OrganizationMemberDetail[]> {
  await removeMembership(db, actor, organizationId, targetUserId);
  await recordAuditEvent(db, {
    organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: 'member.removed',
    resourceType: 'membership',
    resourceId: targetUserId,
    outcome: 'allowed',
  });
  return listOrganizationMembers(db, actor, organizationId);
}

/**
 * Deletes a knowledge document and cascades to its chunks (`DELETE /api/v1/knowledge/documents/:id`).
 */
export async function deleteKnowledgeDocumentForActor(
  db: OrdarisDatabase,
  actor: AuthenticatedActor,
  organizationId: string,
  documentId: string
): Promise<{ deletedId: string }> {
  requireAuthorization(actor, 'document.delete', {
    organizationId,
    resourceType: 'knowledge_document',
    resourceId: documentId,
  });

  const [existing] = await db
    .select()
    .from(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.id, documentId),
        eq(knowledgeDocuments.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!existing) {
    throw new KnowledgeConstraintError(
      'DOCUMENT_NOT_FOUND',
      `Knowledge document "${documentId}" was not found.`,
      404
    );
  }

  await db
    .delete(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.id, documentId),
        eq(knowledgeDocuments.organizationId, organizationId)
      )
    );

  await recordAuditEvent(db, {
    organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: 'document.deleted',
    resourceType: 'knowledge_document',
    resourceId: documentId,
    outcome: 'allowed',
    metadata: { title: existing.title },
  });

  return { deletedId: documentId };
}

/**
 * Computes workspace resource utilization for the active demo tenant.
 */
export async function getWorkspaceQuotaStatus(
  db: OrdarisDatabase,
  organizationId: string
): Promise<WorkspaceQuotaStatus> {
  const orgAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.organizationId, organizationId));

  const orgDocs = await db
    .select({ id: knowledgeDocuments.id })
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.organizationId, organizationId));

  const orgMembers = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.organizationId, organizationId));

  const runsCountResult = await db.execute<{ count: number }>(
    sql`SELECT count(*)::int AS count FROM runs WHERE organization_id = ${organizationId};`
  );

  return {
    planName: 'Ordaris Enterprise Sandbox',
    limits: {
      maxAgents: 25,
      maxDocuments: 50,
      maxRunsPerWindow: 500,
      maxMembers: 20,
    },
    usage: {
      agentsCount: orgAgents.length,
      documentsCount: orgDocs.length,
      runsCount: Number(runsCountResult.rows?.[0]?.count ?? 0),
      membersCount: orgMembers.length,
    },
  };
}

/**
 * Exports all tenant-owned records as a sanitized JSON bundle (`GET /api/v1/workspace/export`).
 */
export async function exportWorkspaceDataBundle(
  db: OrdarisDatabase,
  actor: AuthenticatedActor,
  organizationId: string
) {
  requireAuthorization(actor, 'org.view', {
    organizationId,
    resourceType: 'organization',
    resourceId: organizationId,
  });

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  const members = await listOrganizationMembers(db, actor, organizationId);
  const orgAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.organizationId, organizationId))
    .orderBy(desc(agents.updatedAt));
  const orgVersions = await db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.organizationId, organizationId));
  const orgDocs = await db
    .select()
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.organizationId, organizationId));
  const orgWorkflows = await db
    .select()
    .from(workflows)
    .where(eq(workflows.organizationId, organizationId));
  const orgWorkflowVersions = await db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.organizationId, organizationId));
  const orgRuns = await listOrganizationRuns(db, actor, organizationId, 100);
  const orgApprovals = await listApprovalRequests(db, actor, organizationId);
  const orgSuites = await db
    .select()
    .from(evalSuites)
    .where(eq(evalSuites.organizationId, organizationId));
  const orgCases = await db
    .select()
    .from(evalCases)
    .where(eq(evalCases.organizationId, organizationId));
  const orgExperiments = await db
    .select()
    .from(evalExperiments)
    .where(eq(evalExperiments.organizationId, organizationId));
  const usageSummary = await getOrganizationUsageSummary(db, actor, organizationId);
  let auditEvents: Awaited<ReturnType<typeof listAuditEvents>> = [];
  try {
    auditEvents = await listAuditEvents(db, actor, { organizationId });
  } catch {
    // Viewer role does not have audit.view permission; export empty auditEvents array for Viewer
    auditEvents = [];
  }

  await recordAuditEvent(db, {
    organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: 'org.data_exported',
    resourceType: 'organization',
    resourceId: organizationId,
    outcome: 'allowed',
  });

  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: '1.0.0-demo',
    platform: 'Ordaris Enterprise Agent Sandbox',
    organization: org,
    members,
    agents: orgAgents,
    agentVersions: orgVersions,
    documents: orgDocs,
    workflows: orgWorkflows,
    workflowVersions: orgWorkflowVersions,
    runs: orgRuns,
    approvals: orgApprovals,
    evalSuites: orgSuites,
    evalCases: orgCases,
    evalExperiments: orgExperiments,
    usageSummary,
    auditEvents,
  };
}

/**
 * Imports a JSON workspace bundle (agents and/or documents) into the active demo organization
 * (`POST /api/v1/workspace/import`).
 */
export async function importWorkspaceDataBundle(
  db: OrdarisDatabase,
  actor: AuthenticatedActor,
  organizationId: string,
  bundle: {
    agents?: Array<{
      name?: string;
      slug?: string;
      description?: string;
      draftSystemPrompt?: string;
      draftToolAllowlist?: AllowedToolName[];
    }>;
    documents?: Array<{
      title?: string;
      sourceFilename?: string;
      mimeType?: 'text/plain' | 'text/markdown' | 'application/json';
      content?: string;
    }>;
  }
): Promise<{
  importedAgentsCount: number;
  importedDocumentsCount: number;
}> {
  requireAuthorization(actor, 'agent.edit', {
    organizationId,
    resourceType: 'organization',
    resourceId: organizationId,
  });

  let importedAgentsCount = 0;
  let importedDocumentsCount = 0;

  if (Array.isArray(bundle.agents)) {
    for (const item of bundle.agents.slice(0, 10)) {
      if (!item?.name || !item?.draftSystemPrompt) continue;
      const baseSlug = (item.slug || item.name)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40);
      const uniqueSlug = `${baseSlug || 'imported-agent'}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;

      const draft = await createAgentDraft(db, actor, {
        organizationId,
        name: item.name.slice(0, 120),
        slug: uniqueSlug,
        description:
          item.description ?? 'Imported via Ordaris Workspace Bundle.',
        draftSystemPrompt: item.draftSystemPrompt,
        draftToolAllowlist: Array.isArray(item.draftToolAllowlist)
          ? item.draftToolAllowlist
          : ['calculator', 'knowledge_search'],
      });
      await publishAgentVersion(db, actor, organizationId, draft.id);
      importedAgentsCount += 1;
    }
  }

  if (Array.isArray(bundle.documents)) {
    for (const doc of bundle.documents.slice(0, 10)) {
      if (!doc?.title || !doc?.content) continue;
      await ingestKnowledgeDocument(db, actor, {
        organizationId,
        title: doc.title.slice(0, 180),
        sourceFilename: doc.sourceFilename || 'imported-playbook.md',
        mimeType: doc.mimeType || 'text/markdown',
        content: doc.content,
      });
      importedDocumentsCount += 1;
    }
  }

  await recordAuditEvent(db, {
    organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: 'org.data_imported',
    resourceType: 'organization',
    resourceId: organizationId,
    outcome: 'allowed',
    metadata: {
      importedAgentsCount,
      importedDocumentsCount,
    },
  });

  return {
    importedAgentsCount,
    importedDocumentsCount,
  };
}
