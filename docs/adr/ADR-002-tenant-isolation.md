# ADR-002: Defense-in-Depth Multi-Tenant Isolation, 8-Persona RBAC & Cross-Tenant 404 Masking

- **Status:** Accepted & Implemented (`v1.0.0-demo`)
- **Date:** 2026-10-31
- **Tickets:** `PLAN-004`, `TENANT-002`, `TENANT-004`

---

## 1. Context

**Ordaris Runtime (`v1.0.0-demo`)** is a multi-tenant AI Agent, Hybrid RAG, Workflow DAG & Governance Platform where multiple organizations (`Acme Cyber Defense` and `Beta Global Logistics`) share a single PostgreSQL database (`20` tables).

In multi-tenant AI systems, cross-tenant leakage and privilege escalation can occur through four distinct vectors:
1. **Direct API/Repository IDOR (`Threat T-01`)**: An authenticated actor in Tenant A passes a valid resource UUID (`agentId`, `runId`, `documentId`) belonging to Tenant B.
2. **UUID Existence Enumeration**: Returning `403 Forbidden` when an actor queries a UUID belonging to another tenant leaks the existence of that foreign resource.
3. **Intra-Tenant Privilege Escalation & Sole-Owner Lockout (`Threat T-02`)**: A `viewer` attempts to run or mutate an agent, a `developer` attempts to approve a production HITL gate or inspect the security audit log, or an `owner` removes the last remaining `owner` of an organization.
4. **Model-Driven Tenant Override (`Threat T-03`)**: A prompt-injected LLM attempts to pass `organizationId: "<victim-org-uuid>"` inside `knowledge_search` tool arguments.

---

## 2. Decision

We enforce a **four-layer defense-in-depth tenant isolation and RBAC architecture**:

1. **Schema-Level `organization_id` Partition Key & Composite Foreign Keys**:
   - Every tenant-owned table (`agents`, `agent_versions`, `runs`, `run_steps`, `run_events`, `job_queue`, `knowledge_documents`, `document_chunks`, `workflows`, `workflow_versions`, `approval_requests`, `usage_events`, `eval_suites`, `eval_cases`, `eval_experiments`, `eval_case_results`, `audit_events`) carries a non-null `organization_id` and composite `(organization_id, ...)` foreign keys so cross-tenant parent-child links are rejected by PostgreSQL itself.
2. **Central 23-Permission Policy Engine (`src/server/policies/authorization.ts`) with 404 Cross-Tenant Masking**:
   - Evaluates `authorize(actor, action, resource)` across 4 roles (`owner`: `23/23`, `admin`: `21/23`, `developer`: `16/23`, `viewer`: `9/23`).
   - If `actor.organizationId !== resource.organizationId`, `authorize()` denies the request with code `'TENANT_MISMATCH'` and HTTP status **`404 Not Found`** (never `403 Forbidden`).
   - `assertNotRemovingLastOwner()` rejects removing or demoting the final `owner` of an organization with **`409 Conflict` (`LAST_OWNER_PROTECTED`)**.
3. **Server-Injected Tool Context (`src/server/modules/tools/tool-gateway.ts`)**:
   - Tool argument schemas strip/ignore any model-supplied `organizationId`; `ToolGateway` always injects the server-verified `runs.organization_id`.
4. **Live 4-Point Cross-Tenant Verification Endpoint (`GET /api/v1/demo/verify-isolation`)**:
   - Allows evaluators to execute live cross-tenant and RBAC probes directly from the UI and inspect the resulting `404` / `403` / `200` verdicts and append-only `audit_events` rows.

---

## 3. Consequences & Planned Evolution (`v1.1+`)

- **Positive**: Eliminates IDOR (`T-01`), prevents foreign UUID probing, enforces strict role separation across all 8 seeded personas, and guarantees that prompt-injected models cannot query another organization's knowledge base.
- **Planned `v1.1` Evolution**: Gate interactive `x-actor-id` persona switching behind `DEMO_MODE=true` and bind production `ActorContext` resolution to OAuth 2.0 / OIDC session tokens and scoped `ord_live_...` API keys.
