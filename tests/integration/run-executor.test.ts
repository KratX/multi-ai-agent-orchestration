import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createDatabaseClient } from '../../src/server/db/client';
import {
  createOrganizationWithOwner,
  ensureUser,
} from '../../src/server/db/repositories/tenant-repository';
import {
  createAgentDraft,
  publishAgentVersion,
  updateAgentDraft,
} from '../../src/server/db/repositories/agent-repository';
import {
  claimNextPendingJob,
  enqueueAgentRun,
  executeAgentRun,
  failClaimedJob,
  getRunDetailsForActor,
  listRunEventsAfterSequence,
  processNextQueuedJob,
  recoverExpiredJobLeases,
} from '../../src/server/modules/runs/run-executor';
import { ToolGateway } from '../../src/server/modules/tools/tool-gateway';
import { jobQueue } from '../../src/server/db/schema/runs';
import { AuthorizationError } from '../../src/server/policies/authorization';

/**
 * Tickets RUN-001, RUN-002, QUEUE-001 & QUEUE-002:
 * PostgreSQL Integration Tests for the Bounded Agent Runtime & Job Queue Worker
 */

describe('RUN-001 & RUN-002 & QUEUE-001: Bounded Agent Runtime & PostgreSQL Job Queue', () => {
  it('enqueues a run idempotently, pins immutable v1 snapshot even after draft is edited, and executes multi-step calculator + knowledge_search with verified citations', async () => {
    const ctx = await createDatabaseClient();
    try {
      const user = await ensureUser(ctx.db, {
        authSubject: 'sub_run_operator_1',
        email: 'operator@acme-runs.io',
        displayName: 'Run Operator',
      });
      const { organization, membership } = await createOrganizationWithOwner(
        ctx.db,
        {
          name: 'Acme Run Cloud',
          slug: 'acme-run-cloud',
          creatorUserId: user.id,
        }
      );

      const actor = {
        userId: user.id,
        organizationId: organization.id,
        role: membership.role,
      };

      const draft = await createAgentDraft(ctx.db, actor, {
        organizationId: organization.id,
        name: 'Reliability Incident Copilot',
        slug: 'reliability-incident-copilot',
        draftSystemPrompt: 'You are v1 reliability copilot. Use calculator and knowledge_search.',
        draftToolAllowlist: ['calculator', 'knowledge_search'],
        draftModelConfig: {
          provider: 'mock',
          model: 'aegis-mock-v1',
          temperature: 0,
          maxSteps: 8,
          maxToolCalls: 4,
        },
      });

      const { version: v1 } = await publishAgentVersion(
        ctx.db,
        actor,
        organization.id,
        draft.id
      );

      // Mutate draft after v1 publish to prove active runs remain pinned to immutable v1
      await updateAgentDraft(ctx.db, actor, {
        organizationId: organization.id,
        agentId: draft.id,
        draftSystemPrompt: 'MUTATED DRAFT PROMPT THAT MUST NOT AFFECT V1 RUNS',
        draftToolAllowlist: [],
      });

      // Enqueue run with an idempotencyKey
      const firstEnqueue = await enqueueAgentRun(ctx.db, actor, {
        organizationId: organization.id,
        agentId: draft.id,
        inputPrompt:
          'Calculate (125 * 4) + 50 and check our incident escalation policy [mock:unverified-citation]',
        idempotencyKey: 'idem-key-001',
      });
      assert.equal(firstEnqueue.deduplicated, false);
      assert.equal(firstEnqueue.run.status, 'queued');
      assert.equal(firstEnqueue.run.agentVersionId, v1.id);

      // Calling enqueueAgentRun again with the same idempotencyKey returns the exact same run
      const duplicateEnqueue = await enqueueAgentRun(ctx.db, actor, {
        organizationId: organization.id,
        agentId: draft.id,
        inputPrompt:
          'Calculate (125 * 4) + 50 and check our incident escalation policy [mock:unverified-citation]',
        idempotencyKey: 'idem-key-001',
      });
      assert.equal(duplicateEnqueue.deduplicated, true);
      assert.equal(duplicateEnqueue.run.id, firstEnqueue.run.id);
      assert.equal(duplicateEnqueue.job.id, firstEnqueue.job.id);

      // Configure ToolGateway with a tenant-scoped knowledge retriever
      const toolGateway = new ToolGateway({
        knowledgeSearchRetriever: async ({ organizationId: retrievedOrgId, query }) => {
          assert.equal(retrievedOrgId, organization.id);
          return [
            {
              chunkId: 'chunk_sev1_policy',
              documentId: 'doc_sev1_runbook',
              documentTitle: 'SEV-1 Incident Escalation Runbook',
              content: `For query "${query}", page the on-call SRE within 5 minutes.`,
              score: 0.96,
            },
          ];
        },
      });

      // Process the queued job via the PostgreSQL FOR UPDATE SKIP LOCKED worker
      const processed = await processNextQueuedJob(ctx.db, {
        workerId: 'worker-test-1',
        toolGateway,
      });

      assert.ok(processed);
      assert.equal(processed.run.id, firstEnqueue.run.id);
      assert.equal(processed.run.status, 'succeeded');
      assert.equal(processed.job.status, 'completed');
      assert.equal(processed.run.toolCallCount, 2);
      assert.equal(processed.run.stepCount, 4); // model_turn -> calculator -> knowledge_search -> final_answer
      assert.ok(processed.run.finalOutput?.includes('Calculation result: 550.'));
      assert.ok(
        processed.run.finalOutput?.includes('SEV-1 Incident Escalation Runbook')
      );

      // Verify that the fabricated citation from [mock:unverified-citation] was stripped
      // and only the real retrieved chunk_sev1_policy citation was persisted
      assert.equal(processed.run.citations.length, 1);
      assert.equal(processed.run.citations[0]?.chunkId, 'chunk_sev1_policy');
      assert.equal(
        processed.run.citations[0]?.documentTitle,
        'SEV-1 Incident Escalation Runbook'
      );

      // Inspect full run trace and SSE event replay
      const details = await getRunDetailsForActor(
        ctx.db,
        actor,
        organization.id,
        processed.run.id
      );
      assert.equal(details.steps.length, 4);
      assert.deepEqual(
        details.steps.map((s) => s.kind),
        ['model_turn', 'tool_call', 'tool_call', 'final_answer']
      );

      const replayedEvents = await listRunEventsAfterSequence(
        ctx.db,
        actor,
        organization.id,
        processed.run.id,
        2
      );
      assert.ok(replayedEvents.length >= 4);
      assert.equal(replayedEvents[0]?.sequenceNo, 3);
      assert.equal(
        replayedEvents[replayedEvents.length - 1]?.eventType,
        'run.succeeded'
      );
    } finally {
      await ctx.close();
    }
  });

  it('enforces Threat T-03 (unauthorized tool call denial) and Threat T-04 (maxSteps loop guard)', async () => {
    const ctx = await createDatabaseClient();
    try {
      const user = await ensureUser(ctx.db, {
        authSubject: 'sub_security_eng_1',
        email: 'security@acme-runs.io',
        displayName: 'Security Engineer',
      });
      const { organization, membership } = await createOrganizationWithOwner(
        ctx.db,
        {
          name: 'Acme Security Org',
          slug: 'acme-security-org',
          creatorUserId: user.id,
        }
      );

      const actor = {
        userId: user.id,
        organizationId: organization.id,
        role: membership.role,
      };

      const draft = await createAgentDraft(ctx.db, actor, {
        organizationId: organization.id,
        name: 'Locked Down Agent',
        slug: 'locked-down-agent',
        draftSystemPrompt: 'Strictly bounded agent.',
        draftToolAllowlist: ['calculator'],
        draftModelConfig: {
          provider: 'mock',
          model: 'aegis-mock-v1',
          temperature: 0,
          maxSteps: 3,
          maxToolCalls: 4,
        },
      });

      await publishAgentVersion(ctx.db, actor, organization.id, draft.id);

      // 1. Trigger [mock:unauthorized-tool] -> attempts shell_exec which is not registered/allowed
      const unauthRun = await enqueueAgentRun(ctx.db, actor, {
        organizationId: organization.id,
        agentId: draft.id,
        inputPrompt: 'Attempt unauthorized shell tool [mock:unauthorized-tool]',
      });

      const unauthResult = await executeAgentRun(ctx.db, unauthRun.run.id);
      assert.equal(unauthResult.status, 'failed');
      assert.equal(unauthResult.errorCode, 'UNKNOWN_TOOL');
      assert.ok(unauthResult.errorMessage?.includes('shell_exec'));

      // 2. Trigger [mock:infinite-loop] -> hits maxSteps: 3 ceiling (Threat T-04)
      const loopRun = await enqueueAgentRun(ctx.db, actor, {
        organizationId: organization.id,
        agentId: draft.id,
        inputPrompt: 'Trigger infinite loop [mock:infinite-loop]',
      });

      const loopResult = await executeAgentRun(ctx.db, loopRun.run.id);
      assert.equal(loopResult.status, 'failed');
      assert.equal(loopResult.errorCode, 'MAX_STEPS_EXCEEDED');
      assert.equal(loopResult.stepCount, 3);
    } finally {
      await ctx.close();
    }
  });

  it('enforces cross-tenant 404 isolation on runs and recovers expired job_queue leases into pending or dead_letter (ADR-003)', async () => {
    const ctx = await createDatabaseClient();
    try {
      const userA = await ensureUser(ctx.db, {
        authSubject: 'sub_tenant_a_owner',
        email: 'tenant-a@aegis.io',
        displayName: 'Tenant A Owner',
      });
      const orgA = await createOrganizationWithOwner(ctx.db, {
        name: 'Tenant A',
        slug: 'tenant-a',
        creatorUserId: userA.id,
      });
      const actorA = {
        userId: userA.id,
        organizationId: orgA.organization.id,
        role: orgA.membership.role,
      };

      const userB = await ensureUser(ctx.db, {
        authSubject: 'sub_tenant_b_owner',
        email: 'tenant-b@aegis.io',
        displayName: 'Tenant B Owner',
      });
      const orgB = await createOrganizationWithOwner(ctx.db, {
        name: 'Tenant B',
        slug: 'tenant-b',
        creatorUserId: userB.id,
      });
      const actorB = {
        userId: userB.id,
        organizationId: orgB.organization.id,
        role: orgB.membership.role,
      };

      const draftA = await createAgentDraft(ctx.db, actorA, {
        organizationId: orgA.organization.id,
        name: 'Tenant A Agent',
        slug: 'tenant-a-agent',
        draftSystemPrompt: 'Tenant A system prompt.',
        draftToolAllowlist: ['calculator'],
      });
      await publishAgentVersion(ctx.db, actorA, orgA.organization.id, draftA.id);

      const enqueued = await enqueueAgentRun(ctx.db, actorA, {
        organizationId: orgA.organization.id,
        agentId: draftA.id,
        inputPrompt: 'Simple prompt for queue recovery test',
        maxAttempts: 2,
      });

      // Tenant B must receive 404 when attempting to view Tenant A's run (Threat T-01)
      await assert.rejects(
        async () => {
          await getRunDetailsForActor(
            ctx.db,
            actorB,
            orgA.organization.id,
            enqueued.run.id
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof AuthorizationError);
          assert.equal(err.statusCode, 404);
          return true;
        }
      );

      // Claim the job with a -1000ms lease so it is immediately expired (attempt 1 of 2)
      const claimed1 = await claimNextPendingJob(ctx.db, 'worker-crashed-1', -1000);
      assert.ok(claimed1);
      assert.equal(claimed1.id, enqueued.job.id);
      assert.equal(claimed1.status, 'locked');
      assert.equal(claimed1.attempts, 1);

      // Recover expired lease -> should transition back to 'pending' because attempts (1) < maxAttempts (2)
      const recovery1 = await recoverExpiredJobLeases(ctx.db);
      assert.equal(recovery1.requeuedCount, 1);
      assert.equal(recovery1.deadLetteredCount, 0);

      // Claim again (attempt 2 of 2) and fail it -> should transition to 'dead_letter'
      const claimed2 = await claimNextPendingJob(ctx.db, 'worker-2', 30_000);
      assert.ok(claimed2);
      assert.equal(claimed2.attempts, 2);

      const deadLettered = await failClaimedJob(
        ctx.db,
        claimed2.id,
        'Simulated unrecoverable worker crash'
      );
      assert.equal(deadLettered.status, 'dead_letter');

      const [verifyRow] = await ctx.db
        .select()
        .from(jobQueue)
        .where(eq(jobQueue.id, enqueued.job.id));
      assert.equal(verifyRow?.status, 'dead_letter');
    } finally {
      await ctx.close();
    }
  });
});
