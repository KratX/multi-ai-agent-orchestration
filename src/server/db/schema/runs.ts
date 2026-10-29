import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  jsonb,
  timestamp,
  unique,
  check,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './tenant';
import { agents, agentVersions } from './agents';
import type { ModelCitation, ModelUsageSource } from '../../ai/model-provider';

/**
 * Tickets RUN-001 & QUEUE-001: Runs, Run Steps, Run Events & PostgreSQL Job Queue Schema
 *
 * Implements Blueprint Section 8.4, Section 8.5 & ADR-003:
 * 1. `runs`: Execution record pinned to an immutable `agent_version_id` (never reading
 *    mutable `agents` draft config), with per-tenant idempotency key deduplication
 *    `UNIQUE (organization_id, idempotency_key)`, token/cost/latency metrics, and
 *    verified citations.
 * 2. `run_steps`: Append-only trace of each bounded execution step (`model_turn`,
 *    `tool_call`, `approval_gate`, `final_answer`) with `UNIQUE (run_id, step_index)`.
 * 3. `run_events`: Append-only event stream with per-run monotonic `sequence_no`
 *    (`UNIQUE (run_id, sequence_no)`) powering live SSE streaming and replay.
 * 4. `job_queue`: PostgreSQL-backed durable queue supporting `FOR UPDATE SKIP LOCKED`
 *    worker leases, heartbeats, exponential backoff retries, and dead-lettering (`ADR-003`).
 */

export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STEP_KINDS = [
  'model_turn',
  'tool_call',
  'approval_gate',
  'final_answer',
] as const;
export type RunStepKind = (typeof RUN_STEP_KINDS)[number];

export const RUN_STEP_STATUSES = ['succeeded', 'failed', 'skipped'] as const;
export type RunStepStatus = (typeof RUN_STEP_STATUSES)[number];

export const RUN_EVENT_TYPES = [
  'run.queued',
  'run.started',
  'step.model_completed',
  'step.tool_completed',
  'step.tool_failed',
  'run.waiting_approval',
  'run.succeeded',
  'run.failed',
  'run.timed_out',
  'run.cancelled',
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const JOB_STATUSES = [
  'pending',
  'locked',
  'completed',
  'dead_letter',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    agentVersionId: uuid('agent_version_id')
      .notNull()
      .references(() => agentVersions.id, { onDelete: 'restrict' }),
    status: text('status').$type<RunStatus>().notNull().default('queued'),
    inputPrompt: text('input_prompt').notNull(),
    finalOutput: text('final_output'),
    citations: jsonb('citations')
      .$type<ModelCitation[]>()
      .notNull()
      .default([]),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    stepCount: integer('step_count').notNull().default(0),
    toolCallCount: integer('tool_call_count').notNull().default(0),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    estimatedCostUsd: numeric('estimated_cost_usd', {
      precision: 12,
      scale: 6,
    })
      .notNull()
      .default('0.000000'),
    usageSource: text('usage_source')
      .$type<ModelUsageSource>()
      .notNull()
      .default('mock'),
    latencyMs: integer('latency_ms'),
    idempotencyKey: text('idempotency_key'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('runs_org_idempotency_unique').on(
      table.organizationId,
      table.idempotencyKey
    ),
    check(
      'runs_status_check',
      sql`${table.status} IN ('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'timed_out')`
    ),
    check(
      'runs_input_prompt_check',
      sql`length(trim(${table.inputPrompt})) >= 1`
    ),
    check('runs_step_count_non_negative', sql`${table.stepCount} >= 0`),
    check(
      'runs_tool_call_count_non_negative',
      sql`${table.toolCallCount} >= 0`
    ),
  ]
);

export const runSteps = pgTable(
  'run_steps',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepIndex: integer('step_index').notNull(),
    kind: text('kind').$type<RunStepKind>().notNull(),
    modelOrToolName: text('model_or_tool_name').notNull(),
    inputPayload: jsonb('input_payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    outputPayload: jsonb('output_payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    citations: jsonb('citations')
      .$type<ModelCitation[]>()
      .notNull()
      .default([]),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    status: text('status')
      .$type<RunStepStatus>()
      .notNull()
      .default('succeeded'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('run_steps_run_step_index_unique').on(table.runId, table.stepIndex),
    check('run_steps_positive_index_check', sql`${table.stepIndex} >= 1`),
    check(
      'run_steps_kind_check',
      sql`${table.kind} IN ('model_turn', 'tool_call', 'approval_gate', 'final_answer')`
    ),
    check(
      'run_steps_status_check',
      sql`${table.status} IN ('succeeded', 'failed', 'skipped')`
    ),
  ]
);

export const runEvents = pgTable(
  'run_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sequenceNo: integer('sequence_no').notNull(),
    eventType: text('event_type').$type<RunEventType>().notNull(),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('run_events_run_sequence_unique').on(table.runId, table.sequenceNo),
    check('run_events_positive_seq_check', sql`${table.sequenceNo} >= 1`),
  ]
);

export const jobQueue = pgTable(
  'job_queue',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    jobType: text('job_type').notNull().default('agent_run'),
    status: text('status').$type<JobStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    availableAt: timestamp('available_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('job_queue_run_id_unique').on(table.runId),
    check(
      'job_queue_status_check',
      sql`${table.status} IN ('pending', 'locked', 'completed', 'dead_letter')`
    ),
    check('job_queue_attempts_non_negative', sql`${table.attempts} >= 0`),
    check('job_queue_max_attempts_positive', sql`${table.maxAttempts} >= 1`),
  ]
);

export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;

export type RunStepRow = typeof runSteps.$inferSelect;
export type NewRunStepRow = typeof runSteps.$inferInsert;

export type RunEventRow = typeof runEvents.$inferSelect;
export type NewRunEventRow = typeof runEvents.$inferInsert;

export type JobQueueRow = typeof jobQueue.$inferSelect;
export type NewJobQueueRow = typeof jobQueue.$inferInsert;

/**
 * Versioned SQL Migration 0003: `runs`, `run_steps`, `run_events`, and `job_queue`
 */
export const MIGRATION_0003_RUNS_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_version_id UUID NOT NULL REFERENCES agent_versions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  input_prompt TEXT NOT NULL CHECK (length(trim(input_prompt)) >= 1),
  final_output TEXT,
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_code TEXT,
  error_message TEXT,
  step_count INTEGER NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  tool_call_count INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_count >= 0),
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0.000000,
  usage_source TEXT NOT NULL DEFAULT 'mock',
  latency_ms INTEGER,
  idempotency_key TEXT,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT runs_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT runs_org_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT runs_org_agent_fk
    FOREIGN KEY (organization_id, agent_id)
    REFERENCES agents(organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT runs_org_agent_version_fk
    FOREIGN KEY (organization_id, agent_id, agent_version_id)
    REFERENCES agent_versions(organization_id, agent_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS runs_org_created_idx
  ON runs (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS run_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL CHECK (step_index >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('model_turn', 'tool_call', 'approval_gate', 'final_answer')),
  model_or_tool_name TEXT NOT NULL,
  input_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'succeeded' CHECK (status IN ('succeeded', 'failed', 'skipped')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT run_steps_org_run_fk
    FOREIGN KEY (organization_id, run_id)
    REFERENCES runs(organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT run_steps_run_step_index_unique UNIQUE (run_id, step_index)
);

CREATE INDEX IF NOT EXISTS run_steps_org_run_idx
  ON run_steps (organization_id, run_id, step_index ASC);

CREATE TABLE IF NOT EXISTS run_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL CHECK (sequence_no >= 1),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT run_events_org_run_fk
    FOREIGN KEY (organization_id, run_id)
    REFERENCES runs(organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT run_events_run_sequence_unique UNIQUE (run_id, sequence_no)
);

CREATE INDEX IF NOT EXISTS run_events_org_run_seq_idx
  ON run_events (organization_id, run_id, sequence_no ASC);

CREATE TABLE IF NOT EXISTS job_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL DEFAULT 'agent_run',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'locked', 'completed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT job_queue_org_run_fk
    FOREIGN KEY (organization_id, run_id)
    REFERENCES runs(organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT job_queue_run_id_unique UNIQUE (run_id)
);

CREATE INDEX IF NOT EXISTS job_queue_claim_idx
  ON job_queue (status, available_at ASC);
`;

