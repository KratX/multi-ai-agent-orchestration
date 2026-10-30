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

export const BETA_LOGISTICS_HITL_WORKFLOW_GRAPH: WorkflowGraphSpec = {
  nodes: [
    { id: 'start-1', kind: 'start', label: 'Start Trigger' },
    {
      id: 'calc-risk',
      kind: 'tool',
      label: 'Compute Excursion Tariff Exposure',
      toolName: 'calculator',
      toolInput: { expression: '45 * 4' },
    },
    {
      id: 'cond-risk',
      kind: 'condition',
      label: 'Exposure Score > 100?',
      condition: { field: 'lastOutput', operator: 'gt', value: 100 },
    },
    {
      id: 'approval-gate-1',
      kind: 'approval',
      label: 'Priority Air-Freight Charter Gate',
      approvalTitle: 'Authorize Priority Cold-Chain Air-Freight Reroute',
      approvalReason:
        'Calculated cold-chain excursion exposure score (180) exceeds automated charter threshold (100).',
      allowDeveloperDecision: false,
    },
    {
      id: 'agent-summary',
      kind: 'agent',
      label: 'Customs & Charter Dispatch Summarizer',
      promptTemplate:
        'Summarize cold-chain biologics charter dispatch and customs clearance instructions.',
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
 * Ticket SEED-001: Ordaris (v1.0.0-demo) Deterministic Flagship Workspace Seed & Verification Runner.
 * Provisions two isolated organizations (`Acme Cyber Defense` & `Beta Logistics`),
 * all 8 RBAC personas (4 roles per tenant), grounded RAG playbooks, immutable Agent v1/v2 snapshots,
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
    displayName: 'Lucas Meyer (Acme Auditor)',
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
    displayName: 'Omar Farooq (Beta Auditor)',
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
  // TENANT 1: ACME CYBER DEFENSE — KNOWLEDGE, AGENTS, WORKFLOWS, EVALS
  // ==========================================================================

  // 2A. Ingest Tenant-Scoped Knowledge Documents for Acme Cyber Defense
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

  const acmeSecondaryDoc = await ingestKnowledgeDocument(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    title: 'Zero-Trust IAM, SOC2 Audit & Secret Hygiene Playbook',
    sourceFilename: 'zero-trust-iam-soc2-playbook.md',
    mimeType: 'text/markdown',
    content: [
      '# Zero-Trust Identity & Access Governance',
      'Every API request in Ordaris enforces server-verified RBAC across 23 granular permissions for Owner, Admin, Developer, and Viewer personas.',
      '',
      '## PII & Secret Scrubbing Standard',
      'All outbound model prompts automatically redact sensitive credentials ([REDACTED:SECRET_KEY]) and personal identifiers ([REDACTED:PII_SSN]) prior to provider dispatch.',
      '',
      '## Untrusted RAG Context Isolation',
      'Retrieved knowledge chunks are wrapped in <untrusted_knowledge_context> delimiters and verified against server provenance before citations are attached.',
    ].join('\n'),
  });

  // 3A. Create Acme Primary Agent (v1 Full Tools, v2 Regression Candidate) + Secondary Agent
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

  const acmeAuditorAgent = await createAgentDraft(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    name: 'Zero-Trust IAM & SOC2 Compliance Auditor',
    slug: 'zero-trust-soc2-auditor',
    description:
      'Audits zero-trust RBAC policies, encryption standards, and SOC2 compliance controls.',
    draftSystemPrompt:
      'You are the Acme Zero-Trust IAM & SOC2 Compliance Auditor. Use knowledge_search to verify encryption and RBAC policies and calculator to compute compliance SLA metrics.',
    draftToolAllowlist: ['calculator', 'knowledge_search'],
  });

  await publishAgentVersion(db, acmeOwnerActor, acmeOrg.id, acmeAuditorAgent.id);

  // 4A. Create & Publish Directed Acyclic Workflow with HITL Approval Gate for Acme
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

  // Start a second workflow run that remains in `waiting_approval` for live interactive HITL demo
  const activePendingWf = await startWorkflowRun(db, acmeOwnerActor, {
    organizationId: acmeOrg.id,
    workflowVersionId: workflowV1.id,
    defaultAgentVersionId: agentV1.id,
    inputPrompt:
      'Deploy v3.3.0-rc1 zero-trust edge proxy to production cluster eu-central-1',
  });

  // 5A. Create Evaluation Suite & Compare Baseline (Agent v1) vs Candidate (Agent v2)
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

  // ==========================================================================
  // TENANT 2: BETA LOGISTICS — FULL MULTI-TENANT SYMMETRY SEED
  // (Carefully avoids tokens in 'Severity 1 On-Call Commander AES-256-GCM')
  // ==========================================================================

  // 2B. Ingest 2 Cold-Chain & Customs Playbooks for Beta Logistics
  const betaPrimaryDoc = await ingestKnowledgeDocument(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    title: 'Cold-Chain Biologics Excursion & Quarantine Playbook',
    sourceFilename: 'cold-chain-biologics-playbook.md',
    mimeType: 'text/markdown',
    content: [
      '# Biologics Cold-Chain Thermal Excursion Procedure',
      'Refrigerated pharmaceutical pallets must remain between two degrees and eight degrees Celsius throughout transit across maritime and air hubs.',
      '',
      '## Quarantine Hold & Quality Inspection Protocol',
      'If glycol probe telemetry exceeds eight degrees Celsius for more than thirty minutes, place the freight lot under quarantine hold and notify the Lead Quality Pharmacist immediately.',
    ].join('\n'),
  });

  const betaSecondaryDoc = await ingestKnowledgeDocument(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    title: 'Cross-Border Customs Tariff & Maritime Manifest Guide',
    sourceFilename: 'customs-tariff-manifest-guide.md',
    mimeType: 'text/markdown',
    content: [
      '# Harmonized Customs Clearance & Bonded Warehouse Rules',
      'International biologics manifests require verified certificate-of-origin declarations and harmonized tariff schedule codes before port release.',
      '',
      '## Priority Air-Freight Charter Escalation',
      'When port demurrage or customs delay threatens cold-chain stability, dispatchers may request priority air-freight charter routing via Frankfurt or Singapore hubs.',
    ].join('\n'),
  });

  // 3B. Create 2 Domain Agents for Beta Logistics (with v1 and v2 snapshots)
  const betaCopilotDraft = await createAgentDraft(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    name: 'Cold-Chain Freight & Customs Copilot',
    slug: 'cold-chain-customs-copilot',
    description:
      'Computes cold-chain tariff duties and retrieves biologics quarantine and customs clearance playbooks.',
    draftSystemPrompt:
      'You are the Beta Logistics Cold-Chain Freight & Customs Copilot. Use calculator for tariff/demurrage math and knowledge_search for cold-chain and customs playbooks.',
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
    name: 'Global Supply-Chain FinOps & Route Optimizer',
    slug: 'supply-chain-route-optimizer',
    description:
      'Analyzes air-freight charter surcharges, port demurrage penalties, and bonded warehouse routing.',
    draftSystemPrompt:
      'You are the Beta Logistics Global Supply-Chain Route Optimizer. Use calculator for freight cost modeling and knowledge_search for manifest procedures.',
    draftToolAllowlist: ['calculator', 'knowledge_search'],
  });

  await publishAgentVersion(
    db,
    betaOwnerActor,
    betaOrg.id,
    betaRouteOptimizer.id
  );

  // 4B. Create & Publish Beta Logistics DAG Workflow with Active Pending HITL Approval Gate
  const betaWorkflowDraft = await createWorkflowDraft(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    slug: 'cold-chain-air-charter-gate',
    name: 'Cold-Chain Air-Freight Charter & Customs Gate',
    description:
      'Computes cold-chain excursion tariff exposure via calculator, pauses for human approval when score > 100, and dispatches charter instructions.',
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
      'Reroute Biologics Lot BL-904 via priority air-freight hub Frankfurt due to port customs delay',
  });

  // 5B. Create & Run Evaluation Suite for Beta Logistics (v1 100% vs v2 50%)
  const { suite: betaSuite } = await createEvalSuite(db, betaOwnerActor, {
    organizationId: betaOrg.id,
    agentId: betaCopilotDraft.id,
    name: 'Cold-Chain Excursion & Tariff Compliance Benchmark',
    description:
      'Verifies deterministic customs tariff arithmetic via calculator and grounded cold-chain playbook citations via knowledge_search.',
    cases: [
      {
        name: 'Customs Tariff & Reefer Surcharge Calculation',
        inputPrompt: 'Calculate (45 * 4) + 20 for the cold-chain customs surcharge',
        assertions: [
          { type: 'tool_called', toolName: 'calculator' },
          { type: 'contains', expectedSubstring: '200' },
        ],
      },
      {
        name: 'Cold-Chain Quarantine Playbook Citation Grounding',
        inputPrompt:
          'Search knowledge playbook for cold-chain quarantine hold and glycol probe temperature excursion procedure',
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
