# ADR-003: PostgreSQL-Backed Job Queue with Row Leases (`PLAN-004`)

- **Status:** Accepted & Implemented (`v1.0.0-demo`)
- **Date:** 2026-10-31
- **Ticket:** `PLAN-004`, `QUEUE-001`, `QUEUE-002`

---

## 1. Context

When an operator in **Ordaris Runtime (`v1.0.0-demo`)** starts an agent run (`POST /api/v1/agents/:agentId/runs`), launches a 2-engine Arena comparison (`POST /api/v1/agents/:agentId/arena`), or triggers a gated workflow DAG (`POST /api/v1/workflows/:workflowId/runs`), execution spans multiple bounded steps:
- Calling a cloud or deterministic model provider across up to `8` iterations.
- Validating and executing up to `6` tool calls (`calculator`, `knowledge_search`).
- Pausing at Human-in-the-Loop (`approval`) gates (`waiting_approval`) until an `owner` or `admin` submits a decision.

Introducing Redis + BullMQ, RabbitMQ, or Temporal Cloud adds mandatory external infrastructure dependencies and introduces the **dual-write problem** (writing the `runs` row to PostgreSQL and publishing the job to an external broker without a distributed transaction).

---

## 2. Decision

We implement a **PostgreSQL-Backed Job Queue (`job_queue` table)** claimed by `RuntimeWorker` (`src/server/worker/main.ts`) using **row-level locking (`FOR UPDATE SKIP LOCKED`) and time-bounded leases**:

1. **Atomic Enqueue Transaction (`enqueueAgentRun`)**:
   - Inserts the `runs` record, the `job_queue` row (`status = 'pending'`), and sequence `1` (`run.queued`) in `run_events` inside **one PostgreSQL ACID transaction**, with composite `(organization_id, run_id)` foreign keys.
2. **Non-Blocking Worker Claim (`FOR UPDATE SKIP LOCKED`)**:
   - Workers claim due jobs in a short transaction, setting `status = 'claimed'`, `locked_by = workerId`, and `lease_expires_at = now() + leaseDurationMs`, and commit immediately before invoking any model or tool call.
3. **Expired-Lease Recovery & Bounded Retries (`recoverExpiredJobLeases`)**:
   - Sweeps `status = 'claimed' AND lease_expires_at <= now()`.
   - If `attempts < max_attempts`, transitions the job back to `status = 'pending'` for retry; otherwise marks the job and run as `failed`.
4. **Graceful Shutdown (`SIGINT` / `SIGTERM`)**:
   - `RuntimeWorker` stops polling on termination signals and awaits in-flight step completion before closing database handles.

---

## 3. Consequences & Planned Evolution (`v1.2` – `v2.0`)

- **Zero Dual-Write Gap**: If a `runs` row is queued, its `job_queue` row and initial `run.queued` event are guaranteed by PostgreSQL ACID semantics to exist.
- **Planned `v1.2` – `v2.0` Evolution**:
  - **`v1.2`**: Offload asynchronous multimodal PDF/CSV chunking and embedding generation onto `job_queue`.
  - **`v1.3`**: Enqueue signed outbound webhook deliveries (`HMAC-SHA256`) with exponential retry backoff in `job_queue`.
  - **`v2.0`**: Support parent-to-child sub-agent delegation jobs with bounded depth (`MAX_DELEGATION_DEPTH = 3`).
