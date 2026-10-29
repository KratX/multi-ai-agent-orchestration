import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabaseClient } from '../../src/server/db/client';
import {
  createAgentDraft,
  publishAgentVersion,
} from '../../src/server/db/repositories/agent-repository';
import {
  createOrganizationWithOwner,
  ensureUser,
  upsertMembership,
} from '../../src/server/db/repositories/tenant-repository';
import type { WorkflowGraphSpec } from '../../src/server/db/schema/workflows';
import {
  createWorkflowDraft,
  decideApprovalRequest,
  getOrganizationUsageSummary,
  listAuditEvents,
  publishWorkflowVersion,
  recordUsageEvent,
  startWorkflowRun,
  updateWorkflowDraft,
} from '../../src/server/modules/workflows/workflow-engine';
import {
  AuthorizationError,
  type AuthenticatedActor,
} from '../../src/server/policies/authorization';

const SAMPLE_HITL_GRAPH: WorkflowGraphSpec = {
  nodes: [
    { id: 'start-1', kind: 'start', label: 'Start' },
    {
      id: 'calc-risk',
      kind: 'tool',
      label: 'Compute Risk Score',
      toolName: 'calculator',
      toolInput: { expression: '50 * 3' },
    },
    {
      id: 'cond-1',
      kind: 'condition',
      label: 'Score > 100?',
      condition: { field: 'lastOutput', operator: 'gt', value: 100 },
    },
    {
      id: 'approval-gate-1',
      kind: 'approval',
      label: 'Production Release Gate',
      approvalTitle: 'Approve High-Impact Deployment',
      approvalReason: 'Calculated risk score 150 exceeds threshold 100.',
      allowDeveloperDecision: false,
    },
    {
      id: 'agent-final',
      kind: 'agent',
      label: 'Release Notes Summarizer',
      promptTemplate: 'Summarize approved deployment status',
    },
    { id: 'end-1', kind: 'end', label: 'End' },
  ],
  edges: [
    { id: 'e1', source: 'start-1', target: 'calc-risk' },
    { id: 'e2', source: 'calc-risk', target: 'cond-1' },
    {
      id: 'e3',
      source: 'cond-1',
      target: 'approval-gate-1',
      conditionLabel: 'true',
    },
    {
      id: 'e4',
      source: 'cond-1',
      target: 'agent-final',
      conditionLabel: 'false',
    },
    { id: 'e5', source: 'approval-gate-1', target: 'agent-final' },
    { id: 'e6', source: 'agent-final', target: 'end-1' },
  ],
};

test('WORKFLOW-001: publishing workflow creates immutable workflow_versions snapshots unaffected by draft edits', async () => {
  const ctx = await createDatabaseClient();
  try {
    const ownerUser = await ensureUser(ctx.db, {
      authSubject: 'sub_wf_owner_1',
      email: 'wf-owner@acme.example',
      displayName: 'Workflow Owner',
    });
    const { organization } = await createOrganizationWithOwner(ctx.db, {
      name: 'Acme Workflows',
      slug: 'acme-workflows',
      creatorUserId: ownerUser.id,
    });

    const ownerActor: AuthenticatedActor = {
      userId: ownerUser.id,
      organizationId: organization.id,
      role: 'owner',
    };

    const draft = await createWorkflowDraft(ctx.db, ownerActor, {
      organizationId: organization.id,
      slug: 'prod-deploy-pipeline',
      name: 'Production Deploy Pipeline',
      description: 'Initial v1 workflow',
      graph: SAMPLE_HITL_GRAPH,
    });

    const { version: v1 } = await publishWorkflowVersion(ctx.db, ownerActor, {
      organizationId: organization.id,
      workflowId: draft.id,
    });
    assert.equal(v1.versionNumber, 1);
    assert.equal(v1.graphJson.nodes.length, 6);

    // Mutate the draft so calculator expression is '10 * 2'
    const modifiedGraph: WorkflowGraphSpec = structuredClone(SAMPLE_HITL_GRAPH);
    const calcNode = modifiedGraph.nodes.find((n) => n.id === 'calc-risk')!;
    calcNode.toolInput = { expression: '10 * 2' };

    await updateWorkflowDraft(ctx.db, ownerActor, {
      organizationId: organization.id,
      workflowId: draft.id,
      graph: modifiedGraph,
    });

    const { version: v2 } = await publishWorkflowVersion(ctx.db, ownerActor, {
      organizationId: organization.id,
      workflowId: draft.id,
    });

    assert.equal(v2.versionNumber, 2);
    assert.notEqual(v1.snapshotHash, v2.snapshotHash);

    // Verify v1 snapshot was never mutated
    const v1CalcNode = v1.graphJson.nodes.find((n) => n.id === 'calc-risk')!;
    assert.deepEqual(v1CalcNode.toolInput, { expression: '50 * 3' });
  } finally {
    await ctx.close();
  }
});

test('WORKFLOW-002 & HITL-001: workflow pauses at waiting_approval and resumes to succeeded upon admin approval', async () => {
  const ctx = await createDatabaseClient();
  try {
    const ownerUser = await ensureUser(ctx.db, {
      authSubject: 'sub_hitl_owner',
      email: 'hitl-owner@acme.example',
      displayName: 'HITL Owner',
    });
    const adminUser = await ensureUser(ctx.db, {
      authSubject: 'sub_hitl_admin',
      email: 'hitl-admin@acme.example',
      displayName: 'HITL Admin',
    });
    const { organization } = await createOrganizationWithOwner(ctx.db, {
      name: 'Acme HITL Org',
      slug: 'acme-hitl-org',
      creatorUserId: ownerUser.id,
    });

    const ownerActor: AuthenticatedActor = {
      userId: ownerUser.id,
      organizationId: organization.id,
      role: 'owner',
    };
    await upsertMembership(ctx.db, ownerActor, {
      organizationId: organization.id,
      targetUserId: adminUser.id,
      role: 'admin',
    });
    const adminActor: AuthenticatedActor = {
      userId: adminUser.id,
      organizationId: organization.id,
      role: 'admin',
    };

    const agentDraft = await createAgentDraft(ctx.db, ownerActor, {
      organizationId: organization.id,
      name: 'Release Agent',
      slug: 'release-agent',
      draftSystemPrompt: 'You summarize deployment approvals.',
      draftToolAllowlist: ['calculator'],
    });
    const { version: agentV1 } = await publishAgentVersion(
      ctx.db,
      ownerActor,
      organization.id,
      agentDraft.id
    );

    const wfDraft = await createWorkflowDraft(ctx.db, ownerActor, {
      organizationId: organization.id,
      slug: 'hitl-release-flow',
      name: 'HITL Release Flow',
      graph: SAMPLE_HITL_GRAPH,
    });
    const { version: wfV1 } = await publishWorkflowVersion(ctx.db, ownerActor, {
      organizationId: organization.id,
      workflowId: wfDraft.id,
    });

    // Start workflow run: should execute calculator (50 * 3 = 150), take 'true' branch (> 100), and pause at approval-gate-1
    const started = await startWorkflowRun(ctx.db, ownerActor, {
      organizationId: organization.id,
      workflowVersionId: wfV1.id,
      defaultAgentVersionId: agentV1.id,
      inputPrompt: 'Deploy v2.4.0 to production cluster',
    });

    assert.equal(started.run.status, 'waiting_approval');
    assert.ok(started.pendingApproval);
    assert.equal(started.pendingApproval.status, 'pending');
    assert.equal(started.pendingApproval.nodeId, 'approval-gate-1');
    assert.equal(
      started.pendingApproval.title,
      'Approve High-Impact Deployment'
    );

    // Admin approves the pending request -> workflow resumes through agent-final -> end-1 -> 'succeeded'
    const decided = await decideApprovalRequest(ctx.db, adminActor, {
      approvalRequestId: started.pendingApproval.id,
      decision: 'approved',
      note: 'Verified staging metrics; approved for production rollout.',
    });

    assert.equal(decided.approval.status, 'approved');
    assert.equal(decided.approval.decidedByUserId, adminUser.id);
    assert.equal(decided.run.status, 'succeeded');
    assert.ok(decided.run.finalOutput && decided.run.finalOutput.length > 0);
    assert.ok(decided.run.totalTokens > 0);
  } finally {
    await ctx.close();
  }
});

test('HITL-001 & AUDIT-001: enforces cross-tenant 404 isolation, blocks unauthorized viewer/developer approvals with denied audit logs, and cancels run on rejection', async () => {
  const ctx = await createDatabaseClient();
  try {
    const ownerA = await ensureUser(ctx.db, {
      authSubject: 'sub_sec_owner_a',
      email: 'owner-a@org-a.example',
      displayName: 'Owner A',
    });
    const devA = await ensureUser(ctx.db, {
      authSubject: 'sub_sec_dev_a',
      email: 'dev-a@org-a.example',
      displayName: 'Dev A',
    });
    const viewerA = await ensureUser(ctx.db, {
      authSubject: 'sub_sec_viewer_a',
      email: 'viewer-a@org-a.example',
      displayName: 'Viewer A',
    });
    const ownerB = await ensureUser(ctx.db, {
      authSubject: 'sub_sec_owner_b',
      email: 'owner-b@org-b.example',
      displayName: 'Owner B',
    });

    const { organization: orgA } = await createOrganizationWithOwner(ctx.db, {
      name: 'Org A',
      slug: 'org-a-sec',
      creatorUserId: ownerA.id,
    });
    const { organization: orgB } = await createOrganizationWithOwner(ctx.db, {
      name: 'Org B',
      slug: 'org-b-sec',
      creatorUserId: ownerB.id,
    });

    const ownerAActor: AuthenticatedActor = {
      userId: ownerA.id,
      organizationId: orgA.id,
      role: 'owner',
    };
    await upsertMembership(ctx.db, ownerAActor, {
      organizationId: orgA.id,
      targetUserId: devA.id,
      role: 'developer',
    });
    await upsertMembership(ctx.db, ownerAActor, {
      organizationId: orgA.id,
      targetUserId: viewerA.id,
      role: 'viewer',
    });

    const devAActor: AuthenticatedActor = {
      userId: devA.id,
      organizationId: orgA.id,
      role: 'developer',
    };
    const viewerAActor: AuthenticatedActor = {
      userId: viewerA.id,
      organizationId: orgA.id,
      role: 'viewer',
    };
    const ownerBActor: AuthenticatedActor = {
      userId: ownerB.id,
      organizationId: orgB.id,
      role: 'owner',
    };

    const agentDraft = await createAgentDraft(ctx.db, ownerAActor, {
      organizationId: orgA.id,
      name: 'Sec Agent',
      slug: 'sec-agent',
      draftSystemPrompt: 'Security gate agent.',
      draftToolAllowlist: ['calculator'],
    });
    const { version: agentV1 } = await publishAgentVersion(
      ctx.db,
      ownerAActor,
      orgA.id,
      agentDraft.id
    );

    const wfDraft = await createWorkflowDraft(ctx.db, ownerAActor, {
      organizationId: orgA.id,
      slug: 'sec-hitl-workflow',
      name: 'Sec HITL Workflow',
      graph: SAMPLE_HITL_GRAPH,
    });
    const { version: wfV1 } = await publishWorkflowVersion(
      ctx.db,
      ownerAActor,
      {
        organizationId: orgA.id,
        workflowId: wfDraft.id,
      }
    );

    const started = await startWorkflowRun(ctx.db, devAActor, {
      organizationId: orgA.id,
      workflowVersionId: wfV1.id,
      defaultAgentVersionId: agentV1.id,
      inputPrompt: 'Request sensitive action',
    });
    const approvalId = started.pendingApproval!.id;

    // 1. Cross-tenant Owner B attempting to approve Org A's request gets 404 (ADR-002)
    await assert.rejects(
      async () => {
        await decideApprovalRequest(ctx.db, ownerBActor, {
          approvalRequestId: approvalId,
          decision: 'approved',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthorizationError);
        assert.equal(err.statusCode, 404);
        assert.equal(err.code, 'TENANT_MISMATCH');
        return true;
      }
    );

    // 2. Same-tenant Viewer A attempting to approve gets 403 and records a 'denied' audit event (Threat T-06)
    await assert.rejects(
      async () => {
        await decideApprovalRequest(ctx.db, viewerAActor, {
          approvalRequestId: approvalId,
          decision: 'approved',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthorizationError);
        assert.equal(err.statusCode, 403);
        return true;
      }
    );

    // 3. Same-tenant Developer A attempting to approve when allowDeveloperDecision=false gets 403
    await assert.rejects(
      async () => {
        await decideApprovalRequest(ctx.db, devAActor, {
          approvalRequestId: approvalId,
          decision: 'approved',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthorizationError);
        assert.equal(err.statusCode, 403);
        return true;
      }
    );

    // 4. Owner A rejects the approval -> run transitions to 'cancelled'
    const rejected = await decideApprovalRequest(ctx.db, ownerAActor, {
      approvalRequestId: approvalId,
      decision: 'rejected',
      note: 'Change freeze window active.',
    });
    assert.equal(rejected.approval.status, 'rejected');
    assert.equal(rejected.run.status, 'cancelled');
    assert.equal(rejected.run.errorCode, 'APPROVAL_REJECTED');

    // Verify audit log contains both the 'denied' attempts and the 'allowed' rejection
    const auditLog = await listAuditEvents(ctx.db, ownerAActor);
    const deniedEntries = auditLog.filter(
      (e) => e.action === 'approval.decide' && e.outcome === 'denied'
    );
    assert.equal(deniedEntries.length, 2);

    const allowedDecision = auditLog.find(
      (e) => e.action === 'approval.decide' && e.outcome === 'allowed'
    );
    assert.ok(allowedDecision);
    assert.equal(allowedDecision.actorUserId, ownerA.id);
  } finally {
    await ctx.close();
  }
});

test('USAGE-001 & AUDIT-001: getOrganizationUsageSummary separates mock vs live tokens and listAuditEvents blocks non-admin roles', async () => {
  const ctx = await createDatabaseClient();
  try {
    const ownerUser = await ensureUser(ctx.db, {
      authSubject: 'sub_usage_owner',
      email: 'usage-owner@acme.example',
      displayName: 'Usage Owner',
    });
    const viewerUser = await ensureUser(ctx.db, {
      authSubject: 'sub_usage_viewer',
      email: 'usage-viewer@acme.example',
      displayName: 'Usage Viewer',
    });
    const { organization } = await createOrganizationWithOwner(ctx.db, {
      name: 'Acme Usage Org',
      slug: 'acme-usage-org',
      creatorUserId: ownerUser.id,
    });

    const ownerActor: AuthenticatedActor = {
      userId: ownerUser.id,
      organizationId: organization.id,
      role: 'owner',
    };
    await upsertMembership(ctx.db, ownerActor, {
      organizationId: organization.id,
      targetUserId: viewerUser.id,
      role: 'viewer',
    });
    const viewerActor: AuthenticatedActor = {
      userId: viewerUser.id,
      organizationId: organization.id,
      role: 'viewer',
    };

    const agentDraft = await createAgentDraft(ctx.db, ownerActor, {
      organizationId: organization.id,
      name: 'Usage Agent',
      slug: 'usage-agent',
      draftSystemPrompt: 'Track usage accurately.',
      draftToolAllowlist: ['calculator'],
    });
    const { version: agentV1 } = await publishAgentVersion(
      ctx.db,
      ownerActor,
      organization.id,
      agentDraft.id
    );

    const simpleGraph: WorkflowGraphSpec = {
      nodes: [
        { id: 'start-1', kind: 'start', label: 'Start' },
        { id: 'agent-1', kind: 'agent', label: 'Agent Step' },
        { id: 'end-1', kind: 'end', label: 'End' },
      ],
      edges: [
        { id: 'e1', source: 'start-1', target: 'agent-1' },
        { id: 'e2', source: 'agent-1', target: 'end-1' },
      ],
    };

    const wfDraft = await createWorkflowDraft(ctx.db, ownerActor, {
      organizationId: organization.id,
      slug: 'simple-usage-wf',
      name: 'Simple Usage Workflow',
      graph: simpleGraph,
    });
    const { version: wfV1 } = await publishWorkflowVersion(ctx.db, ownerActor, {
      organizationId: organization.id,
      workflowId: wfDraft.id,
    });

    // Run 1 executes in default mock mode
    const mockRun = await startWorkflowRun(ctx.db, ownerActor, {
      organizationId: organization.id,
      workflowVersionId: wfV1.id,
      defaultAgentVersionId: agentV1.id,
      inputPrompt: 'Simulated run in free-tier demo mode',
    });
    assert.equal(mockRun.run.status, 'succeeded');

    // Record an explicit live provider usage event on the same run for comparison
    await recordUsageEvent(ctx.db, {
      organizationId: organization.id,
      runId: mockRun.run.id,
      workflowVersionId: wfV1.id,
      agentVersionId: agentV1.id,
      providerMode: 'live',
      modelId: 'gemini-2.5-flash',
      inputTokens: 120,
      outputTokens: 80,
      totalTokens: 200,
      toolCallsCount: 2,
      isEstimated: false,
    });

    // Viewer can read usage summary (`usage.view`)
    const summary = await getOrganizationUsageSummary(ctx.db, viewerActor);
    assert.equal(summary.mock.runsCount, 1);
    assert.ok(summary.mock.totalTokens > 0);
    assert.equal(summary.live.runsCount, 1);
    assert.equal(summary.live.totalTokens, 200);
    assert.equal(summary.live.toolCallsCount, 2);

    // Viewer is blocked from reading security audit logs (`audit.view` -> 403)
    await assert.rejects(
      async () => {
        await listAuditEvents(ctx.db, viewerActor);
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthorizationError);
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
  } finally {
    await ctx.close();
  }
});
