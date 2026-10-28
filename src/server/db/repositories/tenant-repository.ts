import { and, eq, sql } from 'drizzle-orm';
import type { AegisDatabase } from '../client';
import {
  organizations,
  users,
  memberships,
  type OrganizationRow,
  type UserRow,
  type MembershipRow,
  type TenantRole,
} from '../schema/tenant';
import {
  requireAuthorization,
  type AuthenticatedActor,
} from '../../policies/authorization';

/**
 * Tickets TENANT-001 & TENANT-003: Multi-Tenant Repository & Membership Safeguards
 *
 * Responsibilities:
 * 1. `ensureUser()`: Idempotent first-login / demo user provisioning by `auth_subject`.
 * 2. `createOrganizationWithOwner()`: Atomic PostgreSQL transaction creating both the
 *    `organizations` row and the creator's `owner` row in `memberships`.
 * 3. `resolveActorContext()`: Verifies that a `userId` actually holds a membership in
 *    `organizationId` before minting an `AuthenticatedActor` context (prevents tenant header spoofing).
 * 4. `upsertMembership()` & `removeMembership()`: Enforces central RBAC (`requireAuthorization`)
 *    AND the Last-Owner Safeguard so an organization can never be left without an `owner`.
 */

export type TenantErrorCode =
  | 'LAST_OWNER_PROTECTED'
  | 'MEMBER_NOT_FOUND'
  | 'ORGANIZATION_NOT_FOUND'
  | 'DUPLICATE_ORG_SLUG'
  | 'INVALID_TENANT_INPUT';

export class TenantConstraintError extends Error {
  public readonly code: TenantErrorCode;
  public readonly statusCode: 400 | 404 | 409;

  constructor(
    code: TenantErrorCode,
    message: string,
    statusCode: 400 | 404 | 409 = 409
  ) {
    super(message);
    this.name = 'TenantConstraintError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface EnsureUserInput {
  authSubject: string;
  email?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface CreateOrganizationInput {
  name: string;
  slug: string;
  creatorUserId: string;
}

export interface OrganizationWithRole {
  organization: OrganizationRow;
  role: TenantRole;
  joinedAt: Date;
}

export interface OrganizationMemberDetail {
  organizationId: string;
  userId: string;
  role: TenantRole;
  joinedAt: Date;
  email: string | null;
  displayName: string | null;
  authSubject: string;
}

/**
 * Idempotently provisions or updates a user record by `authSubject`.
 */
export async function ensureUser(
  db: AegisDatabase,
  input: EnsureUserInput
): Promise<UserRow> {
  const trimmedSubject = input.authSubject.trim();
  if (!trimmedSubject) {
    throw new TenantConstraintError(
      'INVALID_TENANT_INPUT',
      'authSubject must be a non-empty string.',
      400
    );
  }

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.authSubject, trimmedSubject))
    .limit(1);

  if (existing.length > 0) {
    const current = existing[0];
    const [updated] = await db
      .update(users)
      .set({
        email: input.email !== undefined ? input.email : current.email,
        displayName:
          input.displayName !== undefined ? input.displayName : current.displayName,
        avatarUrl:
          input.avatarUrl !== undefined ? input.avatarUrl : current.avatarUrl,
        updatedAt: new Date(),
      })
      .where(eq(users.id, current.id))
      .returning();

    return updated;
  }

  const [created] = await db
    .insert(users)
    .values({
      authSubject: trimmedSubject,
      email: input.email ?? null,
      displayName: input.displayName ?? null,
      avatarUrl: input.avatarUrl ?? null,
    })
    .returning();

  return created;
}

/**
 * Creates a new organization and assigns `creatorUserId` as `owner` inside a single
 * atomic PostgreSQL transaction.
 */
export async function createOrganizationWithOwner(
  db: AegisDatabase,
  input: CreateOrganizationInput
): Promise<{ organization: OrganizationRow; membership: MembershipRow }> {
  const cleanName = input.name.trim();
  const cleanSlug = input.slug.trim().toLowerCase();

  if (cleanName.length < 1 || cleanName.length > 100) {
    throw new TenantConstraintError(
      'INVALID_TENANT_INPUT',
      'Organization name must be between 1 and 100 characters.',
      400
    );
  }

  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(cleanSlug)) {
    throw new TenantConstraintError(
      'INVALID_TENANT_INPUT',
      'Organization slug must be 2..64 lowercase alphanumeric characters or hyphens.',
      400
    );
  }

  return db.transaction(async (tx) => {
    const existingSlug = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, cleanSlug))
      .limit(1);

    if (existingSlug.length > 0) {
      throw new TenantConstraintError(
        'DUPLICATE_ORG_SLUG',
        `Organization slug "${cleanSlug}" is already taken.`,
        409
      );
    }

    const [organization] = await tx
      .insert(organizations)
      .values({
        name: cleanName,
        slug: cleanSlug,
      })
      .returning();

    const [membership] = await tx
      .insert(memberships)
      .values({
        organizationId: organization.id,
        userId: input.creatorUserId,
        role: 'owner',
      })
      .returning();

    return { organization, membership };
  });
}

/**
 * Verifies that `userId` is actually a member of `organizationId` in PostgreSQL
 * and returns a trusted `AuthenticatedActor` context. Returns `null` if no membership exists.
 */
export async function resolveActorContext(
  db: AegisDatabase,
  userId: string,
  organizationId: string
): Promise<AuthenticatedActor | null> {
  const rows = await db
    .select({
      userId: memberships.userId,
      organizationId: memberships.organizationId,
      role: memberships.role,
    })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.userId, userId)
      )
    )
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  return rows[0];
}

/**
 * Lists all organizations that `userId` belongs to, ordered by creation time.
 */
export async function listUserOrganizations(
  db: AegisDatabase,
  userId: string
): Promise<OrganizationWithRole[]> {
  const rows = await db
    .select({
      organization: organizations,
      role: memberships.role,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
    .where(eq(memberships.userId, userId));

  return rows;
}

/**
 * Fetches an organization by ID only if `actor` is authorized for `org.view` on that tenant.
 */
export async function getOrganizationForActor(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  targetOrganizationId: string
): Promise<OrganizationRow> {
  requireAuthorization(actor, 'org.view', {
    organizationId: targetOrganizationId,
    resourceType: 'organization',
    resourceId: targetOrganizationId,
  });

  const rows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, targetOrganizationId))
    .limit(1);

  if (rows.length === 0) {
    throw new TenantConstraintError(
      'ORGANIZATION_NOT_FOUND',
      `Organization ${targetOrganizationId} was not found.`,
      404
    );
  }

  return rows[0];
}

/**
 * Lists all members of `organizationId` after verifying `actor` has `member.view` permission.
 */
export async function listOrganizationMembers(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  organizationId: string
): Promise<OrganizationMemberDetail[]> {
  requireAuthorization(actor, 'member.view', {
    organizationId,
    resourceType: 'membership',
  });

  const rows = await db
    .select({
      organizationId: memberships.organizationId,
      userId: memberships.userId,
      role: memberships.role,
      joinedAt: memberships.createdAt,
      email: users.email,
      displayName: users.displayName,
      authSubject: users.authSubject,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.organizationId, organizationId));

  return rows;
}

async function countOrganizationOwners(
  db: AegisDatabase,
  organizationId: string
): Promise<number> {
  const [result] = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.role, 'owner')
      )
    );

  return Number(result?.count ?? 0);
}

/**
 * Adds a member or updates an existing member's role within `organizationId`.
 * Enforces:
 * 1. Central RBAC (`member.manage_owners` when assigning/modifying `owner`, `member.manage` otherwise).
 * 2. Last-owner safeguard: blocks demoting the last remaining `owner` of an organization.
 */
export async function upsertMembership(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  input: {
    organizationId: string;
    targetUserId: string;
    role: TenantRole;
  }
): Promise<MembershipRow> {
  const existingRows = await db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, input.organizationId),
        eq(memberships.userId, input.targetUserId)
      )
    )
    .limit(1);

  const existingTarget = existingRows[0];

  const requiredAction =
    input.role === 'owner' || existingTarget?.role === 'owner'
      ? 'member.manage_owners'
      : 'member.manage';

  requireAuthorization(actor, requiredAction, {
    organizationId: input.organizationId,
    resourceType: 'membership',
    resourceId: input.targetUserId,
    targetMemberRole: existingTarget?.role ?? input.role,
  });

  if (!existingTarget) {
    const [created] = await db
      .insert(memberships)
      .values({
        organizationId: input.organizationId,
        userId: input.targetUserId,
        role: input.role,
      })
      .returning();

    return created;
  }

  // Last-owner safeguard: if demoting an existing owner to a non-owner role, ensure > 1 owner exists
  if (existingTarget.role === 'owner' && input.role !== 'owner') {
    const ownerCount = await countOrganizationOwners(db, input.organizationId);
    if (ownerCount <= 1) {
      throw new TenantConstraintError(
        'LAST_OWNER_PROTECTED',
        'Cannot demote the last owner of an organization. Promote another member to owner first.',
        409
      );
    }
  }

  const [updated] = await db
    .update(memberships)
    .set({ role: input.role })
    .where(
      and(
        eq(memberships.organizationId, input.organizationId),
        eq(memberships.userId, input.targetUserId)
      )
    )
    .returning();

  return updated;
}

/**
 * Removes a member from `organizationId`.
 * Enforces:
 * 1. Central RBAC (`member.manage_owners` when removing an `owner`, `member.manage` otherwise).
 * 2. Last-owner safeguard: blocks removing the last remaining `owner` of an organization.
 */
export async function removeMembership(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  organizationId: string,
  targetUserId: string
): Promise<void> {
  const existingRows = await db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.userId, targetUserId)
      )
    )
    .limit(1);

  const existingTarget = existingRows[0];
  if (!existingTarget) {
    // Still enforce tenant/role check before returning 404 so cross-tenant callers get 404/403 appropriately
    requireAuthorization(actor, 'member.manage', {
      organizationId,
      resourceType: 'membership',
      resourceId: targetUserId,
    });
    throw new TenantConstraintError(
      'MEMBER_NOT_FOUND',
      `User ${targetUserId} is not a member of organization ${organizationId}.`,
      404
    );
  }

  const requiredAction =
    existingTarget.role === 'owner' ? 'member.manage_owners' : 'member.manage';

  requireAuthorization(actor, requiredAction, {
    organizationId,
    resourceType: 'membership',
    resourceId: targetUserId,
    targetMemberRole: existingTarget.role,
  });

  if (existingTarget.role === 'owner') {
    const ownerCount = await countOrganizationOwners(db, organizationId);
    if (ownerCount <= 1) {
      throw new TenantConstraintError(
        'LAST_OWNER_PROTECTED',
        'Cannot remove the last owner of an organization.',
        409
      );
    }
  }

  await db
    .delete(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.userId, targetUserId)
      )
    );
}
