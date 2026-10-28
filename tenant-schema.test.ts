import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import {
  createDatabaseClient,
  createDrizzleReadinessProbe,
  type DatabaseContext,
} from '../../src/server/db/client';
import {
  organizations,
  users,
  memberships,
  type TenantRole,
} from '../../src/server/db/schema/tenant';

/**
 * Ticket REPO-005 Verification: Foundational Multi-Tenant Schema Integration Tests
 *
 * Executes real SQL DDL & DML against an isolated in-memory PostgreSQL 16 (PGlite)
 * instance to verify:
 * 1. Migration 0001 applies cleanly and creates `organizations`, `users`, `memberships`.
 * 2. Valid user, organization, and owner membership rows can be inserted and queried via Drizzle.
 * 3. Duplicate organization slugs are rejected by the PostgreSQL UNIQUE constraint.
 * 4. Whitespace-only organization names are rejected by the PostgreSQL CHECK constraint.
 * 5. Invalid membership roles (e.g. 'superadmin') are rejected by the PostgreSQL CHECK constraint.
 * 6. Duplicate (organization_id, user_id) memberships are rejected by the composite primary key.
 * 7. Deleting an organization cascades to its memberships (`ON DELETE CASCADE`).
 * 8. `createDrizzleReadinessProbe()` executes `SELECT 1 AS ok` and reports `reachable: true`.
 */

describe('REPO-005: Foundational Multi-Tenant PostgreSQL Schema', () => {
  let ctx: DatabaseContext;

  before(async () => {
    ctx = await createDatabaseClient({ autoMigrate: true });
  });

  beforeEach(async () => {
    await ctx.pg.exec('TRUNCATE TABLE memberships, organizations, users CASCADE;');
  });

  after(async () => {
    await ctx.close();
  });

  it('inserts a user, organization, and owner membership and queries them via Drizzle', async () => {
    const [createdUser] = await ctx.db
      .insert(users)
      .values({
        authSubject: 'demo:user_alice',
        email: 'alice@aegis.local',
        displayName: 'Alice Founder',
      })
      .returning();

    assert.ok(createdUser.id, 'Expected generated UUID for user.id');
    assert.equal(createdUser.authSubject, 'demo:user_alice');

    const [createdOrg] = await ctx.db
      .insert(organizations)
      .values({
        name: 'Acme Robotics',
        slug: 'acme-robotics',
      })
      .returning();

    assert.ok(createdOrg.id, 'Expected generated UUID for organization.id');
    assert.equal(createdOrg.slug, 'acme-robotics');

    const [membership] = await ctx.db
      .insert(memberships)
      .values({
        organizationId: createdOrg.id,
        userId: createdUser.id,
        role: 'owner',
      })
      .returning();

    assert.equal(membership.organizationId, createdOrg.id);
    assert.equal(membership.userId, createdUser.id);
    assert.equal(membership.role, 'owner');
  });

  it('rejects duplicate organization slugs via PostgreSQL UNIQUE constraint', async () => {
    await ctx.db.insert(organizations).values({
      name: 'First Org',
      slug: 'shared-slug',
    });

    await assert.rejects(
      async () => {
        await ctx.db.insert(organizations).values({
          name: 'Second Org',
          slug: 'shared-slug',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
      'Expected duplicate organization slug to be rejected by UNIQUE constraint'
    );
  });

  it('rejects whitespace-only organization names via PostgreSQL CHECK constraint', async () => {
    await assert.rejects(
      async () => {
        await ctx.db.insert(organizations).values({
          name: '    ',
          slug: 'blank-name-org',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
      'Expected blank trimmed organization name to fail CHECK constraint'
    );
  });

  it('rejects invalid membership roles via PostgreSQL CHECK constraint', async () => {
    const [user] = await ctx.db
      .insert(users)
      .values({ authSubject: 'demo:user_bob', email: 'bob@aegis.local' })
      .returning();

    const [org] = await ctx.db
      .insert(organizations)
      .values({ name: 'Bob Workspace', slug: 'bob-workspace' })
      .returning();

    await assert.rejects(
      async () => {
        await ctx.db.insert(memberships).values({
          organizationId: org.id,
          userId: user.id,
          role: 'superadmin' as unknown as TenantRole,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
      'Expected invalid role "superadmin" to fail memberships_role_check constraint'
    );
  });

  it('rejects duplicate (organization_id, user_id) rows via composite primary key and cascades on org delete', async () => {
    const [user] = await ctx.db
      .insert(users)
      .values({ authSubject: 'demo:user_charlie' })
      .returning();

    const [org] = await ctx.db
      .insert(organizations)
      .values({ name: 'Charlie Lab', slug: 'charlie-lab' })
      .returning();

    await ctx.db.insert(memberships).values({
      organizationId: org.id,
      userId: user.id,
      role: 'developer',
    });

    // Attempting a second membership row for the same (organizationId, userId) must fail
    await assert.rejects(async () => {
      await ctx.db.insert(memberships).values({
        organizationId: org.id,
        userId: user.id,
        role: 'admin',
      });
    });

    // Deleting the organization must cascade-delete the membership row
    await ctx.db.delete(organizations).where(eq(organizations.id, org.id));

    const remainingMemberships = await ctx.db
      .select()
      .from(memberships)
      .where(eq(memberships.organizationId, org.id));

    assert.equal(remainingMemberships.length, 0);
  });

  it('verifies database readiness via createDrizzleReadinessProbe()', async () => {
    const probe = createDrizzleReadinessProbe(async () => ctx);
    const result = await probe.ping();

    assert.equal(result.reachable, true);
    assert.equal(typeof result.latencyMs, 'number');
    assert.ok(result.latencyMs >= 0);
    assert.equal(result.error, undefined);
  });
});
