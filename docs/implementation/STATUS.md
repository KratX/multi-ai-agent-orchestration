# Implementation Status

- Current phase: Phase A–H Full-Stack Runtime Integration, Persistence & Verification (COMPLETE)
- Current ticket: All MVP & Review Remediation Phases Complete (`Phase A` .. `Phase H`)
- Last updated: 2026-10-29
- Demo mode: verified (`AI_MODE=demo` default with deterministic `MockModelProvider`; optional server-side `GeminiModelProvider` when `AI_MODE=provider`)
- Local database: File-backed PGlite PostgreSQL (`PGLITE_DATA_DIR=".local/aegis-db"`) with migrations `0001`..`0006` and composite `(organization_id, ...)` foreign keys enforced at the SQL constraint layer
- Runtime processes: Full-stack Express API + Vite server (`pnpm dev` / `server.ts`) and standalone background queue worker (`pnpm dev:worker` / `src/server/worker/main.ts`)
- Automated verification: `19` test suites (`84/84 tests passing`), `pnpm typecheck` (`0` errors), `pnpm seed`, and `pnpm build` verified

## 1. Confirmed MVP Scope & Explicit Non-Goals (`PLAN-001`)

### MVP Scope (Built & Verified End-to-End)
1. **Multi-Tenant Foundation & SQL Composite Foreign Keys**: `organizations`, `users`, and `memberships` (`owner`, `admin`, `developer`, `viewer`) with central server-side `can(actor, action, resource)` authorization, `404 Not Found` cross-tenant masking (`ADR-002`), and composite `(organization_id, ...)` foreign keys across all child tables verified by direct SQL negative tests.
2. **Agent Studio & Immutable Versioning**: Mutable agent drafts (`agents`) and immutable published snapshots (`agent_versions` with SHA-256 snapshot hashes) so active runs never read mutable draft state.
3. **Deterministic Mock AI + Optional Server-Side Gemini Adapter**: `MockModelProvider` (`AI_MODE=demo`) as the zero-cost default requiring no API keys, plus `GeminiModelProvider` (`src/server/ai/gemini-provider.ts`) when `AI_MODE=provider`, verified via offline SDK contract tests.
4. **Bounded Agent Runtime & Safe Tool Gateway**: Strict step, tool-call, timeout, and payload budgets; server-validated tool registry with `calculator` (safe recursive-descent arithmetic parser, zero `eval`) and organization-scoped `knowledge_search`.
5. **PostgreSQL-Backed Job Queue & Standalone/Embedded Worker**: Transactional run + job + initial event creation; `RuntimeWorker` (`src/server/worker/main.ts`) claiming jobs via `FOR UPDATE SKIP LOCKED` leases, heartbeats, expired-lease recovery, and graceful `SIGINT`/`SIGTERM` shutdown.
6. **Express HTTP API & Real SSE Replay Stream**: Mounted `/api/v1/*` routes (`src/server/http/app.ts`) for liveness (`/api/v1/health/live`), real `SELECT 1` database readiness (`/api/v1/health/ready`), agents, runs, SSE cursor replay (`/api/v1/runs/:id/stream`), workflows, knowledge, approvals, usage, and audit events.
7. **Local Document Ingestion & Hybrid RAG**: Opaque local file storage keys (`Threat T-05`), deterministic chunking with provenance metadata, PostgreSQL `tsvector` + vector cosine similarity search scoped by `organization_id`, and verified source citations (`Threat T-02`, `Threat T-03`).
8. **Workflow DSL & HITL Approval Gates**: Server-validated directed acyclic workflow graphs (`start`, `agent`, `tool`, `condition`, `approval`, `end`), durable `approval_requests`, `audit_events` recording both `allowed` and `denied` outcomes (`Threat T-06`), and `usage_events` separating `mock` (estimated) from `live` tokens.
9. **API-Backed Agent Studio UI & Secondary Workbench**: Default React view connects directly to `/api/v1/*` endpoints over HTTP so creating agents, enqueuing runs, streaming SSE events, and deciding HITL approvals mutate and query real PostgreSQL rows.

### Explicit Non-Goals (Excluded to Preserve Zero-Spend & Scope)
- No real payment processing or Stripe billing integration.
- No mandatory Redis, Kafka, Temporal Cloud, Kubernetes, or paid vector database.
- No arbitrary shell execution (`exec`/`spawn`) or unrestricted user code execution.
- No arbitrary user-controlled URL fetching (SSRF vector).

## 2. Verified Phases & Tickets

- `Phase A (Reproducible Baseline & CI Hardening)`: Updated `.github/workflows/ci.yml` to enforce `pnpm install --frozen-lockfile` and repository hygiene checks (blocking committed `.env` or `.local/` artifacts). Added `index.html` and `vite.config.ts`.
- `Phase B (File-Backed Persistence & Real Readiness Probe)`: Configured `PGLITE_DATA_DIR=".local/aegis-db"` in `src/server/config/env.ts` and `src/server/db/client.ts`. Wired `src/server/modules/health/health-service.ts` and `src/app/api/v1/health/route.ts` to execute a real `SELECT 1` query against the active database. Verified restart persistence in `tests/integration/persistence-and-tenant-fk.test.ts`.
- `Phase C (Express HTTP API Integration)`: Implemented `src/server/http/app.ts`, `src/server/http/server.ts`, and `server.ts` mounting `/api/v1/health/live`, `/api/v1/health/ready`, `/api/v1/workspace`, `/api/v1/organizations`, `/api/v1/agents`, `/api/v1/runs`, `/api/v1/runs/:id/stream`, `/api/v1/approvals/:id/decision`, `/api/v1/knowledge/documents`, `/api/v1/workflows`, `/api/v1/usage`, and `/api/v1/audit-events`.
- `Phase D (Worker Lifecycle & Durable Runs)`: Implemented `RuntimeWorker` in `src/server/worker/main.ts` (`pnpm dev:worker` / `pnpm start:worker`) with `FOR UPDATE SKIP LOCKED` job claiming, `recoverExpiredJobLeases`, and graceful shutdown. Verified over HTTP in `tests/integration/http-api-and-worker.test.ts`.
- `Phase E (Tenant-Integrity SQL Composite Foreign Keys)`: Added composite `(organization_id, ...)` foreign keys across `agent_versions`, `runs` (including `(organization_id, agent_id, agent_version_id)`), `run_steps`, `run_events`, `job_queue`, `approval_requests`, `usage_events`, and `eval_experiments`. Verified with direct SQL negative tests in `tests/integration/persistence-and-tenant-fk.test.ts`.
- `Phase F (Server-Only Gemini ModelProvider Adapter)`: Implemented `GeminiModelProvider` (`src/server/ai/gemini-provider.ts`) using `@google/genai` with timeout bounds and `verifyModelCitations()`, wired into `createModelProvider` when `AI_MODE=provider`, and verified with offline mocked SDK contract tests in `tests/unit/gemini-provider.test.ts`.
- `Phase G & H (API-Backed Agent Studio UI & Browser Verification)`: Refactored `src/App.tsx` so the default view is the live API-backed Agent Studio & Operator Console (with honest `AI_MODE=demo` labeling and real HTTP mutations to PostgreSQL) and moved the source file inspector / `.zip` exporter to a secondary tab.

## 3. Test Evidence (`84/84` Passing Across `19` Suites)

- `tests/unit/env.test.ts` -> `7 pass, 0 fail`
- `tests/unit/health-route.test.ts` -> `4 pass, 0 fail`
- `tests/unit/authorization.test.ts` -> `6 pass, 0 fail`
- `tests/unit/mock-model-provider.test.ts` -> `6 pass, 0 fail`
- `tests/unit/gemini-provider.test.ts` -> `3 pass, 0 fail`
- `tests/unit/tool-gateway.test.ts` -> `6 pass, 0 fail`
- `tests/unit/rag-chunker.test.ts` -> `6 pass, 0 fail`
- `tests/unit/workflow-dag.test.ts` -> `6 pass, 0 fail`
- `tests/unit/eval-graders.test.ts` -> `6 pass, 0 fail`
- `tests/integration/tenant-schema.test.ts` -> `6 pass, 0 fail`
- `tests/integration/agent-versions.test.ts` -> `3 pass, 0 fail`
- `tests/integration/run-executor.test.ts` -> `3 pass, 0 fail`
- `tests/integration/knowledge-rag.test.ts` -> `3 pass, 0 fail`
- `tests/integration/workflow-hitl-audit.test.ts` -> `4 pass, 0 fail`
- `tests/integration/eval-sse.test.ts` -> `4 pass, 0 fail`
- `tests/integration/flagship-e2e.test.ts` -> `4 pass, 0 fail`
- `tests/integration/persistence-and-tenant-fk.test.ts` -> `2 pass, 0 fail`
- `tests/integration/http-api-and-worker.test.ts` -> `1 pass, 0 fail`
- `tests/security/tenant-isolation.test.ts` -> `4 pass, 0 fail`
