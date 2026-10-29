import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createDatabaseClient } from '../../src/server/db/client';
import { createApiApp } from '../../src/server/http/app';
import { RuntimeWorker } from '../../src/server/worker/main';

/**
 * Phase C & Phase D Integration Tests:
 * Exercises the mounted Express HTTP API (`/api/v1/*`) and `RuntimeWorker` over real
 * TCP sockets (`fetch`) backed by PostgreSQL (PGlite).
 */

test('Phase C & D: Express API serves real health/readiness probes, agent creation, worker run processing, SSE cursor replay, and server-authorized HITL approvals', async () => {
  const ctx = await createDatabaseClient();
  const worker = new RuntimeWorker({
    db: ctx.db,
    workerId: 'test-http-worker-1',
  });

  const app = createApiApp({
    contextProvider: async () => ctx,
    worker,
    rawEnv: {
      NODE_ENV: 'test',
      AI_MODE: 'demo',
      DEMO_MODE: 'true',
    },
  });

  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', (err) => reject(err));
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    // 1. Liveness & Readiness Probes over HTTP
    const liveRes = await fetch(`${baseUrl}/api/v1/health/live`);
    assert.equal(liveRes.status, 200);
    const liveJson = (await liveRes.json()) as { data: { status: string } };
    assert.equal(liveJson.data.status, 'alive');

    const readyRes = await fetch(`${baseUrl}/api/v1/health/ready`);
    assert.equal(readyRes.status, 200);
    const readyJson = (await readyRes.json()) as {
      data: { readiness: { database: string; engine: string } };
    };
    assert.equal(readyJson.data.readiness.database, 'ready');
    assert.equal(readyJson.data.readiness.engine, 'pglite');

    // 2. Seed workspace via HTTP POST /api/v1/workspace/seed
    const seedRes = await fetch(`${baseUrl}/api/v1/workspace/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ forceReset: true }),
    });
    assert.equal(seedRes.status, 200);
    const seedData = (await seedRes.json()) as {
      data: {
        status: string;
        pendingApprovalId: string | null;
        personas: Array<{ id: string; organizationId: string }>;
      };
    };
    assert.equal(seedData.data.status, 'seeded');
    assert.ok(seedData.data.pendingApprovalId, 'Expected a pending HITL approval request');

    const acmeOrgId = seedData.data.personas.find((p) => p.id === 'acme-owner')!.organizationId;
    const pendingApprovalId = seedData.data.pendingApprovalId!;

    // 3. Anonymous request is rejected with 401 UNAUTHENTICATED
    const anonRes = await fetch(`${baseUrl}/api/v1/workspace`, {
      headers: { 'x-actor-id': 'anonymous' },
    });
    assert.equal(anonRes.status, 401);

    // 4. Cross-tenant request from Beta Logistics Owner to Acme organizationId returns 404 Not Found
    const crossTenantWorkspaceRes = await fetch(
      `${baseUrl}/api/v1/workspace?organizationId=${acmeOrgId}`,
      {
        headers: { 'x-actor-id': 'beta-owner' },
      }
    );
    assert.equal(crossTenantWorkspaceRes.status, 404);

    // 5. Create a new Agent Draft, Publish v1, and Enqueue + Execute a Run over HTTP
    const createAgentRes = await fetch(`${baseUrl}/api/v1/agents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'acme-dev',
      },
      body: JSON.stringify({
        name: 'HTTP API FinOps Agent',
        slug: 'http-api-finops-agent',
        description: 'Created over Express HTTP route',
        draftSystemPrompt: 'Use calculator for arithmetic.',
        draftToolAllowlist: ['calculator'],
      }),
    });
    assert.equal(createAgentRes.status, 201);
    const createdAgent = ((await createAgentRes.json()) as { data: { id: string } }).data;

    const publishRes = await fetch(
      `${baseUrl}/api/v1/agents/${createdAgent.id}/publish`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actor-id': 'acme-dev',
        },
        body: JSON.stringify({}),
      }
    );
    assert.equal(publishRes.status, 201);

    const runRes = await fetch(`${baseUrl}/api/v1/agents/${createdAgent.id}/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'acme-dev',
      },
      body: JSON.stringify({
        inputPrompt: 'Calculate (25 * 4) + 10 using calculator',
        idempotencyKey: 'http-test-run-key-001',
        processImmediately: true,
      }),
    });
    assert.equal(runRes.status, 202);
    const runPayload = (await runRes.json()) as {
      data: {
        run: { id: string; status: string; finalOutput: string; toolCallCount: number };
        events: Array<{ sequenceNo: number; eventType: string }>;
      };
    };
    assert.equal(runPayload.data.run.status, 'succeeded');
    assert.equal(runPayload.data.run.toolCallCount, 1);
    assert.match(runPayload.data.run.finalOutput, /110/);
    assert.ok(runPayload.data.events.length >= 4);

    // 6. Stream persisted SSE events with Last-Event-ID cursor = 2
    const sseRes = await fetch(
      `${baseUrl}/api/v1/runs/${runPayload.data.run.id}/stream`,
      {
        headers: {
          'x-actor-id': 'acme-dev',
          'Last-Event-ID': '2',
        },
      }
    );
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get('content-type') ?? '', /text\/event-stream/);
    const sseText = await sseRes.text();
    assert.equal(sseText.includes('id: 1\n'), false);
    assert.equal(sseText.includes('id: 2\n'), false);
    assert.equal(sseText.includes('id: 3\n'), true);

    // 7. Server-Authorized HITL Approval Gate over HTTP:
    // 7a. Viewer is rejected with 403 Forbidden and recorded in audit_events
    const viewerDecisionRes = await fetch(
      `${baseUrl}/api/v1/approvals/${pendingApprovalId}/decision`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actor-id': 'acme-viewer',
        },
        body: JSON.stringify({
          decision: 'approved',
          note: 'Viewer attempting unauthorized approval',
        }),
      }
    );
    assert.equal(viewerDecisionRes.status, 403);

    // 7b. Beta Owner (cross-tenant) is rejected with 404 Not Found
    const betaDecisionRes = await fetch(
      `${baseUrl}/api/v1/approvals/${pendingApprovalId}/decision`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actor-id': 'beta-owner',
        },
        body: JSON.stringify({
          organizationId: acmeOrgId,
          decision: 'approved',
        }),
      }
    );
    assert.equal(betaDecisionRes.status, 404);

    // 7c. Acme Admin approves the pending gate -> 200 OK and run transitions to 'succeeded'
    const adminDecisionRes = await fetch(
      `${baseUrl}/api/v1/approvals/${pendingApprovalId}/decision`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actor-id': 'acme-admin',
        },
        body: JSON.stringify({
          decision: 'approved',
          note: 'Approved by Marcus Sterling over HTTP API',
        }),
      }
    );
    assert.equal(adminDecisionRes.status, 200);
    const adminDecisionData = (await adminDecisionRes.json()) as {
      data: {
        approval: { status: string; decisionNote: string };
        run: { status: string };
      };
    };
    assert.equal(adminDecisionData.data.approval.status, 'approved');
    assert.equal(adminDecisionData.data.run.status, 'succeeded');

    // 8. Verify denied + allowed audit events are persisted in PostgreSQL
    const auditRes = await fetch(`${baseUrl}/api/v1/audit-events`, {
      headers: { 'x-actor-id': 'acme-admin' },
    });
    assert.equal(auditRes.status, 200);
    const auditJson = (await auditRes.json()) as {
      data: Array<{ action: string; outcome: string; actorRole: string }>;
    };
    const deniedViewerAudit = auditJson.data.find(
      (e) => e.action === 'approval.decide' && e.outcome === 'denied' && e.actorRole === 'viewer'
    );
    assert.ok(deniedViewerAudit, 'Expected denied viewer approval attempt in audit_events');
  } finally {
    await worker.stop();
    server.close();
    await ctx.close();
  }
});
