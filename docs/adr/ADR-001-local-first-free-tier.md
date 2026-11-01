# ADR-001: Local-First, Zero-Required-Spend & 3-Tier BYOK AI Resolution (`PLAN-004`)

- **Status:** Accepted & Implemented (`v1.0.0-demo`)
- **Date:** 2026-10-31
- **Ticket:** `PLAN-004`

---

## 1. Context

We are building **Ordaris Runtime (`v1.0.0-demo`)**, an enterprise-grade multi-tenant AI Agent, Hybrid RAG, Workflow DAG, HITL Governance & FinOps Platform designed to demonstrate senior full-stack and AI systems engineering (multi-tenant isolation, immutable versioning, server-authorized tool execution, durable background job queues, RAG with verified source citations, and visual workflow validation).

Many AI portfolio projects depend on:
- Paid LLM API keys (OpenAI, Anthropic, or Gemini paid tiers) just to boot or run tests.
- Paid or credit-card-gated managed services (Redis Cloud, Temporal Cloud, Pinecone, AWS S3, Datadog).
- Hosted database free tiers that sleep after inactivity, expire after 30–90 days, or fail when an evaluator clones or visits the project months later.

At the same time, evaluators who *do* have a free-tier cloud API key (`Gemini`, `ChatGPT`, `Claude`, `Grok`, or `OpenRouter`) want to test real live LLM inference side-by-side with the deterministic engine without modifying code or committing secrets.

---

## 2. Decision

We adopt a strict **Zero-Required-Spend, Local-First Architecture with 3-Tier AI Key Resolution**:

1. **3-Tier AI Key Resolution Hierarchy (`src/server/ai/provider-factory.ts`)**:
   - **Tier 1 — Session-Scoped AES-256-GCM BYOK Vault (`src/server/security/session-key-vault.ts`)**: Visitors can enter free-tier keys (`gemini`, `chatgpt`, `claude`, `grok`, `openrouter`) in the UI's Session BYOK Drawer. Keys are encrypted in server RAM using `aes-256-gcm` under an ephemeral 256-bit CSPRNG master key scoped to `x-ordaris-demo-session` with a 2-hour sliding TTL.
   - **Tier 2 — Server `.env` Fallback**: Optional server-side environment variables (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`).
   - **Tier 3 — Deterministic Simulation Engine (`MockModelProvider`, `AI_MODE=demo` default)**: The application boots, runs its full 104-test suite, and executes end-to-end multi-step agent, RAG, and workflow runs with **zero network calls and zero API keys required**.
2. **PostgreSQL as the Single Infrastructure Dependency**:
   - We use PostgreSQL (via embedded file-backed `PGlite` in `.local/ordaris-db` for instant zero-daemon local execution, or `docker-compose.yml` for external Postgres 16) for all 20 relational tables, transactional job queuing (`FOR UPDATE SKIP LOCKED`), append-only event replay (`run_events`), and hybrid `tsvector` + 64-D cosine vector RAG.
3. **Local Opaque File Storage in Development**:
   - Uploaded knowledge documents are stored under `.local/uploads/` using opaque UUID keys (`<orgId>/<uuid>.bin`), avoiding mandatory cloud object storage accounts.
4. **Honest FinOps Labeling of Simulated vs. Live Telemetry**:
   - Every `usage_events` row explicitly records `provider` and `is_estimated` (`true` for deterministic simulation, `false` for live cloud API calls).

---

## 3. Alternatives Considered

### Alternative A: Require an External LLM API Key for All Runs
- **Pros:** Slightly less code than maintaining deterministic mock scenarios.
- **Cons:** Breaks CI without secret injection, costs money on every test run, makes tests non-deterministic, and prevents evaluators from running the repo locally with zero setup.
- **Verdict:** Rejected.

### Alternative B: Store Visitor BYOK Keys in Browser `localStorage` and Call LLMs from the Client
- **Pros:** No server key vault needed.
- **Cons:** Exposes raw API keys to XSS, bypasses server-enforced tool gateways and citation verification, and violates server-authoritative execution boundaries.
- **Verdict:** Rejected in favor of the server-side AES-256-GCM Session BYOK Vault (`Threat T-08`).

---

## 4. Consequences & Planned Evolution (`v1.1+`)

- **100% Reproducible Clean Clone**: Anyone can clone the repo and run `pnpm test` and `pnpm dev` immediately with zero cloud accounts or API keys, or optionally test live cloud models via the Session BYOK Drawer.
- **Planned `v1.1` KMS Extension**: Add optional KMS envelope encryption (`AWS KMS` / `GCP Cloud KMS`) for persistent organization-level keys in production (`DEMO_MODE=false`), and optional `pgvector` HNSW indexes (`v1.2`) when running on external PostgreSQL 16.
