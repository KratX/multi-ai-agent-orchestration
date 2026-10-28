import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDatabaseClient,
  type DatabaseContext,
} from '../../src/server/db/client';
import {
  ensureUser,
  createOrganizationWithOwner,
  resolveActorContext,
  getOrganizationForActor,
  listOrganizationMembers,
  upsertMembership,
  removeMembership,
  TenantConstraintError,
} from '../../src/server/db/repositories/tenant-repository';
import { AuthorizationError } from '../../src/server/policies/authorization';

/**
 * Ticket TENANT-004: Cross-Tenant Negative Security & Last-Owner Safeguard Test Suite
 *
 * Executes against real PostgreSQL 16 (PGlite) to verify:
 * 1. Idempotent `ensureUser()` updates existing user without creating duplicates.
 * 2. `createOrganizationWithOwner()` atomically creates the org and assigns `owner`.
 * 3. Anti-spoofing: `resolveActorContext()` returns `null` when User A claims Org B's ID.
 * 4. Cross-tenant negative tests (Threat T-01): Owner of Org A receives 404 `TENANT_MISMATCH`
 *    when attempting to read Org B, list Org B's members, add a member to Org B, or remove
 *    a member from Org B.
 * 5. Role escalation guard: `admin` in Org A can add a `developer`, but receives 403
 *    `INSUFFICIENT_ROLE` when attempting to promote a user to `owner` or remove an `owner`.
 * 6. Last-owner safeguard: Sole `owner` of Org A receives 409 `LAST_OWNER_PROTECTED` when
 *    attempting to demote or remove themselves, and succeeds only after a second `owner` exists.
 */

describe('TENANT-004: Multi-Tenant Isolation & Security Negative Tests', () => {
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

  it('provisions users idempotently via ensureUser() without creating duplicate rows', async () => {
    const first = await ensureUser(ctx.db, {
      authSubject: 'demo:user_alice',
      email: 'alice@v1.local',
      displayName: 'Alice V1',
    });

    const second = await ensureUser(ctx.db, {
      authSubject: 'demo:user_alice',
      email: 'alice@v2.local',
      displayName: 'Alice V2',
    });

    assert.equal(first.id, second.id, 'Expected idempotent user UUID');
    assert.equal(second.email, 'alice@v2.local');
    assert.equal(second.displayName, 'Alice V2');
  });

  it('rejects cross-tenant read, member listing, member addition, and member removal (Threat T-01)', async () => {
    const alice = await ensureUser(ctx.db, {
      authSubject: 'demo:alice_org_a',
      email: 'alice@orga.local',
    });
    const bob = await ensureUser(ctx.db, {
      authSubject: 'demo:bob_org_b',
      email: 'bob@orgb.local',
    });

    const { organization: orgA } = await createOrganizationWithOwner(ctx.db, {
      name: 'Tenant Alpha',
      slug: 'tenant-alpha',
      creatorUserId: alice.id,
    });

    const { organization: orgB } = await createOrganizationWithOwner(ctx.db, {
      name: 'Tenant Bravo',
      slug: 'tenant-bravo',
      creatorUserId: bob.id,
    });

    // Alice resolves her legitimate actor context in Org A
    const aliceActorInOrgA = await resolveActorContext(ctx.db, alice.id, orgA.id);
    assert.ok(aliceActorInOrgA);
    assert.equal(aliceActorInOrgA.role, 'owner');

    // Anti-spoofing check: Alice cannot resolve an actor context for Org B
    const spoofedContext = await resolveActorContext(ctx.db, alice.id, orgB.id);
    assert.equal(
      spoofedContext,
      null,
      'Expected resolveActorContext to return null when user is not a member of target org'
    );

    // 1. Cross-tenant org read must fail with 404 TENANT_MISMATCH
    await assert.rejects(
      async () => getOrganizationForActor(ctx.db, aliceActorInOrgA, orgB.id),
      (err: unknown) => {
        if (!(err instanceof AuthorizationError)) return false;
        assert.equal(err.code, 'TENANT_MISMATCH');
        assert.equal(err.statusCode, 404);
        return true;
      }
    );

    // 2. Cross-tenant member listing must fail with 404 TENANT_MISMATCH
    await assert.rejects(
      async () => listOrganizationMembers(ctx.db, aliceActorInOrgA, orgB.id),
      (err: unknown) => {
        if (!(err instanceof AuthorizationError)) return false;
        assert.equal(err.code, 'TENANT_MISMATCH');
        assert.equal(err.statusCode, 404);
        return true;
      }
    );

    // 3. Cross-tenant member injection into Org B must fail with 404 TENANT_MISMATCH
    await assert.rejects(
      async () =>
        upsertMembership(ctx.db, aliceActorInOrgA, {
          organizationId: orgB.id,
          targetUserId: alice.id,
          role: 'admin',
        }),
      (err: unknown) => {
        if (!(err instanceof AuthorizationError)) return false;
        assert.equal(err.code, 'TENANT_MISMATCH');
        assert.equal(err.statusCode, 404);
        return true;
      }
    );

    // 4. Cross-tenant member removal of Bob from Org B must fail with 404 TENANT_MISMATCH
    await assert.rejects(
      async () => removeMembership(ctx.db, aliceActorInOrgA, orgB.id, bob.id),
      (err: unknown) => {
        if (!(err instanceof AuthorizationError)) return false;
        assert.equal(err.code, 'TENANT_MISMATCH');
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  });

  it('prevents admin from promoting a user to owner or removing an existing owner', async () => {
    const ownerUser = await ensureUser(ctx.db, { authSubject: 'demo:owner' });
    const adminUser = await ensureUser(ctx.db, { authSubject: 'demo:admin' });
    const devUser = await ensureUser(ctx.db, { authSubject: 'demo:dev' });

    const { organization } = await createOrganizationWithOwner(ctx.db, {
      name: 'Role Guard Org',
      slug: 'role-guard-org',
      creatorUserId: ownerUser.id,
    });

    const ownerActor = await resolveActorContext(
      ctx.db,
      ownerUser.id,
      organization.id
    );
    assert.ok(ownerActor);

    // Owner adds adminUser as 'admin'
    await upsertMembership(ctx.db, ownerActor, {
      organizationId: organization.id,
      targetUserId: adminUser.id,
      role: 'admin',
    });

    const adminActor = await resolveActorContext(
      ctx.db,
      adminUser.id,
      organization.id
    );
    assert.ok(adminActor);
    assert.equal(adminActor.role, 'admin');

    // Admin CAN add devUser as 'developer'
    const devMembership = await upsertMembership(ctx.db, adminActor, {
      organizationId: organization.id,
      targetUserId: devUser.id,
      role: 'developer',
    });
    assert.equal(devMembership.role, 'developer');

    // Admin CANNOT promote devUser to 'owner' (403 INSUFFICIENT_ROLE)
    await assert.rejects(
      async () =>
        upsertMembership(ctx.db, adminActor, {
          organizationId: organization.id,
          targetUserId: devUser.id,
          role: 'owner',
        }),
      (err: unknown) => {
        if (!(err instanceof AuthorizationError)) return false;
        assert.equal(err.code, 'INSUFFICIENT_ROLE');
        assert.equal(err.statusCode, 403);
        return true;
      }
    );

    // Admin CANNOT remove ownerUser (403 INSUFFICIENT_ROLE)
    await assert.rejects(
      async () =>
        removeMembership(ctx.db, adminActor, organization.id, ownerUser.id),
      (err: unknown) => {
        if (!(err instanceof AuthorizationError)) return false;
        assert.equal(err.code, 'INSUFFICIENT_ROLE');
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
  });

  it('enforces the last-owner safeguard on demotion and removal until a second owner is promoted', async () => {
    const firstOwner = await ensureUser(ctx.db, { authSubject: 'demo:owner_1' });
    const secondOwner = await ensureUser(ctx.db, { authSubject: 'demo:owner_2' });

    const { organization } = await createOrganizationWithOwner(ctx.db, {
      name: 'Last Owner Safeguard Org',
      slug: 'last-owner-org',
      creatorUserId: firstOwner.id,
    });

    const firstOwnerActor = await resolveActorContext(
      ctx.db,
      firstOwner.id,
      organization.id
    );
    assert.ok(firstOwnerActor);

    // 1. Sole owner cannot demote themselves to 'admin'
    await assert.rejects(
      async () =>
        upsertMembership(ctx.db, firstOwnerActor, {
          organizationId: organization.id,
          targetUserId: firstOwner.id,
          role: 'admin',
        }),
      (err: unknown) => {
        if (!(err instanceof TenantConstraintError)) return false;
        assert.equal(err.code, 'LAST_OWNER_PROTECTED');
        assert.equal(err.statusCode, 409);
        return true;
      }
    );

    // 2. Sole owner cannot remove themselves from the organization
    await assert.rejects(
      async () =>
        removeMembership(ctx.db, firstOwnerActor, organization.id, firstOwner.id),
      (err: unknown) => {
        if (!(err instanceof TenantConstraintError)) return false;
        assert.equal(err.code, 'LAST_OWNER_PROTECTED');
        assert.equal(err.statusCode, 409);
        return true;
      }
    );

    // 3. Promote secondOwner to 'owner'
    await upsertMembership(ctx.db, firstOwnerActor, {
      organizationId: organization.id,
      targetUserId: secondOwner.id,
      role: 'owner',
    });

    // 4. Now that 2 owners exist, firstOwner CAN be demoted to 'admin'
    const demoted = await upsertMembership(ctx.db, firstOwnerActor, {
      organizationId: organization.id,
      targetUserId: firstOwner.id,
      role: 'admin',
    });
    assert.equal(demoted.role, 'admin');
  });
});
