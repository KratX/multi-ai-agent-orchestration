import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';

/**
 * Ticket REPO-005: Foundational Multi-Tenant PostgreSQL Schema
 *
 * Implements Blueprint Section 8.1 & 8.3:
 * 1. `organizations`: Workspace / tenant boundary with trimmed name length CHECK (1..100) and unique slug.
 * 2. `users`: Identity record linked to external or demo `auth_subject`.
 * 3. `memberships`: Composite primary key `(organization_id, user_id)` with strict role CHECK enum.
 */

export const TENANT_ROLES = ['owner', 'admin', 'developer', 'viewer'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'organizations_name_length_check',
      sql`length(trim(${table.name})) BETWEEN 1 AND 100`
    ),
    check(
      'organizations_slug_format_check',
      sql`length(trim(${table.slug})) BETWEEN 2 AND 64`
    ),
  ]
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    authSubject: text('auth_subject').notNull().unique(),
    email: text('email'),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'users_auth_subject_non_empty_check',
      sql`length(trim(${table.authSubject})) > 0`
    ),
  ]
);

export const memberships = pgTable(
  'memberships',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<TenantRole>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: 'memberships_org_user_pk',
      columns: [table.organizationId, table.userId],
    }),
    check(
      'memberships_role_check',
      sql`${table.role} IN ('owner', 'admin', 'developer', 'viewer')`
    ),
  ]
);

export type OrganizationRow = typeof organizations.$inferSelect;
export type NewOrganizationRow = typeof organizations.$inferInsert;

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

export type MembershipRow = typeof memberships.$inferSelect;
export type NewMembershipRow = typeof memberships.$inferInsert;

/**
 * Versioned SQL Migration 0001 (Matches Drizzle schema above 1:1)
 * Used to bootstrap empty PostgreSQL / PGlite instances deterministically in migrations and tests.
 */
export const MIGRATION_0001_TENANT_SQL = `
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  slug TEXT NOT NULL UNIQUE CHECK (length(trim(slug)) BETWEEN 2 AND 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject TEXT NOT NULL UNIQUE CHECK (length(trim(auth_subject)) > 0),
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memberships_org_user_pk PRIMARY KEY (organization_id, user_id)
);
`;
