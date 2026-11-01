# Ordaris Runtime (`v1.0.0-demo`) — Implementation Status & Planned Roadmap

- **Current Release**: `v1.0.0-demo` — Enterprise Multi-Tenant AI Agent, Hybrid RAG, Workflow DAG, HITL Governance & FinOps Platform (**COMPLETE**)
- **Current Phase**: Phases `A`–`H` (Core Runtime) + Phase `I` / Checkpoints `1`–`12` (`Ordaris Runtime v1.0.0-demo` Interactive Multi-Tenant Sandbox & Security Hardening) (**COMPLETE**)
- **Last Updated**: 2026-10-31
- **AI Execution Mode**: 3-Tier AI Resolution (`Tier 1`: Session AES-256-GCM BYOK Vault -> `Tier 2`: Server `.env` -> `Tier 3`: Deterministic `MockModelProvider` across `mock`, `gemini`, `chatgpt`, `claude`, `grok`, `openrouter`)
- **Database Engine (`DB_DRIVER=auto|postgres|pglite`)**: Dual PostgreSQL adapter supporting external PostgreSQL 16+ via `pg.Pool` (`drizzle-orm/node-postgres`) when `DATABASE_URL` is configured, and file-backed PGlite (`PGLITE_DATA_DIR=".local/ordaris-db"`) for local zero-daemon execution, with `20` tables, migrations `0001`..`0006`, and composite `(organization_id, ...)` foreign keys enforced at the SQL constraint layer
- **Runtime Processes**: Full-stack Express API + Vite UI (`pnpm dev` / `server.ts`, compiled to `server.js` via `pnpm build`) and standalone background queue worker (`pnpm dev:worker` / `src/server/worker/main.ts`)
- **Automated Verification**: `21` test suites (`108/108` tests passing across unit, security, and full-stack PostgreSQL/HTTP integration), `pnpm typecheck` (`0` errors), `pnpm seed`, and `pnpm build` verified

---

## 1. What We Have Built (`v1.0.0-demo` Completed Capabilities)

### A. Core Platform Foundation (Phases `A`–`H`)
1. **Multi-Tenant Foundation & SQL Composite Foreign Keys (`TENANT-001`..`004`)**:
   - `organizations`, `users`, and `memberships` (`owner`, `admin`, `developer`, `viewer`) with central server-side `authorize()` / `requireAuthorization()`, `404 Not Found` (`TENANT_MISMATCH`) cross-tenant masking (`ADR-002`), and composite `(organization_id, ...)` foreign keys across all child tables verified by direct SQL negative tests.
2. **Agent Studio & Immutable Snapshot Versioning (`AGENT-001`..`002`)**:
   - Mutable agent drafts (`agents`) separated from immutable published snapshots (`agent_versions` with canonical SHA-256 `snapshot_hash`) so active runs, workflows, and evaluations never read mutable draft state.
3. **Bounded Agent Runtime & Safe Tool Gateway (`TOOL-001`..`002`, `RUN-001`..`002`)**:
   - Strict step (`8`), tool-call (`6`), timeout (`120s`), and payload byte budgets.
   - Server-validated `ToolGateway` (`src/server/modules/tools/tool-gateway.ts`) enforcing per-version tool allowlists, `calculator` (recursive-descent arithmetic parser with **zero `eval()` or `Function()`**), organization-scoped `knowledge_search`, and `verifyModelCitations()` to strip hallucinated citations.
4. **PostgreSQL Transactional Job Queue & Background Worker (`QUEUE-001`..`002`, `ADR-003`)**:
   - Atomic transaction inserting `runs`, `job_queue` (with per-job `execution_config` JSONB), and `run_events (seq=1)`.
   - `RuntimeWorker` (`src/server/worker/main.ts`) claiming jobs via `FOR UPDATE SKIP LOCKED` leases (`claimNextPendingJob` and `claimPendingJobById`), periodic lease heartbeats (`renewJobLease` / `startJobLeaseHeartbeat`), single-worker CAS guard (`WHERE status = 'queued'`), `recoverExpiredJobLeases`, and graceful `SIGINT`/`SIGTERM` shutdown.
5. **Tenant-Isolated Knowledge Ingestion & Hybrid RAG (`RAG-001`..`003`)**:
   - Path-traversal filename sanitization (`Threat T-05`), unified `MAX_UPLOAD_BYTES` (`10 MiB`) across HTTP JSON middleware, route validation, and service layer, opaque `<org_id>/<uuid>.bin` storage keys, SHA-256 deduplication, `<untrusted_knowledge_context>` prompt-injection delimiters (`Threat T-03`), and hybrid PostgreSQL `tsvector` + 64-D cosine vector ranking.
6. **Directed Acyclic Workflow Engine & HITL Approval Gates (`WORKFLOW-001`..`002`, `HITL-001`)**:
   - 3-color DFS cycle detector (`validateWorkflowDag` in `src/server/modules/workflows/dag-validator.ts`) reporting exact `cyclePath` arrays, safe branching evaluation without `eval()`, durable `approval_requests` (`waiting_approval`), and server-authorized `owner`/`admin` approval/rejection (`POST /api/v1/approvals/:id/decision`).
7. **Automated Evaluation Harness, Honest FinOps Ledger & SSE Cursor Replay (`EVAL-001`, `USAGE-001`, `AUDIT-001`, `SSE-001`)**:
   - 5 deterministic graders (`exact_match`, `contains`, `json_schema`, `citation_required`, `tool_called`) with `v1`-vs-`v2` regression comparison (`compareEvalExperiments`).
   - Append-only `audit_events` recording both `allowed` and `denied` outcomes (`Threat T-06`).
   - `usage_events` partitioning `mock` (`is_estimated = true`) vs `live` (`is_estimated = false`) tokens.
   - `GET /api/v1/runs/:id/stream` and `/events?afterSequence=N` for gap-free `Last-Event-ID` cursor replay.

---

### B. Ordaris Runtime `v1.0.0-demo` Interactive Enterprise Sandbox (Checkpoints `1`–`12`)
1. **Checkpoint 1 — Session-Scoped AES-256-GCM BYOK Vault (`src/server/security/session-key-vault.ts`)**:
   - Encrypts visitor-supplied cloud API keys in server RAM using `aes-256-gcm` with an ephemeral 256-bit CSPRNG master key (`crypto.randomBytes(32)`), 96-bit random IV, and 128-bit authentication tag.
   - Enforces a 2-hour sliding TTL per `x-ordaris-demo-session` (CSPRNG `crypto.getRandomValues` minimum 16-char high-entropy token, failing closed when unavailable and rejecting static/ephemeral fallback strings), returns only prefix-redacted masked previews (`••••••••9xQp` / `•••••••• (server env)`), and never writes raw keys to disk or logs (`Threat T-08`).
2. **Checkpoint 2 — 28-Permission RBAC Policy Matrix (`src/server/policies/authorization.ts`)**:
   - Fine-grained RBAC across `owner` (`28/28`), `admin` (`26/28`), `developer` (`18/28`), and `viewer` (`9/28`), plus `assertNotRemovingLastOwner()` (`409 Conflict` `LAST_OWNER_PROTECTED`).
3. **Checkpoint 3 — 3-Tier Multi-Provider AI Factory (`src/server/ai/provider-factory.ts`)**:
   - Unified resolution across `mock`, `gemini`, `chatgpt`, `claude`, `grok`, and `openrouter` using `Session BYOK -> Server .env -> Deterministic Mock` fallback and live connectivity testing (`testProviderConnection`).
4. **Checkpoint 4 — 8-Persona Multi-Tenant Seed & 3-Mode Reset (`src/server/seed.ts`)**:
   - Seeds 8 distinct personas across `Acme Cyber Defense` (`acme-owner`, `acme-admin`, `acme-dev`, `acme-viewer`) and `Beta Global Logistics` (`beta-owner`, `beta-admin`, `beta-dev`, `beta-viewer`).
   - Supports 3-choice sandbox reset (`workspace_only`, `keys_only`, `factory_reset`) and live 20-table diagnostics (`getDatabaseDiagnostics`).
5. **Checkpoints 5 & 6 — Demo Governance & Arena HTTP API (`src/server/http/demo-routes.ts`, `src/server/http/auth.ts`, `src/server/http/app.ts`)**:
   - Mounted `/api/v1/demo/byok`, `/api/v1/demo/verify-isolation` (4-point live cross-tenant & RBAC verifier), `/api/v1/demo/diagnostics`, `/api/v1/workflows/validate-dag`, `/api/v1/agents/:id/arena` (Side-by-Side 2-Engine Comparison Arena), `/api/v1/workspace/reset`, and `/api/v1/members`.
6. **Checkpoints 7–10 — 5-Tab React 19 Operator Console (`src/App.tsx`, `src/client/components/*`)**:
   - Built the dark-slate enterprise command header (8-Persona switcher, active role badge, Session BYOK Vault trigger, 3-Choice Reset popover), collapsible 5-Step Evaluator Walkthrough, and 5 specialized workspace tabs (`Agent Studio & Arena`, `Knowledge RAG & Citations`, `Workflow DAG & HITL Gates`, `Evals, FinOps & Security`, `AI Engine Matrix & Logs`) in `OrdarisRagAndByokDrawer.tsx`, `OrdarisWorkflowAndHitl.tsx`, and `OrdarisGovernanceAndTelemetry.tsx`.
7. **Checkpoints 11 & 12 — Full-Stack Integration Test Suite & Release Documentation**:
   - Expanded `tests/integration/http-api-and-worker.test.ts` to verify 8-persona RBAC, session BYOK isolation, 3-mode sandbox resets, cyclic/acyclic DAG validation, 4-point isolation probes, and `409 LAST_OWNER_PROTECTED`.

---

## 2. Test Evidence (`108/108` Passing Across `21` Suites)

### Unit & Security Suites (`74/74` Passing Across `12` Suites)
- `tests/unit/session-key-vault.test.ts` -> `9 pass, 0 fail` (In-RAM AES-256-GCM encryption with ephemeral CSPRNG master key, master key rotation, zero disk writes, 2-hour sliding TTL expiry & extension, high-entropy session token validation, session isolation, masked preview, and scope clearing)
- `tests/unit/provider-factory.test.ts` -> `6 pass, 0 fail` (3-tier key resolution: Session BYOK -> `.env` -> Deterministic Mock, TTL expiry fallback, multi-engine routing, and live connection verification)
- `tests/unit/authorization.test.ts` -> `6 pass, 0 fail` (28-permission matrix, 404 cross-tenant masking, 409 last-owner guard)
- `tests/unit/env.test.ts` -> `11 pass, 0 fail` (Env validation, `WORKER_HEARTBEAT_INTERVAL_MS < WORKER_LEASE_MS`, `DB_DRIVER`, secret redaction, production `DEMO_MODE` lockout)
- `tests/unit/health-route.test.ts` -> `4 pass, 0 fail`
- `tests/unit/mock-model-provider.test.ts` -> `6 pass, 0 fail`
- `tests/unit/gemini-provider.test.ts` -> `4 pass, 0 fail`
- `tests/unit/tool-gateway.test.ts` -> `6 pass, 0 fail`
- `tests/unit/rag-chunker.test.ts` -> `6 pass, 0 fail`
- `tests/unit/workflow-dag.test.ts` -> `6 pass, 0 fail`
- `tests/unit/eval-graders.test.ts` -> `6 pass, 0 fail`
- `tests/security/tenant-isolation.test.ts` -> `4 pass, 0 fail`

### PostgreSQL & Full-Stack HTTP Integration Suites (`34/34` Passing Across `9` Suites)
- `tests/integration/http-api-and-worker.test.ts` -> `4 pass, 0 fail` (Full `v1.0.0-demo` HTTP API, worker queue, SSE replay, 8-persona RBAC, production JWT auth lockout, in-RAM BYOK vault with static fallback rejection, tenant-isolated `/api/v1/logs` RBAC, targeted job dispatch, DAG validator, 4-point isolation verifier, and 3-mode reset)
- `tests/integration/persistence-and-tenant-fk.test.ts` -> `2 pass, 0 fail` (Restart durability & composite FK violation rejection)
- `tests/integration/flagship-e2e.test.ts` -> `4 pass, 0 fail`
- `tests/integration/tenant-schema.test.ts` -> `6 pass, 0 fail`
- `tests/integration/agent-versions.test.ts` -> `3 pass, 0 fail`
- `tests/integration/run-executor.test.ts` -> `4 pass, 0 fail` (Bounded run execution, lease heartbeat renewal, single-worker CAS guard, and targeted `processQueuedJobById` execution)
- `tests/integration/knowledge-rag.test.ts` -> `3 pass, 0 fail`
- `tests/integration/workflow-hitl-audit.test.ts` -> `4 pass, 0 fail`
- `tests/integration/eval-sse.test.ts` -> `4 pass, 0 fail`

---

## 3. What We Have Planned (`v1.1` – `v2.0` Engineering Roadmap)

While `v1.0.0-demo` completes the self-contained, zero-required-spend multi-tenant platform, the following roadmap defines the planned production evolution across four milestones:

### Milestone `v1.1` — Identity Federation, Persistent KMS Vault & API Tokens
- **OAuth 2.0 / OIDC & SAML SSO**: Replace the interactive `x-actor-id` persona switcher in production deployments (`DEMO_MODE=false`) with signed HttpOnly session cookies backed by GitHub, Google Workspace, and Okta OIDC providers while retaining the 8-persona switcher exclusively for sandbox demos.
- **Envelope-Encrypted Persistent Tenant Key Vault**: Extend the in-memory `SessionKeyVault` with an optional PostgreSQL `tenant_api_keys` table using envelope encryption (per-tenant DEKs wrapped by AWS KMS / GCP Cloud KMS or local Master Key) and scheduled key rotation.
- **Scoped Machine-to-Machine API Keys**: Allow `owner` and `admin` roles to mint prefix-tagged (`ord_live_...`) bearer tokens with per-token permission scopes and rate-limit buckets.

### Milestone `v1.2` — Native `pgvector` HNSW Indexing & Multimodal RAG Ingestion
- **`pgvector` HNSW Migration**: Add an optional migration enabling `CREATE EXTENSION IF NOT EXISTS vector` with `HNSW (embedding vector_cosine_ops)` indexes when running against external PostgreSQL 16 (`docker-compose.yml` or managed Postgres), while preserving the in-process cosine + `tsvector` hybrid scorer for zero-dependency PGlite mode.
- **Asynchronous Document Ingestion Pipeline**: Move large PDF, Markdown, and CSV parsing + embedding generation onto the `job_queue` worker with chunk-level progress events over SSE.
- **Chunk-Level ACLs & Metadata Filtering**: Support tag-based and sensitivity-tier (`public`, `internal`, `restricted`) filtering inside `knowledge_search`.

### Milestone `v1.3` — OpenTelemetry (OTLP) Observability & Outbound Event Webhooks
- **OpenTelemetry Spans & Metrics**: Emit W3C Trace Context spans across HTTP ingress -> `job_queue` enqueue -> `RuntimeWorker` claim -> `ModelProvider.generate()` -> `ToolGateway` execution, exportable to Jaeger, Grafana Tempo, or Honeycomb.
- **Signed Outbound Webhooks (`HMAC-SHA256`)**: Allow tenants to subscribe external endpoints (Slack, PagerDuty, Jira) to `approval.requested`, `run.failed`, and `eval.regression_detected` events with exponential retry delivery on the PostgreSQL job queue.
- **Token Streaming Over SSE**: Extend `ModelProvider` with `streamGenerate()` so intermediate assistant token deltas stream over `/api/v1/runs/:id/stream` alongside step lifecycle events.

### Milestone `v2.0` — Multi-Agent Delegation Graphs, Policy-as-Code & FinOps Quotas
- **Hierarchical Sub-Agent Handoffs**: Allow a workflow `agent` node or parent supervisor agent to spawn child `runs` pinned to specialized sub-agent versions with bounded depth (`MAX_DELEGATION_DEPTH = 3`) and consolidated parent-child trace trees.
- **Hard FinOps Token & Spend Budgets**: Enforce organization-level and per-agent daily/monthly token and USD cost caps inside `enqueueAgentRun`, automatically pausing runs or routing to lower-cost fallback models when thresholds are reached.
- **Sandboxed WebAssembly (Wasm) Custom Tools**: Allow `developer` and `admin` roles to upload custom TypeScript/AssemblyScript tools compiled to `.wasm` and executed inside a memory- and CPU-bounded Wasm sandbox with zero host network or filesystem access.
