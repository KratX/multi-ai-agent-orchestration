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

test('v1.0.0-demo Enterprise Control Plane: 8-Persona RBAC, Session-Scoped BYOK Vault Isolation, 3-Mode Sandbox Reset, Workflow DAG Cycle Validator, 4-Point Isolation Verifier, Last-Owner 409 Safeguard, and DB Diagnostics', async () => {
  const ctx = await createDatabaseClient();
  const worker = new RuntimeWorker({
    db: ctx.db,
    workerId: 'test-http-worker-v1-demo',
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

    // 1. Seed workspace and verify all 8 personas across Acme Cyber Defense & Beta Logistics
    const seedRes = await fetch(`${baseUrl}/api/v1/workspace/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ forceReset: true }),
    });
    assert.equal(seedRes.status, 200);
    const seedPayload = (await seedRes.json()) as {
      data: {
        status: string;
        personas: Array<{
          id: string;
          userId: string;
          organizationId: string;
          organizationSlug: string;
          role: string;
        }>;
      };
    };
    assert.equal(seedPayload.data.status, 'seeded');
    const personaIds = seedPayload.data.personas.map((p) => p.id).sort();
    assert.deepEqual(personaIds, [
      'acme-admin',
      'acme-dev',
      'acme-owner',
      'acme-viewer',
      'beta-admin',
      'beta-dev',
      'beta-owner',
      'beta-viewer',
    ]);

    // Verify both tenants resolve their isolated workspaces and RBAC matrices
    const acmeOwnerWsRes = await fetch(`${baseUrl}/api/v1/workspace`, {
      headers: { 'x-actor-id': 'acme-owner' },
    });
    assert.equal(acmeOwnerWsRes.status, 200);
    const acmeOwnerWs = (await acmeOwnerWsRes.json()) as {
      data: {
        actor: { userId: string; organizationId: string; role: string };
        organization: { slug: string };
        rbacMatrix: { owner: string[]; viewer: string[]; activeActorPermissions: string[] };
      };
    };
    assert.equal(acmeOwnerWs.data.organization.slug, 'acme-cyber-defense');
    assert.equal(acmeOwnerWs.data.actor.role, 'owner');
    assert.equal(acmeOwnerWs.data.rbacMatrix.owner.length, 28);
    assert.ok(acmeOwnerWs.data.rbacMatrix.viewer.length < 28);

    const betaDevWsRes = await fetch(`${baseUrl}/api/v1/workspace`, {
      headers: { 'x-actor-id': 'beta-dev' },
    });
    assert.equal(betaDevWsRes.status, 200);
    const betaDevWs = (await betaDevWsRes.json()) as {
      data: {
        actor: { role: string };
        organization: { slug: string };
      };
    };
    assert.equal(betaDevWs.data.organization.slug, 'beta-logistics');
    assert.equal(betaDevWs.data.actor.role, 'developer');

    // 2. Session-Scoped BYOK Vault Isolation (x-ordaris-demo-session)
    const saveKeyAlphaRes = await fetch(`${baseUrl}/api/v1/providers/keys`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'acme-owner',
        'x-ordaris-demo-session': 'session-alpha-eval',
      },
      body: JSON.stringify({
        provider: 'openrouter',
        rawKey: 'sk-or-v1-alpha-session-secret-key-9999',
      }),
    });
    assert.equal(saveKeyAlphaRes.status, 200);
    const saveKeyAlphaData = (await saveKeyAlphaRes.json()) as {
      data: {
        updated: {
          provider: string;
          configuredInVault: boolean;
          effectiveActive: boolean;
          source: string;
          resolutionTier: string;
          maskedPreview: string | null;
        };
      };
    };
    assert.equal(saveKeyAlphaData.data.updated.provider, 'openrouter');
    assert.equal(saveKeyAlphaData.data.updated.configuredInVault, true);
    assert.equal(saveKeyAlphaData.data.updated.effectiveActive, true);
    assert.equal(saveKeyAlphaData.data.updated.source, 'vault');
    assert.equal(saveKeyAlphaData.data.updated.resolutionTier, 'session_byok');
    assert.ok(
      saveKeyAlphaData.data.updated.maskedPreview &&
        !saveKeyAlphaData.data.updated.maskedPreview.includes('secret-key'),
      'Expected masked BYOK key preview without leaking plaintext middle characters'
    );

    // Verify session-beta-eval does NOT see session-alpha-eval's BYOK key
    const keysBetaRes = await fetch(`${baseUrl}/api/v1/providers/keys`, {
      headers: {
        'x-actor-id': 'acme-owner',
        'x-ordaris-demo-session': 'session-beta-eval',
      },
    });
    assert.equal(keysBetaRes.status, 200);
    const keysBetaData = (await keysBetaRes.json()) as {
      data: Array<{
        provider: string;
        configuredInVault: boolean;
        source: string;
        resolutionTier: string;
      }>;
    };
    const betaOpenRouter = keysBetaData.data.find((p) => p.provider === 'openrouter')!;
    assert.equal(
      betaOpenRouter.configuredInVault,
      false,
      'Expected session-beta-eval to have zero access to session-alpha-eval BYOK key'
    );
    assert.notEqual(betaOpenRouter.resolutionTier, 'session_byok');

    // 3. 3-Mode Sandbox Reset:
    // 3a. workspace_only preserves session-alpha-eval's BYOK key
    const wsOnlyResetRes = await fetch(`${baseUrl}/api/v1/workspace/reset`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'acme-owner',
        'x-ordaris-demo-session': 'session-alpha-eval',
      },
      body: JSON.stringify({ resetMode: 'workspace_only' }),
    });
    assert.equal(wsOnlyResetRes.status, 200);
    const wsOnlyResetData = (await wsOnlyResetRes.json()) as {
      data: {
        resetMode: string;
        clearedByokKeysCount: number;
        byokProviders: Array<{
          provider: string;
          configuredInVault: boolean;
          resolutionTier: string;
        }>;
      };
    };
    assert.equal(wsOnlyResetData.data.resetMode, 'workspace_only');
    assert.equal(wsOnlyResetData.data.clearedByokKeysCount, 0);
    assert.equal(
      wsOnlyResetData.data.byokProviders.find((p) => p.provider === 'openrouter')
        ?.resolutionTier,
      'session_byok'
    );

    // 3b. keys_only wipes session-alpha-eval's BYOK key without wiping database state
    const keysOnlyResetRes = await fetch(`${baseUrl}/api/v1/workspace/reset`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'acme-owner',
        'x-ordaris-demo-session': 'session-alpha-eval',
      },
      body: JSON.stringify({ resetMode: 'keys_only' }),
    });
    assert.equal(keysOnlyResetRes.status, 200);
    const keysOnlyResetData = (await keysOnlyResetRes.json()) as {
      data: {
        resetMode: string;
        clearedByokKeysCount: number;
        byokProviders: Array<{
          provider: string;
          configuredInVault: boolean;
          resolutionTier: string;
        }>;
      };
    };
    assert.equal(keysOnlyResetData.data.resetMode, 'keys_only');
    assert.equal(keysOnlyResetData.data.clearedByokKeysCount, 1);
    assert.equal(
      keysOnlyResetData.data.byokProviders.find((p) => p.provider === 'openrouter')
        ?.configuredInVault,
      false
    );

    // 4. Workflow DAG Cycle Validator (`POST /api/v1/workflows/validate-dag`)
    const cyclicGraph = {
      nodes: [
        { id: 'start_1', label: 'Start', kind: 'start' },
        { id: 'step_a', label: 'Step A', kind: 'tool', toolName: 'calculator' },
        { id: 'step_b', label: 'Step B', kind: 'tool', toolName: 'calculator' },
        { id: 'end_1', label: 'End', kind: 'end' },
      ],
      edges: [
        { id: 'e1', source: 'start_1', target: 'step_a' },
        { id: 'e2', source: 'step_a', target: 'step_b' },
        { id: 'e3', source: 'step_b', target: 'step_a' },
        { id: 'e4', source: 'step_b', target: 'end_1' },
      ],
    };
    const cyclicRes = await fetch(`${baseUrl}/api/v1/workflows/validate-dag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ graph: cyclicGraph }),
    });
    assert.equal(cyclicRes.status, 200);
    const cyclicData = (await cyclicRes.json()) as {
      data: { valid: boolean; cyclePath: string[] | null; errors: string[] };
    };
    assert.equal(cyclicData.data.valid, false);
    assert.ok(
      Array.isArray(cyclicData.data.cyclePath) && cyclicData.data.cyclePath.length >= 2,
      'Expected cyclePath to identify the directed cycle'
    );

    // Valid acyclic graph passes validation with topological order
    const acyclicGraph = {
      nodes: [
        { id: 'start_1', label: 'Start', kind: 'start' },
        { id: 'step_a', label: 'Step A', kind: 'tool', toolName: 'calculator' },
        { id: 'end_1', label: 'End', kind: 'end' },
      ],
      edges: [
        { id: 'e1', source: 'start_1', target: 'step_a' },
        { id: 'e2', source: 'step_a', target: 'end_1' },
      ],
    };
    const acyclicRes = await fetch(`${baseUrl}/api/v1/workflows/validate-dag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ graph: acyclicGraph }),
    });
    assert.equal(acyclicRes.status, 200);
    const acyclicData = (await acyclicRes.json()) as {
      data: { valid: boolean; topologicalOrder: string[] };
    };
    assert.equal(acyclicData.data.valid, true);
    assert.deepEqual(acyclicData.data.topologicalOrder, ['start_1', 'step_a', 'end_1']);

    // 5. Live 4-Point Cross-Tenant Isolation Verifier (`GET /api/v1/demo/verify-isolation`)
    const isolationRes = await fetch(`${baseUrl}/api/v1/demo/verify-isolation`);
    assert.equal(isolationRes.status, 200);
    const isolationData = (await isolationRes.json()) as {
      data: {
        overallPassed: boolean;
        checksCount: number;
        passedCount: number;
        checks: Array<{ id: string; passed: boolean; httpStatus: number }>;
      };
    };
    assert.equal(isolationData.data.overallPassed, true);
    assert.equal(isolationData.data.checksCount, 4);
    assert.equal(isolationData.data.passedCount, 4);
    assert.ok(isolationData.data.checks.every((c) => c.passed));

    // 6. Last-Owner 409 Safeguard over HTTP (`DELETE /api/v1/members/:userId`)
    const refreshedOwnerWsRes = await fetch(`${baseUrl}/api/v1/workspace`, {
      headers: { 'x-actor-id': 'acme-owner' },
    });
    const refreshedOwnerWs = (await refreshedOwnerWsRes.json()) as {
      data: { actor: { userId: string } };
    };
    const ownerUserId = refreshedOwnerWs.data.actor.userId;
    const removeSoleOwnerRes = await fetch(
      `${baseUrl}/api/v1/members/${ownerUserId}`,
      {
        method: 'DELETE',
        headers: { 'x-actor-id': 'acme-owner' },
      }
    );
    assert.equal(removeSoleOwnerRes.status, 409);
    const removeSoleOwnerProblem = (await removeSoleOwnerRes.json()) as {
      code: string;
      status: number;
    };
    assert.equal(removeSoleOwnerProblem.code, 'LAST_OWNER_PROTECTED');

    // 7. Live PostgreSQL Table Diagnostics & Runtime Logs (`GET /api/v1/demo/diagnostics` & `GET /api/v1/logs`)
    const diagRes = await fetch(`${baseUrl}/api/v1/demo/diagnostics`);
    assert.equal(diagRes.status, 200);
    const diagData = (await diagRes.json()) as {
      data: {
        version: string;
        database: {
          engine: string;
          totalRows: number;
          tables: Record<string, number>;
        };
      };
    };
    assert.equal(
      diagData.data.database.engine,
      'PostgreSQL 16 (Embedded PGlite + Drizzle ORM)'
    );
    assert.ok(diagData.data.database.totalRows > 10);
    assert.ok((diagData.data.database.tables.organizations ?? 0) >= 2);
    assert.ok((diagData.data.database.tables.users ?? 0) >= 8);

    const logsRes = await fetch(`${baseUrl}/api/v1/logs`);
    assert.equal(logsRes.status, 200);
    const logsData = (await logsRes.json()) as {
      data: {
        logFilePath: string;
        logs: Array<{ level: string; component: string; message: string }>;
      };
    };
    assert.ok(logsData.data.logFilePath.endsWith('ordaris-runtime.log'));
    assert.ok(logsData.data.logs.length >= 1);
  } finally {
    await worker.stop();
    server.close();
    await ctx.close();
  }
});

