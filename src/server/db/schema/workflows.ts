import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './tenant';
import { agentVersions } from './agents';
import { runs } from './runs';

/**
 * Tickets WORKFLOW-001, HITL-001, AUDIT-001 & USAGE-001:
 * Directed Acyclic Workflows, Immutable Workflow Snapshots, Human-in-the-Loop
 * Approval Gates, Append-Only Audit Ledger & Honest Usage Events Schema
 *
 * Implements Blueprint Section 4.1, Section 8.6 & Threat Model T-01, T-04, T-06, T-07:
 * 1. `workflows`: Mutable tenant-scoped workflow drafts (`draft_graph_json`).
 * 2. `workflow_versions`: Immutable published workflow DAG snapshots with composite
 *    tenant FK `(organization_id, workflow_id) -> workflows(organization_id, id)`
 *    and SHA-256 `snapshot_hash`.
 * 3. `approval_requests`: Durable human-in-the-loop pause/resume gates tied to a run
 *    and DAG node (`pending` -> `approved` | `rejected` | `expired`).
 * 4. `audit_events`: Append-only security & governance audit ledger recording both
 *    `allowed` and `denied` outcomes with actor role and structured metadata.
 * 5. `usage_events`: Honest token & tool invocation ledger separating `mock`
 *    (deterministic simulation) from `live` provider usage.
 */

export const WORKFLOW_STATUSES = ['draft', 'active', 'archived'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const WORKFLOW_NODE_KINDS = [
  'start',
  'agent',
  'tool',
  'condition',
  'approval',
  'end',
] as const;
export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

export const CONDITION_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'gt',
  'lt',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export interface WorkflowConditionConfig {
  field: string;
  operator: ConditionOperator;
  value: string | number | boolean;
}

export interface WorkflowNodeSpec {
  id: string;
  kind: WorkflowNodeKind;
  label: string;
  agentVersionId?: string;
  promptTemplate?: string;
  toolName?: 'calculator' | 'http_fetch' | 'knowledge_search';
  toolInput?: Record<string, unknown>;
  condition?: WorkflowConditionConfig;
  approvalTitle?: string;
  approvalReason?: string;
  allowDeveloperDecision?: boolean;
}

export interface WorkflowEdgeSpec {
  id: string;
  source: string;
  target: string;
  conditionLabel?: 'true' | 'false';
}

export interface WorkflowGraphSpec {
  nodes: WorkflowNodeSpec[];
  edges: WorkflowEdgeSpec[];
}

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const AUDIT_OUTCOMES = ['allowed', 'denied'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const USAGE_PROVIDER_MODES = ['mock', 'live'] as const;
export type UsageProviderMode = (typeof USAGE_PROVIDER_MODES)[number];

export const workflows = pgTable(
  'workflows',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    draftGraphJson: jsonb('draft_graph_json')
      .$type<WorkflowGraphSpec>()
      .notNull(),
    status: text('status')
      .$type<WorkflowStatus>()
      .notNull()
      .default('draft'),
    latestVersionNumber: integer('latest_version_number').notNull().default(0),
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
    unique('workflows_org_id_unique').on(table.organizationId, table.id),
    unique('workflows_org_slug_unique').on(table.organizationId, table.slug),
    index('idx_workflows_org_created').on(
      table.organizationId,
      table.createdAt
    ),
    check(
      'workflows_slug_format_check',
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`
    ),
    check(
      'workflows_name_not_blank',
      sql`length(btrim(${table.name})) >= 2`
    ),
    check(
      'workflows_status_valid',
      sql`${table.status} IN ('draft', 'active', 'archived')`
    ),
    check(
      'workflows_latest_version_non_negative',
      sql`${table.latestVersionNumber} >= 0`
    ),
  ]
);

export const workflowVersions = pgTable(
  'workflow_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    workflowId: uuid('workflow_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    graphJson: jsonb('graph_json').$type<WorkflowGraphSpec>().notNull(),
    publishedByUserId: uuid('published_by_user_id').references(
      () => users.id,
      { onDelete: 'set null' }
    ),
    publishedAt: timestamp('published_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'workflow_versions_org_workflow_fk',
      columns: [table.organizationId, table.workflowId],
      foreignColumns: [workflows.organizationId, workflows.id],
    }).onDelete('cascade'),
    unique('workflow_versions_org_id_unique').on(
      table.organizationId,
      table.id
    ),
    unique('workflow_versions_workflow_version_unique').on(
      table.workflowId,
      table.versionNumber
    ),
    index('idx_workflow_versions_org_workflow').on(
      table.organizationId,
      table.workflowId,
      table.versionNumber
    ),
    check(
      'workflow_versions_positive_version',
      sql`${table.versionNumber} >= 1`
    ),
    check(
      'workflow_versions_hash_not_blank',
      sql`length(btrim(${table.snapshotHash})) >= 16`
    ),
  ]
);

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    workflowVersionId: uuid('workflow_version_id').references(
      () => workflowVersions.id,
      { onDelete: 'set null' }
    ),
    nodeId: text('node_id').notNull(),
    title: text('title').notNull(),
    reason: text('reason').notNull(),
    status: text('status')
      .$type<ApprovalStatus>()
      .notNull()
      .default('pending'),
    allowDeveloperDecision: boolean('allow_developer_decision')
      .notNull()
      .default(false),
    contextJson: jsonb('context_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    decisionNote: text('decision_note'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('approval_requests_run_node_unique').on(table.runId, table.nodeId),
    index('idx_approval_requests_org_status').on(
      table.organizationId,
      table.status,
      table.createdAt
    ),
    check(
      'approval_requests_status_valid',
      sql`${table.status} IN ('pending', 'approved', 'rejected', 'expired')`
    ),
    check(
      'approval_requests_title_not_blank',
      sql`length(btrim(${table.title})) > 0`
    ),
  ]
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    actorRole: text('actor_role').notNull(),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    outcome: text('outcome').$type<AuditOutcome>().notNull(),
    metadataJson: jsonb('metadata_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_audit_events_org_created').on(
      table.organizationId,
      table.createdAt
    ),
    index('idx_audit_events_org_action').on(table.organizationId, table.action),
    check(
      'audit_events_outcome_valid',
      sql`${table.outcome} IN ('allowed', 'denied')`
    ),
    check(
      'audit_events_action_not_blank',
      sql`length(btrim(${table.action})) > 0`
    ),
  ]
);

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    workflowVersionId: uuid('workflow_version_id').references(
      () => workflowVersions.id,
      { onDelete: 'set null' }
    ),
    agentVersionId: uuid('agent_version_id').references(
      () => agentVersions.id,
      { onDelete: 'set null' }
    ),
    providerMode: text('provider_mode')
      .$type<UsageProviderMode>()
      .notNull()
      .default('mock'),
    modelId: text('model_id').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    toolCallsCount: integer('tool_calls_count').notNull().default(0),
    isEstimated: boolean('is_estimated').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_usage_events_org_created').on(
      table.organizationId,
      table.createdAt
    ),
    index('idx_usage_events_org_mode').on(
      table.organizationId,
      table.providerMode
    ),
    check(
      'usage_events_provider_mode_valid',
      sql`${table.providerMode} IN ('mock', 'live')`
    ),
    check(
      'usage_events_tokens_non_negative',
      sql`${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0 AND ${table.totalTokens} >= 0`
    ),
    check(
      'usage_events_tool_calls_non_negative',
      sql`${table.toolCallsCount} >= 0`
    ),
  ]
);

export type WorkflowRow = typeof workflows.$inferSelect;
export type NewWorkflowRow = typeof workflows.$inferInsert;

export type WorkflowVersionRow = typeof workflowVersions.$inferSelect;
export type NewWorkflowVersionRow = typeof workflowVersions.$inferInsert;

export type ApprovalRequestRow = typeof approvalRequests.$inferSelect;
export type NewApprovalRequestRow = typeof approvalRequests.$inferInsert;

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;

export type UsageEventRow = typeof usageEvents.$inferSelect;
export type NewUsageEventRow = typeof usageEvents.$inferInsert;

/**
 * Versioned SQL Migration 0005: `workflows`, `workflow_versions`,
 * `approval_requests`, `audit_events`, and `usage_events`.
 */
export const MIGRATION_0005_WORKFLOWS_SQL = `
CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name TEXT NOT NULL CHECK (length(btrim(name)) >= 2),
  description TEXT NOT NULL DEFAULT '',
  draft_graph_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  latest_version_number INTEGER NOT NULL DEFAULT 0 CHECK (latest_version_number >= 0),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflows_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT workflows_org_slug_unique UNIQUE (organization_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_workflows_org_created
  ON workflows (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  snapshot_hash TEXT NOT NULL CHECK (length(btrim(snapshot_hash)) >= 16),
  graph_json JSONB NOT NULL,
  published_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_versions_org_workflow_fk
    FOREIGN KEY (organization_id, workflow_id)
    REFERENCES workflows(organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT workflow_versions_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT workflow_versions_workflow_version_unique UNIQUE (workflow_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_org_workflow
  ON workflow_versions (organization_id, workflow_id, version_number DESC);

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  workflow_version_id UUID REFERENCES workflow_versions(id) ON DELETE SET NULL,
  node_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  allow_developer_decision BOOLEAN NOT NULL DEFAULT FALSE,
  context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  decision_note TEXT,
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT approval_requests_run_node_unique UNIQUE (run_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_org_status
  ON approval_requests (organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(btrim(action)) > 0),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied')),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_org_created
  ON audit_events (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_org_action
  ON audit_events (organization_id, action);

CREATE TABLE IF NOT EXISTS usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  workflow_version_id UUID REFERENCES workflow_versions(id) ON DELETE SET NULL,
  agent_version_id UUID REFERENCES agent_versions(id) ON DELETE SET NULL,
  provider_mode TEXT NOT NULL DEFAULT 'mock' CHECK (provider_mode IN ('mock', 'live')),
  model_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  tool_calls_count INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls_count >= 0),
  is_estimated BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_org_created
  ON usage_events (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_org_mode
  ON usage_events (organization_id, provider_mode);
`;
