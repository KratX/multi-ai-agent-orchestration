# ADR-002: Defense-in-Depth Multi-Tenant Isolation & Cross-Tenant 404 Masking

- **Status**: Accepted
- **Date**: 2026-10-28
- **Tickets**: `PLAN-004`, `TENANT-002`, `TENANT-004`

## 1. Context

Aegis Cloud is a multi-tenant AI Agent Reliability, Governance & Operations Cloud where multiple organizations share a single PostgreSQL database (`organizations`, `users`, `memberships`, `agents`, `agent_versions`, `runs`, `run_steps`, `run_events`, `job_queue`, and knowledge base documents/chunks).

In multi-tenant AI systems, cross-tenant leakage can happen through three distinct vectors:
1. **Direct API/Repository IDOR (`Threat T-01`)**: An authenticated actor in Organization A passes a valid resource UUID (`agentId`, `runId`, `documentId`) belonging to Organization B, or attempts to spoof an `x-organization-id` header.
2. **Existence Enumeration**: Returning `403 Forbidden` when an actor queries a UUID belonging to another tenant leaks the existence of that foreign resource.
3. **Model-Driven Tenant Override (`Threat T-02`)**: A prompt-injected model attempts to pass `organizationId: "<victim-org-uuid>"` inside `knowledge_search` tool arguments.

## 2. Decision

We enforce a **three-layer defense-in-depth tenant isolation architecture**:

1. **Schema-Level `organization_id` Partition Key**:
   - Every tenant-owned table (`agents`, `agent_versions`, `runs`, `run_steps`, `run_events`, `job_queue`, `knowledge_documents`, `knowledge_chunks`, `audit_events`) carries a non-null `organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE` column and composite indexes leading with `organization_id`.
2. **Central RBAC Policy Engine (`src/server/policies/authorization.ts`) with 404 Cross-Tenant Masking**:
   - Every repository and service entry point must call `requireAuthorization(actor, action, resource)` before executing any query or mutation.
   - If `actor.organizationId !== resource.organizationId`, `authorize()` immediately denies the request with reason `'CROSS_TENANT_ACCESS_DENIED'` and maps the HTTP status code to **`404 Not Found`** (never `403 Forbidden`), making cross-tenant resources indistinguishable from non-existent UUIDs.
   - All SQL `SELECT`, `UPDATE`, and `DELETE` predicates must include `AND organization_id = $actorOrgId`.
3. **Server-Injected Tool Context (`src/server/modules/tools/tool-gateway.ts`)**:
   - Tool argument schemas (`knowledgeSearchToolArgsSchema`) strip or reject any model-supplied `organizationId`.
   - `ToolGateway` always injects `context.organizationId` from the server-verified `runs.organization_id` record.

## 3. Consequences

- **Positive**: Eliminates IDOR (`T-01`), prevents foreign resource existence probing, and guarantees that even a compromised or prompt-injected LLM cannot query another organization's knowledge chunks (`T-02`).
- **Trade-offs**: Every repository method explicitly requires `(db, actor, organizationId, ...)` parameters rather than relying on implicit global state, which slightly increases function signature verbosity in exchange for compile-time and unit-testable clarity.
