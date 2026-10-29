import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { AegisDatabase } from '../../db/client';
import {
  agentVersions,
  type AllowedToolName,
} from '../../db/schema/agents';
import {
  runEvents,
  runs,
  runSteps,
  type RunEventType,
  type RunRow,
} from '../../db/schema/runs';
import {
  approvalRequests,
  auditEvents,
  usageEvents,
  workflows,
  workflowVersions,
  type ApprovalRequestRow,
  type AuditEventRow,
  type AuditOutcome,
  type UsageEventRow,
  type UsageProviderMode,
  type WorkflowGraphSpec,
  type WorkflowNodeSpec,
  type WorkflowRow,
  type WorkflowVersionRow,
} from '../../db/schema/workflows';
import {
  MockModelProvider,
  type ModelProvider,
} from '../../ai/model-provider';
import {
  AuthorizationError,
  authorize,
  requireAuthorization,
  type AuthenticatedActor,
} from '../../policies/authorization';
import { createTenantKnowledgeRetriever } from '../knowledge/knowledge-service';
import { ToolGateway } from '../tools/tool-gateway';
import {
  assertValidWorkflowDag,
  computeWorkflowSnapshotHash,
  evaluateWorkflowCondition,
} from './dag-validator';

/**
 * Tickets WORKFLOW-002, HITL-001, AUDIT-001 & USAGE-001:
 * Directed Acyclic Workflow Engine, Human-in-the-Loop Approval Gate Controller,
 * Append-Only Security Audit Ledger & Honest Usage Ledger
 *
 * Implements Blueprint Section 4.1, Section 5.2, Section 6 & Threat Model T-01..T-07:
 * - Validates and publishes immutable `workflow_versions` snapshots.
 * - Executes DAG nodes (`start`, `agent`, `tool`, `condition`, `approval`, `end`)
 *   against tenant-isolated runs.
 * - Pauses execution at `approval` nodes (`runs.status = 'waiting_approval'`), creates
 *   durable `approval_requests`, and resumes or cancels upon authorized review.
 * - Records append-only `audit_events` for both `allowed` and `denied` security actions.
 * - Records `usage_events` separating `mock` (simulated) vs `live` provider tokens.
 */

export class WorkflowResourceNotFoundError extends Error {
  public readonly statusCode = 404;
  public readonly code = 'RESOURCE_NOT_FOUND';

  constructor(resourceType: string, resourceId: string) {
    super(`${resourceType} "${resourceId}" was not found.`);
    this.name = 'WorkflowResourceNotFoundError';
  }
}

export class ApprovalStateConflictError extends Error {
  public readonly statusCode = 409;
  public readonly code = 'APPROVAL_STATE_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'ApprovalStateConflictError';
  }
}

export interface RecordAuditEventInput {
  organizationId: string;
  actorUserId: string | null;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string;
  outcome: AuditOutcome;
  metadata?: Record<string, unknown>;
}

/**
 * Appends an immutable security/governance event to `audit_events` (`AUDIT-001`).
 */
export async function recordAuditEvent(
  db: AegisDatabase,
  input: RecordAuditEventInput
): Promise<AuditEventRow> {
  const [created] = await db
    .insert(auditEvents)
    .values({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      outcome: input.outcome,
      metadataJson: input.metadata ?? {},
    })
    .returning();

  return created;
}

/**
 * Lists tenant-scoped audit events. Restricted to `owner` and `admin` roles (`audit.view`).
 */
export async function listAuditEvents(
  db: AegisDatabase,
  actor: AuthenticatedActor,
  options?: { organizationId?: string; limit?: number }
): Promise<AuditEventRow[]> {
  const targetOrgId = options?.organizationId ?? actor.organizationId;
  requireAuthorization(actor, 'audit.view', {
    organizationId: targetOrgId,
    resourceType: 'audit_events',
  });

  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.organizationId, targetOrgId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
}

export interface RecordUsageEventInput {
  organizationId: string;
  runId: string;
  workflowVersionId?: string | null;
  agentVersionId?: string | null;
  providerMode: UsageProviderMode;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  toolCallsCount: number;
  isEstimated?: boolean;
}

/**
 * Records an honest token and tool invocation usage ledger entry (`USAGE-001`).
 */
export async function recordUsageEvent(
  db: AegisDatabase,
  input: RecordUsageEventInput
): Promise<UsageEventRow> {
  const totalTokens =
    input.totalTokens ?? input.inputTokens + input.outputTokens;
  const isEstimated =
    input.isEstimated !== undefined
      ? input.isEstimated
      : input.providerMode === 'mock';

  const [created] = await db
    .insert(usageEvents)
    .values({
      organizationId: input.organizationId,
      runId: input.runId,
      workflowVersionId: input.workflowVersionId ?? null,
      agentVersionId: input.agentVersionId ?? null,
      providerMode: input.providerMode,
      modelId: input.modelId,
      inputTokens: Math.max(0, input.inputTokens),
      outputTokens: Math.max(0, input.outputTokens),
      totalTokens: Math.max(0, totalTokens),
      toolCallsCount: Math.max(0, input.toolCallsCount),
      isEstimated,
    })
    .returning();

  return created;
}

export interface OrganizationUsageSummary {
  organizationId: string;
  mock: {
    runsCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    toolCallsCount: number;
  };
  live: {
    runsCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    toolCallsCount: number;
  };
  events: UsageEventRow[];
}

/**
 * Returns an organization's usage summary with strict separation between
 * simulated `mock` usage and real `live` provider usage (`USAGE-001`).
 */
export async function getOrganizationUsageSummary(
  db: AegisDatabase,
  actor: AuthenticatedActor,
  targetOrganizationId?: string
): Promise<OrganizationUsageSummary> {
  const orgId = targetOrganizationId ?? actor.organizationId;
  requireAuthorization(actor, 'usage.view', {
    organizationId: orgId,
    resourceType: 'usage_events',
  });

  const rows = await db
    .select()
    .from(usageEvents)
    .where(eq(usageEvents.organizationId, orgId))
    .orderBy(desc(usageEvents.createdAt));

  const summary: OrganizationUsageSummary = {
    organizationId: orgId,
    mock: {
      runsCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCallsCount: 0,
    },
    live: {
      runsCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCallsCount: 0,
    },
    events: rows,
  };

  for (const row of rows) {
    const bucket = row.providerMode === 'live' ? summary.live : summary.mock;
    bucket.runsCount += 1;
    bucket.inputTokens += row.inputTokens;
    bucket.outputTokens += row.outputTokens;
    bucket.totalTokens += row.totalTokens;
    bucket.toolCallsCount += row.toolCallsCount;
  }

  return summary;
}

export interface CreateWorkflowDraftInput {
  organizationId: string;
  slug: string;
  name: string;
  description?: string;
  graph: WorkflowGraphSpec;
}

/**
 * Creates a validated workflow draft (`workflows`) and logs an audit event.
 */
export async function createWorkflowDraft(
  db: AegisDatabase,
  actor: AuthenticatedActor,
  input: CreateWorkflowDraftInput
): Promise<WorkflowRow> {
  requireAuthorization(actor, 'workflow.edit', {
    organizationId: input.organizationId,
    resourceType: 'workflow',
  });

  assertValidWorkflowDag(input.graph);

  const [workflow] = await db
    .insert(workflows)
    .values({
      organizationId: input.organizationId,
      slug: input.slug.trim(),
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      draftGraphJson: input.graph,
      status: 'draft',
      latestVersionNumber: 0,
      createdByUserId: actor.userId,
    })
    .returning();

  await recordAuditEvent(db, {
    organizationId: input.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: 'workflow.edit',
    resourceType: 'workflow',
    resourceId: workflow.id,
    outcome: 'allowed',
    metadata: { slug: workflow.slug, operation: 'create_draft' },
  });

  return workflow;
}

export interface UpdateWorkflowDraftInput {
  organizationId: string;
  workflowId: string;
  name?: string;
  description?: string;
  graph: WorkflowGraphSpec;
}

/**
 * Updates a mutable workflow draft without mutating any published `workflow_versions` rows.
 */
export async function updateWorkflowDraft(
  db: AegisDatabase,
  actor: AuthenticatedActor,
  input: UpdateWorkflowDraftInput
): Promise<WorkflowRow> {
  requireAuthorization(actor, 'workflow.edit', {
    organizationId: input.organizationId,
    resourceType: 'workflow',
    resourceId: input.workflowId,
  });

  const [existing] = await db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.organizationId, input.organizationId),
        eq(workflows.id, input.workflowId)
      )
    )
    .limit(1);

  if (!existing) {
    throw new WorkflowResourceNotFoundError('Workflow', input.workflowId);
  }

  assertValidWorkflowDag(input.graph);

  const [updated] = await db
    .update(workflows)
    .set({
      name: input.name ? input.name.trim() : existing.name,
      description:
        input.description !== undefined
          ? input.description.trim()
          : existing.description,
      draftGraphJson: input.graph,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflows.organizationId, input.organizationId),
        eq(workflows.id, input.workflowId)
      )
    )
    .returning();

  await recordAuditEvent(db, {
    organizationId: input.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: 'workflow.edit',
    resourceType: 'workflow',
    resourceId: updated.id,
    outcome: 'allowed',
    metadata: { slug: updated.slug, operation: 'update_draft' },
  });

  return updated;
}

/**
 * Publishes an immutable `workflow_versions` snapshot from the current workflow draft (`WORKFLOW-001`).
 */
export async function publishWorkflowVersion(
  db: AegisDatabase,
  actor: AuthenticatedActor,
  input: { organizationId: string; workflowId: string }
): Promise<{ workflow: WorkflowRow; version: WorkflowVersionRow }> {
  requireAuthorization(actor, 'workflow.publish', {
    organizationId: input.organizationId,
    resourceType: 'workflow',
    resourceId: input.workflowId,
  });

  const [existing] = await db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.organizationId, input.organizationId),
        eq(workflows.id, input.workflowId)
      )
    )
    .limit(1);

  if (!existing) {
    throw new WorkflowResourceNotFoundError('Workflow', input.workflowId);
  }

  assertValidWorkflowDag(existing.draftGraphJson);
  const snapshotHash = computeWorkflowSnapshotHash(existing.draftGraphJson);
  const nextVersionNumber = existing.latestVersionNumber + 1;

  const result = await db.transaction(async (tx) => {
    const [version] = await tx
      .insert(workflowVersions)
      .values({
        organizationId: input.organizationId,
        workflowId: existing.id,
        versionNumber: nextVersionNumber,
        snapshotHash,
        graphJson: structuredClone(existing.draftGraphJson),
        publishedByUserId: actor.userId,
      })
      .returning();

    const [updatedWorkflow] = await tx
      .update(workflows)
      .set({
        status: 'active',
        latestVersionNumber: nextVersionNumber,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workflows.organizationId, input.organizationId),
          eq(workflows.id, existing.id)
        )
      )
      .returning();

    return { workflow: updatedWorkflow, version };
  });

  await recordAuditEvent(db, {
    organizationId: input.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: 'workflow.publish',
    resourceType: 'workflow_version',
    resourceId: result.version.id,
    outcome: 'allowed',
    metadata: {
      workflowId: existing.id,
      versionNumber: result.version.versionNumber,
      snapshotHash: result.version.snapshotHash,
    },
  });

  return result;
}

export interface WorkflowExecutionContext extends Record<string, unknown> {
  inputPrompt: string;
  lastOutput: string;
  visitedNodes: string[];
  variables: Record<string, unknown>;
}

export interface WorkflowRunExecutionResult {
  run: RunRow;
  pendingApproval?: ApprovalRequestRow;
}

export interface StartWorkflowRunInput {
  organizationId: string;
  workflowVersionId: string;
  defaultAgentVersionId: string;
  inputPrompt: string;
  initialVariables?: Record<string, unknown>;
  idempotencyKey?: string;
  modelProvider?: ModelProvider;
  toolGateway?: ToolGateway;
}

async function appendWorkflowRunEvent(
  db: AegisDatabase,
  organizationId: string,
  runId: string,
  eventType: RunEventType,
  payload: Record<string, unknown>
): Promise<void> {
  const existing = await db
    .select({
      maxSeq: sql<number>`coalesce(max(${runEvents.sequenceNo}), 0)::int`,
    })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.organizationId, organizationId),
        eq(runEvents.runId, runId)
      )
    );

  const nextSequence = (existing[0]?.maxSeq ?? 0) + 1;
  await db.insert(runEvents).values({
    organizationId,
    runId,
    sequenceNo: nextSequence,
    eventType,
    payload,
  });
}

async function nextRunStepIndex(
  db: AegisDatabase,
  organizationId: string,
  runId: string
): Promise<number> {
  const existing = await db
    .select({
      maxStep: sql<number>`coalesce(max(${runSteps.stepIndex}), 0)::int`,
    })
    .from(runSteps)
    .where(
      and(
        eq(runSteps.organizationId, organizationId),
        eq(runSteps.runId, runId)
      )
    );
  return (existing[0]?.maxStep ?? 0) + 1;
}

/**
 * Starts a workflow run pinned to an immutable `workflow_versions` snapshot (`WORKFLOW-002`).
 * Executes nodes in DAG order until reaching an `approval` gate (pausing at `waiting_approval`)
 * or an `end` node (completing at `succeeded`).
 */
export async function startWorkflowRun(
  db: AegisDatabase,
  actor: AuthenticatedActor,
  input: StartWorkflowRunInput
): Promise<WorkflowRunExecutionResult> {
  requireAuthorization(actor, 'run.start', {
    organizationId: input.organizationId,
    resourceType: 'workflow_version',
    resourceId: input.workflowVersionId,
  });

  const [wfVersion] = await db
    .select()
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.organizationId, input.organizationId),
        eq(workflowVersions.id, input.workflowVersionId)
      )
    )
    .limit(1);

  if (!wfVersion) {
    throw new WorkflowResourceNotFoundError(
      'WorkflowVersion',
      input.workflowVersionId
    );
  }

  const [defaultAgentVersion] = await db
    .select()
    .from(agentVersions)
    .where(
      and(
        eq(agentVersions.organizationId, input.organizationId),
        eq(agentVersions.id, input.defaultAgentVersionId)
      )
    )
    .limit(1);

  if (!defaultAgentVersion) {
    throw new WorkflowResourceNotFoundError(
      'AgentVersion',
      input.defaultAgentVersionId
    );
  }

  const graph = wfVersion.graphJson;
  assertValidWorkflowDag(graph);

  const startNode = graph.nodes.find((n) => n.kind === 'start');
  if (!startNode) {
    throw new WorkflowResourceNotFoundError('StartNode', wfVersion.id);
  }

  const now = new Date();
  const [run] = await db
    .insert(runs)
    .values({
      organizationId: input.organizationId,
      agentId: defaultAgentVersion.agentId,
      agentVersionId: defaultAgentVersion.id,
      status: 'running',
      inputPrompt: input.inputPrompt.trim(),
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: actor.userId,
      startedAt: now,
    })
    .returning();

  await appendWorkflowRunEvent(db, input.organizationId, run.id, 'run.queued', {
    workflowVersionId: wfVersion.id,
  });
  await appendWorkflowRunEvent(
    db,
    input.organizationId,
    run.id,
    'run.started',
    {
      workflowVersionId: wfVersion.id,
      startNodeId: startNode.id,
    }
  );

  const initialContext: WorkflowExecutionContext = {
    inputPrompt: input.inputPrompt.trim(),
    lastOutput: input.inputPrompt.trim(),
    visitedNodes: [],
    variables: { ...(input.initialVariables ?? {}) },
  };

  return advanceWorkflowExecution({
    db,
    actor,
    run,
    workflowVersion: wfVersion,
    defaultAgentVersionId: defaultAgentVersion.id,
    currentNodeId: startNode.id,
    context: initialContext,
    modelProvider: input.modelProvider ?? new MockModelProvider(),
    toolGateway:
      input.toolGateway ??
      new ToolGateway({
        knowledgeSearchRetriever: createTenantKnowledgeRetriever(db),
      }),
  });
}

interface AdvanceWorkflowParams {
  db: AegisDatabase;
  actor: AuthenticatedActor;
  run: RunRow;
  workflowVersion: WorkflowVersionRow;
  defaultAgentVersionId: string;
  currentNodeId: string;
  context: WorkflowExecutionContext;
  modelProvider: ModelProvider;
  toolGateway: ToolGateway;
}

async function advanceWorkflowExecution(
  params: AdvanceWorkflowParams
): Promise<WorkflowRunExecutionResult> {
  const {
    db,
    actor,
    workflowVersion,
    defaultAgentVersionId,
    context,
    modelProvider,
    toolGateway,
  } = params;

  let currentRun = params.run;
  const graph = workflowVersion.graphJson;
  const nodeById = new Map<string, WorkflowNodeSpec>(
    graph.nodes.map((n) => [n.id, n])
  );

  let cursorNodeId: string | undefined = params.currentNodeId;
  let safetyCounter = 0;

  while (cursorNodeId) {
    safetyCounter += 1;
    if (safetyCounter > 50) {
      throw new Error('Workflow execution exceeded maximum node hops (50).');
    }

    const node = nodeById.get(cursorNodeId);
    if (!node) {
      throw new WorkflowResourceNotFoundError('WorkflowNode', cursorNodeId);
    }

    context.visitedNodes.push(node.id);
    const outgoingEdges = graph.edges.filter((e) => e.source === node.id);

    if (node.kind === 'start') {
      cursorNodeId = outgoingEdges[0]?.target;
      continue;
    }

    if (node.kind === 'agent') {
      const targetAgentVersionId =
        node.agentVersionId ?? defaultAgentVersionId;
      const [agentVersion] = await db
        .select()
        .from(agentVersions)
        .where(
          and(
            eq(agentVersions.organizationId, currentRun.organizationId),
            eq(agentVersions.id, targetAgentVersionId)
          )
        )
        .limit(1);

      if (!agentVersion) {
        throw new WorkflowResourceNotFoundError(
          'AgentVersion',
          targetAgentVersionId
        );
      }

      const promptText = node.promptTemplate
        ? `${node.promptTemplate}\n\nInput: ${context.lastOutput}`
        : context.lastOutput;

      const stepIdx = await nextRunStepIndex(
        db,
        currentRun.organizationId,
        currentRun.id
      );

      const startPerf = performance.now();
      const modelResult = await modelProvider.generate({
        systemPrompt: agentVersion.systemPrompt,
        modelConfig: agentVersion.modelConfig,
        allowedTools: [],
        messages: [{ role: 'user', content: promptText }],
        stepIndex: stepIdx,
      });
      const turnDurationMs = Math.max(
        1,
        Math.round(performance.now() - startPerf)
      );

      const outputText =
        modelResult.answer ?? modelResult.reasoningSummary ?? '';

      await db.insert(runSteps).values({
        organizationId: currentRun.organizationId,
        runId: currentRun.id,
        stepIndex: stepIdx,
        kind: 'model_turn',
        modelOrToolName: modelResult.modelName,
        inputPayload: { nodeId: node.id, prompt: promptText },
        outputPayload: {
          nodeId: node.id,
          content: outputText,
        },
        citations: modelResult.citations,
        promptTokens: modelResult.usage.inputTokens,
        completionTokens: modelResult.usage.outputTokens,
        durationMs: turnDurationMs,
        status: 'succeeded',
      });

      const [updatedRun] = await db
        .update(runs)
        .set({
          stepCount: currentRun.stepCount + 1,
          promptTokens:
            currentRun.promptTokens + modelResult.usage.inputTokens,
          completionTokens:
            currentRun.completionTokens + modelResult.usage.outputTokens,
          totalTokens: currentRun.totalTokens + modelResult.usage.totalTokens,
          usageSource: modelResult.usage.source,
          updatedAt: new Date(),
        })
        .where(eq(runs.id, currentRun.id))
        .returning();

      currentRun = updatedRun;
      context.lastOutput = outputText || context.lastOutput;
      context.variables[node.id] = context.lastOutput;

      await appendWorkflowRunEvent(
        db,
        currentRun.organizationId,
        currentRun.id,
        'step.model_completed',
        {
          nodeId: node.id,
          stepIndex: stepIdx,
          output: context.lastOutput,
        }
      );

      cursorNodeId = outgoingEdges[0]?.target;
      continue;
    }

    if (node.kind === 'tool') {
      const toolName: AllowedToolName =
        node.toolName === 'knowledge_search'
          ? 'knowledge_search'
          : 'calculator';
      const toolInput = node.toolInput ?? { expression: '1 + 1' };

      const stepIdx = await nextRunStepIndex(
        db,
        currentRun.organizationId,
        currentRun.id
      );

      const toolOutcome = await toolGateway.executeToolCall(
        {
          id: `wf_tool_${node.id}_${stepIdx}`,
          name: toolName,
          arguments: toolInput,
        },
        {
          organizationId: currentRun.organizationId,
          runId: currentRun.id,
          allowedTools: [toolName],
        }
      );

      const rawOutputPayload =
        toolOutcome.output as unknown as Record<string, unknown>;

      await db.insert(runSteps).values({
        organizationId: currentRun.organizationId,
        runId: currentRun.id,
        stepIndex: stepIdx,
        kind: 'tool_call',
        modelOrToolName: toolName,
        inputPayload: { nodeId: node.id, ...toolInput },
        outputPayload: rawOutputPayload,
        durationMs: toolOutcome.durationMs,
        status: 'succeeded',
        errorMessage: null,
      });

      const [updatedRun] = await db
        .update(runs)
        .set({
          stepCount: currentRun.stepCount + 1,
          toolCallCount: currentRun.toolCallCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(runs.id, currentRun.id))
        .returning();

      currentRun = updatedRun;
      context.variables[node.id] = rawOutputPayload;
      if (rawOutputPayload.result !== undefined) {
        context.lastOutput = String(rawOutputPayload.result);
      }

      await appendWorkflowRunEvent(
        db,
        currentRun.organizationId,
        currentRun.id,
        'step.tool_completed',
        {
          nodeId: node.id,
          toolName,
          output: rawOutputPayload,
        }
      );

      cursorNodeId = outgoingEdges[0]?.target;
      continue;
    }

    if (node.kind === 'condition') {
      const evalContext: Record<string, unknown> = {
        ...context.variables,
        inputPrompt: context.inputPrompt,
        lastOutput: context.lastOutput,
      };
      const matched = node.condition
        ? evaluateWorkflowCondition(node.condition, evalContext)
        : false;
      const targetLabel = matched ? 'true' : 'false';
      const chosenEdge =
        outgoingEdges.find((e) => e.conditionLabel === targetLabel) ??
        outgoingEdges[0];
      cursorNodeId = chosenEdge?.target;
      continue;
    }

    if (node.kind === 'approval') {
      const nextNodeId = outgoingEdges[0]?.target ?? null;
      const pausedContext: WorkflowExecutionContext = {
        ...context,
        variables: {
          ...context.variables,
          __resumeNodeId: nextNodeId,
          __defaultAgentVersionId: defaultAgentVersionId,
        },
      };

      const [approval] = await db
        .insert(approvalRequests)
        .values({
          organizationId: currentRun.organizationId,
          runId: currentRun.id,
          workflowVersionId: workflowVersion.id,
          nodeId: node.id,
          title: node.approvalTitle ?? node.label,
          reason:
            node.approvalReason ??
            'Human-in-the-loop approval required before workflow can proceed.',
          status: 'pending',
          allowDeveloperDecision: Boolean(node.allowDeveloperDecision),
          contextJson: pausedContext,
          requestedByUserId: actor.userId,
        })
        .returning();

      const stepIdx = await nextRunStepIndex(
        db,
        currentRun.organizationId,
        currentRun.id
      );

      await db.insert(runSteps).values({
        organizationId: currentRun.organizationId,
        runId: currentRun.id,
        stepIndex: stepIdx,
        kind: 'approval_gate',
        modelOrToolName: node.id,
        inputPayload: {
          nodeId: node.id,
          approvalRequestId: approval.id,
          title: approval.title,
        },
        outputPayload: {
          status: 'waiting_approval',
          approvalRequestId: approval.id,
        },
        durationMs: 0,
        status: 'succeeded',
      });

      const [pausedRun] = await db
        .update(runs)
        .set({
          status: 'waiting_approval',
          stepCount: currentRun.stepCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(runs.id, currentRun.id))
        .returning();

      await appendWorkflowRunEvent(
        db,
        currentRun.organizationId,
        currentRun.id,
        'run.waiting_approval',
        {
          nodeId: node.id,
          approvalRequestId: approval.id,
          title: approval.title,
        }
      );

      await recordAuditEvent(db, {
        organizationId: currentRun.organizationId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'approval.requested',
        resourceType: 'approval_request',
        resourceId: approval.id,
        outcome: 'allowed',
        metadata: {
          runId: currentRun.id,
          workflowVersionId: workflowVersion.id,
          nodeId: node.id,
        },
      });

      return {
        run: pausedRun,
        pendingApproval: approval,
      };
    }

    if (node.kind === 'end') {
      const stepIdx = await nextRunStepIndex(
        db,
        currentRun.organizationId,
        currentRun.id
      );

      await db.insert(runSteps).values({
        organizationId: currentRun.organizationId,
        runId: currentRun.id,
        stepIndex: stepIdx,
        kind: 'final_answer',
        modelOrToolName: node.id,
        inputPayload: { nodeId: node.id },
        outputPayload: { finalOutput: context.lastOutput },
        durationMs: 0,
        status: 'succeeded',
      });

      const completedAt = new Date();
      const latencyMs = currentRun.startedAt
        ? Math.max(1, completedAt.getTime() - currentRun.startedAt.getTime())
        : 1;

      const [completedRun] = await db
        .update(runs)
        .set({
          status: 'succeeded',
          finalOutput: context.lastOutput,
          stepCount: currentRun.stepCount + 1,
          latencyMs,
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(runs.id, currentRun.id))
        .returning();

      await appendWorkflowRunEvent(
        db,
        currentRun.organizationId,
        currentRun.id,
        'run.succeeded',
        {
          nodeId: node.id,
          finalOutput: completedRun.finalOutput,
        }
      );

      const providerMode: UsageProviderMode =
        completedRun.usageSource === 'provider' ? 'live' : 'mock';

      await recordUsageEvent(db, {
        organizationId: completedRun.organizationId,
        runId: completedRun.id,
        workflowVersionId: workflowVersion.id,
        agentVersionId: completedRun.agentVersionId,
        providerMode,
        modelId:
          providerMode === 'live' ? 'gemini-2.5-flash' : 'aegis-mock-v1',
        inputTokens: completedRun.promptTokens,
        outputTokens: completedRun.completionTokens,
        totalTokens: completedRun.totalTokens,
        toolCallsCount: completedRun.toolCallCount,
        isEstimated: providerMode === 'mock',
      });

      return { run: completedRun };
    }
  }

  return { run: currentRun };
}

export interface DecideApprovalRequestInput {
  approvalRequestId: string;
  decision: 'approved' | 'rejected';
  note?: string;
  modelProvider?: ModelProvider;
  toolGateway?: ToolGateway;
}

/**
 * Processes a Human-in-the-Loop approval decision (`HITL-001` & `AUDIT-001`):
 * - Cross-tenant attempts throw `404` (`AuthorizationError` with `TENANT_MISMATCH`).
 * - Same-tenant unauthorized roles (`viewer`, or `developer` when `allowDeveloperDecision` is false)
 *   log a `denied` entry in `audit_events` (`Threat T-06`) and throw `403`.
 * - Authorized `'approved'` decisions resume workflow execution from the paused node.
 * - Authorized `'rejected'` decisions transition the run to `'cancelled'`.
 */
export async function decideApprovalRequest(
  db: AegisDatabase,
  actor: AuthenticatedActor,
  input: DecideApprovalRequestInput
): Promise<{ approval: ApprovalRequestRow; run: RunRow }> {
  const [approval] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, input.approvalRequestId))
    .limit(1);

  if (!approval) {
    throw new WorkflowResourceNotFoundError(
      'ApprovalRequest',
      input.approvalRequestId
    );
  }

  const authDecision = authorize(actor, 'approval.decide', {
    organizationId: approval.organizationId,
    resourceType: 'approval_request',
    resourceId: approval.id,
    allowDeveloperApproval: approval.allowDeveloperDecision,
  });

  if (!authDecision.allowed) {
    if (actor.organizationId === approval.organizationId) {
      await recordAuditEvent(db, {
        organizationId: approval.organizationId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'approval.decide',
        resourceType: 'approval_request',
        resourceId: approval.id,
        outcome: 'denied',
        metadata: {
          attemptedDecision: input.decision,
          reason: authDecision.reason,
          runId: approval.runId,
          nodeId: approval.nodeId,
        },
      });
    }
    throw new AuthorizationError(authDecision);
  }

  if (approval.status !== 'pending') {
    throw new ApprovalStateConflictError(
      `Approval request "${approval.id}" has already been decided (${approval.status}).`
    );
  }

  const now = new Date();
  if (approval.expiresAt && approval.expiresAt.getTime() < now.getTime()) {
    await db
      .update(approvalRequests)
      .set({ status: 'expired', decidedAt: now })
      .where(eq(approvalRequests.id, approval.id));
    throw new ApprovalStateConflictError(
      `Approval request "${approval.id}" has expired.`
    );
  }

  const [updatedApproval] = await db
    .update(approvalRequests)
    .set({
      status: input.decision,
      decidedByUserId: actor.userId,
      decisionNote: input.note?.trim() ?? null,
      decidedAt: now,
    })
    .where(
      and(
        eq(approvalRequests.organizationId, approval.organizationId),
        eq(approvalRequests.id, approval.id)
      )
    )
    .returning();

  await recordAuditEvent(db, {
    organizationId: approval.organizationId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: 'approval.decide',
    resourceType: 'approval_request',
    resourceId: approval.id,
    outcome: 'allowed',
    metadata: {
      decision: input.decision,
      note: updatedApproval.decisionNote,
      runId: approval.runId,
      nodeId: approval.nodeId,
    },
  });

  const [currentRun] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.organizationId, approval.organizationId),
        eq(runs.id, approval.runId)
      )
    )
    .limit(1);

  if (!currentRun) {
    throw new WorkflowResourceNotFoundError('Run', approval.runId);
  }

  if (input.decision === 'rejected') {
    const [cancelledRun] = await db
      .update(runs)
      .set({
        status: 'cancelled',
        errorCode: 'APPROVAL_REJECTED',
        errorMessage:
          updatedApproval.decisionNote ??
          `Rejected at approval gate "${approval.nodeId}".`,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(runs.id, currentRun.id))
      .returning();

    await appendWorkflowRunEvent(
      db,
      cancelledRun.organizationId,
      cancelledRun.id,
      'run.cancelled',
      {
        approvalRequestId: updatedApproval.id,
        nodeId: updatedApproval.nodeId,
        reason: cancelledRun.errorMessage,
      }
    );

    const providerMode: UsageProviderMode =
      cancelledRun.usageSource === 'provider' ? 'live' : 'mock';

    await recordUsageEvent(db, {
      organizationId: cancelledRun.organizationId,
      runId: cancelledRun.id,
      workflowVersionId: approval.workflowVersionId,
      agentVersionId: cancelledRun.agentVersionId,
      providerMode,
      modelId: providerMode === 'live' ? 'gemini-2.5-flash' : 'aegis-mock-v1',
      inputTokens: cancelledRun.promptTokens,
      outputTokens: cancelledRun.completionTokens,
      totalTokens: cancelledRun.totalTokens,
      toolCallsCount: cancelledRun.toolCallCount,
      isEstimated: providerMode === 'mock',
    });

    return { approval: updatedApproval, run: cancelledRun };
  }

  // Decision === 'approved': resume workflow execution from the saved next node
  const [runningRun] = await db
    .update(runs)
    .set({
      status: 'running',
      updatedAt: now,
    })
    .where(eq(runs.id, currentRun.id))
    .returning();

  if (!approval.workflowVersionId) {
    return { approval: updatedApproval, run: runningRun };
  }

  const [wfVersion] = await db
    .select()
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.organizationId, approval.organizationId),
        eq(workflowVersions.id, approval.workflowVersionId)
      )
    )
    .limit(1);

  if (!wfVersion) {
    throw new WorkflowResourceNotFoundError(
      'WorkflowVersion',
      approval.workflowVersionId
    );
  }

  const savedContext = approval.contextJson as unknown as WorkflowExecutionContext;
  const resumeNodeId =
    typeof savedContext?.variables?.__resumeNodeId === 'string'
      ? (savedContext.variables.__resumeNodeId as string)
      : undefined;
  const defaultAgentVersionId =
    typeof savedContext?.variables?.__defaultAgentVersionId === 'string'
      ? (savedContext.variables.__defaultAgentVersionId as string)
      : runningRun.agentVersionId;

  if (!resumeNodeId) {
    return { approval: updatedApproval, run: runningRun };
  }

  const resumed = await advanceWorkflowExecution({
    db,
    actor,
    run: runningRun,
    workflowVersion: wfVersion,
    defaultAgentVersionId,
    currentNodeId: resumeNodeId,
    context: {
      inputPrompt: savedContext.inputPrompt ?? runningRun.inputPrompt,
      lastOutput: savedContext.lastOutput ?? runningRun.inputPrompt,
      visitedNodes: Array.isArray(savedContext.visitedNodes)
        ? [...savedContext.visitedNodes]
        : [],
      variables: { ...(savedContext.variables ?? {}) },
    },
    modelProvider: input.modelProvider ?? new MockModelProvider(),
    toolGateway:
      input.toolGateway ??
      new ToolGateway({
        knowledgeSearchRetriever: createTenantKnowledgeRetriever(db),
      }),
  });

  return {
    approval: updatedApproval,
    run: resumed.run,
  };
}

/**
 * Lists approval requests for an organization (`approval.view`).
 */
export async function listApprovalRequests(
  db: AegisDatabase,
  actor: AuthenticatedActor,
  organizationId?: string
): Promise<ApprovalRequestRow[]> {
  const targetOrgId = organizationId ?? actor.organizationId;
  requireAuthorization(actor, 'approval.view', {
    organizationId: targetOrgId,
    resourceType: 'approval_request',
  });

  return db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.organizationId, targetOrgId))
    .orderBy(asc(approvalRequests.createdAt));
}
