import { and, asc, desc, eq } from 'drizzle-orm';
import type { AegisDatabase } from '../../db/client';
import {
  agents,
  agentVersions,
  type AllowedToolName,
} from '../../db/schema/agents';
import {
  evalCaseResults,
  evalCases,
  evalExperiments,
  evalSuites,
  type EvalAssertionResult,
  type EvalAssertionSpec,
  type EvalCaseResultRow,
  type EvalCaseRow,
  type EvalExperimentRow,
  type EvalSuiteRow,
  type JsonPrimitiveType,
} from '../../db/schema/evals';
import type { ModelCitation, ModelProvider } from '../../ai/model-provider';
import {
  AuthorizationError,
  authorize,
  requireAuthorization,
  type AuthenticatedActor,
} from '../../policies/authorization';
import {
  enqueueAgentRun,
  executeAgentRun,
  getRunDetailsForActor,
  type ExecuteAgentRunOptions,
} from '../runs/run-executor';
import { recordAuditEvent, recordUsageEvent } from '../workflows/workflow-engine';

/**
 * Ticket EVAL-001: Automated Evaluation Harness, Assertion Graders & Regression Diff Engine
 *
 * Implements Blueprint Section 5.6:
 * - Pure deterministic assertion graders (`exact_match`, `contains`, `json_schema`,
 *   `citation_required`, `tool_called`).
 * - Tenant-isolated `eval_suites` and `eval_cases` management (`eval.manage`, `eval.view`).
 * - Repeatable `runEvalExperiment()` execution pinned to an immutable `agent_versions`
 *   snapshot (`eval.execute`), producing real auditable `runs` traces for every test case.
 * - Side-by-side `compareEvalExperiments()` regression detector between two pinned versions
 *   (e.g., `v1` vs `v2`).
 */

export class EvalResourceNotFoundError extends Error {
  public readonly statusCode = 404;
  public readonly code = 'EVAL_RESOURCE_NOT_FOUND';

  constructor(resourceType: string, resourceId: string) {
    super(`${resourceType} "${resourceId}" was not found.`);
    this.name = 'EvalResourceNotFoundError';
  }
}

export class EvalValidationError extends Error {
  public readonly statusCode = 400;
  public readonly code = 'EVAL_VALIDATION_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'EvalValidationError';
  }
}

export interface GradeCandidateInput {
  actualOutput: string;
  citations: ModelCitation[];
  calledTools: AllowedToolName[];
}

export interface CaseEvaluationSummary {
  passed: boolean;
  score: number;
  assertionResults: EvalAssertionResult[];
}

function getJsonValuePrimitiveType(value: unknown): JsonPrimitiveType | 'null' {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return t;
  }
  return 'object';
}

function extractJsonObjectCandidate(rawText: string): unknown {
  const trimmed = rawText.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1]!.trim() : trimmed;
  return JSON.parse(candidate);
}

/**
 * Evaluates a single deterministic assertion against a run's output, citations, and tool trace.
 */
export function evaluateSingleAssertion(
  assertion: EvalAssertionSpec,
  candidate: GradeCandidateInput
): EvalAssertionResult {
  const output = candidate.actualOutput ?? '';

  switch (assertion.type) {
    case 'exact_match': {
      const lhs = assertion.ignoreCase
        ? output.trim().toLowerCase()
        : output.trim();
      const rhs = assertion.ignoreCase
        ? assertion.expected.trim().toLowerCase()
        : assertion.expected.trim();
      const passed = lhs === rhs;
      return {
        type: 'exact_match',
        passed,
        message: passed
          ? `Output matched expected string "${assertion.expected}".`
          : `Expected exact match "${assertion.expected}", got "${output.trim()}".`,
      };
    }

    case 'contains': {
      const haystack = assertion.ignoreCase ? output.toLowerCase() : output;
      const needle = assertion.ignoreCase
        ? assertion.expectedSubstring.toLowerCase()
        : assertion.expectedSubstring;
      const passed = haystack.includes(needle);
      return {
        type: 'contains',
        passed,
        message: passed
          ? `Output contains "${assertion.expectedSubstring}".`
          : `Output did not contain expected substring "${assertion.expectedSubstring}".`,
      };
    }

    case 'json_schema': {
      let parsed: unknown;
      try {
        parsed = extractJsonObjectCandidate(output);
      } catch {
        return {
          type: 'json_schema',
          passed: false,
          message: 'Output is not valid JSON.',
        };
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          type: 'json_schema',
          passed: false,
          message: 'Parsed JSON root must be a non-null JSON object.',
        };
      }

      const obj = parsed as Record<string, unknown>;
      const missingKeys = assertion.requiredKeys.filter(
        (key) => !(key in obj) || obj[key] === undefined
      );
      if (missingKeys.length > 0) {
        return {
          type: 'json_schema',
          passed: false,
          message: `JSON object is missing required keys: ${missingKeys.join(', ')}.`,
        };
      }

      if (assertion.fieldTypes) {
        for (const [key, expectedType] of Object.entries(assertion.fieldTypes)) {
          if (!(key in obj)) {
            return {
              type: 'json_schema',
              passed: false,
              message: `JSON object is missing typed key "${key}".`,
            };
          }
          const actualType = getJsonValuePrimitiveType(obj[key]);
          if (actualType !== expectedType) {
            return {
              type: 'json_schema',
              passed: false,
              message: `Key "${key}" expected type "${expectedType}", got "${actualType}".`,
            };
          }
        }
      }

      return {
        type: 'json_schema',
        passed: true,
        message: `JSON output satisfied all ${assertion.requiredKeys.length} required keys and field types.`,
      };
    }

    case 'citation_required': {
      const minCitations = Math.max(1, assertion.minCitations ?? 1);
      const citations = candidate.citations ?? [];
      if (citations.length < minCitations) {
        return {
          type: 'citation_required',
          passed: false,
          message: `Expected at least ${minCitations} verified citation(s), got ${citations.length}.`,
        };
      }

      if (assertion.documentId) {
        const hasDoc = citations.some(
          (c) => c.documentId === assertion.documentId
        );
        if (!hasDoc) {
          return {
            type: 'citation_required',
            passed: false,
            message: `No verified citation referenced required documentId "${assertion.documentId}".`,
          };
        }
      }

      if (assertion.chunkId) {
        const hasChunk = citations.some((c) => c.chunkId === assertion.chunkId);
        if (!hasChunk) {
          return {
            type: 'citation_required',
            passed: false,
            message: `No verified citation referenced required chunkId "${assertion.chunkId}".`,
          };
        }
      }

      return {
        type: 'citation_required',
        passed: true,
        message: `Verified ${citations.length} grounded citation(s).`,
      };
    }

    case 'tool_called': {
      const passed = candidate.calledTools.includes(assertion.toolName);
      return {
        type: 'tool_called',
        passed,
        message: passed
          ? `Tool "${assertion.toolName}" was invoked during the run.`
          : `Expected tool "${assertion.toolName}" to be called, but invoked tools were: [${candidate.calledTools.join(', ')}].`,
      };
    }
  }
}

/**
 * Evaluates all assertions for a test case and computes a deterministic score in `[0, 1]`.
 */
export function evaluateCaseAssertions(
  assertions: EvalAssertionSpec[],
  candidate: GradeCandidateInput
): CaseEvaluationSummary {
  if (assertions.length === 0) {
    return {
      passed: true,
      score: 1,
      assertionResults: [],
    };
  }

  const assertionResults = assertions.map((assertion) =>
    evaluateSingleAssertion(assertion, candidate)
  );
  const passedCount = assertionResults.filter((r) => r.passed).length;
  const score = Number((passedCount / assertionResults.length).toFixed(4));
  const passed = passedCount === assertionResults.length;

  return {
    passed,
    score,
    assertionResults,
  };
}

export interface CreateEvalCaseInput {
  name: string;
  inputPrompt: string;
  assertions: EvalAssertionSpec[];
}

export interface CreateEvalSuiteInput {
  organizationId: string;
  agentId: string;
  name: string;
  description?: string;
  cases: CreateEvalCaseInput[];
}

export interface EvalSuiteWithCases {
  suite: EvalSuiteRow;
  cases: EvalCaseRow[];
}

/**
 * Creates a tenant-isolated evaluation suite and its ordered test cases (`EVAL-001`).
 */
export async function createEvalSuite(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  input: CreateEvalSuiteInput
): Promise<EvalSuiteWithCases> {
  const decision = authorize(actor, 'eval.manage', {
    organizationId: input.organizationId,
    resourceType: 'eval_suite',
  });

  if (!decision.allowed) {
    if (actor && actor.organizationId === input.organizationId) {
      await recordAuditEvent(db, {
        organizationId: input.organizationId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'eval.manage',
        resourceType: 'eval_suite',
        resourceId: input.agentId,
        outcome: 'denied',
        metadata: { reason: decision.reason },
      });
    }
    throw new AuthorizationError(decision);
  }

  const trimmedName = input.name.trim();
  if (!trimmedName) {
    throw new EvalValidationError('Evaluation suite name cannot be empty.');
  }

  if (!Array.isArray(input.cases) || input.cases.length === 0) {
    throw new EvalValidationError(
      'Evaluation suite must contain at least one test case.'
    );
  }

  const [agent] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.id, input.agentId),
        eq(agents.organizationId, input.organizationId)
      )
    )
    .limit(1);

  if (!agent) {
    throw new EvalResourceNotFoundError('Agent', input.agentId);
  }

  return db.transaction(async (tx) => {
    const [suite] = await tx
      .insert(evalSuites)
      .values({
        organizationId: input.organizationId,
        agentId: input.agentId,
        name: trimmedName,
        description: (input.description ?? '').trim(),
        createdByUserId: actor!.userId,
      })
      .returning();

    const createdCases: EvalCaseRow[] = [];
    for (let i = 0; i < input.cases.length; i++) {
      const item = input.cases[i]!;
      const caseName = item.name.trim();
      const prompt = item.inputPrompt.trim();
      if (!caseName || !prompt) {
        throw new EvalValidationError(
          `Evaluation case #${i + 1} must have a non-empty name and inputPrompt.`
        );
      }

      const [createdCase] = await tx
        .insert(evalCases)
        .values({
          organizationId: input.organizationId,
          suiteId: suite!.id,
          caseIndex: i + 1,
          name: caseName,
          inputPrompt: prompt,
          assertionsJson: item.assertions,
        })
        .returning();

      createdCases.push(createdCase!);
    }

    await recordAuditEvent(tx as unknown as AegisDatabase, {
      organizationId: input.organizationId,
      actorUserId: actor!.userId,
      actorRole: actor!.role,
      action: 'eval.suite.created',
      resourceType: 'eval_suite',
      resourceId: suite!.id,
      outcome: 'allowed',
      metadata: {
        name: suite!.name,
        agentId: suite!.agentId,
        caseCount: createdCases.length,
      },
    });

    return {
      suite: suite!,
      cases: createdCases,
    };
  });
}

/**
 * Fetches an evaluation suite and its ordered cases for the active tenant.
 */
export async function getEvalSuiteWithCases(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  organizationId: string,
  suiteId: string
): Promise<EvalSuiteWithCases> {
  requireAuthorization(actor, 'eval.view', {
    organizationId,
    resourceType: 'eval_suite',
    resourceId: suiteId,
  });

  const [suite] = await db
    .select()
    .from(evalSuites)
    .where(
      and(
        eq(evalSuites.id, suiteId),
        eq(evalSuites.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!suite) {
    throw new EvalResourceNotFoundError('EvaluationSuite', suiteId);
  }

  const cases = await db
    .select()
    .from(evalCases)
    .where(
      and(
        eq(evalCases.suiteId, suiteId),
        eq(evalCases.organizationId, organizationId)
      )
    )
    .orderBy(asc(evalCases.caseIndex));

  return { suite, cases };
}

/**
 * Lists evaluation suites for an organization.
 */
export async function listEvalSuites(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  organizationId: string
): Promise<EvalSuiteRow[]> {
  requireAuthorization(actor, 'eval.view', {
    organizationId,
    resourceType: 'eval_suite',
  });

  return db
    .select()
    .from(evalSuites)
    .where(eq(evalSuites.organizationId, organizationId))
    .orderBy(desc(evalSuites.createdAt));
}

export interface RunEvalExperimentInput {
  organizationId: string;
  suiteId: string;
  agentVersionId: string;
  providerMode?: 'mock' | 'live';
}

export interface RunEvalExperimentOptions extends ExecuteAgentRunOptions {
  modelProvider?: ModelProvider;
}

export interface EvalExperimentResultDetails {
  experiment: EvalExperimentRow;
  caseResults: Array<{
    caseRow: EvalCaseRow;
    resultRow: EvalCaseResultRow;
  }>;
}

/**
 * Executes an automated evaluation experiment against a pinned `agent_versions` snapshot (`EVAL-001`).
 */
export async function runEvalExperiment(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  input: RunEvalExperimentInput,
  options?: RunEvalExperimentOptions
): Promise<EvalExperimentResultDetails> {
  const decision = authorize(actor, 'eval.execute', {
    organizationId: input.organizationId,
    resourceType: 'eval_experiment',
    resourceId: input.suiteId,
  });

  if (!decision.allowed) {
    if (actor && actor.organizationId === input.organizationId) {
      await recordAuditEvent(db, {
        organizationId: input.organizationId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'eval.execute',
        resourceType: 'eval_suite',
        resourceId: input.suiteId,
        outcome: 'denied',
        metadata: { reason: decision.reason },
      });
    }
    throw new AuthorizationError(decision);
  }

  const { suite, cases } = await getEvalSuiteWithCases(
    db,
    actor,
    input.organizationId,
    input.suiteId
  );

  const [agentVersion] = await db
    .select()
    .from(agentVersions)
    .where(
      and(
        eq(agentVersions.id, input.agentVersionId),
        eq(agentVersions.organizationId, input.organizationId),
        eq(agentVersions.agentId, suite.agentId)
      )
    )
    .limit(1);

  if (!agentVersion) {
    throw new EvalResourceNotFoundError('AgentVersion', input.agentVersionId);
  }

  const providerMode = input.providerMode ?? 'mock';

  const [experiment] = await db
    .insert(evalExperiments)
    .values({
      organizationId: input.organizationId,
      suiteId: suite.id,
      agentId: suite.agentId,
      agentVersionId: agentVersion.id,
      status: 'running',
      totalCases: cases.length,
      providerMode,
      triggeredByUserId: actor!.userId,
    })
    .returning();

  const detailedResults: Array<{
    caseRow: EvalCaseRow;
    resultRow: EvalCaseResultRow;
  }> = [];

  let passedCases = 0;
  let totalTokens = 0;
  let totalLatencyMs = 0;

  for (const evalCase of cases) {
    const caseStart = performance.now();

    const enqueued = await enqueueAgentRun(db, actor, {
      organizationId: input.organizationId,
      agentId: suite.agentId,
      agentVersionId: agentVersion.id,
      inputPrompt: evalCase.inputPrompt,
    });

    await executeAgentRun(db, enqueued.run.id, options);

    const trace = await getRunDetailsForActor(
      db,
      actor,
      input.organizationId,
      enqueued.run.id
    );

    const caseLatencyMs = Math.max(
      1,
      Math.round(performance.now() - caseStart)
    );

    const actualOutput = trace.run.finalOutput ?? '';
    const citations = Array.isArray(trace.run.citations)
      ? trace.run.citations
      : [];

    const calledTools = trace.steps
      .filter((s) => s.kind === 'tool_call' && s.modelOrToolName)
      .map((s) => s.modelOrToolName as AllowedToolName);

    const runTokens = trace.run.totalTokens ?? 0;

    const evaluation = evaluateCaseAssertions(evalCase.assertionsJson, {
      actualOutput,
      citations,
      calledTools,
    });

    const casePassed =
      trace.run.status === 'succeeded' && evaluation.passed;

    if (casePassed) {
      passedCases += 1;
    }
    totalTokens += runTokens;
    totalLatencyMs += caseLatencyMs;

    await recordUsageEvent(db, {
      organizationId: input.organizationId,
      runId: trace.run.id,
      agentVersionId: agentVersion.id,
      providerMode,
      modelId: agentVersion.modelConfig.model,
      inputTokens: trace.run.promptTokens ?? 0,
      outputTokens: trace.run.completionTokens ?? 0,
      totalTokens: runTokens,
      toolCallsCount: calledTools.length,
    });

    const [createdResult] = await db
      .insert(evalCaseResults)
      .values({
        organizationId: input.organizationId,
        experimentId: experiment!.id,
        caseId: evalCase.id,
        runId: trace.run.id,
        passed: casePassed,
        score: trace.run.status === 'succeeded' ? evaluation.score : 0,
        actualOutput,
        citationsJson: citations,
        assertionResultsJson: evaluation.assertionResults,
        latencyMs: caseLatencyMs,
        totalTokens: runTokens,
      })
      .returning();

    detailedResults.push({
      caseRow: evalCase,
      resultRow: createdResult!,
    });
  }

  const failedCases = cases.length - passedCases;
  const passRate =
    cases.length > 0
      ? Number(((passedCases / cases.length) * 100).toFixed(2))
      : 0;
  const avgLatencyMs =
    cases.length > 0 ? Math.round(totalLatencyMs / cases.length) : 0;

  const [completedExperiment] = await db
    .update(evalExperiments)
    .set({
      status: 'succeeded',
      passedCases,
      failedCases,
      passRate,
      totalTokens,
      avgLatencyMs,
      completedAt: new Date(),
    })
    .where(eq(evalExperiments.id, experiment!.id))
    .returning();

  await recordAuditEvent(db, {
    organizationId: input.organizationId,
    actorUserId: actor!.userId,
    actorRole: actor!.role,
    action: 'eval.experiment.completed',
    resourceType: 'eval_experiment',
    resourceId: completedExperiment!.id,
    outcome: 'allowed',
    metadata: {
      suiteId: suite.id,
      agentVersionId: agentVersion.id,
      versionNumber: agentVersion.versionNumber,
      passRate,
      passedCases,
      totalCases: cases.length,
    },
  });

  return {
    experiment: completedExperiment!,
    caseResults: detailedResults,
  };
}

export interface CaseComparisonDiff {
  caseId: string;
  caseIndex: number;
  caseName: string;
  baselinePassed: boolean;
  candidatePassed: boolean;
  baselineScore: number;
  candidateScore: number;
  status: 'regressed' | 'improved' | 'unchanged_pass' | 'unchanged_fail';
}

export interface ExperimentComparisonReport {
  suiteId: string;
  baselineExperiment: EvalExperimentRow;
  candidateExperiment: EvalExperimentRow;
  passRateDelta: number;
  avgLatencyDeltaMs: number;
  totalTokensDelta: number;
  regressedCasesCount: number;
  improvedCasesCount: number;
  caseDiffs: CaseComparisonDiff[];
}

/**
 * Compares two evaluation experiments belonging to the same suite (e.g., Agent v1 vs v2)
 * and identifies exact per-case regressions or improvements (`EVAL-001`).
 */
export async function compareEvalExperiments(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  input: {
    organizationId: string;
    baselineExperimentId: string;
    candidateExperimentId: string;
  }
): Promise<ExperimentComparisonReport> {
  requireAuthorization(actor, 'eval.view', {
    organizationId: input.organizationId,
    resourceType: 'eval_experiment',
  });

  const [baseline] = await db
    .select()
    .from(evalExperiments)
    .where(
      and(
        eq(evalExperiments.id, input.baselineExperimentId),
        eq(evalExperiments.organizationId, input.organizationId)
      )
    )
    .limit(1);

  if (!baseline) {
    throw new EvalResourceNotFoundError(
      'EvalExperiment',
      input.baselineExperimentId
    );
  }

  const [candidate] = await db
    .select()
    .from(evalExperiments)
    .where(
      and(
        eq(evalExperiments.id, input.candidateExperimentId),
        eq(evalExperiments.organizationId, input.organizationId)
      )
    )
    .limit(1);

  if (!candidate) {
    throw new EvalResourceNotFoundError(
      'EvalExperiment',
      input.candidateExperimentId
    );
  }

  if (baseline.suiteId !== candidate.suiteId) {
    throw new EvalValidationError(
      'Cannot compare experiments from different evaluation suites.'
    );
  }

  const cases = await db
    .select()
    .from(evalCases)
    .where(
      and(
        eq(evalCases.suiteId, baseline.suiteId),
        eq(evalCases.organizationId, input.organizationId)
      )
    )
    .orderBy(asc(evalCases.caseIndex));

  const baselineResults = await db
    .select()
    .from(evalCaseResults)
    .where(
      and(
        eq(evalCaseResults.experimentId, baseline.id),
        eq(evalCaseResults.organizationId, input.organizationId)
      )
    );

  const candidateResults = await db
    .select()
    .from(evalCaseResults)
    .where(
      and(
        eq(evalCaseResults.experimentId, candidate.id),
        eq(evalCaseResults.organizationId, input.organizationId)
      )
    );

  const baselineMap = new Map(baselineResults.map((r) => [r.caseId, r]));
  const candidateMap = new Map(candidateResults.map((r) => [r.caseId, r]));

  let regressedCasesCount = 0;
  let improvedCasesCount = 0;

  const caseDiffs: CaseComparisonDiff[] = cases.map((c) => {
    const b = baselineMap.get(c.id);
    const d = candidateMap.get(c.id);
    const baselinePassed = b?.passed ?? false;
    const candidatePassed = d?.passed ?? false;
    const baselineScore = b?.score ?? 0;
    const candidateScore = d?.score ?? 0;

    let status: CaseComparisonDiff['status'];
    if (baselinePassed && !candidatePassed) {
      status = 'regressed';
      regressedCasesCount += 1;
    } else if (!baselinePassed && candidatePassed) {
      status = 'improved';
      improvedCasesCount += 1;
    } else if (baselinePassed && candidatePassed) {
      status = 'unchanged_pass';
    } else {
      status = 'unchanged_fail';
    }

    return {
      caseId: c.id,
      caseIndex: c.caseIndex,
      caseName: c.name,
      baselinePassed,
      candidatePassed,
      baselineScore,
      candidateScore,
      status,
    };
  });

  return {
    suiteId: baseline.suiteId,
    baselineExperiment: baseline,
    candidateExperiment: candidate,
    passRateDelta: Number(
      (candidate.passRate - baseline.passRate).toFixed(2)
    ),
    avgLatencyDeltaMs: candidate.avgLatencyMs - baseline.avgLatencyMs,
    totalTokensDelta: candidate.totalTokens - baseline.totalTokens,
    regressedCasesCount,
    improvedCasesCount,
    caseDiffs,
  };
}
