import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import type { AegisDatabase } from '../../db/client';
import {
  agents,
  agentVersions,
  type AgentVersionRow,
} from '../../db/schema/agents';
import {
  jobQueue,
  runEvents,
  runs,
  runSteps,
  type JobQueueRow,
  type RunEventRow,
  type RunEventType,
  type RunRow,
  type RunStepRow,
} from '../../db/schema/runs';
import { usageEvents } from '../../db/schema/workflows';
import { computeAgentSnapshotHash } from '../../db/repositories/agent-repository';
import {
  requireAuthorization,
  type AuthenticatedActor,
} from '../../policies/authorization';
import {
  extractRetrievedChunksFromMessages,
  MockModelProvider,
  verifyModelCitations,
  type ModelCitation,
  type ModelMessage,
  type ModelProvider,
} from '../../ai/model-provider';
import {
  ToolAuthorizationError,
  ToolExecutionError,
  ToolGateway,
} from '../tools/tool-gateway';
import { createTenantKnowledgeRetriever } from '../knowledge/knowledge-service';

/**
 * Tickets RUN-002 & QUEUE-002: Bounded Agent Runtime Executor & PostgreSQL Job Queue Worker
 *
 * Implements Blueprint Section 5.3, Section 6.1, Section 7 & ADR-003:
 * 1. `enqueueAgentRun()`: Atomic PostgreSQL transaction creating `runs` + `job_queue` +
 *    initial `run.queued` event, pinned to an immutable `agent_versions` snapshot and
 *    deduplicated by `(organization_id, idempotency_key)`.
 * 2. `claimNextPendingJob()` & `recoverExpiredJobLeases()`: `FOR UPDATE SKIP LOCKED`
 *    worker lease acquisition, exponential backoff retry, and dead-letter transition.
 * 3. `executeAgentRun()`: Bounded step & tool-call execution loop that reads ONLY the
 *    pinned `agent_versions` snapshot (verifying its SHA-256 `snapshot_hash`), routes
 *    all tool calls through `ToolGateway`, verifies grounded citations via
 *    `verifyModelCitations()`, appends monotonic `run_steps` + `run_events`, and
 *    enforces step, tool-call, cancellation, and wall-clock timeout guardrails (`T-03`, `T-04`).
 */

export const DEFAULT_RUN_MAX_STEPS = 10;
export const DEFAULT_RUN_MAX_TOOL_CALLS = 6;
export const DEFAULT_RUN_TIMEOUT_MS = 30_000;
export const DEFAULT_JOB_LEASE_MS = 30_000;

export type RunErrorCode =
  | 'RUN_NOT_FOUND'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_NOT_PUBLISHED'
  | 'AGENT_VERSION_NOT_FOUND'
  | 'SNAPSHOT_INTEGRITY_ERROR'
  | 'INVALID_RUN_INPUT'
  | 'RUN_ALREADY_TERMINAL'
  | 'MAX_STEPS_EXCEEDED'
  | 'MAX_TOOL_CALLS_EXCEEDED'
  | 'RUN_TIMEOUT_EXCEEDED'
  | 'TOOL_NOT_ALLOWED_FOR_AGENT'
  | 'UNKNOWN_TOOL'
  | 'TOOL_EXECUTION_ERROR'
  | 'MODEL_EXECUTION_ERROR';

export class RunConstraintError extends Error {
  public readonly code: RunErrorCode;
  public readonly statusCode: 400 | 403 | 404 | 409 | 422;

  constructor(
    code: RunErrorCode,
    message: string,
    statusCode: 400 | 403 | 404 | 409 | 422 = 400
  ) {
    super(message);
    this.name = 'RunConstraintError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface EnqueueAgentRunInput {
  organizationId: string;
  agentId: string;
  agentVersionId?: string;
  inputPrompt: string;
  idempotencyKey?: string;
  maxAttempts?: number;
}

export interface EnqueueAgentRunResult {
  run: RunRow;
  job: JobQueueRow;
  deduplicated: boolean;
}

export interface ExecuteAgentRunOptions {
  modelProvider?: ModelProvider;
  toolGateway?: ToolGateway;
  maxStepsCeiling?: number;
  maxToolCallsCeiling?: number;
  timeoutMs?: number;
}

export interface ProcessNextJobOptions extends ExecuteAgentRunOptions {
  workerId?: string;
  leaseDurationMs?: number;
}

export interface RunDetailsResult {
  run: RunRow;
  version: AgentVersionRow;
  steps: RunStepRow[];
  events: RunEventRow[];
}

async function appendRunEvent(
  txOrDb: AegisDatabase,
  params: {
    organizationId: string;
    runId: string;
    eventType: RunEventType;
    payload: Record<string, unknown>;
  }
): Promise<RunEventRow> {
  const existing = await txOrDb
    .select({
      maxSeq: sql<number>`coalesce(max(${runEvents.sequenceNo}), 0)::int`,
    })
    .from(runEvents)
    .where(eq(runEvents.runId, params.runId));

  const nextSequenceNo = (existing[0]?.maxSeq ?? 0) + 1;

  const [createdEvent] = await txOrDb
    .insert(runEvents)
    .values({
      organizationId: params.organizationId,
      runId: params.runId,
      sequenceNo: nextSequenceNo,
      eventType: params.eventType,
      payload: params.payload,
    })
    .returning();

  return createdEvent!;
}

/**
 * Atomically enqueues a new Agent Run (`runs` + `job_queue` + `run.queued` event).
 * Enforces RBAC (`run.create`), tenant isolation, immutable `agent_versions` pinning,
 * and idempotent deduplication when `(organizationId, idempotencyKey)` is repeated.
 */
export async function enqueueAgentRun(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  input: EnqueueAgentRunInput
): Promise<EnqueueAgentRunResult> {
  requireAuthorization(actor, 'run.start', {
    organizationId: input.organizationId,
    resourceType: 'run',
  });

  const cleanPrompt = input.inputPrompt.trim();
  if (cleanPrompt.length === 0) {
    throw new RunConstraintError(
      'INVALID_RUN_INPUT',
      'Run inputPrompt must not be empty.',
      400
    );
  }

  const cleanIdempotencyKey = input.idempotencyKey?.trim() || null;

  return db.transaction(async (tx) => {
    // 1. Check idempotency key deduplication within the organization
    if (cleanIdempotencyKey) {
      const existingRuns = await tx
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.organizationId, input.organizationId),
            eq(runs.idempotencyKey, cleanIdempotencyKey)
          )
        )
        .limit(1);

      if (existingRuns.length > 0) {
        const existingRun = existingRuns[0]!;
        const existingJobs = await tx
          .select()
          .from(jobQueue)
          .where(eq(jobQueue.runId, existingRun.id))
          .limit(1);

        return {
          run: existingRun,
          job: existingJobs[0]!,
          deduplicated: true,
        };
      }
    }

    // 2. Verify agent belongs to organizationId
    const agentRows = await tx
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.id, input.agentId),
          eq(agents.organizationId, input.organizationId)
        )
      )
      .limit(1);

    if (agentRows.length === 0) {
      throw new RunConstraintError(
        'AGENT_NOT_FOUND',
        `Agent ${input.agentId} was not found in organization ${input.organizationId}.`,
        404
      );
    }

    const agent = agentRows[0]!;

    // 3. Resolve the pinned immutable `agent_versions` row
    let targetVersion: AgentVersionRow | undefined;

    if (input.agentVersionId) {
      const versionRows = await tx
        .select()
        .from(agentVersions)
        .where(
          and(
            eq(agentVersions.id, input.agentVersionId),
            eq(agentVersions.agentId, agent.id),
            eq(agentVersions.organizationId, input.organizationId)
          )
        )
        .limit(1);

      targetVersion = versionRows[0];
      if (!targetVersion) {
        throw new RunConstraintError(
          'AGENT_VERSION_NOT_FOUND',
          `Agent version ${input.agentVersionId} was not found for agent ${agent.id}.`,
          404
        );
      }
    } else {
      if (agent.latestVersionNumber < 1) {
        throw new RunConstraintError(
          'AGENT_NOT_PUBLISHED',
          `Agent "${agent.slug}" has no published immutable version yet. Publish a version before creating a run.`,
          409
        );
      }

      const latestRows = await tx
        .select()
        .from(agentVersions)
        .where(
          and(
            eq(agentVersions.agentId, agent.id),
            eq(agentVersions.organizationId, input.organizationId),
            eq(agentVersions.versionNumber, agent.latestVersionNumber)
          )
        )
        .limit(1);

      targetVersion = latestRows[0];
      if (!targetVersion) {
        throw new RunConstraintError(
          'AGENT_VERSION_NOT_FOUND',
          `Latest version v${agent.latestVersionNumber} was not found for agent ${agent.id}.`,
          404
        );
      }
    }

    // 4. Insert `runs` row pinned to `targetVersion.id`
    const [createdRun] = await tx
      .insert(runs)
      .values({
        organizationId: input.organizationId,
        agentId: agent.id,
        agentVersionId: targetVersion.id,
        status: 'queued',
        inputPrompt: cleanPrompt,
        idempotencyKey: cleanIdempotencyKey,
        createdByUserId: actor!.userId,
      })
      .returning();

    // 5. Insert `job_queue` row for asynchronous worker claiming
    const [createdJob] = await tx
      .insert(jobQueue)
      .values({
        organizationId: input.organizationId,
        runId: createdRun!.id,
        jobType: 'agent_run',
        status: 'pending',
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
      })
      .returning();

    // 6. Emit initial `run.queued` event (`sequence_no = 1`)
    await appendRunEvent(tx, {
      organizationId: input.organizationId,
      runId: createdRun!.id,
      eventType: 'run.queued',
      payload: {
        runId: createdRun!.id,
        agentId: agent.id,
        agentVersionId: targetVersion.id,
        versionNumber: targetVersion.versionNumber,
        snapshotHash: targetVersion.snapshotHash,
      },
    });

    return {
      run: createdRun!,
      job: createdJob!,
      deduplicated: false,
    };
  });
}

/**
 * Claims the next available `'pending'` job in PostgreSQL using `FOR UPDATE SKIP LOCKED` (`ADR-003`).
 * Increments `attempts`, sets `status = 'locked'`, and assigns a lease expiration timestamp.
 */
export async function claimNextPendingJob(
  db: AegisDatabase,
  workerId = 'worker-local-1',
  leaseDurationMs = DEFAULT_JOB_LEASE_MS
): Promise<JobQueueRow | null> {
  const result = await db.execute(sql`
    UPDATE job_queue
    SET
      status = 'locked',
      attempts = attempts + 1,
      locked_at = now(),
      locked_by = ${workerId},
      lease_expires_at = now() + (${leaseDurationMs} * interval '1 millisecond'),
      updated_at = now()
    WHERE id = (
      SELECT id
      FROM job_queue
      WHERE status = 'pending'
        AND available_at <= now()
      ORDER BY available_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id
  `);

  const rows = (result as unknown as { rows?: Array<{ id: string }> }).rows ?? [];
  if (rows.length === 0) {
    return null;
  }

  const claimedId = rows[0]!.id;
  const [claimedJob] = await db
    .select()
    .from(jobQueue)
    .where(eq(jobQueue.id, claimedId))
    .limit(1);

  return claimedJob ?? null;
}

/**
 * Recovers jobs stuck in `'locked'` state past `lease_expires_at` (`ADR-003`).
 * Transitions jobs with remaining attempts back to `'pending'` and exhausted jobs to `'dead_letter'`.
 */
export async function recoverExpiredJobLeases(
  db: AegisDatabase
): Promise<{ requeuedCount: number; deadLetteredCount: number }> {
  const requeued = await db.execute(sql`
    UPDATE job_queue
    SET
      status = 'pending',
      locked_at = NULL,
      locked_by = NULL,
      lease_expires_at = NULL,
      last_error = COALESCE(last_error, 'Worker lease expired; requeued automatically.'),
      updated_at = now()
    WHERE status = 'locked'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= now()
      AND attempts < max_attempts
    RETURNING id
  `);

  const deadLettered = await db.execute(sql`
    UPDATE job_queue
    SET
      status = 'dead_letter',
      lease_expires_at = NULL,
      last_error = COALESCE(last_error, 'Worker lease expired after maximum attempts.'),
      updated_at = now()
    WHERE status = 'locked'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= now()
      AND attempts >= max_attempts
    RETURNING id
  `);

  const requeuedRows =
    (requeued as unknown as { rows?: Array<{ id: string }> }).rows ?? [];
  const deadLetteredRows =
    (deadLettered as unknown as { rows?: Array<{ id: string }> }).rows ?? [];

  return {
    requeuedCount: requeuedRows.length,
    deadLetteredCount: deadLetteredRows.length,
  };
}

/**
 * Marks a claimed job as failed and either schedules an exponential-backoff retry
 * (`status = 'pending'`) or transitions it to `'dead_letter'` when `attempts >= maxAttempts`.
 */
export async function failClaimedJob(
  db: AegisDatabase,
  jobId: string,
  errorMessage: string,
  retryBackoffMs = 0
): Promise<JobQueueRow> {
  const [job] = await db
    .select()
    .from(jobQueue)
    .where(eq(jobQueue.id, jobId))
    .limit(1);

  if (!job) {
    throw new Error(`Job ${jobId} not found in job_queue.`);
  }

  const exhausted = job.attempts >= job.maxAttempts;
  const nextStatus = exhausted ? 'dead_letter' : 'pending';
  const nextAvailableAt = new Date(Date.now() + Math.max(0, retryBackoffMs));

  const [updated] = await db
    .update(jobQueue)
    .set({
      status: nextStatus,
      availableAt: nextAvailableAt,
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
      lastError: errorMessage,
      updatedAt: new Date(),
    })
    .where(eq(jobQueue.id, jobId))
    .returning();

  return updated!;
}

/**
 * Executes the bounded agent runtime loop for `runId` (`RUN-002`).
 *
 * Key Guarantees:
 * - Reads ONLY the immutable `agent_versions` snapshot pinned on `runs.agent_version_id`.
 * - Cryptographically verifies `snapshotHash` before executing.
 * - Enforces `maxSteps`, `maxToolCalls`, and `timeoutMs` (`Threat T-04`).
 * - Routes every tool call through `ToolGateway` (`Threat T-03` & `Threat T-02`).
 * - Strips fabricated citations via `verifyModelCitations()`.
 * - Records every step in `run_steps` and emits monotonic `run_events`.
 */
export async function executeAgentRun(
  db: AegisDatabase,
  runId: string,
  options: ExecuteAgentRunOptions = {}
): Promise<RunRow> {
  const modelProvider = options.modelProvider ?? new MockModelProvider();
  const toolGateway =
    options.toolGateway ??
    new ToolGateway({
      knowledgeSearchRetriever: createTenantKnowledgeRetriever(db, {
        modelProvider,
      }),
    });
  const maxStepsCeiling = options.maxStepsCeiling ?? DEFAULT_RUN_MAX_STEPS;
  const maxToolCallsCeiling =
    options.maxToolCallsCeiling ?? DEFAULT_RUN_MAX_TOOL_CALLS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

  const runRows = await db
    .select()
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  if (runRows.length === 0) {
    throw new RunConstraintError(
      'RUN_NOT_FOUND',
      `Run ${runId} was not found.`,
      404
    );
  }

  const initialRun = runRows[0]!;

  if (
    initialRun.status === 'succeeded' ||
    initialRun.status === 'failed' ||
    initialRun.status === 'cancelled' ||
    initialRun.status === 'timed_out'
  ) {
    return initialRun;
  }

  // Load pinned immutable agent_versions snapshot
  const versionRows = await db
    .select()
    .from(agentVersions)
    .where(
      and(
        eq(agentVersions.id, initialRun.agentVersionId),
        eq(agentVersions.organizationId, initialRun.organizationId)
      )
    )
    .limit(1);

  if (versionRows.length === 0) {
    throw new RunConstraintError(
      'AGENT_VERSION_NOT_FOUND',
      `Pinned agent version ${initialRun.agentVersionId} was not found.`,
      404
    );
  }

  const snapshot = versionRows[0]!;

  // Verify cryptographic SHA-256 snapshot integrity before running
  const expectedHash = computeAgentSnapshotHash({
    systemPrompt: snapshot.systemPrompt,
    modelConfig: snapshot.modelConfig,
    toolAllowlist: snapshot.toolAllowlist,
  });

  if (expectedHash !== snapshot.snapshotHash) {
    throw new RunConstraintError(
      'SNAPSHOT_INTEGRITY_ERROR',
      `Immutable snapshot hash mismatch for agent_version ${snapshot.id}.`,
      422
    );
  }

  const effectiveMaxSteps = Math.max(
    1,
    Math.min(snapshot.modelConfig.maxSteps, maxStepsCeiling)
  );
  const effectiveMaxToolCalls = Math.max(
    0,
    Math.min(snapshot.modelConfig.maxToolCalls, maxToolCallsCeiling)
  );

  const runStartPerf = performance.now();
  const startedAt = new Date();

  await db
    .update(runs)
    .set({
      status: 'running',
      startedAt,
      usageSource: modelProvider.source,
      updatedAt: startedAt,
    })
    .where(eq(runs.id, initialRun.id));

  await appendRunEvent(db, {
    organizationId: initialRun.organizationId,
    runId: initialRun.id,
    eventType: 'run.started',
    payload: {
      agentVersionId: snapshot.id,
      versionNumber: snapshot.versionNumber,
      maxSteps: effectiveMaxSteps,
      maxToolCalls: effectiveMaxToolCalls,
      model: snapshot.modelConfig.model,
      usageSource: modelProvider.source,
    },
  });

  const conversation: ModelMessage[] = [
    {
      role: 'user',
      content: initialRun.inputPrompt,
    },
  ];

  let stepIndex = 0;
  let modelTurnNumber = 0;
  let totalToolCallsExecuted = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalEstimatedCostUsd = 0;

  const markRunFailed = async (
    status: 'failed' | 'timed_out' | 'cancelled',
    errorCode: RunErrorCode | string,
    errorMessage: string
  ): Promise<RunRow> => {
    const completedAt = new Date();
    const latencyMs = Math.max(0, Math.round(performance.now() - runStartPerf));
    const eventType: RunEventType =
      status === 'timed_out'
        ? 'run.timed_out'
        : status === 'cancelled'
          ? 'run.cancelled'
          : 'run.failed';

    const [updatedRun] = await db
      .update(runs)
      .set({
        status,
        errorCode,
        errorMessage,
        stepCount: stepIndex,
        toolCallCount: totalToolCallsExecuted,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens,
        estimatedCostUsd: totalEstimatedCostUsd.toFixed(6),
        latencyMs,
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(runs.id, initialRun.id))
      .returning();

    await appendRunEvent(db, {
      organizationId: initialRun.organizationId,
      runId: initialRun.id,
      eventType,
      payload: {
        status,
        errorCode,
        errorMessage,
        stepCount: stepIndex,
        toolCallCount: totalToolCallsExecuted,
        latencyMs,
      },
    });

    await db
      .update(jobQueue)
      .set({
        status: 'completed',
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
        lastError: errorMessage,
        updatedAt: completedAt,
      })
      .where(eq(jobQueue.runId, initialRun.id));

    return updatedRun!;
  };

  while (true) {
    // 1. Check if run was cancelled externally between steps
    const [freshStatusRow] = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, initialRun.id))
      .limit(1);

    if (freshStatusRow?.status === 'cancelled') {
      return markRunFailed(
        'cancelled',
        'RUN_ALREADY_TERMINAL',
        'Run was cancelled by operator.'
      );
    }

    // 2. Enforce wall-clock run timeout budget (Threat T-04)
    const elapsedMs = performance.now() - runStartPerf;
    if (elapsedMs > timeoutMs) {
      return markRunFailed(
        'timed_out',
        'RUN_TIMEOUT_EXCEEDED',
        `Run exceeded wall-clock timeout budget of ${timeoutMs}ms.`
      );
    }

    // 3. Enforce step budget ceiling before invoking model turn (Threat T-04)
    if (stepIndex >= effectiveMaxSteps) {
      return markRunFailed(
        'failed',
        'MAX_STEPS_EXCEEDED',
        `Run exceeded maximum step budget of ${effectiveMaxSteps} steps.`
      );
    }

    stepIndex += 1;
    modelTurnNumber += 1;
    const turnStartPerf = performance.now();

    let modelOutput;
    try {
      modelOutput = await modelProvider.generate({
        systemPrompt: snapshot.systemPrompt,
        modelConfig: snapshot.modelConfig,
        allowedTools: snapshot.toolAllowlist,
        messages: conversation,
        stepIndex: modelTurnNumber,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Model generation failed.';
      return markRunFailed('failed', 'MODEL_EXECUTION_ERROR', message);
    }

    const turnDurationMs = Math.max(
      0,
      Math.round(performance.now() - turnStartPerf)
    );

    totalPromptTokens += modelOutput.usage.inputTokens;
    totalCompletionTokens += modelOutput.usage.outputTokens;
    totalEstimatedCostUsd += modelOutput.usage.estimatedCostUsd;

    // Case A: Model completed with a final answer (`finishReason === 'stop'`)
    if (
      modelOutput.finishReason === 'stop' ||
      modelOutput.toolCalls.length === 0
    ) {
      const retrievedChunks = extractRetrievedChunksFromMessages(conversation);
      const { verifiedCitations } = verifyModelCitations(
        modelOutput.citations,
        retrievedChunks
      );
      const finalAnswerText =
        modelOutput.answer ?? 'Completed with no text output.';

      await db.insert(runSteps).values({
        organizationId: initialRun.organizationId,
        runId: initialRun.id,
        stepIndex,
        kind: 'final_answer',
        modelOrToolName: modelOutput.modelName,
        inputPayload: {
          turn: modelTurnNumber,
          messageCount: conversation.length,
        },
        outputPayload: {
          reasoningSummary: modelOutput.reasoningSummary,
          answer: finalAnswerText,
        },
        citations: verifiedCitations,
        promptTokens: modelOutput.usage.inputTokens,
        completionTokens: modelOutput.usage.outputTokens,
        durationMs: turnDurationMs,
        status: 'succeeded',
      });

      await appendRunEvent(db, {
        organizationId: initialRun.organizationId,
        runId: initialRun.id,
        eventType: 'step.model_completed',
        payload: {
          stepIndex,
          kind: 'final_answer',
          modelName: modelOutput.modelName,
          finishReason: 'stop',
          citationCount: verifiedCitations.length,
        },
      });

      const completedAt = new Date();
      const latencyMs = Math.max(
        0,
        Math.round(performance.now() - runStartPerf)
      );

      const [succeededRun] = await db
        .update(runs)
        .set({
          status: 'succeeded',
          finalOutput: finalAnswerText,
          citations: verifiedCitations,
          stepCount: stepIndex,
          toolCallCount: totalToolCallsExecuted,
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens,
          estimatedCostUsd: totalEstimatedCostUsd.toFixed(6),
          usageSource: modelOutput.usage.source,
          latencyMs,
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(runs.id, initialRun.id))
        .returning();

      if (modelOutput.usage.source === 'provider') {
        await db.insert(usageEvents).values({
          organizationId: initialRun.organizationId,
          runId: initialRun.id,
          agentVersionId: initialRun.agentVersionId,
          providerMode: 'live',
          modelId: modelOutput.modelName,
          inputTokens: totalPromptTokens,
          outputTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens,
          toolCallsCount: totalToolCallsExecuted,
          isEstimated: modelOutput.usage.isSimulated,
        });
      }

      await appendRunEvent(db, {
        organizationId: initialRun.organizationId,
        runId: initialRun.id,
        eventType: 'run.succeeded',
        payload: {
          stepCount: stepIndex,
          toolCallCount: totalToolCallsExecuted,
          totalTokens: totalPromptTokens + totalCompletionTokens,
          citationCount: verifiedCitations.length,
          latencyMs,
        },
      });

      await db
        .update(jobQueue)
        .set({
          status: 'completed',
          lockedAt: null,
          lockedBy: null,
          leaseExpiresAt: null,
          updatedAt: completedAt,
        })
        .where(eq(jobQueue.runId, initialRun.id));

      return succeededRun!;
    }

    // Case B: Model requested tool call(s) (`finishReason === 'tool_calls'`)
    await db.insert(runSteps).values({
      organizationId: initialRun.organizationId,
      runId: initialRun.id,
      stepIndex,
      kind: 'model_turn',
      modelOrToolName: modelOutput.modelName,
      inputPayload: {
        turn: modelTurnNumber,
        messageCount: conversation.length,
      },
      outputPayload: {
        reasoningSummary: modelOutput.reasoningSummary,
        requestedTools: modelOutput.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
      },
      citations: [],
      promptTokens: modelOutput.usage.inputTokens,
      completionTokens: modelOutput.usage.outputTokens,
      durationMs: turnDurationMs,
      status: 'succeeded',
    });

    await appendRunEvent(db, {
      organizationId: initialRun.organizationId,
      runId: initialRun.id,
      eventType: 'step.model_completed',
      payload: {
        stepIndex,
        kind: 'model_turn',
        modelName: modelOutput.modelName,
        finishReason: 'tool_calls',
        toolCallNames: modelOutput.toolCalls.map((tc) => tc.name),
      },
    });

    conversation.push({
      role: 'assistant',
      content: modelOutput.reasoningSummary,
      toolCalls: modelOutput.toolCalls,
    });

    // Execute each requested tool call through the server-authorized ToolGateway
    for (const toolCall of modelOutput.toolCalls) {
      if (totalToolCallsExecuted >= effectiveMaxToolCalls) {
        return markRunFailed(
          'failed',
          'MAX_TOOL_CALLS_EXCEEDED',
          `Run exceeded maximum tool call budget of ${effectiveMaxToolCalls} calls.`
        );
      }

      if (stepIndex >= effectiveMaxSteps) {
        return markRunFailed(
          'failed',
          'MAX_STEPS_EXCEEDED',
          `Run exceeded maximum step budget of ${effectiveMaxSteps} steps before executing tool "${toolCall.name}".`
        );
      }

      stepIndex += 1;
      totalToolCallsExecuted += 1;

      try {
        const remainingTimeoutMs = Math.max(
          50,
          Math.round(timeoutMs - (performance.now() - runStartPerf))
        );

        const toolResult = await toolGateway.executeToolCall(toolCall, {
          organizationId: initialRun.organizationId,
          runId: initialRun.id,
          allowedTools: snapshot.toolAllowlist,
          timeoutMs: remainingTimeoutMs,
        });

        await db.insert(runSteps).values({
          organizationId: initialRun.organizationId,
          runId: initialRun.id,
          stepIndex,
          kind: 'tool_call',
          modelOrToolName: toolResult.toolName,
          inputPayload: toolResult.sanitizedArguments,
          outputPayload: toolResult.output as unknown as Record<string, unknown>,
          citations: [],
          promptTokens: 0,
          completionTokens: 0,
          durationMs: toolResult.durationMs,
          status: 'succeeded',
        });

        await appendRunEvent(db, {
          organizationId: initialRun.organizationId,
          runId: initialRun.id,
          eventType: 'step.tool_completed',
          payload: {
            stepIndex,
            toolCallId: toolResult.toolCallId,
            toolName: toolResult.toolName,
            durationMs: toolResult.durationMs,
          },
        });

        conversation.push({
          role: 'tool',
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
          content: toolResult.serializedOutput,
          toolOutput: toolResult.output,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Tool execution failed.';
        const errorCode: RunErrorCode =
          error instanceof ToolAuthorizationError
            ? error.code
            : error instanceof ToolExecutionError &&
                error.code === 'TOOL_TIMEOUT'
              ? 'RUN_TIMEOUT_EXCEEDED'
              : 'TOOL_EXECUTION_ERROR';

        await db.insert(runSteps).values({
          organizationId: initialRun.organizationId,
          runId: initialRun.id,
          stepIndex,
          kind: 'tool_call',
          modelOrToolName: toolCall.name,
          inputPayload: toolCall.arguments,
          outputPayload: {},
          citations: [],
          promptTokens: 0,
          completionTokens: 0,
          durationMs: 0,
          status: 'failed',
          errorMessage,
        });

        await appendRunEvent(db, {
          organizationId: initialRun.organizationId,
          runId: initialRun.id,
          eventType: 'step.tool_failed',
          payload: {
            stepIndex,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            errorCode,
            errorMessage,
          },
        });

        const terminalStatus =
          errorCode === 'RUN_TIMEOUT_EXCEEDED' ? 'timed_out' : 'failed';
        return markRunFailed(terminalStatus, errorCode, errorMessage);
      }
    }
  }
}

/**
 * Claims the next pending job from `job_queue` via `FOR UPDATE SKIP LOCKED`
 * and executes its associated `runs` record (`QUEUE-002`).
 */
export async function processNextQueuedJob(
  db: AegisDatabase,
  options: ProcessNextJobOptions = {}
): Promise<{ job: JobQueueRow; run: RunRow } | null> {
  const claimedJob = await claimNextPendingJob(
    db,
    options.workerId ?? 'worker-local-1',
    options.leaseDurationMs ?? DEFAULT_JOB_LEASE_MS
  );

  if (!claimedJob) {
    return null;
  }

  const completedRun = await executeAgentRun(db, claimedJob.runId, options);

  const [updatedJob] = await db
    .select()
    .from(jobQueue)
    .where(eq(jobQueue.id, claimedJob.id))
    .limit(1);

  return {
    job: updatedJob ?? claimedJob,
    run: completedRun,
  };
}

/**
 * Cancels an active or queued run (`run.cancel` RBAC action).
 */
export async function cancelAgentRun(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  organizationId: string,
  runId: string
): Promise<RunRow> {
  requireAuthorization(actor, 'run.cancel', {
    organizationId,
    resourceType: 'run',
    resourceId: runId,
  });

  const existingRows = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.organizationId, organizationId)))
    .limit(1);

  if (existingRows.length === 0) {
    throw new RunConstraintError(
      'RUN_NOT_FOUND',
      `Run ${runId} was not found in organization ${organizationId}.`,
      404
    );
  }

  const currentRun = existingRows[0]!;
  if (
    currentRun.status === 'succeeded' ||
    currentRun.status === 'failed' ||
    currentRun.status === 'cancelled' ||
    currentRun.status === 'timed_out'
  ) {
    throw new RunConstraintError(
      'RUN_ALREADY_TERMINAL',
      `Run ${runId} is already in terminal status "${currentRun.status}".`,
      409
    );
  }

  const now = new Date();
  const [cancelledRun] = await db
    .update(runs)
    .set({
      status: 'cancelled',
      errorCode: 'RUN_ALREADY_TERMINAL',
      errorMessage: `Cancelled by user ${actor!.userId}.`,
      completedAt: now,
      updatedAt: now,
    })
    .where(and(eq(runs.id, runId), eq(runs.organizationId, organizationId)))
    .returning();

  await appendRunEvent(db, {
    organizationId,
    runId,
    eventType: 'run.cancelled',
    payload: {
      cancelledByUserId: actor!.userId,
    },
  });

  await db
    .update(jobQueue)
    .set({
      status: 'completed',
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(eq(jobQueue.runId, runId));

  return cancelledRun!;
}

/**
 * Fetches a single run with its pinned `agent_versions` snapshot, ordered `run_steps`,
 * and ordered `run_events`. Strictly scoped to `organizationId` (`Threat T-01`).
 */
export async function getRunDetailsForActor(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  organizationId: string,
  runId: string
): Promise<RunDetailsResult> {
  requireAuthorization(actor, 'run.view', {
    organizationId,
    resourceType: 'run',
    resourceId: runId,
  });

  const runRows = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.organizationId, organizationId)))
    .limit(1);

  if (runRows.length === 0) {
    throw new RunConstraintError(
      'RUN_NOT_FOUND',
      `Run ${runId} was not found in organization ${organizationId}.`,
      404
    );
  }

  const run = runRows[0]!;

  const [version] = await db
    .select()
    .from(agentVersions)
    .where(
      and(
        eq(agentVersions.id, run.agentVersionId),
        eq(agentVersions.organizationId, organizationId)
      )
    )
    .limit(1);

  const steps = await db
    .select()
    .from(runSteps)
    .where(
      and(
        eq(runSteps.runId, run.id),
        eq(runSteps.organizationId, organizationId)
      )
    )
    .orderBy(asc(runSteps.stepIndex));

  const events = await db
    .select()
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, run.id),
        eq(runEvents.organizationId, organizationId)
      )
    )
    .orderBy(asc(runEvents.sequenceNo));

  return {
    run,
    version: version!,
    steps,
    events,
  };
}

/**
 * Lists `run_events` with `sequence_no > afterSequence` for SSE reconnect replay (`Last-Event-ID`).
 */
export async function listRunEventsAfterSequence(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  organizationId: string,
  runId: string,
  afterSequence = 0
): Promise<RunEventRow[]> {
  requireAuthorization(actor, 'run.view', {
    organizationId,
    resourceType: 'run',
    resourceId: runId,
  });

  const runRows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.organizationId, organizationId)))
    .limit(1);

  if (runRows.length === 0) {
    throw new RunConstraintError(
      'RUN_NOT_FOUND',
      `Run ${runId} was not found in organization ${organizationId}.`,
      404
    );
  }

  return db
    .select()
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, runId),
        eq(runEvents.organizationId, organizationId),
        gt(runEvents.sequenceNo, afterSequence)
      )
    )
    .orderBy(asc(runEvents.sequenceNo));
}

/**
 * Lists recent runs for an organization in descending creation order.
 */
export async function listOrganizationRuns(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  organizationId: string,
  limit = 50
): Promise<RunRow[]> {
  requireAuthorization(actor, 'run.view', {
    organizationId,
    resourceType: 'run',
  });

  return db
    .select()
    .from(runs)
    .where(eq(runs.organizationId, organizationId))
    .orderBy(desc(runs.createdAt))
    .limit(Math.max(1, Math.min(limit, 100)));
}
