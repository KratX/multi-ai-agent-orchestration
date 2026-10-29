import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseClient } from '../../src/server/db/client';
import { seedFlagshipWorkspace } from '../../src/server/seed/demo-seed';
import {
  getEvalSuiteWithCases,
  compareEvalExperiments,
} from '../../src/server/modules/evals/eval-harness';
import {
  getKnowledgeDocumentWithChunks,
  KnowledgeConstraintError,
  searchKnowledgeChunks,
} from '../../src/server/modules/knowledge/knowledge-service';
import { createRunEventsSseResponse } from '../../src/server/modules/runs/sse-stream';
import {
  getOrganizationUsageSummary,
  listAuditEvents,
} from '../../src/server/modules/workflows/workflow-engine';
import {
  AuthorizationError,
  type AuthenticatedActor,
} from '../../src/server/policies/authorization';

test('SEED-001: seedFlagshipWorkspace provisions multi-tenant orgs, RAG chunks, Agent v1/v2, HITL workflow, and Eval comparison end-to-end', async () => {
  const ctx = await createDatabaseClient();
  try {
    const report = await seedFlagshipWorkspace(ctx.db);

    // 1. Multi-tenant orgs provisioned with distinct IDs
    assert.equal(report.tenants.acme.slug, 'acme-cyber-defense');
    assert.equal(report.tenants.beta.slug, 'beta-logistics');
    assert.notEqual(
      report.tenants.acme.organizationId,
      report.tenants.beta.organizationId
    );

    // 2. Knowledge document chunked & stored with opaque tenant-prefixed key
    assert.ok(report.knowledge.chunkCount >= 1);
    assert.ok(
      report.knowledge.storageKey.startsWith(
        `${report.tenants.acme.organizationId}/`
      )
    );

    // 3. Immutable Agent v1 and v2 snapshots have distinct SHA-256 hashes
    assert.notEqual(report.agents.v1VersionId, report.agents.v2VersionId);
    assert.notEqual(report.agents.v1SnapshotHash, report.agents.v2SnapshotHash);
    assert.equal(report.agents.v1SnapshotHash.length, 64);
    assert.equal(report.agents.v2SnapshotHash.length, 64);

    // 4. Workflow paused at waiting_approval and resumed to succeeded after admin approval
    assert.equal(report.workflow.initialStatus, 'waiting_approval');
    assert.equal(report.workflow.finalStatus, 'succeeded');
    assert.equal(
      report.workflow.approvedByUserId,
      report.tenants.acme.adminUserId
    );

    // 5. Eval suite detected v1 (100%) -> v2 (50%) regression when calculator was removed
    assert.equal(report.evaluation.baselinePassRate, 100);
    assert.equal(report.evaluation.candidatePassRate, 50);
    assert.equal(report.evaluation.passRateDelta, -50);
    assert.equal(report.evaluation.regressedCasesCount, 1);

    // 6. SSE cursor replay skipped first 2 frames on reconnect
    assert.ok(report.sseReplay.fullEventsCount >= 4);
    assert.equal(
      report.sseReplay.replayedAfterCursor2Count,
      report.sseReplay.fullEventsCount - 2
    );

    // 7. Governance audit events and usage ledger recorded
    assert.ok(report.governance.auditEventsCount >= 2);
    assert.ok(report.governance.mockRunsCount >= 1);
    assert.ok(report.governance.mockTotalTokens > 0);
  } finally {
    await ctx.close();
  }
});

test('SEED-001: enforces strict cross-tenant 404 isolation between seeded Acme Cyber Defense and Beta Logistics', async () => {
  const ctx = await createDatabaseClient();
  try {
    const report = await seedFlagshipWorkspace(ctx.db);

    const betaOwnerActor: AuthenticatedActor = {
      userId: report.tenants.beta.ownerUserId,
      organizationId: report.tenants.beta.organizationId,
      role: 'owner',
    };

    // Beta Logistics searching for Acme's SEV-1 or AES-256-GCM runbook receives 0 chunks
    const betaSearch = await searchKnowledgeChunks(ctx.db, {
      organizationId: report.tenants.beta.organizationId,
      query: 'Severity 1 On-Call Commander AES-256-GCM',
      topK: 5,
    });
    assert.equal(betaSearch.length, 0);

    // Beta Logistics attempting to read Acme's knowledge document receives 404
    await assert.rejects(
      () =>
        getKnowledgeDocumentWithChunks(
          ctx.db,
          betaOwnerActor,
          report.tenants.beta.organizationId,
          report.knowledge.documentId
        ),
      (err: unknown) =>
        err instanceof KnowledgeConstraintError && err.statusCode === 404
    );

    // Beta Logistics attempting to read Acme's Eval Suite receives 404 TENANT_MISMATCH
    await assert.rejects(
      () =>
        getEvalSuiteWithCases(
          ctx.db,
          betaOwnerActor,
          report.tenants.acme.organizationId,
          report.evaluation.suiteId
        ),
      (err: unknown) =>
        err instanceof AuthorizationError && err.statusCode === 404
    );

    // Beta Logistics attempting to stream Acme's SSE run events receives 404
    const crossTenantSse = await createRunEventsSseResponse(
      ctx.db,
      betaOwnerActor,
      {
        organizationId: report.tenants.acme.organizationId,
        runId: report.evaluation.sampleEvalRunId,
      }
    );
    assert.equal(crossTenantSse.status, 404);
  } finally {
    await ctx.close();
  }
});

test('SEED-001: verifies SSE Last-Event-ID reconnect replay and Eval diff breakdown on seeded workspace', async () => {
  const ctx = await createDatabaseClient();
  try {
    const report = await seedFlagshipWorkspace(ctx.db);

    const acmeViewerActor: AuthenticatedActor = {
      userId: report.tenants.acme.viewerUserId,
      organizationId: report.tenants.acme.organizationId,
      role: 'viewer',
    };

    // Viewer can inspect evaluation comparison and replay SSE stream in their own organization
    const diff = await compareEvalExperiments(ctx.db, acmeViewerActor, {
      organizationId: report.tenants.acme.organizationId,
      baselineExperimentId: report.evaluation.baselineExperimentId,
      candidateExperimentId: report.evaluation.candidateExperimentId,
    });

    assert.equal(diff.caseDiffs.length, 2);
    assert.equal(diff.caseDiffs[0]!.caseName, 'Error Budget Burn Calculation');
    assert.equal(diff.caseDiffs[0]!.status, 'regressed');
    assert.equal(
      diff.caseDiffs[1]!.caseName,
      'SEV-1 Runbook Citation Grounding'
    );
    assert.equal(diff.caseDiffs[1]!.status, 'unchanged_pass');

    const sseReconnect = await createRunEventsSseResponse(
      ctx.db,
      acmeViewerActor,
      {
        organizationId: report.tenants.acme.organizationId,
        runId: report.evaluation.sampleEvalRunId,
        lastEventIdHeader: '2',
      }
    );
    assert.equal(sseReconnect.status, 200);
    const bodyText = await sseReconnect.text();
    assert.doesNotMatch(bodyText, /\nid: 1\n/);
    assert.doesNotMatch(bodyText, /\nid: 2\n/);
    assert.match(bodyText, /\nid: 3\n/);
    assert.match(bodyText, /event: run\.stream_end/);
  } finally {
    await ctx.close();
  }
});

test('SEED-001: verifies security audit trail completeness and RBAC enforcement for Acme Viewer vs Admin', async () => {
  const ctx = await createDatabaseClient();
  try {
    const report = await seedFlagshipWorkspace(ctx.db);

    const acmeAdminActor: AuthenticatedActor = {
      userId: report.tenants.acme.adminUserId,
      organizationId: report.tenants.acme.organizationId,
      role: 'admin',
    };
    const acmeViewerActor: AuthenticatedActor = {
      userId: report.tenants.acme.viewerUserId,
      organizationId: report.tenants.acme.organizationId,
      role: 'viewer',
    };

    // Admin can query security audit events and verify the HITL approval decision was logged
    const audits = await listAuditEvents(ctx.db, acmeAdminActor);
    const approvalAudit = audits.find(
      (a) =>
        a.action === 'approval.decide' &&
        a.outcome === 'allowed' &&
        a.actorUserId === report.tenants.acme.adminUserId
    );
    assert.ok(approvalAudit);

    // Viewer can read FinOps usage summary (`usage.view`) but is blocked from security audit logs (`audit.view` -> 403)
    const usage = await getOrganizationUsageSummary(ctx.db, acmeViewerActor);
    assert.ok(usage.mock.runsCount >= 1);
    assert.equal(usage.live.runsCount, 0);

    await assert.rejects(
      () => listAuditEvents(ctx.db, acmeViewerActor),
      (err: unknown) =>
        err instanceof AuthorizationError && err.statusCode === 403
    );
  } finally {
    await ctx.close();
  }
});
