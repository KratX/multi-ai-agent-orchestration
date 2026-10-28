import type { TenantRole } from '../db/schema/tenant';

/**
 * Ticket TENANT-002: Central Server-Side Authorization Policy Engine
 *
 * Implements Blueprint Section 5.2 & 6.2:
 * - Single source of truth for Role-Based Access Control (RBAC) and tenant boundary checks.
 * - UI components may hide buttons for ergonomics, but every API route and service
 *   mutation MUST call `can()` or `requireAuthorization()` on the server.
 * - Enforces strict tenant isolation first: an `owner` of Org A is denied all actions
 *   against resources belonging to Org B.
 */

export const POLICY_ACTIONS = [
  // Organization & Membership
  'org.view',
  'org.manage',
  'org.delete',
  'member.view',
  'member.manage',
  'member.manage_owners',
  // Agent Studio & Versions
  'agent.view',
  'agent.edit',
  'agent.publish',
  'agent.delete',
  // Workflows
  'workflow.view',
  'workflow.edit',
  'workflow.publish',
  'workflow.delete',
  // Runs & Execution
  'run.view',
  'run.start',
  'run.cancel',
  'run.retry',
  // Knowledge Base / RAG Documents
  'document.view',
  'document.upload',
  'document.delete',
  // Human-in-the-Loop Approvals
  'approval.view',
  'approval.decide',
  // Evaluations
  'eval.view',
  'eval.manage',
  'eval.execute',
  // Governance & Observability
  'audit.view',
  'usage.view',
] as const;

export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export interface AuthenticatedActor {
  userId: string;
  organizationId: string;
  role: TenantRole;
}

export interface ResourceContext {
  organizationId: string;
  resourceType?: string;
  resourceId?: string;
  /**
   * Blueprint Section 5.2: `approval.decide` is Owner/Admin by default,
   * and configurable (default false) for Developers on specific workflows.
   */
  allowDeveloperApproval?: boolean;
  /**
   * When managing a target member, indicates the target member's current or new role
   * so `admin` cannot promote/demote/remove an `owner`.
   */
  targetMemberRole?: TenantRole;
}

export type AuthorizationCode =
  | 'ALLOWED'
  | 'UNAUTHENTICATED'
  | 'TENANT_MISMATCH'
  | 'INSUFFICIENT_ROLE';

export interface AuthorizationDecision {
  allowed: boolean;
  code: AuthorizationCode;
  action: PolicyAction;
  reason: string;
}

const ROLE_PERMISSIONS: Record<TenantRole, ReadonlySet<PolicyAction>> = {
  owner: new Set<PolicyAction>(POLICY_ACTIONS),

  admin: new Set<PolicyAction>([
    'org.view',
    'org.manage',
    // Note: 'org.delete' and 'member.manage_owners' are intentionally excluded for admin
    'member.view',
    'member.manage',
    'agent.view',
    'agent.edit',
    'agent.publish',
    'agent.delete',
    'workflow.view',
    'workflow.edit',
    'workflow.publish',
    'workflow.delete',
    'run.view',
    'run.start',
    'run.cancel',
    'run.retry',
    'document.view',
    'document.upload',
    'document.delete',
    'approval.view',
    'approval.decide',
    'eval.view',
    'eval.manage',
    'eval.execute',
    'audit.view',
    'usage.view',
  ]),

  developer: new Set<PolicyAction>([
    'org.view',
    'member.view',
    'agent.view',
    'agent.edit',
    'agent.publish',
    'workflow.view',
    'workflow.edit',
    'workflow.publish',
    'run.view',
    'run.start',
    'run.cancel',
    'run.retry',
    'document.view',
    'document.upload',
    'document.delete',
    'approval.view',
    // Note: 'approval.decide' is false by default for developer unless allowDeveloperApproval=true
    'eval.view',
    'eval.manage',
    'eval.execute',
    'usage.view',
  ]),

  viewer: new Set<PolicyAction>([
    'org.view',
    'member.view',
    'agent.view',
    'workflow.view',
    'run.view',
    'document.view',
    'approval.view',
    'eval.view',
    'usage.view',
  ]),
};

/**
 * Evaluates whether `actor` is permitted to perform `action` on `resource`
 * and returns a structured decision with reason and machine-readable code.
 */
export function authorize(
  actor: AuthenticatedActor | null | undefined,
  action: PolicyAction,
  resource: ResourceContext
): AuthorizationDecision {
  if (!actor || !actor.userId || !actor.organizationId) {
    return {
      allowed: false,
      code: 'UNAUTHENTICATED',
      action,
      reason: 'Actor is not authenticated or lacks an active organization context.',
    };
  }

  // Rule 1: Strict tenant isolation boundary check (Threat T-01 mitigation)
  if (actor.organizationId !== resource.organizationId) {
    return {
      allowed: false,
      code: 'TENANT_MISMATCH',
      action,
      reason: `Cross-tenant access denied: actor organization (${actor.organizationId}) does not match resource organization (${resource.organizationId}).`,
    };
  }

  // Rule 2: Admin cannot modify, promote, or remove an Owner membership
  if (
    action === 'member.manage' &&
    actor.role === 'admin' &&
    resource.targetMemberRole === 'owner'
  ) {
    return {
      allowed: false,
      code: 'INSUFFICIENT_ROLE',
      action,
      reason: 'Role "admin" cannot promote, demote, or remove an "owner" membership.',
    };
  }

  // Rule 3: Configurable developer approval gate (Blueprint Section 5.2)
  if (
    action === 'approval.decide' &&
    actor.role === 'developer' &&
    resource.allowDeveloperApproval === true
  ) {
    return {
      allowed: true,
      code: 'ALLOWED',
      action,
      reason: 'Developer approval explicitly enabled for this resource context.',
    };
  }

  // Rule 4: Standard role-matrix lookup
  const roleSet = ROLE_PERMISSIONS[actor.role];
  if (!roleSet || !roleSet.has(action)) {
    return {
      allowed: false,
      code: 'INSUFFICIENT_ROLE',
      action,
      reason: `Role "${actor.role}" is not permitted to perform action "${action}".`,
    };
  }

  return {
    allowed: true,
    code: 'ALLOWED',
    action,
    reason: `Role "${actor.role}" is authorized for "${action}".`,
  };
}

/**
 * Pure boolean helper `can(actor, action, resource)` as specified in Ticket TENANT-002.
 */
export function can(
  actor: AuthenticatedActor | null | undefined,
  action: PolicyAction,
  resource: ResourceContext
): boolean {
  return authorize(actor, action, resource).allowed;
}

export class AuthorizationError extends Error {
  public readonly code: Exclude<AuthorizationCode, 'ALLOWED'>;
  public readonly action: PolicyAction;
  public readonly statusCode: 401 | 403 | 404;

  constructor(decision: AuthorizationDecision) {
    super(decision.reason);
    this.name = 'AuthorizationError';
    this.code = decision.code === 'ALLOWED' ? 'INSUFFICIENT_ROLE' : decision.code;
    this.action = decision.action;
    // Per Blueprint Section 11.4, cross-tenant resource lookups return 404 to prevent ID enumeration
    this.statusCode =
      decision.code === 'UNAUTHENTICATED'
        ? 401
        : decision.code === 'TENANT_MISMATCH'
          ? 404
          : 403;
  }
}

/**
 * Enforces authorization and throws a typed `AuthorizationError` if denied.
 */
export function requireAuthorization(
  actor: AuthenticatedActor | null | undefined,
  action: PolicyAction,
  resource: ResourceContext
): void {
  const decision = authorize(actor, action, resource);
  if (!decision.allowed) {
    throw new AuthorizationError(decision);
  }
}

/**
 * Returns the complete list of allowed actions for a given role.
 */
export function listRolePermissions(role: TenantRole): PolicyAction[] {
  return Array.from(ROLE_PERMISSIONS[role] ?? []);
}
