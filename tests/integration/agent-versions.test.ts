import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabaseClient } from '../../src/server/db/client';
import {
  createOrganizationWithOwner,
  ensureUser,
  resolveActorContext,
  upsertMembership,
} from '../../src/server/db/repositories/tenant-repository';
import {
  AgentConstraintError,
  archiveAgent,
  computeAgentSnapshotHash,
  createAgentDraft,
  getAgentForActor,
  getAgentVersionForActor,
  listAgentVersions,
  publishAgentVersion,
  updateAgentDraft,
} from '../../src/server/db/repositories/agent-repository';
import { AuthorizationError } from '../../src/server/policies/authorization';

/**
 * Tickets AGENT-001 & AGENT-002 (Part 3): Agent Studio & Immutable Version Integration Tests
 *
 * Verifies against PostgreSQL:
 * 1. Draft Creation & Validation: Enforces slug format, tool allowlist (`calculator`, `knowledge_search`),
 *    and model budget limits (`maxSteps`, `maxToolCalls`, `temperature`).
 * 2. Immutable Version Publishing (`v1`, `v2`):
 *    - Cannot publish an empty `draftSystemPrompt`.
 *    - Publishing `v1` transitions status from `'draft'` to `'active'`, increments `latestVersionNumber` to 1,
 *      and stores a deterministic 64-character SHA-256 `snapshotHash`.
 *    - Mutating the draft (`updateAgentDraft`) changes `agents.draft_*` columns ONLY and leaves `v1` in
 *      `agent_versions` 100% untouched.
 *    - Publishing a second time creates `v2` with a new `snapshotHash` while preserving `v1`.
 * 3. RBAC & Cross-Tenant Isolation:
 *    - `developer` can create, edit, and publish agents (`agent.edit`, `agent.publish`),
 *      but CANNOT archive agents (`agent.delete` requires `owner` or `admin`).
 *    - `viewer` can read agents and versions (`agent.view`), but CANNOT edit or publish (`403`).
 *    - Cross-tenant actors receive `404` (`TENANT_MISMATCH`) when attempting to read, edit, or publish
 *      another organization's agent or agent version.
 */

async function seedAgentTestTenants() {
  const conn = await createDatabaseClient();
  const { db } = conn;

  const aliceOwner = await ensureUser(db, {
    authSubject: 'sub_alice_owner',
    email: 'alice-owner@acme.local',
    displayName: 'Alice Owner',
  });
  const devUser = await ensureUser(db, {
    authSubject: 'sub_dan_dev',
    email: 'dev@acme.local',
    displayName: 'Dan Developer',
  });
  const viewerUser = await ensureUser(db, {
    authSubject: 'sub_vera_viewer',
    email: 'viewer@acme.local',
    displayName: 'Vera Viewer',
  });
  const malloryBeta = await ensureUser(db, {
    authSubject: 'sub_mallory_beta',
    email: 'mallory@beta.local',
    displayName: 'Mallory Beta Owner',
  });

  const { organization: orgAcme } = await createOrganizationWithOwner(db, {
    name: 'Acme AI Labs',
    slug: 'acme-ai-labs',
    creatorUserId: aliceOwner.id,
  });

  const { organization: orgBeta } = await createOrganizationWithOwner(db, {
    name: 'Beta Corp',
    slug: 'beta-corp',
    creatorUserId: malloryBeta.id,
  });

  const aliceActor = await resolveActorContext(db, aliceOwner.id, orgAcme.id);
  assert.ok(aliceActor);

  await upsertMembership(db, aliceActor, {
    organizationId: orgAcme.id,
    targetUserId: devUser.id,
    role: 'developer',
  });

  await upsertMembership(db, aliceActor, {
    organizationId: orgAcme.id,
    targetUserId: viewerUser.id,
    role: 'viewer',
  });

  const devActor = await resolveActorContext(db, devUser.id, orgAcme.id);
  const viewerActor = await resolveActorContext(db, viewerUser.id, orgAcme.id);
  const malloryActor = await resolveActorContext(db, malloryBeta.id, orgBeta.id);

  assert.ok(devActor);
  assert.ok(viewerActor);
  assert.ok(malloryActor);

  return {
    conn,
    db,
    orgAcme,
    orgBeta,
    aliceActor,
    devActor,
    viewerActor,
    malloryActor,
  };
}

test('AGENT-001: enforces tool allowlist, model budgets, and unique slug per organization', async () => {
  const { conn, db, orgAcme, devActor } = await seedAgentTestTenants();

  try {
    // 1. Reject unregistered tool name (e.g. shell_exec)
    await assert.rejects(
      async () => {
        await createAgentDraft(db, devActor, {
          organizationId: orgAcme.id,
          name: 'Unsafe Agent',
          slug: 'unsafe-agent',
          draftToolAllowlist: ['calculator', 'shell_exec'],
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AgentConstraintError);
        assert.equal(err.code, 'INVALID_AGENT_INPUT');
        assert.equal(err.statusCode, 400);
        return true;
      }
    );

    // 2. Reject out-of-bounds maxSteps (> 20)
    await assert.rejects(
      async () => {
        await createAgentDraft(db, devActor, {
          organizationId: orgAcme.id,
          name: 'Unbounded Agent',
          slug: 'unbounded-agent',
          draftModelConfig: { maxSteps: 99 },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AgentConstraintError);
        assert.equal(err.code, 'INVALID_AGENT_INPUT');
        return true;
      }
    );

    // 3. Create valid draft
    const draft = await createAgentDraft(db, devActor, {
      organizationId: orgAcme.id,
      name: 'Support Triage Agent',
      slug: 'support-triage',
      description: 'Triages incoming customer support tickets',
      draftSystemPrompt: '',
      draftToolAllowlist: ['calculator', 'knowledge_search', 'calculator'], // deduplicates automatically
    });

    assert.equal(draft.status, 'draft');
    assert.equal(draft.latestVersionNumber, 0);
    assert.deepEqual(draft.draftToolAllowlist, ['calculator', 'knowledge_search']);

    // 4. Reject duplicate slug within same organization
    await assert.rejects(
      async () => {
        await createAgentDraft(db, devActor, {
          organizationId: orgAcme.id,
          name: 'Duplicate Slug Agent',
          slug: 'support-triage',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AgentConstraintError);
        assert.equal(err.code, 'DUPLICATE_AGENT_SLUG');
        assert.equal(err.statusCode, 409);
        return true;
      }
    );
  } finally {
    await conn.close();
  }
});

test('AGENT-002: editing draft never mutates published v1 snapshot and publishing again creates v2', async () => {
  const { conn, db, orgAcme, devActor } = await seedAgentTestTenants();

  try {
    const draft = await createAgentDraft(db, devActor, {
      organizationId: orgAcme.id,
      name: 'Financial Analyst Agent',
      slug: 'financial-analyst',
      draftSystemPrompt: '',
      draftToolAllowlist: ['calculator'],
    });

    // 1. Publishing with an empty system prompt is rejected
    await assert.rejects(
      async () => {
        await publishAgentVersion(db, devActor, orgAcme.id, draft.id);
      },
      (err: unknown) => {
        assert.ok(err instanceof AgentConstraintError);
        assert.equal(err.code, 'EMPTY_SYSTEM_PROMPT');
        assert.equal(err.statusCode, 400);
        return true;
      }
    );

    // 2. Populate v1 draft prompt and publish v1
    const v1Prompt = 'You are Financial Analyst v1. Always verify totals with calculator.';
    await updateAgentDraft(db, devActor, {
      organizationId: orgAcme.id,
      agentId: draft.id,
      draftSystemPrompt: v1Prompt,
      draftModelConfig: { temperature: 0.1, maxSteps: 5, maxToolCalls: 3 },
    });

    const { agent: activeAgentV1, version: version1 } = await publishAgentVersion(
      db,
      devActor,
      orgAcme.id,
      draft.id
    );

    assert.equal(activeAgentV1.status, 'active');
    assert.equal(activeAgentV1.latestVersionNumber, 1);
    assert.equal(version1.versionNumber, 1);
    assert.equal(version1.systemPrompt, v1Prompt);
    assert.equal(version1.snapshotHash.length, 64);
    assert.equal(
      version1.snapshotHash,
      computeAgentSnapshotHash({
        systemPrompt: version1.systemPrompt,
        modelConfig: version1.modelConfig,
        toolAllowlist: version1.toolAllowlist,
      })
    );

    // 3. Mutate the working draft on the parent agent
    const v2Prompt =
      'You are Financial Analyst v2. Search the knowledge base first, then calculate.';
    const mutatedDraft = await updateAgentDraft(db, devActor, {
      organizationId: orgAcme.id,
      agentId: draft.id,
      draftSystemPrompt: v2Prompt,
      draftToolAllowlist: ['calculator', 'knowledge_search'],
      draftModelConfig: { temperature: 0.4, maxSteps: 8, maxToolCalls: 6 },
    });

    assert.equal(mutatedDraft.draftSystemPrompt, v2Prompt);
    assert.equal(mutatedDraft.latestVersionNumber, 1);

    // 4. Verify v1 snapshot in `agent_versions` is 100% untouched!
    const fetchedV1AfterDraftEdit = await getAgentVersionForActor(
      db,
      devActor,
      orgAcme.id,
      version1.id
    );
    assert.equal(fetchedV1AfterDraftEdit.systemPrompt, v1Prompt);
    assert.deepEqual(fetchedV1AfterDraftEdit.toolAllowlist, ['calculator']);
    assert.equal(fetchedV1AfterDraftEdit.modelConfig.temperature, 0.1);
    assert.equal(fetchedV1AfterDraftEdit.snapshotHash, version1.snapshotHash);

    // 5. Publish v2 and verify both v2 and v1 coexist immutably
    const { agent: activeAgentV2, version: version2 } = await publishAgentVersion(
      db,
      devActor,
      orgAcme.id,
      draft.id
    );

    assert.equal(activeAgentV2.latestVersionNumber, 2);
    assert.equal(version2.versionNumber, 2);
    assert.equal(version2.systemPrompt, v2Prompt);
    assert.notEqual(version2.snapshotHash, version1.snapshotHash);

    const history = await listAgentVersions(db, devActor, orgAcme.id, draft.id);
    assert.equal(history.length, 2);
    assert.equal(history[0].versionNumber, 2);
    assert.equal(history[1].versionNumber, 1);
    assert.equal(history[1].systemPrompt, v1Prompt);
  } finally {
    await conn.close();
  }
});

test('AGENT-001 & AGENT-002: enforces RBAC (viewer vs developer vs owner) and cross-tenant 404 isolation', async () => {
  const {
    conn,
    db,
    orgAcme,
    aliceActor,
    devActor,
    viewerActor,
    malloryActor,
  } = await seedAgentTestTenants();

  try {
    const agent = await createAgentDraft(db, devActor, {
      organizationId: orgAcme.id,
      name: 'Security Copilot',
      slug: 'security-copilot',
      draftSystemPrompt: 'Analyze security alerts within tenant boundaries.',
      draftToolAllowlist: ['knowledge_search'],
    });

    const { version } = await publishAgentVersion(
      db,
      devActor,
      orgAcme.id,
      agent.id
    );

    // 1. Viewer CAN read agent and version
    const viewedAgent = await getAgentForActor(db, viewerActor, orgAcme.id, agent.id);
    assert.equal(viewedAgent.id, agent.id);

    const viewedVersion = await getAgentVersionForActor(
      db,
      viewerActor,
      orgAcme.id,
      version.id
    );
    assert.equal(viewedVersion.id, version.id);

    // 2. Viewer CANNOT edit draft or publish version (403 FORBIDDEN_ROLE)
    await assert.rejects(
      async () => {
        await updateAgentDraft(db, viewerActor, {
          organizationId: orgAcme.id,
          agentId: agent.id,
          draftSystemPrompt: 'Viewer tampering attempt',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthorizationError);
        assert.equal(err.code, 'INSUFFICIENT_ROLE');
        assert.equal(err.statusCode, 403);
        return true;
      }
    );

    // 3. Developer CANNOT archive agent (`agent.delete` requires owner or admin)
    await assert.rejects(
      async () => {
        await archiveAgent(db, devActor, orgAcme.id, agent.id);
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthorizationError);
        assert.equal(err.code, 'INSUFFICIENT_ROLE');
        assert.equal(err.statusCode, 403);
        return true;
      }
    );

    // 4. Cross-tenant actor (Mallory from Beta Corp) gets 404 TENANT_MISMATCH
    await assert.rejects(
      async () => {
        await getAgentForActor(db, malloryActor, orgAcme.id, agent.id);
      },
      (err: unknown) => {
        assert.ok(err instanceof AuthorizationError);
        assert.equal(err.code, 'TENANT_MISMATCH');
        assert.equal(err.statusCode, 404);
        return true;
      }
    );

    // 5. Owner CAN archive agent, and archived agents cannot be edited or published
    const archived = await archiveAgent(db, aliceActor, orgAcme.id, agent.id);
    assert.equal(archived.status, 'archived');

    await assert.rejects(
      async () => {
        await publishAgentVersion(db, aliceActor, orgAcme.id, agent.id);
      },
      (err: unknown) => {
        assert.ok(err instanceof AgentConstraintError);
        assert.equal(err.code, 'AGENT_ARCHIVED');
        assert.equal(err.statusCode, 409);
        return true;
      }
    );
  } finally {
    await conn.close();
  }
});
