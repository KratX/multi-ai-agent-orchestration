import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './tenant';
import { agents, agentVersions, type AllowedToolName } from './agents';
import { runs } from './runs';
import type { ModelCitation } from '../../ai/model-provider';
import type { UsageProviderMode } from './workflows';

/**
 * Ticket EVAL-001: Automated Evaluation Suites, Assertions, Experiments & Case Results Schema
 *
 * Implements Blueprint Section 4.1 & Section 5.6:
 * - `eval_suites`: Tenant-scoped evaluation benchmark suites attached to an agent.
 * - `eval_cases`: Ordered test cases with deterministic assertion rules (`exact_match`,
 *   `contains`, `json_schema`, `citation_required`, `tool_called`).
 * - `eval_experiments`: Immutable evaluation runs pinned to a specific `agent_versions`
 *   snapshot (`v1`, `v2`, ...) with aggregated pass rate, token, and latency metrics.
 * - `eval_case_results`: Individual case outcomes linked to the underlying `runs.id`
 *   execution trace and per-assertion grading breakdown.
 */

export const EVAL_ASSERTION_TYPES = [
  'exact_match',
  'contains',
  'json_schema',
  'citation_required',
  'tool_called',
] as const;

export type EvalAssertionType = (typeof EVAL_ASSERTION_TYPES)[number];

export type JsonPrimitiveType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export type EvalAssertionSpec =
  | {
      type: 'exact_match';
      expected: string;
      ignoreCase?: boolean;
    }
  | {
      type: 'contains';
      expectedSubstring: string;
      ignoreCase?: boolean;
    }
  | {
      type: 'json_schema';
      requiredKeys: string[];
      fieldTypes?: Record<string, JsonPrimitiveType>;
    }
  | {
      type: 'citation_required';
      minCitations?: number;
      documentId?: string;
      chunkId?: string;
    }
  | {
      type: 'tool_called';
      toolName: AllowedToolName;
    };

export interface EvalAssertionResult {
  type: EvalAssertionType;
  passed: boolean;
  message: string;
}

export const EVAL_EXPERIMENT_STATUSES = [
  'running',
  'succeeded',
  'failed',
] as const;

export type EvalExperimentStatus = (typeof EVAL_EXPERIMENT_STATUSES)[number];

/**
 * 1. `eval_suites`
 * Collection of repeatable evaluation test cases for an agent within an organization.
 */
export const evalSuites = pgTable(
  'eval_suites',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('eval_suites_org_id_id_unique').on(
      table.organizationId,
      table.id
    ),
    index('eval_suites_org_agent_idx').on(table.organizationId, table.agentId),
    foreignKey({
      name: 'eval_suites_org_agent_fk',
      columns: [table.organizationId, table.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete('cascade'),
    check('eval_suites_name_not_empty', sql`length(trim(${table.name})) > 0`),
  ]
);

/**
 * 2. `eval_cases`
 * Individual prompt + deterministic assertion specs belonging to an `eval_suites` row.
 */
export const evalCases = pgTable(
  'eval_cases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    suiteId: uuid('suite_id').notNull(),
    caseIndex: integer('case_index').notNull(),
    name: text('name').notNull(),
    inputPrompt: text('input_prompt').notNull(),
    assertionsJson: jsonb('assertions_json')
      .$type<EvalAssertionSpec[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('eval_cases_org_id_id_unique').on(
      table.organizationId,
      table.id
    ),
    uniqueIndex('eval_cases_suite_index_unique').on(
      table.suiteId,
      table.caseIndex
    ),
    foreignKey({
      name: 'eval_cases_org_suite_fk',
      columns: [table.organizationId, table.suiteId],
      foreignColumns: [evalSuites.organizationId, evalSuites.id],
    }).onDelete('cascade'),
    check('eval_cases_index_positive', sql`${table.caseIndex} >= 1`),
    check('eval_cases_name_not_empty', sql`length(trim(${table.name})) > 0`),
    check(
      'eval_cases_prompt_not_empty',
      sql`length(trim(${table.inputPrompt})) > 0`
    ),
  ]
);

/**
 * 3. `eval_experiments`
 * Execution of an `eval_suites` benchmark against a pinned `agent_versions` snapshot.
 */
export const evalExperiments = pgTable(
  'eval_experiments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    suiteId: uuid('suite_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    agentVersionId: uuid('agent_version_id').notNull(),
    status: text('status').$type<EvalExperimentStatus>().notNull().default('running'),
    totalCases: integer('total_cases').notNull().default(0),
    passedCases: integer('passed_cases').notNull().default(0),
    failedCases: integer('failed_cases').notNull().default(0),
    passRate: doublePrecision('pass_rate').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    avgLatencyMs: integer('avg_latency_ms').notNull().default(0),
    providerMode: text('provider_mode')
      .$type<UsageProviderMode>()
      .notNull()
      .default('mock'),
    triggeredByUserId: uuid('triggered_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('eval_experiments_org_id_id_unique').on(
      table.organizationId,
      table.id
    ),
    index('eval_experiments_org_suite_idx').on(
      table.organizationId,
      table.suiteId,
      table.createdAt
    ),
    foreignKey({
      name: 'eval_experiments_org_suite_fk',
      columns: [table.organizationId, table.suiteId],
      foreignColumns: [evalSuites.organizationId, evalSuites.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'eval_experiments_org_agent_fk',
      columns: [table.organizationId, table.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'eval_experiments_org_agent_version_fk',
      columns: [table.organizationId, table.agentVersionId],
      foreignColumns: [agentVersions.organizationId, agentVersions.id],
    }).onDelete('restrict'),
    check(
      'eval_experiments_status_valid',
      sql`${table.status} IN ('running', 'succeeded', 'failed')`
    ),
    check(
      'eval_experiments_provider_mode_valid',
      sql`${table.providerMode} IN ('mock', 'live')`
    ),
    check(
      'eval_experiments_counts_non_negative',
      sql`${table.totalCases} >= 0 AND ${table.passedCases} >= 0 AND ${table.failedCases} >= 0`
    ),
  ]
);

/**
 * 4. `eval_case_results`
 * Per-case outcome for an experiment, linked to the actual `runs.id` trace.
 */
export const evalCaseResults = pgTable(
  'eval_case_results',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    experimentId: uuid('experiment_id').notNull(),
    caseId: uuid('case_id').notNull(),
    runId: uuid('run_id'),
    passed: boolean('passed').notNull(),
    score: doublePrecision('score').notNull().default(0),
    actualOutput: text('actual_output').notNull().default(''),
    citationsJson: jsonb('citations_json')
      .$type<ModelCitation[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    assertionResultsJson: jsonb('assertion_results_json')
      .$type<EvalAssertionResult[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    latencyMs: integer('latency_ms').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('eval_case_results_experiment_case_unique').on(
      table.experimentId,
      table.caseId
    ),
    index('eval_case_results_org_experiment_idx').on(
      table.organizationId,
      table.experimentId
    ),
    foreignKey({
      name: 'eval_case_results_org_experiment_fk',
      columns: [table.organizationId, table.experimentId],
      foreignColumns: [evalExperiments.organizationId, evalExperiments.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'eval_case_results_org_case_fk',
      columns: [table.organizationId, table.caseId],
      foreignColumns: [evalCases.organizationId, evalCases.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'eval_case_results_org_run_fk',
      columns: [table.organizationId, table.runId],
      foreignColumns: [runs.organizationId, runs.id],
    }).onDelete('set null'),
    check(
      'eval_case_results_score_range',
      sql`${table.score} >= 0 AND ${table.score} <= 1`
    ),
  ]
);

export type EvalSuiteRow = typeof evalSuites.$inferSelect;
export type NewEvalSuiteRow = typeof evalSuites.$inferInsert;

export type EvalCaseRow = typeof evalCases.$inferSelect;
export type NewEvalCaseRow = typeof evalCases.$inferInsert;

export type EvalExperimentRow = typeof evalExperiments.$inferSelect;
export type NewEvalExperimentRow = typeof evalExperiments.$inferInsert;

export type EvalCaseResultRow = typeof evalCaseResults.$inferSelect;
export type NewEvalCaseResultRow = typeof evalCaseResults.$inferInsert;

/**
 * Versioned SQL Migration 0006: Evaluation Suites, Cases, Experiments & Case Results
 */
export const MIGRATION_0006_EVALS_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS agents_org_id_id_unique
  ON agents(organization_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS agent_versions_org_id_id_unique
  ON agent_versions(organization_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS runs_org_id_id_unique
  ON runs(organization_id, id);

CREATE TABLE IF NOT EXISTS eval_suites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT eval_suites_name_not_empty CHECK (length(trim(name)) > 0),
  CONSTRAINT eval_suites_org_agent_fk
    FOREIGN KEY (organization_id, agent_id)
    REFERENCES agents(organization_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS eval_suites_org_id_id_unique
  ON eval_suites(organization_id, id);

CREATE INDEX IF NOT EXISTS eval_suites_org_agent_idx
  ON eval_suites(organization_id, agent_id);

CREATE TABLE IF NOT EXISTS eval_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  suite_id UUID NOT NULL,
  case_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  input_prompt TEXT NOT NULL,
  assertions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT eval_cases_index_positive CHECK (case_index >= 1),
  CONSTRAINT eval_cases_name_not_empty CHECK (length(trim(name)) > 0),
  CONSTRAINT eval_cases_prompt_not_empty CHECK (length(trim(input_prompt)) > 0),
  CONSTRAINT eval_cases_org_suite_fk
    FOREIGN KEY (organization_id, suite_id)
    REFERENCES eval_suites(organization_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS eval_cases_org_id_id_unique
  ON eval_cases(organization_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS eval_cases_suite_index_unique
  ON eval_cases(suite_id, case_index);

CREATE TABLE IF NOT EXISTS eval_experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  suite_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  agent_version_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  total_cases INTEGER NOT NULL DEFAULT 0,
  passed_cases INTEGER NOT NULL DEFAULT 0,
  failed_cases INTEGER NOT NULL DEFAULT 0,
  pass_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms INTEGER NOT NULL DEFAULT 0,
  provider_mode TEXT NOT NULL DEFAULT 'mock',
  triggered_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT eval_experiments_status_valid CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT eval_experiments_provider_mode_valid CHECK (provider_mode IN ('mock', 'live')),
  CONSTRAINT eval_experiments_counts_non_negative CHECK (
    total_cases >= 0 AND passed_cases >= 0 AND failed_cases >= 0
  ),
  CONSTRAINT eval_experiments_org_suite_fk
    FOREIGN KEY (organization_id, suite_id)
    REFERENCES eval_suites(organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT eval_experiments_org_agent_fk
    FOREIGN KEY (organization_id, agent_id)
    REFERENCES agents(organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT eval_experiments_org_agent_version_fk
    FOREIGN KEY (organization_id, agent_version_id)
    REFERENCES agent_versions(organization_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS eval_experiments_org_id_id_unique
  ON eval_experiments(organization_id, id);

CREATE INDEX IF NOT EXISTS eval_experiments_org_suite_idx
  ON eval_experiments(organization_id, suite_id, created_at);

CREATE TABLE IF NOT EXISTS eval_case_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  experiment_id UUID NOT NULL,
  case_id UUID NOT NULL,
  run_id UUID,
  passed BOOLEAN NOT NULL,
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  actual_output TEXT NOT NULL DEFAULT '',
  citations_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  assertion_results_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT eval_case_results_score_range CHECK (score >= 0 AND score <= 1),
  CONSTRAINT eval_case_results_org_experiment_fk
    FOREIGN KEY (organization_id, experiment_id)
    REFERENCES eval_experiments(organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT eval_case_results_org_case_fk
    FOREIGN KEY (organization_id, case_id)
    REFERENCES eval_cases(organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT eval_case_results_org_run_fk
    FOREIGN KEY (organization_id, run_id)
    REFERENCES runs(organization_id, id)
    ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS eval_case_results_experiment_case_unique
  ON eval_case_results(experiment_id, case_id);

CREATE INDEX IF NOT EXISTS eval_case_results_org_experiment_idx
  ON eval_case_results(organization_id, experiment_id);
`;
