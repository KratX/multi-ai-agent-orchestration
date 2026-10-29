# Implementation Status

- Current phase: Phase 5 — Tenant-Isolated Knowledge Base Ingestion & Full-Text / Vector RAG (Next)
- Current ticket: RAG-001 (Next — Knowledge Documents & Chunks Schema + Deterministic Chunker)
- Last updated: 2026-10-29
- Demo mode: verified (`AI_MODE=demo` unit & integration tests passing, `MockModelProvider` + `ToolGateway` + `RunExecutor` verified)
- Local database: Drizzle schema + PGlite PostgreSQL migrations 0001, 0002 & 0003 active
- CI status: local unit + integration + security test suites verified (`45/45 tests passing`, `pnpm typecheck` 0 errors)

## 1. Confirmed MVP Scope & Explicit Non-Goals (`PLAN-001`)

### MVP Scope (Must Build & Verify End-to-End)
1. **Multi-Tenant Foundation**: `organizations`, `users`, and `memberships` (`owner`, `admin`, `developer`, `viewer`) with central server-side `can(actor, action, resource)` authorization and cross-tenant negative tests.
2. **Agent Studio & Immutable Versioning**: Mutable agent drafts (`agents`) and immutable published snapshots (`agent_versions` with SHA-256 snapshot hashes) so active runs never read mutable draft state.
3. **Deterministic Mock AI + Optional Live Adapter**: `MockModelProvider` (`AI_MODE=demo`) as the zero-cost default requiring no API keys, with an optional server-only live provider adapter.
4. **Bounded Agent Runtime & Safe Tool Gateway**: Strict step, tool-call, timeout, and payload budgets; server-validated tool registry starting with `calculator` (safe parsed arithmetic, no `eval`) and organization-scoped `knowledge_search`.
5. **PostgreSQL-Backed Job Queue & Worker**: Transactional run + job + initial event creation; worker claiming via `FOR UPDATE SKIP LOCKED` leases, heartbeats, expired-lease recovery, and bounded retries.
6. **Event History & SSE Replay Debugger**: Append-only `run_events` with per-run monotonic `sequence` numbers, cursor pagination, and SSE reconnect replay via `Last-Event-ID` / `afterSequence`.
7. **Local Document Ingestion & Full-Text RAG**: Opaque local file storage, chunking with provenance metadata, PostgreSQL `tsvector` full-text search scoped by `organization_id`, and verified source citations.
8. **Workflow DSL & Visual Editor**: Server-validated directed acyclic workflow graphs (`start`, `agent`, `tool`, `condition`, `approval`, `end`) with immutable published versions.
9. **Approval Gates, Audit Trail & Usage Ledger**: Human-in-the-loop pause/resume approvals, security `audit_events`, and honest `usage_events` (explicitly labeling mock vs. live usage).

### Explicit Non-Goals (Excluded from MVP to Preserve Zero-Spend & Scope)
- No real payment processing or Stripe billing integration.
- No mandatory Redis, Kafka, Temporal Cloud, Kubernetes, or paid vector database.
- No arbitrary shell execution (`exec`/`spawn`) or unrestricted user code execution.
- No arbitrary user-controlled URL fetching (SSRF vector) in the MVP.
- No fabricated uptime, throughput, or fake telemetry metrics in the UI.

## Verified complete
- `PLAN-001`: Confirmed MVP requirements, execution guardrails, and explicit non-goals (`docs/implementation/STATUS.md`).
- `PLAN-002`: Wrote system architecture overview, responsibility boundaries, Mermaid diagrams, and state machine specification (`docs/architecture.md`).
- `PLAN-003`: Wrote security threat model, trust boundaries, T-01..T-07 mitigation catalog, and residual risk disclosure (`docs/threat-model.md`).
- `PLAN-004`: Created `docs/adr/ADR-001-local-first-free-tier.md`, `docs/adr/ADR-002-tenant-isolation.md`, and `docs/adr/ADR-003-postgres-job-queue.md`.
- `REPO-001 & REPO-002`: Updated `package.json`, `tsconfig.json`, `.gitignore`, and `pnpm-workspace.yaml` with `pnpm` 12 `allowBuilds` and strict typechecking.
- `REPO-003`: Updated `.env.example`, implemented `src/server/config/env.ts`, and verified all 7 unit tests in `tests/unit/env.test.ts` (`7/7 passing`).
- `REPO-004`: Created `docker-compose.yml`, implemented `src/app/api/v1/health/route.ts`, and verified all 4 unit tests in `tests/unit/health-route.test.ts` (`4/4 passing`).
- `REPO-005`: Created `src/server/db/schema/tenant.ts`, `src/server/db/client.ts`, and verified all 6 PostgreSQL constraint integration tests in `tests/integration/tenant-schema.test.ts` (`6/6 passing`).
- `TENANT-002`: Created `src/server/policies/authorization.ts` and verified all 6 RBAC and cross-tenant boundary unit tests in `tests/unit/authorization.test.ts` (`6/6 passing`).
- `TENANT-001 & TENANT-003`: Created `src/server/db/repositories/tenant-repository.ts` implementing `ensureUser()`, transactional `createOrganizationWithOwner()`, `resolveActorContext()`, `upsertMembership()`, `removeMembership()`, and the last-owner safeguard.
- `TENANT-004`: Created and verified `tests/security/tenant-isolation.test.ts` (`4/4 passing` against PostgreSQL) covering cross-tenant negative access, anti-spoofing, role escalation prevention, and last-owner protection.
- `AGENT-001 & AGENT-002`: Completed `src/server/db/schema/agents.ts`, `src/server/db/client.ts` (`MIGRATION_0002_AGENTS_SQL`), `src/server/db/repositories/agent-repository.ts`, and verified all 3 PostgreSQL integration tests in `tests/integration/agent-versions.test.ts` (`3/3 passing`).
- `AGENT-003`: Implemented `src/server/ai/model-provider.ts` (`ModelProvider` contract, deterministic `MockModelProvider`, `verifyModelCitations()`, and `embedText()`) and verified all 6 unit tests in `tests/unit/mock-model-provider.test.ts` (`6/6 passing`). Phase 3 complete!
- `TOOL-001 & TOOL-002`: Implemented `src/server/modules/tools/tool-gateway.ts` (`evaluateSafeArithmetic` recursive-descent parser with zero `eval()`, `ToolGateway` allowlist/Zod/payload/timeout enforcement, and tenant-scoped `knowledge_search` adapter) and verified all 6 unit/security tests in `tests/unit/tool-gateway.test.ts` (`6/6 passing`).
- `RUN-001, RUN-002, QUEUE-001 & QUEUE-002`: Implemented `src/server/db/schema/runs.ts` (`runs`, `run_steps`, `run_events`, `job_queue` + `MIGRATION_0003_RUNS_SQL`), updated `src/server/db/client.ts`, implemented `src/server/modules/runs/run-executor.ts` (idempotent `enqueueAgentRun`, `FOR UPDATE SKIP LOCKED` `claimNextPendingJob`, `recoverExpiredJobLeases`, and bounded `executeAgentRun`), and verified all 3 PostgreSQL integration tests in `tests/integration/run-executor.test.ts` (`3/3 passing`). Phase 4 complete!

## In progress
- `RAG-001`: Define Drizzle PostgreSQL schema and SQL migration 0004 for `knowledge_documents` and `knowledge_chunks` with deterministic chunker and tenant-isolated retrieval.

## Blockers and risks
- None recorded yet.

## Next task
- `RAG-001, RAG-002 & RAG-003`: Create `src/server/db/schema/knowledge.ts`, implement `src/server/modules/knowledge/knowledge-service.ts`, and verify tenant-scoped RAG & prompt-injection defense (`T-02`).

## Test evidence
- `npx --yes tsx --test tests/unit/env.test.ts` -> `7 tests, 7 pass, 0 fail`.
- `npx --yes tsx --test tests/unit/health-route.test.ts` -> `4 tests, 4 pass, 0 fail`.
- `npx --yes tsx --test tests/integration/tenant-schema.test.ts` -> `6 tests, 6 pass, 0 fail`.
- `npx --yes tsx --test tests/unit/authorization.test.ts` -> `6 tests, 6 pass, 0 fail`.
- `npx --yes tsx --test tests/security/tenant-isolation.test.ts` -> `4 tests, 4 pass, 0 fail`.
- `npx --yes tsx --test tests/integration/agent-versions.test.ts` -> `3 tests, 3 pass, 0 fail`.
- `npx --yes tsx --test tests/unit/mock-model-provider.test.ts` -> `6 tests, 6 pass, 0 fail`.
- `npx --yes tsx --test tests/unit/tool-gateway.test.ts` -> `6 tests, 6 pass, 0 fail`.
- `npx --yes tsx --test tests/integration/run-executor.test.ts` -> `3 tests, 3 pass, 0 fail`.

## Change log
- 2026-10-29: Completed `RUN-001, RUN-002, QUEUE-001 & QUEUE-002` (`src/server/db/schema/runs.ts`, `src/server/modules/runs/run-executor.ts`, `tests/integration/run-executor.test.ts` 3/3 passing; 45/45 total tests passing). Phase 4 complete!
- 2026-10-29: Completed `TOOL-001 & TOOL-002` (`src/server/modules/tools/tool-gateway.ts` + `tests/unit/tool-gateway.test.ts` 6/6 passing; 42/42 total tests passing).
- 2026-10-29: Completed `AGENT-003` (`src/server/ai/model-provider.ts` + `tests/unit/mock-model-provider.test.ts` 6/6 passing; 36/36 total tests passing). Phase 3 complete!
- 2026-10-28: Completed `AGENT-001 & AGENT-002` (`tests/integration/agent-versions.test.ts` 3/3 passing; 30/30 total tests passing).
- 2026-10-28: Created `src/server/db/repositories/agent-repository.ts` (`AGENT-001` & `AGENT-002` Part 2).
- 2026-10-28: Created `src/server/db/schema/agents.ts` and updated `src/server/db/client.ts` (`AGENT-001` & `AGENT-002` Part 1).
- 2026-10-28: Completed `TENANT-004` (`tests/security/tenant-isolation.test.ts` 4/4 passing). Phase 2 complete!
- 2026-10-28: Created `src/server/db/repositories/tenant-repository.ts` (`TENANT-001` & `TENANT-003`).
- 2026-10-28: Completed `TENANT-002` (`src/server/policies/authorization.ts` + `tests/unit/authorization.test.ts` 6/6 passing).
- 2026-10-28: Completed `REPO-005` (`src/server/db/client.ts` + `tests/integration/tenant-schema.test.ts` 6/6 passing). Phase 1 complete!
- 2026-10-27: Updated `package.json` (`REPO-001`/`REPO-002`) and created `src/server/db/schema/tenant.ts` (`REPO-005` Part 1).
