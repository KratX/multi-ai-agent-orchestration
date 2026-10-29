# Implementation Status

- Current phase: Phase 3 — Agent Studio, Immutable Versioning & Mock Model Provider
- Current ticket: AGENT-003 (Next — Deterministic `MockModelProvider` & `ModelProvider` Interface)
- Last updated: 2026-10-28
- Demo mode: verified (`AI_MODE=demo` unit tests passing)
- Local database: Drizzle schema + PGlite PostgreSQL migrations 0001 & 0002 active
- CI status: local unit + integration + security test suites verified (`30/30 tests passing`, `pnpm typecheck` 0 errors)

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
- `PLAN-004`: Created `docs/adr/ADR-001-local-first-free-tier.md` and `docs/adr/ADR-003-postgres-job-queue.md`.
- `REPO-001 & REPO-002`: Updated `package.json`, `tsconfig.json`, and `pnpm-workspace.yaml` with `pnpm` 12 `allowBuilds` and strict typechecking.
- `REPO-003`: Updated `.env.example`, implemented `src/server/config/env.ts`, and verified all 7 unit tests in `tests/unit/env.test.ts` (`7/7 passing`).
- `REPO-004`: Created `docker-compose.yml`, implemented `src/app/api/v1/health/route.ts`, and verified all 4 unit tests in `tests/unit/health-route.test.ts` (`4/4 passing`).
- `REPO-005`: Created `src/server/db/schema/tenant.ts`, `src/server/db/client.ts`, and verified all 6 PostgreSQL constraint integration tests in `tests/integration/tenant-schema.test.ts` (`6/6 passing`).
- `TENANT-002`: Created `src/server/policies/authorization.ts` and verified all 6 RBAC and cross-tenant boundary unit tests in `tests/unit/authorization.test.ts` (`6/6 passing`).
- `TENANT-001 & TENANT-003`: Created `src/server/db/repositories/tenant-repository.ts` implementing `ensureUser()`, transactional `createOrganizationWithOwner()`, `resolveActorContext()`, `upsertMembership()`, `removeMembership()`, and the last-owner safeguard.
- `TENANT-004`: Created and verified `tests/security/tenant-isolation.test.ts` (`4/4 passing` against PostgreSQL) covering cross-tenant negative access, anti-spoofing, role escalation prevention, and last-owner protection.
- `AGENT-001 & AGENT-002`: Completed `src/server/db/schema/agents.ts`, `src/server/db/client.ts` (`MIGRATION_0002_AGENTS_SQL`), `src/server/db/repositories/agent-repository.ts`, and verified all 3 PostgreSQL integration tests in `tests/integration/agent-versions.test.ts` (`3/3 passing`).

## In progress
- `AGENT-003`: Implement `src/server/ai/model-provider.ts` defining the `ModelProvider` contract and the deterministic zero-cost `MockModelProvider` (`AI_MODE=demo`), plus unit tests in `tests/unit/mock-model-provider.test.ts`.

## Blockers and risks
- None recorded yet.

## Next task
- `AGENT-003`: Create `src/server/ai/model-provider.ts` and `tests/unit/mock-model-provider.test.ts`.

## Test evidence
- `npx --yes tsx --test tests/unit/env.test.ts` -> `7 tests, 7 pass, 0 fail`.
- `npx --yes tsx --test tests/unit/health-route.test.ts` -> `4 tests, 4 pass, 0 fail`.
- `npx --yes tsx --test tests/integration/tenant-schema.test.ts` -> `6 tests, 6 pass, 0 fail`.
- `npx --yes tsx --test tests/unit/authorization.test.ts` -> `6 tests, 6 pass, 0 fail`.
- `npx --yes tsx --test tests/security/tenant-isolation.test.ts` -> `4 tests, 4 pass, 0 fail`.
- `npx --yes tsx --test tests/integration/agent-versions.test.ts` -> `3 tests, 3 pass, 0 fail`.

## Change log
- 2026-10-28: Completed `AGENT-001 & AGENT-002` (`tests/integration/agent-versions.test.ts` 3/3 passing; 30/30 total tests passing).
- 2026-10-28: Created `src/server/db/repositories/agent-repository.ts` (`AGENT-001` & `AGENT-002` Part 2).
- 2026-10-28: Created `src/server/db/schema/agents.ts` and updated `src/server/db/client.ts` (`AGENT-001` & `AGENT-002` Part 1).
- 2026-10-28: Completed `TENANT-004` (`tests/security/tenant-isolation.test.ts` 4/4 passing). Phase 2 complete!
- 2026-10-28: Created `src/server/db/repositories/tenant-repository.ts` (`TENANT-001` & `TENANT-003`).
- 2026-10-28: Completed `TENANT-002` (`src/server/policies/authorization.ts` + `tests/unit/authorization.test.ts` 6/6 passing).
- 2026-10-28: Completed `REPO-005` (`src/server/db/client.ts` + `tests/integration/tenant-schema.test.ts` 6/6 passing). Phase 1 complete!
- 2026-10-27: Updated `package.json` (`REPO-001`/`REPO-002`) and created `src/server/db/schema/tenant.ts` (`REPO-005` Part 1).
