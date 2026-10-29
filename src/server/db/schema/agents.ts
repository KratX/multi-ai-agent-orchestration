import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  unique,
  check,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './tenant';

/**
 * Tickets AGENT-001 & AGENT-002 (Part 1): Agent Studio & Immutable Agent Versions Schema
 *
 * Implements Blueprint Section 8.1, 8.2, and 8.3:
 * 1. `agents`: Mutable draft configuration and lifecycle state (`draft`, `active`, `archived`),
 *    strictly scoped to `organization_id` with composite `UNIQUE (organization_id, slug)`.
 * 2. `agent_versions`: Append-only, immutable snapshots created when an agent is published.
 *    Active runs reference `agent_version_id` so editing an agent draft never mutates an
 *    in-flight or historical run. Includes a 64-character SHA-256 `snapshot_hash`.
 */

export const AGENT_STATUSES = ['draft', 'active', 'archived'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const ALLOWED_TOOLS = ['calculator', 'knowledge_search'] as const;
export type AllowedToolName = (typeof ALLOWED_TOOLS)[number];

export interface AgentModelConfig {
  provider: 'mock' | 'openai' | 'anthropic' | 'google';
  model: string;
  temperature: number;
  maxSteps: number;
  maxToolCalls: number;
}

export const DEFAULT_AGENT_MODEL_CONFIG: AgentModelConfig = {
  provider: 'mock',
  model: 'aegis-mock-v1',
  temperature: 0,
  maxSteps: 6,
  maxToolCalls: 4,
};

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').$type<AgentStatus>().notNull().default('draft'),
    draftSystemPrompt: text('draft_system_prompt').notNull().default(''),
    draftModelConfig: jsonb('draft_model_config')
      .$type<AgentModelConfig>()
      .notNull(),
    draftToolAllowlist: jsonb('draft_tool_allowlist')
      .$type<AllowedToolName[]>()
      .notNull(),
    latestVersionNumber: integer('latest_version_number').notNull().default(0),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('agents_org_slug_unique').on(table.organizationId, table.slug),
    check(
      'agents_name_length_check',
      sql`length(trim(${table.name})) BETWEEN 1 AND 100`
    ),
    check(
      'agents_slug_length_check',
      sql`length(trim(${table.slug})) BETWEEN 2 AND 64`
    ),
    check(
      'agents_status_check',
      sql`${table.status} IN ('draft', 'active', 'archived')`
    ),
    check(
      'agents_latest_version_non_negative_check',
      sql`${table.latestVersionNumber} >= 0`
    ),
  ]
);

export const agentVersions = pgTable(
  'agent_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    modelConfig: jsonb('model_config').$type<AgentModelConfig>().notNull(),
    toolAllowlist: jsonb('tool_allowlist')
      .$type<AllowedToolName[]>()
      .notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    publishedByUserId: uuid('published_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    publishedAt: timestamp('published_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('agent_versions_agent_version_unique').on(
      table.agentId,
      table.versionNumber
    ),
    check('agent_versions_positive_number_check', sql`${table.versionNumber} >= 1`),
    check(
      'agent_versions_snapshot_hash_check',
      sql`length(trim(${table.snapshotHash})) = 64`
    ),
  ]
);

export type AgentRow = typeof agents.$inferSelect;
export type NewAgentRow = typeof agents.$inferInsert;

export type AgentVersionRow = typeof agentVersions.$inferSelect;
export type NewAgentVersionRow = typeof agentVersions.$inferInsert;

/**
 * Versioned SQL Migration 0002: Mutable `agents` & Immutable `agent_versions`
 */
export const MIGRATION_0002_AGENTS_SQL = `
CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  slug TEXT NOT NULL CHECK (length(trim(slug)) BETWEEN 2 AND 64),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  draft_system_prompt TEXT NOT NULL DEFAULT '',
  draft_model_config JSONB NOT NULL,
  draft_tool_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb,
  latest_version_number INTEGER NOT NULL DEFAULT 0 CHECK (latest_version_number >= 0),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agents_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT agents_org_slug_unique UNIQUE (organization_id, slug)
);

CREATE INDEX IF NOT EXISTS agents_org_updated_idx
  ON agents (organization_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  system_prompt TEXT NOT NULL,
  model_config JSONB NOT NULL,
  tool_allowlist JSONB NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK (length(trim(snapshot_hash)) = 64),
  published_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_versions_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT agent_versions_org_agent_id_unique UNIQUE (organization_id, agent_id, id),
  CONSTRAINT agent_versions_org_agent_fk
    FOREIGN KEY (organization_id, agent_id)
    REFERENCES agents(organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT agent_versions_agent_version_unique UNIQUE (agent_id, version_number)
);

CREATE INDEX IF NOT EXISTS agent_versions_org_agent_idx
  ON agent_versions (organization_id, agent_id, version_number DESC);
`;

