import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY_ACTIONS,
  can,
  authorize,
  requireAuthorization,
  AuthorizationError,
  listRolePermissions,
  type AuthenticatedActor,
  type ResourceContext,
} from '../../src/server/policies/authorization';

/**
 * Ticket TENANT-002 Verification: Unit Tests for Central RBAC & Tenant Boundary Engine
 *
 * Verifies:
 * 1. Unauthenticated actors are denied with statusCode 401 (`UNAUTHENTICATED`).
 * 2. Cross-tenant requests are denied even for `owner` with statusCode 404 (`TENANT_MISMATCH`).
 * 3. `owner` is permitted all 25 policy actions within their organization.
 * 4. `admin` is permitted operational/audit actions but denied `org.delete`, `member.manage_owners`,
 *    and `member.manage` when targeting an `owner`.
 * 5. `developer` can edit/publish agents & workflows, run/cancel/retry runs, upload docs, and run evals,
 *    but cannot delete agents/workflows, manage members, or view security audit logs.
 * 6. `developer` is denied `approval.decide` by default, but permitted when `allowDeveloperApproval: true`.
 * 7. `viewer` is strictly read-only and denied all write, execute, approve, and audit actions.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const resourceInOrgA: ResourceContext = {
  organizationId: ORG_A,
  resourceType: 'agent',
  resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

describe('TENANT-002: Central Authorization Policy Engine (authorization.ts)', () => {
  it('denies unauthenticated or incomplete actors with 401 UNAUTHENTICATED', () => {
    assert.equal(can(null, 'org.view', resourceInOrgA), false);
    assert.equal(can(undefined, 'org.view', resourceInOrgA), false);

    assert.throws(
      () => requireAuthorization(null, 'org.view', resourceInOrgA),
      (err: unknown) => {
        if (!(err instanceof AuthorizationError)) return false;
        assert.equal(err.code, 'UNAUTHENTICATED');
        assert.equal(err.statusCode, 401);
        return true;
      }
    );
  });

  it('denies cross-tenant access even for an owner and maps error status to 404', () => {
    const ownerOfOrgA: AuthenticatedActor = {
      userId: 'user-owner-a',
      organizationId: ORG_A,
      role: 'owner',
    };

    const resourceInOrgB: ResourceContext = {
      organizationId: ORG_B,
      resourceType: 'agent',
      resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };

    for (const action of POLICY_ACTIONS) {
      assert.equal(
        can(ownerOfOrgA, action, resourceInOrgB),
        false,
        `Expected owner of Org A to be denied ${action} on Org B resource`
      );
    }

    assert.throws(
      () => requireAuthorization(ownerOfOrgA, 'agent.view', resourceInOrgB),
      (err: unknown) => {
        if (!(err instanceof AuthorizationError)) return false;
        assert.equal(err.code, 'TENANT_MISMATCH');
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  });

  it('permits owner to perform every defined PolicyAction within their own organization', () => {
    const owner: AuthenticatedActor = {
      userId: 'user-owner-a',
      organizationId: ORG_A,
      role: 'owner',
    };

    for (const action of POLICY_ACTIONS) {
      assert.equal(
        can(owner, action, resourceInOrgA),
        true,
        `Expected owner to be allowed ${action}`
      );
    }

    assert.equal(listRolePermissions('owner').length, POLICY_ACTIONS.length);
  });

  it('enforces admin boundaries: allows operational & audit actions, blocks org.delete and owner mutation', () => {
    const admin: AuthenticatedActor = {
      userId: 'user-admin-a',
      organizationId: ORG_A,
      role: 'admin',
    };

    // Allowed for admin
    assert.equal(can(admin, 'org.manage', resourceInOrgA), true);
    assert.equal(can(admin, 'member.manage', resourceInOrgA), true);
    assert.equal(can(admin, 'agent.delete', resourceInOrgA), true);
    assert.equal(can(admin, 'workflow.delete', resourceInOrgA), true);
    assert.equal(can(admin, 'approval.decide', resourceInOrgA), true);
    assert.equal(can(admin, 'audit.view', resourceInOrgA), true);

    // Denied for admin
    assert.equal(can(admin, 'org.delete', resourceInOrgA), false);
    assert.equal(can(admin, 'member.manage_owners', resourceInOrgA), false);

    // Admin cannot use member.manage when targetMemberRole is 'owner'
    const decisionAgainstOwner = authorize(admin, 'member.manage', {
      organizationId: ORG_A,
      targetMemberRole: 'owner',
    });
    assert.equal(decisionAgainstOwner.allowed, false);
    assert.equal(decisionAgainstOwner.code, 'INSUFFICIENT_ROLE');

    // Admin can manage a developer or admin
    assert.equal(
      can(admin, 'member.manage', {
        organizationId: ORG_A,
        targetMemberRole: 'developer',
      }),
      true
    );
  });

  it('enforces developer boundaries and configurable approval gates', () => {
    const developer: AuthenticatedActor = {
      userId: 'user-dev-a',
      organizationId: ORG_A,
      role: 'developer',
    };

    // Allowed for developer
    assert.equal(can(developer, 'agent.edit', resourceInOrgA), true);
    assert.equal(can(developer, 'agent.publish', resourceInOrgA), true);
    assert.equal(can(developer, 'workflow.edit', resourceInOrgA), true);
    assert.equal(can(developer, 'workflow.publish', resourceInOrgA), true);
    assert.equal(can(developer, 'run.start', resourceInOrgA), true);
    assert.equal(can(developer, 'run.cancel', resourceInOrgA), true);
    assert.equal(can(developer, 'run.retry', resourceInOrgA), true);
    assert.equal(can(developer, 'document.upload', resourceInOrgA), true);
    assert.equal(can(developer, 'eval.execute', resourceInOrgA), true);
    assert.equal(can(developer, 'usage.view', resourceInOrgA), true);

    // Denied for developer
    assert.equal(can(developer, 'org.manage', resourceInOrgA), false);
    assert.equal(can(developer, 'member.manage', resourceInOrgA), false);
    assert.equal(can(developer, 'agent.delete', resourceInOrgA), false);
    assert.equal(can(developer, 'workflow.delete', resourceInOrgA), false);
    assert.equal(can(developer, 'audit.view', resourceInOrgA), false);

    // Approval gate: default false, true when allowDeveloperApproval=true
    assert.equal(can(developer, 'approval.decide', resourceInOrgA), false);
    assert.equal(
      can(developer, 'approval.decide', {
        organizationId: ORG_A,
        allowDeveloperApproval: true,
      }),
      true
    );
  });

  it('enforces viewer read-only boundaries and blocks all mutations, runs, approvals, and audit logs', () => {
    const viewer: AuthenticatedActor = {
      userId: 'user-viewer-a',
      organizationId: ORG_A,
      role: 'viewer',
    };

    const expectedAllowed = new Set([
      'org.view',
      'member.view',
      'agent.view',
      'workflow.view',
      'run.view',
      'document.view',
      'approval.view',
      'eval.view',
      'usage.view',
    ]);

    for (const action of POLICY_ACTIONS) {
      assert.equal(
        can(viewer, action, resourceInOrgA),
        expectedAllowed.has(action),
        `Unexpected permission result for viewer on action "${action}"`
      );
    }

    assert.throws(
      () => requireAuthorization(viewer, 'run.start', resourceInOrgA),
      (err: unknown) => {
        if (!(err instanceof AuthorizationError)) return false;
        assert.equal(err.code, 'INSUFFICIENT_ROLE');
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
  });
});
