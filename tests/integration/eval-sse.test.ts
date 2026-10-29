import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseClient } from '../../src/server/db/client';
import {
  createOrganizationWithOwner,
  ensureUser,
  upsertMembership,
} from '../../src/server/db/repositories/tenant-repository';
import {
  createAgentDraft,
  publishAgentVersion,
  updateAgentDraft,
} from '../../src/server/db/repositories/agent-repository';
import { ingestKnowledgeDocument } from '../../src/server/modules/knowledge/knowledge-service';
import {
  compareEvalExperiments,
  createEvalSuite,
  getEvalSuiteWithCases,
  runEvalExperiment,
} from '../../src/server/modules/evals/eval-harness';
import { createRunEventsSseResponse } from '../../src/server/modules/runs/sse-stream';
import { AuthorizationError, type AuthenticatedActor } from '../../src/server/policies/authorization';

test('EVAL-001: creates evaluation suite and runs experiment with 100% pass rate against published Agent v1', async () => {
  const ctx = await createDatabaseClient();
  try {
    const ownerUser = await ensureUser(ctx.db, {
      authSubject: 'eval-owner-1',
      email: 'eval-owner@acme.example',
      displayName: 'Eval Owner',
    });

    const { organization } = await createOrganizationWithOwner(ctx.db, {
      name: 'Acme Evaluation Org',
      slug: 'acme-eval-org',
      creatorUserId: ownerUser.id,
    });

    const ownerActor: AuthenticatedActor = {
      userId: ownerUser.id,
      organizationId: organization.id,
      role: 'owner',
    };

    const ingested = await ingestKnowledgeDocument(ctx.db, ownerActor, {
      organizationId: organization.id,
      title: 'Incident Escalation Runbook',
      sourceFilename: 'incident-runbook.md',
      mimeType: 'text/markdown',
      content:
        'Severity 1 production incidents require notifying the On-Call Commander within 15 minutes and opening bridge channel #sev1-incident.',
    });

    const agent = await createAgentDraft(ctx.db, ownerActor, {
      organizationId: organization.id,
      name: 'SRE Reliability Copilot',
      slug: 'sre-reliability-copilot',
      draftSystemPrompt:
        'You are an SRE Reliability Copilot. Use calculator for arithmetic and knowledge_search for incident runbook policies.',
      draftToolAllowlist: ['calculator', 'knowledge_search'],
    });

    const v1 = await publishAgentVersion(
      ctx.db,
      ownerActor,
      organization.id,
      agent.id
    );

    const { suite, cases } = await createEvalSuite(ctx.db, ownerActor, {
      organizationId: organization.id,
      agentId: agent.id,
      name: 'SRE Core Readiness Benchmark',
      description: 'Verifies arithmetic accuracy and grounded runbook citations.',
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
          name: 'Sev1 Runbook Citation Grounding',
          inputPrompt:
            'Search knowledge base for Severity 1 production incidents escalation policy',
          assertions: [
            { type: 'tool_called', toolName: 'knowledge_search' },
            {
              type: 'citation_required',
              minCitations: 1,
              documentId: ingested.document.id,
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

    assert.equal(cases.length, 2);

    const exp1 = await runEvalExperiment(ctx.db, ownerActor, {
      organizationId: organization.id,
      suiteId: suite.id,
      agentVersionId: v1.version.id,
    });

    assert.equal(exp1.experiment.status, 'succeeded');
    assert.equal(exp1.experiment.totalCases, 2);
    assert.equal(exp1.experiment.passedCases, 2);
    assert.equal(exp1.experiment.failedCases, 0);
    assert.equal(exp1.experiment.passRate, 100);
    assert.equal(exp1.caseResults.length, 2);
    assert.ok(exp1.caseResults[0]!.resultRow.runId);
    assert.ok(exp1.caseResults[1]!.resultRow.runId);
  } finally {
    await ctx.close();
  }
});

test('EVAL-001: compareEvalExperiments detects regression when Agent v2 drops calculator tool allowlist', async () => {
  const ctx = await createDatabaseClient();
  try {
    const ownerUser = await ensureUser(ctx.db, {
      authSubject: 'eval-diff-owner',
      email: 'diff-owner@acme.example',
      displayName: 'Diff Owner',
    });

    const { organization } = await createOrganizationWithOwner(ctx.db, {
      name: 'Acme Regression Org',
      slug: 'acme-regression-org',
      creatorUserId: ownerUser.id,
    });

    const ownerActor: AuthenticatedActor = {
      userId: ownerUser.id,
      organizationId: organization.id,
      role: 'owner',
    };

    const agent = await createAgentDraft(ctx.db, ownerActor, {
      organizationId: organization.id,
      name: 'Finance Analyst Agent',
      slug: 'finance-analyst-agent',
      draftSystemPrompt: 'Compute financial metrics accurately.',
      draftToolAllowlist: ['calculator'],
    });

    const v1 = await publishAgentVersion(
      ctx.db,
      ownerActor,
      organization.id,
      agent.id
    );

    // Update draft to remove calculator allowlist and publish v2
    await updateAgentDraft(ctx.db, ownerActor, {
      organizationId: organization.id,
      agentId: agent.id,
      draftToolAllowlist: [],
    });

    const v2 = await publishAgentVersion(
      ctx.db,
      ownerActor,
      organization.id,
      agent.id
    );

    const { suite } = await createEvalSuite(ctx.db, ownerActor, {
      organizationId: organization.id,
      agentId: agent.id,
      name: 'Quarterly Margin Suite',
      cases: [
        {
          name: 'Compound Margin Arithmetic',
          inputPrompt: 'Calculate 25 * 4',
          assertions: [
            { type: 'tool_called', toolName: 'calculator' },
            { type: 'contains', expectedSubstring: '100' },
          ],
        },
        {
          name: 'Direct Summary Response',
          inputPrompt: 'Provide a concise executive greeting',
          assertions: [
            {
              type: 'contains',
              expectedSubstring: 'Provide a concise executive greeting',
              ignoreCase: true,
            },
          ],
        },
      ],
    });

    const baselineRun = await runEvalExperiment(ctx.db, ownerActor, {
      organizationId: organization.id,
      suiteId: suite.id,
      agentVersionId: v1.version.id,
    });

    const candidateRun = await runEvalExperiment(ctx.db, ownerActor, {
      organizationId: organization.id,
      suiteId: suite.id,
      agentVersionId: v2.version.id,
    });

    assert.equal(baselineRun.experiment.passRate, 100);
    assert.equal(candidateRun.experiment.passRate, 50);

    const comparison = await compareEvalExperiments(ctx.db, ownerActor, {
      organizationId: organization.id,
      baselineExperimentId: baselineRun.experiment.id,
      candidateExperimentId: candidateRun.experiment.id,
    });

    assert.equal(comparison.passRateDelta, -50);
    assert.equal(comparison.regressedCasesCount, 1);
    assert.equal(comparison.improvedCasesCount, 0);
    assert.equal(comparison.caseDiffs[0]!.status, 'regressed');
    assert.equal(comparison.caseDiffs[1]!.status, 'unchanged_pass');
  } finally {
    await ctx.close();
  }
});

test('SSE-001: createRunEventsSseResponse streams ordered run events and replays only missed events after Last-Event-ID cursor', async () => {
  const ctx = await createDatabaseClient();
  try {
    const ownerUser = await ensureUser(ctx.db, {
      authSubject: 'sse-owner',
      email: 'sse-owner@acme.example',
      displayName: 'SSE Owner',
    });

    const { organization } = await createOrganizationWithOwner(ctx.db, {
      name: 'Acme SSE Org',
      slug: 'acme-sse-org',
      creatorUserId: ownerUser.id,
    });

    const ownerActor: AuthenticatedActor = {
      userId: ownerUser.id,
      organizationId: organization.id,
      role: 'owner',
    };

    const agent = await createAgentDraft(ctx.db, ownerActor, {
      organizationId: organization.id,
      name: 'SSE Trace Agent',
      slug: 'sse-trace-agent',
      draftSystemPrompt: 'Use calculator when needed.',
      draftToolAllowlist: ['calculator'],
    });

    const v1 = await publishAgentVersion(
      ctx.db,
      ownerActor,
      organization.id,
      agent.id
    );

    const { suite } = await createEvalSuite(ctx.db, ownerActor, {
      organizationId: organization.id,
      agentId: agent.id,
      name: 'SSE Trace Suite',
      cases: [
        {
          name: 'Calculator Trace Case',
          inputPrompt: 'Calculate 9 * 9',
          assertions: [{ type: 'contains', expectedSubstring: '81' }],
        },
      ],
    });

    const exp = await runEvalExperiment(ctx.db, ownerActor, {
      organizationId: organization.id,
      suiteId: suite.id,
      agentVersionId: v1.version.id,
    });

    const runId = exp.caseResults[0]!.resultRow.runId!;
    assert.ok(runId);

    // 1. Stream full event history from cursor 0
    const fullRes = await createRunEventsSseResponse(ctx.db, ownerActor, {
      organizationId: organization.id,
      runId,
    });
    assert.equal(fullRes.status, 200);
    assert.equal(
      fullRes.headers.get('content-type'),
      'text/event-stream; charset=utf-8'
    );

    const fullCount = Number(fullRes.headers.get('x-replayed-events-count'));
    assert.ok(fullCount >= 4);
    const fullText = await fullRes.text();
    assert.match(fullText, /id: 1\nevent: run\.queued/);
    assert.match(fullText, /event: run\.stream_end/);

    // 2. Reconnect with Last-Event-ID: 2 and verify sequence 1 and 2 are NOT duplicated
    const reconnectRes = await createRunEventsSseResponse(ctx.db, ownerActor, {
      organizationId: organization.id,
      runId,
      lastEventIdHeader: '2',
    });
    assert.equal(reconnectRes.status, 200);
    const replayedCount = Number(
      reconnectRes.headers.get('x-replayed-events-count')
    );
    assert.equal(replayedCount, fullCount - 2);

    const reconnectText = await reconnectRes.text();
    assert.doesNotMatch(reconnectText, /\nid: 1\n/);
    assert.doesNotMatch(reconnectText, /\nid: 2\n/);
    assert.match(reconnectText, /\nid: 3\n/);
  } finally {
    await ctx.close();
  }
});

test('EVAL-001 & SSE-001: enforces RBAC viewer restrictions and cross-tenant 404 isolation', async () => {
  const ctx = await createDatabaseClient();
  try {
    const ownerA = await ensureUser(ctx.db, {
      authSubject: 'tenant-a-owner',
      email: 'owner-a@acme.example',
      displayName: 'Owner A',
    });
    const viewerA = await ensureUser(ctx.db, {
      authSubject: 'tenant-a-viewer',
      email: 'viewer-a@acme.example',
      displayName: 'Viewer A',
    });
    const ownerB = await ensureUser(ctx.db, {
      authSubject: 'tenant-b-owner',
      email: 'owner-b@beta.example',
      displayName: 'Owner B',
    });

    const { organization: orgA } = await createOrganizationWithOwner(ctx.db, {
      name: 'Org Alpha',
      slug: 'org-alpha',
      creatorUserId: ownerA.id,
    });
    const { organization: orgB } = await createOrganizationWithOwner(ctx.db, {
      name: 'Org Beta',
      slug: 'org-beta',
      creatorUserId: ownerB.id,
    });

    const actorOwnerA: AuthenticatedActor = {
      userId: ownerA.id,
      organizationId: orgA.id,
      role: 'owner',
    };
    await upsertMembership(ctx.db, actorOwnerA, {
      organizationId: orgA.id,
      targetUserId: viewerA.id,
      role: 'viewer',
    });

    const actorViewerA: AuthenticatedActor = {
      userId: viewerA.id,
      organizationId: orgA.id,
      role: 'viewer',
    };
    const actorOwnerB: AuthenticatedActor = {
      userId: ownerB.id,
      organizationId: orgB.id,
      role: 'owner',
    };

    const agentA = await createAgentDraft(ctx.db, actorOwnerA, {
      organizationId: orgA.id,
      name: 'Alpha Agent',
      slug: 'alpha-agent',
      draftSystemPrompt: 'Alpha prompt.',
      draftToolAllowlist: [],
    });

    const v1A = await publishAgentVersion(
      ctx.db,
      actorOwnerA,
      orgA.id,
      agentA.id
    );

    const { suite } = await createEvalSuite(ctx.db, actorOwnerA, {
      organizationId: orgA.id,
      agentId: agentA.id,
      name: 'Alpha Suite',
      cases: [
        {
          name: 'Case 1',
          inputPrompt: 'Hello Alpha',
          assertions: [{ type: 'contains', expectedSubstring: 'Hello Alpha' }],
        },
      ],
    });

    // Viewer in Org A can view suite, but cannot create suites or execute experiments
    const viewedByViewer = await getEvalSuiteWithCases(
      ctx.db,
      actorViewerA,
      orgA.id,
      suite.id
    );
    assert.equal(viewedByViewer.suite.id, suite.id);

    await assert.rejects(
      () =>
        runEvalExperiment(ctx.db, actorViewerA, {
          organizationId: orgA.id,
          suiteId: suite.id,
          agentVersionId: v1A.version.id,
        }),
      (err: unknown) =>
        err instanceof AuthorizationError && err.statusCode === 403
    );

    // Owner of Org B gets 404 TENANT_MISMATCH when accessing Org A suite or SSE stream
    await assert.rejects(
      () => getEvalSuiteWithCases(ctx.db, actorOwnerB, orgA.id, suite.id),
      (err: unknown) =>
        err instanceof AuthorizationError && err.statusCode === 404
    );

    const expA = await runEvalExperiment(ctx.db, actorOwnerA, {
      organizationId: orgA.id,
      suiteId: suite.id,
      agentVersionId: v1A.version.id,
    });
    const runIdA = expA.caseResults[0]!.resultRow.runId!;

    const crossTenantSse = await createRunEventsSseResponse(
      ctx.db,
      actorOwnerB,
      {
        organizationId: orgA.id,
        runId: runIdA,
      }
    );
    assert.equal(crossTenantSse.status, 404);
  } finally {
    await ctx.close();
  }
});
