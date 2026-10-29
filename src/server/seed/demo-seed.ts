import { fileURLToPath } from 'node:url';
import {
  createDatabaseClient,
  type AegisDatabase,
} from '../db/client';
import {
  createOrganizationWithOwner,
  ensureUser,
  upsertMembership,
} from '../db/repositories/tenant-repository';
import {
  createAgentDraft,
  publishAgentVersion,
  updateAgentDraft,
} from '../db/repositories/agent-repository';
import { ingestKnowledgeDocument } from '../modules/knowledge/knowledge-service';
import type { WorkflowGraphSpec } from '../db/schema/workflows';
import {
  createWorkflowDraft,
  decideApprovalRequest,
  getOrganizationUsageSummary,
  listAuditEvents,
  publishWorkflowVersion,
  startWorkflowRun,
} from '../modules/workflows/workflow-engine';
import {
  compareEvalExperiments,
  createEvalSuite,
  runEvalExperiment,
} from '../modules/evals/eval-harness';
import { createRunEventsSseResponse } from '../modules/runs/sse-stream';
import type { AuthenticatedActor } from '../policies/authorization';

export interface FlagshipSeedReport {
  tenants: {
    acme: {
      organizationId: string;
      slug: string;
      ownerUserId: string;
      adminUserId: string;
      developerUserId: string;
      viewerUserId: string;
    };
    beta: {
      organizationId: string;
      slug: string;
      ownerUserId: string;
    };
  };
  knowledge: {
    documentId: string;
    title: string;
    chunkCount: number;
    storageKey: string;
  };
  agents: {
    agentId: string;
    slug: string;
    v1VersionId: string;
    v1SnapshotHash: string;
    v2VersionId: string;
    v2SnapshotHash: string;
  };
  workflow: {
    workflowId: string;
    workflowVersionId: string;
    snapshotHash: string;
    runId: string;
    approvalRequestId: string;
    initialStatus: string;
    finalStatus: string;
    approvedByUserId: string;
  };
  evaluation: {
    suiteId: string;
    baselineExperimentId: string;
    baselinePassRate: number;
    candidateExperimentId: string;
    candidatePassRate: number;
    passRateDelta: number;
    regressedCasesCount: number;
    sampleEvalRunId: string;
  };
  sseReplay: {
    fullEventsCount: number;
    replayedAfterCursor2Count: number;
  };
  governance: {
    auditEventsCount: number;
    mockRunsCount: number;
    mockTotalTokens: number;
  };
}

export const FLAGSHIP_HITL_WORKFLOW_GRAPH: WorkflowGraphSpec = {
  nodes: [
    { id: 'start-1', kind: 'start', label: 'Start Trigger' },
    {
      id: 'calc-risk',
      kind: 'tool',
      label: 'Compute Change Risk Score',
      toolName: 'calculator',
      toolInput: { expression: '50 * 3' },
    },
    {
      id: 'cond-risk',
      kind: 'condition',
      label: 'Risk Score > 100?',
      condition: { field: 'lastOutput', operator: 'gt', value: 100 },
    },
    {
      id: 'approval-gate-1',
      kind: 'approval',
      label: 'Production Release Gate',
      approvalTitle: 'Approve High-Impact Production Rollout',
      approvalReason: 'Calculated change risk score (150) exceeds threshold (100).',
      allowDeveloperDecision: false,
    },
    {
      id: 'agent-summary',
      kind: 'agent',
      label: 'Release Readiness Summarizer',
      promptTemplate: 'Summarize approved production deployment readiness.',
    },
    { id: 'end-1', kind: 'end', label: 'Completed' },
  ],
  edges: [
    { id: 'e1', source: 'start-1', target: 'calc-risk' },
    { id: 'e2', source: 'calc-risk', target: 'cond-risk' },
    {
      id: 'e3',
      source: 'cond-risk',
      target: 'approval-gate-1',
      conditionLabel: 'true',
    },
    {
      id: 'e4',
      source: 'cond-risk',
      target: 'agent-summary',
      conditionLabel: 'false',
    },
    { id: 'e5', source: 'approval-gate-1', target: 'agent-summary' },
    { id: 'e6', source: 'agent-summary', target: 'end-1' },
  ],
};

/**
 * Ticket SEED-001: Deterministic Flagship Workspace Seed & Verification Runner.
 * Provisions two isolated organizations, 4 RBAC roles, grounded RAG chunks,
 * immutable Agent v1/v2 snapshots, a 6-node HITL workflow run (pause + admin resume),
 * v1-vs-v2 evaluation regression experiments, and SSE cursor replay verification.
 */
export async function seedFlagshipWorkspace(
  db: AegisDatabase
): Promise<FlagshipSeedReport> {
  // 1. Provision Users & Two Isolated Organizations (Acme Cyber Defense & Beta Logistics)
  const acmeOwner = await ensureUser(db, {
    authSubject: 'seed_acme_owner',
    email: 'owner@acme-cyber.example',
    displayName: 'Elena Vance (Acme Owner)',
  });
  const acmeAdmin = await ensureUser(db, {
    authSubject: 'seed_acme_admin',
    email: 'admin@acme-cyber.example',
    displayName: 'Marcus Sterling (Acme Admin)',
  });
  const acmeDeveloper = await ensureUser(db, {
    authSubject: 'seed_acme_dev',
    email: 'dev@acme-cyber.example',
    displayName: 'Priya Nair (Acme Developer)',
  });
  const acmeViewer = await ensureUser(db, {
    authSubject: 'seed_acme_viewer',
    email: 'viewer@acme-cyber.example',
    displayName: 'Lucas Meyer (Acme Auditor)',
  });

  const betaOwner = await ensureUser(db, {
    authSubject: 'seed_beta_owner',
    email: 'owner@beta-logistics.example',
    displayName: 'Sora Takahashi (Beta Owner)',
  });

  const { organization: acmeOrg } = await createOrganizationWithOwner(db, {
    name: 'Acme Cyber Defense',
    slug: 'acme-cyber-defense',
    creatorUserId: acmeOwner.id,
  });

  const { organization: betaOrg } = await createOrganizationWithOwner(db, {
    name: 'Beta Logistics',
    slug: 'beta-logistics',
    creatorUserId: betaOwner.id,
  });

  const acmeOwnerActor: AuthenticatedActor = {
    userId: acmeOwner.id,
    organizationId: acmeOrg.id,
    role: 'owner',
  };

  await upsertMembership(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    targetUserId: acmeAdmin.id,
    role: 'admin',
  });
  await upsertMembership(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    targetUserId: acmeDeveloper.id,
    role: 'developer',
  });
  await upsertMembership(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    targetUserId: acmeViewer.id,
    role: 'viewer',
  });

  const acmeAdminActor: AuthenticatedActor = {
    userId: acmeAdmin.id,
    organizationId: acmeOrg.id,
    role: 'admin',
  };

  // 2. Ingest Tenant-Scoped Knowledge Document for Hybrid FTS + Vector RAG
  const ingestedDoc = await ingestKnowledgeDocument(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    title: 'Incident Escalation & FinOps Policy Runbook',
    sourceFilename: 'incident-finops-runbook.md',
    mimeType: 'text/markdown',
    content: [
      '# Severity 1 Production Incident Escalation',
      'Severity 1 production incidents require notifying the On-Call Commander within 15 minutes and opening bridge channel #sev1-incident.',
      '',
      '## Database Encryption & Key Rotation Standard',
      'All tenant PostgreSQL backups are encrypted at rest with AES-256-GCM and envelope keys rotated every 90 days.',
    ].join('\n'),
  });

  // 3. Create Agent Draft, Publish Immutable v1 (Full Tools) and v2 (Regression Candidate without calculator)
  const copilotDraft = await createAgentDraft(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    name: 'SRE & FinOps Reliability Copilot',
    slug: 'sre-finops-copilot',
    description:
      'Executes deterministic error-budget arithmetic and grounded incident runbook retrieval.',
    draftSystemPrompt:
      'You are the Acme SRE & FinOps Reliability Copilot. Use calculator for arithmetic and knowledge_search for runbook policies.',
    draftToolAllowlist: ['calculator', 'knowledge_search'],
  });

  const { version: agentV1 } = await publishAgentVersion(
    db,
    acmeOwnerActor,
    acmeOrg.id,
    copilotDraft.id
  );

  // Update mutable draft to drop 'calculator' and publish v2 to demonstrate regression detection
  await updateAgentDraft(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    agentId: copilotDraft.id,
    draftToolAllowlist: ['knowledge_search'],
  });

  const { version: agentV2 } = await publishAgentVersion(
    db,
    acmeOwnerActor,
    acmeOrg.id,
    copilotDraft.id
  );

  // Restore draft allowlist to ['calculator', 'knowledge_search'] for future draft edits
  await updateAgentDraft(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    agentId: copilotDraft.id,
    draftToolAllowlist: ['calculator', 'knowledge_search'],
  });

  // 4. Create & Publish Directed Acyclic Workflow with HITL Approval Gate
  const workflowDraft = await createWorkflowDraft(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    slug: 'prod-release-risk-gate',
    name: 'Production Release & Risk Gate',
    description:
      'Computes deployment risk score via calculator, pauses at human approval when score > 100, and summarizes rollout.',
    graph: FLAGSHIP_HITL_WORKFLOW_GRAPH,
  });

  const { version: workflowV1 } = await publishWorkflowVersion(
    db,
    acmeOwnerActor,
    {
      organizationId: acmeOrg.id,
      workflowId: workflowDraft.id,
    }
  );

  const startedWf = await startWorkflowRun(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    workflowVersionId: workflowV1.id,
    defaultAgentVersionId: agentV1.id,
    inputPrompt: 'Deploy v3.2.0 to production cluster us-east-1',
  });

  const initialWorkflowStatus = startedWf.run.status;
  const approvalRequestId = startedWf.pendingApproval!.id;

  const decidedWf = await decideApprovalRequest(db, acmeAdminActor, {
    approvalRequestId,
    decision: 'approved',
    note: 'Canary error budget verified by Marcus Sterling; approved for production rollout.',
  });

  // 5. Create Evaluation Suite & Compare Baseline (Agent v1) vs Candidate (Agent v2)
  const { suite } = await createEvalSuite(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    agentId: copilotDraft.id,
    name: 'SRE & FinOps Release Readiness Benchmark',
    description:
      'Verifies deterministic arithmetic via calculator and grounded incident runbook citations via knowledge_search.',
    cases: [
      {
        name: 'Error Budget Burn Calculation',
        inputPrompt: 'Calculate 12 * 12 using calculator',
        assertions: [
          { type: 'tool_called', toolName: 'calculator' },
          { type: 'contains', expectedSubstring: '144' },
        ],
      },
      {
        name: 'SEV-1 Runbook Citation Grounding',
        inputPrompt:
          'Search knowledge base for Severity 1 production incidents escalation policy',
        assertions: [
          { type: 'tool_called', toolName: 'knowledge_search' },
          {
            type: 'citation_required',
            minCitations: 1,
            documentId: ingestedDoc.document.id,
          },
          {
            type: 'contains',
            expectedSubstring: 'On-Call Commander',
            ignoreCase: true,
          },
        ],
      },
    ],
  });

  const baselineExp = await runEvalExperiment(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    suiteId: suite.id,
    agentVersionId: agentV1.id,
  });

  const candidateExp = await runEvalExperiment(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    suiteId: suite.id,
    agentVersionId: agentV2.id,
  });

  const comparison = await compareEvalExperiments(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    baselineExperimentId: baselineExp.experiment.id,
    candidateExperimentId: candidateExp.experiment.id,
  });

  const sampleEvalRunId = baselineExp.caseResults[0]!.resultRow.runId!;

  // 6. Verify SSE Replay Stream (Full vs Reconnect with Last-Event-ID: 2)
  const fullSse = await createRunEventsSseResponse(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    runId: sampleEvalRunId,
  });
  const reconnectSse = await createRunEventsSseResponse(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    runId: sampleEvalRunId,
    lastEventIdHeader: '2',
  });

  const fullEventsCount = Number(
    fullSse.headers.get('x-replayed-events-count') ?? '0'
  );
  const replayedAfterCursor2Count = Number(
    reconnectSse.headers.get('x-replayed-events-count') ?? '0'
  );

  // 7. Collect Governance Audit Trail & Usage Summary
  const auditEvents = await listAuditEvents(db, acmeOwnerActor);
  const usageSummary = await getOrganizationUsageSummary(db, acmeOwnerActor);

  return {
    tenants: {
      acme: {
        organizationId: acmeOrg.id,
        slug: acmeOrg.slug,
        ownerUserId: acmeOwner.id,
        adminUserId: acmeAdmin.id,
        developerUserId: acmeDeveloper.id,
        viewerUserId: acmeViewer.id,
      },
      beta: {
        organizationId: betaOrg.id,
        slug: betaOrg.slug,
        ownerUserId: betaOwner.id,
      },
    },
    knowledge: {
      documentId: ingestedDoc.document.id,
      title: ingestedDoc.document.title,
      chunkCount: ingestedDoc.document.chunkCount,
      storageKey: ingestedDoc.document.storageKey,
    },
    agents: {
      agentId: copilotDraft.id,
      slug: copilotDraft.slug,
      v1VersionId: agentV1.id,
      v1SnapshotHash: agentV1.snapshotHash,
      v2VersionId: agentV2.id,
      v2SnapshotHash: agentV2.snapshotHash,
    },
    workflow: {
      workflowId: workflowDraft.id,
      workflowVersionId: workflowV1.id,
      snapshotHash: workflowV1.snapshotHash,
      runId: decidedWf.run.id,
      approvalRequestId,
      initialStatus: initialWorkflowStatus,
      finalStatus: decidedWf.run.status,
      approvedByUserId: decidedWf.approval.decidedByUserId!,
    },
    evaluation: {
      suiteId: suite.id,
      baselineExperimentId: baselineExp.experiment.id,
      baselinePassRate: baselineExp.experiment.passRate,
      candidateExperimentId: candidateExp.experiment.id,
      candidatePassRate: candidateExp.experiment.passRate,
      passRateDelta: comparison.passRateDelta,
      regressedCasesCount: comparison.regressedCasesCount,
      sampleEvalRunId,
    },
    sseReplay: {
      fullEventsCount,
      replayedAfterCursor2Count,
    },
    governance: {
      auditEventsCount: auditEvents.length,
      mockRunsCount: usageSummary.mock.runsCount,
      mockTotalTokens: usageSummary.mock.totalTokens,
    },
  };
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  (async () => {
    const ctx = await createDatabaseClient();
    try {
      const report = await seedFlagshipWorkspace(ctx.db);
      console.log(
        JSON.stringify(
          {
            status: 'seeded',
            mode: 'AI_MODE=demo',
            report,
          },
          null,
          2
        )
      );
    } finally {
      await ctx.close();
    }
  })();
}
