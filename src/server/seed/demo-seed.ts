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
      adminUserId: string;
      developerUserId: string;
      viewerUserId: string;
    };
  };
  knowledge: {
    documentId: string;
    title: string;
    chunkCount: number;
    storageKey: string;
    secondaryDocumentId?: string;
  };
  agents: {
    agentId: string;
    slug: string;
    v1VersionId: string;
    v1SnapshotHash: string;
    v2VersionId: string;
    v2SnapshotHash: string;
    secondaryAgentId?: string;
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
    activePendingRunId?: string;
    activePendingApprovalId?: string;
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
  betaSummary?: {
    primaryDocumentId: string;
    secondaryDocumentId: string;
    primaryAgentId: string;
    secondaryAgentId: string;
    workflowId: string;
    pendingWorkflowRunId: string;
    pendingApprovalRequestId: string;
    evalSuiteId: string;
    baselinePassRate: number;
    candidatePassRate: number;
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
    { id: 'start-1', kind: 'start', label: 'Start Request' },
    {
      id: 'calc-risk',
      kind: 'tool',
      label: 'Calculate Risk Score (50 * 3)',
      toolName: 'calculator',
      toolInput: { expression: '50 * 3' },
    },
    {
      id: 'cond-risk',
      kind: 'condition',
      label: 'Is Score > 100?',
      condition: { field: 'lastOutput', operator: 'gt', value: 100 },
    },
    {
      id: 'approval-gate-1',
      kind: 'approval',
      label: 'Manager Approval Step',
      approvalTitle: 'Approve $1,500 Server Upgrade Request',
      approvalReason:
        'Risk score is 150 (above the 100 limit). Waiting for an Owner or Admin to approve.',
      allowDeveloperDecision: false,
    },
    {
      id: 'agent-summary',
      kind: 'agent',
      label: 'Write Short Summary',
      promptTemplate: 'Write a short summary confirming the approved request is ready.',
    },
    { id: 'end-1', kind: 'end', label: 'Done' },
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

export const BETA_LOGISTICS_HITL_WORKFLOW_GRAPH: WorkflowGraphSpec = {
  nodes: [
    { id: 'start-1', kind: 'start', label: 'Start Request' },
    {
      id: 'calc-risk',
      kind: 'tool',
      label: 'Calculate Shipping Cost Score (45 * 4)',
      toolName: 'calculator',
      toolInput: { expression: '45 * 4' },
    },
    {
      id: 'cond-risk',
      kind: 'condition',
      label: 'Is Score > 100?',
      condition: { field: 'lastOutput', operator: 'gt', value: 100 },
    },
    {
      id: 'approval-gate-1',
      kind: 'approval',
      label: 'Manager Approval Step',
      approvalTitle: 'Approve Express Air Shipping Reroute',
      approvalReason:
        'Shipping cost score is 180 (above the 100 limit). Waiting for an Owner or Admin to approve.',
      allowDeveloperDecision: false,
    },
    {
      id: 'agent-summary',
      kind: 'agent',
      label: 'Write Shipping Summary',
      promptTemplate:
        'Write a short summary confirming the express air shipping request.',
    },
    { id: 'end-1', kind: 'end', label: 'Done' },
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
 * Ticket SEED-001: Ordaris (v1.0.0-demo) Deterministic Flagship Workspace Seed & Verification Runner.
 * Provisions two isolated organizations (`Acme Cyber Defense` & `Beta Logistics`),
 * all 8 RBAC personas (4 roles per tenant), simple plain-English RAG guides, immutable Agent v1/v2 snapshots,
 * 6-node HITL workflows (with both completed and active pending approval gates),
 * v1-vs-v2 evaluation regression experiments, and SSE cursor replay verification.
 */
export async function seedFlagshipWorkspace(
  db: AegisDatabase
): Promise<FlagshipSeedReport> {
  // 1. Provision All 8 RBAC Personas Across Two Isolated Organizations
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
    displayName: 'Lucas Meyer (Acme Viewer)',
  });

  const betaOwner = await ensureUser(db, {
    authSubject: 'seed_beta_owner',
    email: 'owner@beta-logistics.example',
    displayName: 'Sora Takahashi (Beta Owner)',
  });
  const betaAdmin = await ensureUser(db, {
    authSubject: 'seed_beta_admin',
    email: 'admin@beta-logistics.example',
    displayName: 'Mateo Silva (Beta Admin)',
  });
  const betaDeveloper = await ensureUser(db, {
    authSubject: 'seed_beta_dev',
    email: 'dev@beta-logistics.example',
    displayName: 'Hannah Abbott (Beta Developer)',
  });
  const betaViewer = await ensureUser(db, {
    authSubject: 'seed_beta_viewer',
    email: 'viewer@beta-logistics.example',
    displayName: 'Omar Farooq (Beta Viewer)',
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

  const betaOwnerActor: AuthenticatedActor = {
    userId: betaOwner.id,
    organizationId: betaOrg.id,
    role: 'owner',
  };

  await upsertMembership(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    targetUserId: betaAdmin.id,
    role: 'admin',
  });
  await upsertMembership(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    targetUserId: betaDeveloper.id,
    role: 'developer',
  });
  await upsertMembership(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    targetUserId: betaViewer.id,
    role: 'viewer',
  });

  const acmeAdminActor: AuthenticatedActor = {
    userId: acmeAdmin.id,
    organizationId: acmeOrg.id,
    role: 'admin',
  };

  // ==========================================================================
  // TENANT 1: ACME CYBER DEFENSE — SIMPLE, EASY-TO-READ MOCK DATA
  // ==========================================================================

  // 2A. Ingest Simple Plain-English Knowledge Documents for Acme
  const ingestedDoc = await ingestKnowledgeDocument(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    title: 'Company Support & Security Guide',
    sourceFilename: 'company-support-guide.md',
    mimeType: 'text/markdown',
    content: [
      '# Urgent Incident Response (Severity 1)',
      'For any Severity 1 production incidents, notify the On-Call Commander within 15 minutes in #urgent-help.',
      '',
      '## Data Backup & Security Rule',
      'All customer backups are encrypted with AES-256-GCM and keys are rotated every 90 days.',
    ].join('\n'),
  });

  const acmeSecondaryDoc = await ingestKnowledgeDocument(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    title: 'Team Roles & Privacy Rules',
    sourceFilename: 'team-roles-privacy.md',
    mimeType: 'text/markdown',
    content: [
      '# Team Access Roles',
      'Owners and Admins can approve high-risk actions, Developers can run AI agents, and Viewers have read-only access.',
      '',
      '## Private Data Protection',
      'Secret API keys and SSNs are automatically hidden before any message is sent to an AI model.',
    ].join('\n'),
  });

  // 3A. Create Simple, Relatable Acme Agents (v1 Full Tools, v2 Regression Candidate)
  const copilotDraft = await createAgentDraft(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    name: 'Support & Math Assistant',
    slug: 'support-math-assistant',
    description:
      'Answers company policy questions and solves math problems using the calculator.',
    draftSystemPrompt:
      'You are a friendly company assistant. Use calculator for math questions and knowledge_search to look up company rules.',
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

  const acmeAuditorAgent = await createAgentDraft(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    name: 'Team Roles & Privacy Helper',
    slug: 'team-privacy-helper',
    description:
      'Explains team access roles (Owner, Admin, Developer, Viewer) and data privacy rules.',
    draftSystemPrompt:
      'You explain team roles and privacy policies in simple English using knowledge_search and calculator.',
    draftToolAllowlist: ['calculator', 'knowledge_search'],
  });

  await publishAgentVersion(db, acmeOwnerActor, acmeOrg.id, acmeAuditorAgent.id);

  // 4A. Create & Publish Simple Approval Workflow for Acme
  const workflowDraft = await createWorkflowDraft(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    slug: 'high-value-approval-workflow',
    name: 'High-Value Action Approval Workflow',
    description:
      'Calculates a risk score. If the score is over 100, it pauses and waits for an Admin or Owner to approve.',
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
    inputPrompt: 'Approve software update v3.2 for main server',
  });

  const initialWorkflowStatus = startedWf.run.status;
  const approvalRequestId = startedWf.pendingApproval!.id;

  const decidedWf = await decideApprovalRequest(db, acmeAdminActor, {
    approvalRequestId,
    decision: 'approved',
    note: 'Approved by Marcus Sterling (Admin) — everything looks good.',
  });

  // Start a second workflow run that remains in `waiting_approval` for live interactive HITL demo
  const activePendingWf = await startWorkflowRun(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    workflowVersionId: workflowV1.id,
    defaultAgentVersionId: agentV1.id,
    inputPrompt: 'Approve $1,500 server upgrade for US-East support team',
  });

  // 5A. Create Simple Evaluation Suite & Compare Baseline (Agent v1) vs Candidate (Agent v2)
  const { suite } = await createEvalSuite(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    agentId: copilotDraft.id,
    name: 'Basic Math & Policy Accuracy Check',
    description:
      'Checks that our assistant can solve simple math (12 * 12 = 144) and find our 15-minute urgent incident rule.',
    cases: [
      {
        name: 'Error Budget Burn Calculation',
        inputPrompt: 'What is 12 * 12? Use the calculator.',
        assertions: [
          { type: 'tool_called', toolName: 'calculator' },
          { type: 'contains', expectedSubstring: '144' },
        ],
      },
      {
        name: 'SEV-1 Runbook Citation Grounding',
        inputPrompt:
          'What is our policy for Severity 1 production incidents and who do we notify?',
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

  // ==========================================================================
  // TENANT 2: BETA LOGISTICS — SIMPLE, EASY-TO-READ SHIPPING MOCK DATA
  // (Carefully avoids tokens in 'Severity 1 On-Call Commander AES-256-GCM')
  // ==========================================================================

  // 2B. Ingest 2 Simple Shipping Guides for Beta Logistics
  const betaPrimaryDoc = await ingestKnowledgeDocument(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    title: 'Cold Storage Shipping Rules',
    sourceFilename: 'cold-storage-rules.md',
    mimeType: 'text/markdown',
    content: [
      '# Cold Storage Temperature Rule',
      'Chilled medical boxes must stay between two degrees and eight degrees Celsius during transit.',
      '',
      '## Warm Box Quarantine Step',
      'If a cold-chain box gets warmer than eight degrees Celsius for more than thirty minutes, place it on quarantine hold and notify the Lead Quality Pharmacist right away.',
    ].join('\n'),
  });

  const betaSecondaryDoc = await ingestKnowledgeDocument(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    title: 'Customs & Express Shipping Guide',
    sourceFilename: 'customs-shipping-guide.md',
    mimeType: 'text/markdown',
    content: [
      '# Customs Paperwork Rule',
      'International shipments need a signed certificate of origin and tariff code before leaving the port.',
      '',
      '## Express Air Reroute',
      'When port delays threaten chilled goods, dispatchers can book priority air-freight shipping through Frankfurt.',
    ].join('\n'),
  });

  // 3B. Create 2 Simple Shipping Agents for Beta Logistics (with v1 and v2 snapshots)
  const betaCopilotDraft = await createAgentDraft(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    name: 'Shipping & Customs Assistant',
    slug: 'shipping-customs-assistant',
    description:
      'Calculates shipping costs and answers cold storage and customs rules.',
    draftSystemPrompt:
      'You are a helpful shipping assistant. Use calculator for shipping math and knowledge_search for cold storage and customs guides.',
    draftToolAllowlist: ['calculator', 'knowledge_search'],
  });

  const { version: betaAgentV1 } = await publishAgentVersion(
    db,
    betaOwnerActor,
    betaOrg.id,
    betaCopilotDraft.id
  );

  await updateAgentDraft(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    agentId: betaCopilotDraft.id,
    draftToolAllowlist: ['knowledge_search'],
  });

  const { version: betaAgentV2 } = await publishAgentVersion(
    db,
    betaOwnerActor,
    betaOrg.id,
    betaCopilotDraft.id
  );

  await updateAgentDraft(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    agentId: betaCopilotDraft.id,
    draftToolAllowlist: ['calculator', 'knowledge_search'],
  });

  const betaRouteOptimizer = await createAgentDraft(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    name: 'Delivery Route Cost Helper',
    slug: 'delivery-route-helper',
    description:
      'Helps compare delivery routes and shipping fees.',
    draftSystemPrompt:
      'You help calculate shipping fees using calculator and check customs guides using knowledge_search.',
    draftToolAllowlist: ['calculator', 'knowledge_search'],
  });

  await publishAgentVersion(
    db,
    betaOwnerActor,
    betaOrg.id,
    betaRouteOptimizer.id
  );

  // 4B. Create & Publish Beta Logistics Workflow with Active Pending Approval Gate
  const betaWorkflowDraft = await createWorkflowDraft(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    slug: 'express-shipping-approval',
    name: 'Express Air Shipping Approval Workflow',
    description:
      'Calculates shipping cost score. If score is over 100, pauses for Manager approval before booking express air freight.',
    graph: BETA_LOGISTICS_HITL_WORKFLOW_GRAPH,
  });

  const { version: betaWorkflowV1 } = await publishWorkflowVersion(
    db,
    betaOwnerActor,
    {
      organizationId: betaOrg.id,
      workflowId: betaWorkflowDraft.id,
    }
  );

  const betaPendingWf = await startWorkflowRun(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    workflowVersionId: betaWorkflowV1.id,
    defaultAgentVersionId: betaAgentV1.id,
    inputPrompt:
      'Approve express air shipping for Chilled Box Lot BL-904 due to port delay',
  });

  // 5B. Create & Run Simple Evaluation Suite for Beta Logistics (v1 100% vs v2 50%)
  const { suite: betaSuite } = await createEvalSuite(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    agentId: betaCopilotDraft.id,
    name: 'Shipping Math & Rules Check',
    description:
      'Checks that our shipping assistant can calculate fees ((45 * 4) + 20 = 200) and find the cold storage quarantine rule.',
    cases: [
      {
        name: 'Shipping Fee Calculation',
        inputPrompt: 'What is (45 * 4) + 20 for the shipping fee?',
        assertions: [
          { type: 'tool_called', toolName: 'calculator' },
          { type: 'contains', expectedSubstring: '200' },
        ],
      },
      {
        name: 'Cold Storage Quarantine Rule Check',
        inputPrompt:
          'What is our cold-chain quarantine hold rule when a box gets too warm?',
        assertions: [
          { type: 'tool_called', toolName: 'knowledge_search' },
          {
            type: 'citation_required',
            minCitations: 1,
            documentId: betaPrimaryDoc.document.id,
          },
          {
            type: 'contains',
            expectedSubstring: 'Lead Quality Pharmacist',
            ignoreCase: true,
          },
        ],
      },
    ],
  });

  const betaBaselineExp = await runEvalExperiment(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    suiteId: betaSuite.id,
    agentVersionId: betaAgentV1.id,
  });

  const betaCandidateExp = await runEvalExperiment(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    suiteId: betaSuite.id,
    agentVersionId: betaAgentV2.id,
  });

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
        adminUserId: betaAdmin.id,
        developerUserId: betaDeveloper.id,
        viewerUserId: betaViewer.id,
      },
    },
    knowledge: {
      documentId: ingestedDoc.document.id,
      title: ingestedDoc.document.title,
      chunkCount: ingestedDoc.document.chunkCount,
      storageKey: ingestedDoc.document.storageKey,
      secondaryDocumentId: acmeSecondaryDoc.document.id,
    },
    agents: {
      agentId: copilotDraft.id,
      slug: copilotDraft.slug,
      v1VersionId: agentV1.id,
      v1SnapshotHash: agentV1.snapshotHash,
      v2VersionId: agentV2.id,
      v2SnapshotHash: agentV2.snapshotHash,
      secondaryAgentId: acmeAuditorAgent.id,
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
      activePendingRunId: activePendingWf.run.id,
      activePendingApprovalId: activePendingWf.pendingApproval?.id,
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
    betaSummary: {
      primaryDocumentId: betaPrimaryDoc.document.id,
      secondaryDocumentId: betaSecondaryDoc.document.id,
      primaryAgentId: betaCopilotDraft.id,
      secondaryAgentId: betaRouteOptimizer.id,
      workflowId: betaWorkflowDraft.id,
      pendingWorkflowRunId: betaPendingWf.run.id,
      pendingApprovalRequestId: betaPendingWf.pendingApproval!.id,
      evalSuiteId: betaSuite.id,
      baselinePassRate: betaBaselineExp.experiment.passRate,
      candidatePassRate: betaCandidateExp.experiment.passRate,
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
