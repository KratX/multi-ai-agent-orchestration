import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabaseClient } from '../../src/server/db/client';
import { evaluateDatabaseReadiness } from '../../src/server/modules/health/health-service';
import {
  createOrganizationWithOwner,
  ensureUser,
} from '../../src/server/db/repositories/tenant-repository';
import {
  createAgentDraft,
  getAgentForActor,
  listAgentVersions,
  publishAgentVersion,
} from '../../src/server/db/repositories/agent-repository';

/**
 * Phase B & Phase E Integration Tests:
 * 1. File-backed PGlite persistence across process/database restart.
 * 2. Real database readiness probe (`SELECT 1`) returning false after database close.
 * 3. Direct SQL negative tests proving composite `(organization_id, ...)` foreign keys
 *    block cross-tenant parent-child relationships at the PostgreSQL constraint layer.
 */

test('Phase B: file-backed PGlite retains organizations, agents, and published versions across restart', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-pglite-persist-'));

  try {
    // Session 1: Create organization, draft agent, and publish v1
    const ctx1 = await createDatabaseClient({ dataDir: tempDir });
    assert.equal(ctx1.storageMode, 'file');

    const ready1 = await evaluateDatabaseReadiness(async () => ctx1);
    assert.equal(ready1.databaseReady, true);
    assert.equal(ready1.engine, 'pglite');

    const user = await ensureUser(ctx1.db, {
      authSubject: 'persist-owner-sub',
      email: 'persist-owner@acme.sec',
      displayName: 'Persist Owner',
    });
    const { organization } = await createOrganizationWithOwner(ctx1.db, {
      name: 'Persistent Acme Org',
      slug: 'persistent-acme-org',
      creatorUserId: user.id,
    });

    const ownerActor = {
      userId: user.id,
      organizationId: organization.id,
      role: 'owner' as const,
    };

    const agent = await createAgentDraft(ctx1.db, ownerActor, {
      organizationId: organization.id,
      name: 'Durable Copilot',
      slug: 'durable-copilot',
      description: 'Survives process restart',
      draftSystemPrompt: 'Always cite sources.',
      draftToolAllowlist: ['calculator'],
    });
    const published = await publishAgentVersion(
      ctx1.db,
      ownerActor,
      organization.id,
      agent.id
    );

    await ctx1.close();

    // Verify readiness fails when querying a closed database instance
    const readyClosed = await evaluateDatabaseReadiness(async () => ctx1);
    assert.equal(readyClosed.databaseReady, false);

    // Session 2: Re-open from the same dataDir and verify rows persisted on disk
    const ctx2 = await createDatabaseClient({ dataDir: tempDir });

    const fetchedAgent = await getAgentForActor(
      ctx2.db,
      ownerActor,
      organization.id,
      agent.id
    );
    assert.equal(fetchedAgent.id, agent.id);
    assert.equal(fetchedAgent.slug, 'durable-copilot');
    assert.equal(fetchedAgent.latestVersionNumber, 1);

    const fetchedVersions = await listAgentVersions(
      ctx2.db,
      ownerActor,
      organization.id,
      agent.id
    );
    assert.equal(fetchedVersions.length, 1);
    assert.equal(fetchedVersions[0]?.id, published.version.id);
    assert.equal(fetchedVersions[0]?.snapshotHash, published.version.snapshotHash);

    await ctx2.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Phase E: PostgreSQL composite foreign keys reject direct SQL cross-tenant parent-child inserts', async () => {
  const ctx = await createDatabaseClient();

  try {
    // Provision Tenant A (Acme) and Tenant B (Beta)
    const userA = await ensureUser(ctx.db, {
      authSubject: 'owner-tenant-a-sub',
      email: 'owner@tenant-a.io',
      displayName: 'Owner A',
    });
    const { organization: orgA } = await createOrganizationWithOwner(ctx.db, {
      name: 'Tenant Alpha',
      slug: 'tenant-alpha',
      creatorUserId: userA.id,
    });

    const userB = await ensureUser(ctx.db, {
      authSubject: 'owner-tenant-b-sub',
      email: 'owner@tenant-b.io',
      displayName: 'Owner B',
    });
    const { organization: orgB } = await createOrganizationWithOwner(ctx.db, {
      name: 'Tenant Beta',
      slug: 'tenant-beta',
      creatorUserId: userB.id,
    });

    const actorA = {
      userId: userA.id,
      organizationId: orgA.id,
      role: 'owner' as const,
    };
    const actorB = {
      userId: userB.id,
      organizationId: orgB.id,
      role: 'owner' as const,
    };

    const agentA = await createAgentDraft(ctx.db, actorA, {
      organizationId: orgA.id,
      name: 'Alpha Agent',
      slug: 'alpha-agent',
      draftSystemPrompt: 'Alpha prompt',
      draftToolAllowlist: ['calculator'],
    });
    const { version: versionA } = await publishAgentVersion(
      ctx.db,
      actorA,
      orgA.id,
      agentA.id
    );

    const agentB = await createAgentDraft(ctx.db, actorB, {
      organizationId: orgB.id,
      name: 'Beta Agent',
      slug: 'beta-agent',
      draftSystemPrompt: 'Beta prompt',
      draftToolAllowlist: ['calculator'],
    });
    const { version: versionB } = await publishAgentVersion(
      ctx.db,
      actorB,
      orgB.id,
      agentB.id
    );

    // 1. Attempt to insert an agent_version in Tenant B pointing to Tenant A's agent_id
    await assert.rejects(
      async () => {
        await ctx.pg.query(
          `INSERT INTO agent_versions (
            organization_id, agent_id, version_number, system_prompt, model_config, tool_allowlist, snapshot_hash
          ) VALUES ($1, $2, 99, 'hijack', '{}'::jsonb, '[]'::jsonb, $3)`,
          [orgB.id, agentA.id, 'a'.repeat(64)]
        );
      },
      /agent_versions_org_agent_fk|foreign key constraint/i
    );

    // 2. Attempt to insert a run in Tenant B referencing Tenant A's agent and version
    await assert.rejects(
      async () => {
        await ctx.pg.query(
          `INSERT INTO runs (
            organization_id, agent_id, agent_version_id, status, input_prompt
          ) VALUES ($1, $2, $3, 'queued', 'cross-tenant run attempt')`,
          [orgB.id, agentA.id, versionA.id]
        );
      },
      /runs_org_agent_fk|runs_org_agent_version_fk|foreign key constraint/i
    );

    // 3. Attempt to insert a run in Tenant A where agent_id is agentA, but agent_version_id belongs to agentB
    await assert.rejects(
      async () => {
        await ctx.pg.query(
          `INSERT INTO runs (
            organization_id, agent_id, agent_version_id, status, input_prompt
          ) VALUES ($1, $2, $3, 'queued', 'mismatched version attempt')`,
          [orgA.id, agentA.id, versionB.id]
        );
      },
      /runs_org_agent_version_fk|foreign key constraint/i
    );

    // Insert a valid run in Tenant A so we can test child tables (run_steps, run_events, job_queue, approval_requests, usage_events)
    const validRunRes = await ctx.pg.query<{ id: string }>(
      `INSERT INTO runs (
        organization_id, agent_id, agent_version_id, status, input_prompt
      ) VALUES ($1, $2, $3, 'queued', 'valid tenant A run') RETURNING id`,
      [orgA.id, agentA.id, versionA.id]
    );
    const runAId = validRunRes.rows[0]!.id;

    // 4. Attempt to insert a run_step in Tenant B pointing to Tenant A's run_id
    await assert.rejects(
      async () => {
        await ctx.pg.query(
          `INSERT INTO run_steps (
            organization_id, run_id, step_index, kind, model_or_tool_name
          ) VALUES ($1, $2, 1, 'model_turn', 'mock')`,
          [orgB.id, runAId]
        );
      },
      /run_steps_org_run_fk|foreign key constraint/i
    );

    // 5. Attempt to insert a run_event in Tenant B pointing to Tenant A's run_id
    await assert.rejects(
      async () => {
        await ctx.pg.query(
          `INSERT INTO run_events (
            organization_id, run_id, sequence_no, event_type
          ) VALUES ($1, $2, 1, 'run.queued')`,
          [orgB.id, runAId]
        );
      },
      /run_events_org_run_fk|foreign key constraint/i
    );

    // 6. Attempt to insert a job_queue row in Tenant B pointing to Tenant A's run_id
    await assert.rejects(
      async () => {
        await ctx.pg.query(
          `INSERT INTO job_queue (
            organization_id, run_id, status
          ) VALUES ($1, $2, 'pending')`,
          [orgB.id, runAId]
        );
      },
      /job_queue_org_run_fk|foreign key constraint/i
    );

    // 7. Attempt to insert an approval_request in Tenant B pointing to Tenant A's run_id
    await assert.rejects(
      async () => {
        await ctx.pg.query(
          `INSERT INTO approval_requests (
            organization_id, run_id, node_id, title, reason
          ) VALUES ($1, $2, 'gate-1', 'Cross-tenant approval', 'Should fail FK')`,
          [orgB.id, runAId]
        );
      },
      /approval_requests_org_run_fk|foreign key constraint/i
    );

    // 8. Attempt to insert a usage_event in Tenant B pointing to Tenant A's run_id
    await assert.rejects(
      async () => {
        await ctx.pg.query(
          `INSERT INTO usage_events (
            organization_id, run_id, provider_mode, model_id
          ) VALUES ($1, $2, 'mock', 'aegis-mock-v1')`,
          [orgB.id, runAId]
        );
      },
      /usage_events_org_run_fk|foreign key constraint/i
    );
  } finally {
    await ctx.close();
  }
});
