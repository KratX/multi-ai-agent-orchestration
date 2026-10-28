import crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { AegisDatabase } from '../client';
import {
  agents,
  agentVersions,
  ALLOWED_TOOLS,
  DEFAULT_AGENT_MODEL_CONFIG,
  type AgentModelConfig,
  type AgentRow,
  type AgentVersionRow,
  type AllowedToolName,
} from '../schema/agents';
import {
  requireAuthorization,
  type AuthenticatedActor,
} from '../../policies/authorization';

/**
 * Tickets AGENT-001 & AGENT-002 (Part 2): Agent Studio & Immutable Version Repository
 *
 * Responsibilities:
 * 1. `createAgentDraft()` & `updateAgentDraft()`: Tenant-scoped draft management.
 *    Updating a draft mutates ONLY the `agents` draft columns and NEVER mutates
 *    published rows in `agent_versions`.
 * 2. `computeAgentSnapshotHash()`: Deterministic SHA-256 hex digest over the canonical
 *    published payload (`systemPrompt`, `modelConfig`, sorted `toolAllowlist`).
 * 3. `publishAgentVersion()`: Atomic PostgreSQL transaction that increments
 *    `latest_version_number`, inserts an immutable `agent_versions` snapshot (`v1`, `v2`, ...),
 *    and transitions the agent `status` to `'active'`.
 * 4. Strict tenant isolation: Every query filters by `organization_id` AND enforces
 *    central RBAC via `requireAuthorization()`.
 */

export type AgentErrorCode =
  | 'AGENT_NOT_FOUND'
  | 'AGENT_VERSION_NOT_FOUND'
  | 'DUPLICATE_AGENT_SLUG'
  | 'AGENT_ARCHIVED'
  | 'EMPTY_SYSTEM_PROMPT'
  | 'INVALID_AGENT_INPUT';

export class AgentConstraintError extends Error {
  public readonly code: AgentErrorCode;
  public readonly statusCode: 400 | 404 | 409;

  constructor(
    code: AgentErrorCode,
    message: string,
    statusCode: 400 | 404 | 409 = 400
  ) {
    super(message);
    this.name = 'AgentConstraintError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface CreateAgentDraftInput {
  organizationId: string;
  name: string;
  slug: string;
  description?: string;
  draftSystemPrompt?: string;
  draftModelConfig?: Partial<AgentModelConfig>;
  draftToolAllowlist?: string[];
}

export interface UpdateAgentDraftInput {
  organizationId: string;
  agentId: string;
  name?: string;
  description?: string;
  draftSystemPrompt?: string;
  draftModelConfig?: Partial<AgentModelConfig>;
  draftToolAllowlist?: string[];
}

const VALID_ALLOWED_TOOLS = new Set<string>(ALLOWED_TOOLS);

function normalizeAndValidateToolAllowlist(
  rawTools: string[] | undefined
): AllowedToolName[] {
  if (!rawTools) {
    return [];
  }
  const deduplicated = Array.from(new Set(rawTools.map((t) => t.trim())));
  for (const tool of deduplicated) {
    if (!VALID_ALLOWED_TOOLS.has(tool)) {
      throw new AgentConstraintError(
        'INVALID_AGENT_INPUT',
        `Tool "${tool}" is not in the server-registered allowlist (${ALLOWED_TOOLS.join(', ')}).`,
        400
      );
    }
  }
  return deduplicated as AllowedToolName[];
}

function normalizeAndValidateModelConfig(
  partial?: Partial<AgentModelConfig>,
  base: AgentModelConfig = DEFAULT_AGENT_MODEL_CONFIG
): AgentModelConfig {
  const merged: AgentModelConfig = {
    provider: partial?.provider ?? base.provider,
    model: (partial?.model ?? base.model).trim(),
    temperature: partial?.temperature ?? base.temperature,
    maxSteps: partial?.maxSteps ?? base.maxSteps,
    maxToolCalls: partial?.maxToolCalls ?? base.maxToolCalls,
  };

  if (!merged.model) {
    throw new AgentConstraintError(
      'INVALID_AGENT_INPUT',
      'Model identifier must be non-empty.',
      400
    );
  }
  if (merged.temperature < 0 || merged.temperature > 2) {
    throw new AgentConstraintError(
      'INVALID_AGENT_INPUT',
      'Model temperature must be between 0 and 2.',
      400
    );
  }
  if (!Number.isInteger(merged.maxSteps) || merged.maxSteps < 1 || merged.maxSteps > 20) {
    throw new AgentConstraintError(
      'INVALID_AGENT_INPUT',
      'maxSteps must be an integer between 1 and 20.',
      400
    );
  }
  if (
    !Number.isInteger(merged.maxToolCalls) ||
    merged.maxToolCalls < 0 ||
    merged.maxToolCalls > 20
  ) {
    throw new AgentConstraintError(
      'INVALID_AGENT_INPUT',
      'maxToolCalls must be an integer between 0 and 20.',
      400
    );
  }

  return merged;
}

/**
 * Computes a deterministic 64-character SHA-256 hex digest over the canonical
 * published agent configuration so immutability can be cryptographically verified.
 */
export function computeAgentSnapshotHash(snapshot: {
  systemPrompt: string;
  modelConfig: AgentModelConfig;
  toolAllowlist: AllowedToolName[];
}): string {
  const canonicalPayload = JSON.stringify({
    systemPrompt: snapshot.systemPrompt,
    modelConfig: {
      provider: snapshot.modelConfig.provider,
      model: snapshot.modelConfig.model,
      temperature: snapshot.modelConfig.temperature,
      maxSteps: snapshot.modelConfig.maxSteps,
      maxToolCalls: snapshot.modelConfig.maxToolCalls,
    },
    toolAllowlist: [...snapshot.toolAllowlist].sort(),
  });

  return crypto.createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}

/**
 * Creates a new mutable Agent draft in `organizationId`.
 */
export async function createAgentDraft(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  input: CreateAgentDraftInput
): Promise<AgentRow> {
  requireAuthorization(actor, 'agent.edit', {
    organizationId: input.organizationId,
    resourceType: 'agent',
  });

  const cleanName = input.name.trim();
  const cleanSlug = input.slug.trim().toLowerCase();

  if (cleanName.length < 1 || cleanName.length > 100) {
    throw new AgentConstraintError(
      'INVALID_AGENT_INPUT',
      'Agent name must be between 1 and 100 characters.',
      400
    );
  }

  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(cleanSlug)) {
    throw new AgentConstraintError(
      'INVALID_AGENT_INPUT',
      'Agent slug must be 2..64 lowercase alphanumeric characters or hyphens.',
      400
    );
  }

  const modelConfig = normalizeAndValidateModelConfig(input.draftModelConfig);
  const toolAllowlist = normalizeAndValidateToolAllowlist(input.draftToolAllowlist);

  const existingSlug = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, input.organizationId),
        eq(agents.slug, cleanSlug)
      )
    )
    .limit(1);

  if (existingSlug.length > 0) {
    throw new AgentConstraintError(
      'DUPLICATE_AGENT_SLUG',
      `An agent with slug "${cleanSlug}" already exists in this organization.`,
      409
    );
  }

  const [created] = await db
    .insert(agents)
    .values({
      organizationId: input.organizationId,
      name: cleanName,
      slug: cleanSlug,
      description: input.description?.trim() ?? '',
      status: 'draft',
      draftSystemPrompt: input.draftSystemPrompt ?? '',
      draftModelConfig: modelConfig,
      draftToolAllowlist: toolAllowlist,
      latestVersionNumber: 0,
      createdByUserId: actor!.userId,
    })
    .returning();

  return created;
}

/**
 * Fetches a single agent scoped to `organizationId` after verifying `agent.view` permission.
 */
export async function getAgentForActor(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  organizationId: string,
  agentId: string
): Promise<AgentRow> {
  requireAuthorization(actor, 'agent.view', {
    organizationId,
    resourceType: 'agent',
    resourceId: agentId,
  });

  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.organizationId, organizationId)))
    .limit(1);

  if (rows.length === 0) {
    throw new AgentConstraintError(
      'AGENT_NOT_FOUND',
      `Agent ${agentId} was not found in organization ${organizationId}.`,
      404
    );
  }

  return rows[0];
}

/**
 * Lists all agents belonging to `organizationId`, ordered by most recently updated.
 */
export async function listOrganizationAgents(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  organizationId: string
): Promise<AgentRow[]> {
  requireAuthorization(actor, 'agent.view', {
    organizationId,
    resourceType: 'agent',
  });

  return db
    .select()
    .from(agents)
    .where(eq(agents.organizationId, organizationId))
    .orderBy(desc(agents.updatedAt));
}

/**
 * Updates the mutable draft fields on an `agents` row without modifying any
 * previously published `agent_versions` snapshots.
 */
export async function updateAgentDraft(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  input: UpdateAgentDraftInput
): Promise<AgentRow> {
  requireAuthorization(actor, 'agent.edit', {
    organizationId: input.organizationId,
    resourceType: 'agent',
    resourceId: input.agentId,
  });

  const existing = await getAgentForActor(
    db,
    actor,
    input.organizationId,
    input.agentId
  );

  if (existing.status === 'archived') {
    throw new AgentConstraintError(
      'AGENT_ARCHIVED',
      'Archived agents cannot be edited.',
      409
    );
  }

  const nextName =
    input.name !== undefined ? input.name.trim() : existing.name;
  if (nextName.length < 1 || nextName.length > 100) {
    throw new AgentConstraintError(
      'INVALID_AGENT_INPUT',
      'Agent name must be between 1 and 100 characters.',
      400
    );
  }

  const nextModelConfig = input.draftModelConfig
    ? normalizeAndValidateModelConfig(
        input.draftModelConfig,
        existing.draftModelConfig
      )
    : existing.draftModelConfig;

  const nextToolAllowlist =
    input.draftToolAllowlist !== undefined
      ? normalizeAndValidateToolAllowlist(input.draftToolAllowlist)
      : existing.draftToolAllowlist;

  const [updated] = await db
    .update(agents)
    .set({
      name: nextName,
      description:
        input.description !== undefined
          ? input.description.trim()
          : existing.description,
      draftSystemPrompt:
        input.draftSystemPrompt !== undefined
          ? input.draftSystemPrompt
          : existing.draftSystemPrompt,
      draftModelConfig: nextModelConfig,
      draftToolAllowlist: nextToolAllowlist,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agents.id, existing.id),
        eq(agents.organizationId, input.organizationId)
      )
    )
    .returning();

  return updated;
}

/**
 * Atomically publishes the current draft of `agentId` into an immutable `agent_versions`
 * row (`version_number = latest_version_number + 1`) and marks the agent `'active'`.
 */
export async function publishAgentVersion(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  organizationId: string,
  agentId: string
): Promise<{ agent: AgentRow; version: AgentVersionRow }> {
  requireAuthorization(actor, 'agent.publish', {
    organizationId,
    resourceType: 'agent',
    resourceId: agentId,
  });

  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(agents)
      .where(
        and(eq(agents.id, agentId), eq(agents.organizationId, organizationId))
      )
      .limit(1);

    if (rows.length === 0) {
      throw new AgentConstraintError(
        'AGENT_NOT_FOUND',
        `Agent ${agentId} was not found in organization ${organizationId}.`,
        404
      );
    }

    const currentAgent = rows[0];

    if (currentAgent.status === 'archived') {
      throw new AgentConstraintError(
        'AGENT_ARCHIVED',
        'Archived agents cannot be published.',
        409
      );
    }

    if (currentAgent.draftSystemPrompt.trim().length === 0) {
      throw new AgentConstraintError(
        'EMPTY_SYSTEM_PROMPT',
        'Cannot publish an agent version with an empty system prompt.',
        400
      );
    }

    const nextVersionNumber = currentAgent.latestVersionNumber + 1;
    const snapshotHash = computeAgentSnapshotHash({
      systemPrompt: currentAgent.draftSystemPrompt,
      modelConfig: currentAgent.draftModelConfig,
      toolAllowlist: currentAgent.draftToolAllowlist,
    });

    const [createdVersion] = await tx
      .insert(agentVersions)
      .values({
        organizationId,
        agentId: currentAgent.id,
        versionNumber: nextVersionNumber,
        systemPrompt: currentAgent.draftSystemPrompt,
        modelConfig: currentAgent.draftModelConfig,
        toolAllowlist: currentAgent.draftToolAllowlist,
        snapshotHash,
        publishedByUserId: actor!.userId,
      })
      .returning();

    const [updatedAgent] = await tx
      .update(agents)
      .set({
        status: 'active',
        latestVersionNumber: nextVersionNumber,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agents.id, currentAgent.id),
          eq(agents.organizationId, organizationId)
        )
      )
      .returning();

    return {
      agent: updatedAgent,
      version: createdVersion,
    };
  });
}

/**
 * Fetches a specific immutable `agent_versions` snapshot scoped to `organizationId`.
 * Active runs call this so they never read mutable draft columns on `agents`.
 */
export async function getAgentVersionForActor(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  organizationId: string,
  agentVersionId: string
): Promise<AgentVersionRow> {
  requireAuthorization(actor, 'agent.view', {
    organizationId,
    resourceType: 'agent_version',
    resourceId: agentVersionId,
  });

  const rows = await db
    .select()
    .from(agentVersions)
    .where(
      and(
        eq(agentVersions.id, agentVersionId),
        eq(agentVersions.organizationId, organizationId)
      )
    )
    .limit(1);

  if (rows.length === 0) {
    throw new AgentConstraintError(
      'AGENT_VERSION_NOT_FOUND',
      `Agent version ${agentVersionId} was not found in organization ${organizationId}.`,
      404
    );
  }

  return rows[0];
}

/**
 * Lists all immutable published versions for `agentId` in descending version order (`v3, v2, v1`).
 */
export async function listAgentVersions(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  organizationId: string,
  agentId: string
): Promise<AgentVersionRow[]> {
  requireAuthorization(actor, 'agent.view', {
    organizationId,
    resourceType: 'agent',
    resourceId: agentId,
  });

  // Ensure the parent agent actually belongs to `organizationId`
  await getAgentForActor(db, actor, organizationId, agentId);

  return db
    .select()
    .from(agentVersions)
    .where(
      and(
        eq(agentVersions.organizationId, organizationId),
        eq(agentVersions.agentId, agentId)
      )
    )
    .orderBy(desc(agentVersions.versionNumber));
}

/**
 * Archives an agent (`status = 'archived'`). Requires `agent.delete` permission (`owner` or `admin`).
 */
export async function archiveAgent(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  organizationId: string,
  agentId: string
): Promise<AgentRow> {
  requireAuthorization(actor, 'agent.delete', {
    organizationId,
    resourceType: 'agent',
    resourceId: agentId,
  });

  await getAgentForActor(db, actor, organizationId, agentId);

  const [archived] = await db
    .update(agents)
    .set({
      status: 'archived',
      updatedAt: new Date(),
    })
    .where(and(eq(agents.id, agentId), eq(agents.organizationId, organizationId)))
    .returning();

  return archived;
}
