# ADR-001: Local-First and Free-Tier Portfolio Constraints (`PLAN-004`)

- **Status:** Accepted
- **Date:** 2026-10-25
- **Ticket:** `PLAN-004`

---

## 1. Context

We are building **Aegis Runtime**, a portfolio-grade AI Agent Platform designed to demonstrate senior full-stack and AI systems engineering (multi-tenant isolation, immutable versioning, server-authorized tool execution, durable background job queues, RAG with source citations, and visual workflow validation).

Many AI portfolio projects depend on:
- Paid LLM API keys (OpenAI, Anthropic, or Gemini paid tiers) for basic execution.
- Paid or credit-card-gated managed services (Redis Cloud, Temporal Cloud, Pinecone, AWS S3, Datadog).
- Hosted database free tiers that sleep after inactivity, expire after 30–90 days, or fail when a recruiter clones or visits the project months later.

If a hiring manager or engineer clones the repository—or explores the demo—and hits an expired API key, a sleeping database error, or a required cloud credit card setup, the portfolio demonstration fails immediately.

---

## 2. Decision

We adopt a strict **Zero-Required-Spend, Local-First Architecture**:

1. **Deterministic Mock AI by Default (`AI_MODE=demo`)**:
   - The application boots, runs its full test suite, and executes end-to-end multi-step agent and workflow runs using a deterministic `MockModelProvider` with zero network calls and zero API keys required.
   - Real LLM providers (`AI_MODE=provider`) are implemented strictly as optional server-side adapters behind the `ModelProvider` interface.
2. **PostgreSQL as the Single Infrastructure Dependency**:
   - We use PostgreSQL (via local `docker-compose.yml` or embedded `PGlite` for instant zero-daemon local execution and tests) for relational data, transactional job queuing (`FOR UPDATE SKIP LOCKED`), append-only event replay (`run_events`), and full-text document search (`tsvector`).
   - We do **not** require Redis, Kafka, Temporal, or a commercial vector database for the MVP.
3. **Local Opaque File Storage in Development**:
   - Uploaded knowledge documents are stored on the local filesystem under `.local/uploads/` using opaque UUID keys (`<orgId>/<uuid>.bin`), avoiding mandatory AWS S3 / cloud object storage accounts.
4. **Honest Labeling of Simulated vs. Live Telemetry**:
   - Every run and usage record stores `source: 'mock' | 'provider' | 'local'`. Mock token counts and costs are explicitly labeled as simulated in the UI and API responses.

---

## 3. Alternatives Considered

### Alternative A: Require an External LLM API Key for All Runs
- **Pros:** Slightly less code than maintaining deterministic mock scenarios.
- **Cons:** Breaks CI without secret injection, costs money on every test run, makes tests non-deterministic, and prevents recruiters from running the repo locally without spending their own API credits.
- **Verdict:** Rejected.

### Alternative B: Use Redis / BullMQ + Pinecone + S3 Free Tiers
- **Pros:** Familiar distributed-systems stack.
- **Cons:** Requires 3+ external cloud accounts just to boot locally; free tiers frequently expire or pause; introduces dual-write consistency gaps between PostgreSQL and Redis unless an outbox pattern is added.
- **Verdict:** Rejected for MVP.

---

## 4. Consequences & Trade-Offs

### Positive
- **100% Reproducible Clean Clone**: Anyone can clone the repo and run tests and demo flows immediately with zero cloud accounts or API keys.
- **Deterministic CI & Fault Testing**: `MockModelProvider` allows deterministic tests for tool rejection, malformed arguments, transient retry recovery, and citation verification.
- **Transactional Simplicity**: Enqueuing a job and creating a run happen in a single PostgreSQL ACID transaction.

### Negative / Limitations
- **Bounded Queue Throughput**: A PostgreSQL table queue with `FOR UPDATE SKIP LOCKED` is ideal for portfolio and modest production workloads (`1–10` workers), not tens of thousands of jobs per second.
- **Lexical vs. Semantic Search Baseline**: PostgreSQL `tsvector` full-text search matches keywords and stems rather than dense vector embeddings unless an optional embedding adapter is enabled.

---

## 5. Revisit Criteria

We will revisit this ADR only after the MVP passes all Phase 1–13 gates if:
1. Measured queue contention in PostgreSQL exceeds acceptable latency under target load.
2. A specific evaluation dataset demonstrates that `tsvector` full-text retrieval is insufficient and requires `pgvector` embeddings.

