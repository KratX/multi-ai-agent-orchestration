# ADR-003: PostgreSQL-Backed Job Queue with Row Leases (`PLAN-004`)

- **Status:** Accepted
- **Date:** 2026-10-25
- **Ticket:** `PLAN-004`

---

## 1. Context

When a user starts an agent run (`POST /api/v1/agents/:agentId/runs`) or uploads a document for chunking and indexing (`POST /api/v1/documents`), the work involves multiple asynchronous steps:
- Calling a model provider (or deterministic mock scenario) across up to `8` iterations.
- Validating and executing up to `6` tool calls.
- Pausing for human approval gates (`waiting_approval`).
- Parsing, chunking, and indexing uploaded documents.

Running these loops directly inside an HTTP route handler is brittle: browser disconnects, serverless request timeouts, or process restarts lose in-flight work and leave runs in an unknown state. However, introducing Redis + BullMQ, RabbitMQ, Kafka, or Temporal Cloud adds external infrastructure dependencies and introduces the **dual-write problem** (writing the `runs` row to PostgreSQL and publishing the job to an external broker without a distributed transaction).

---

## 2. Decision

We implement a **PostgreSQL-Backed Job Queue (`jobs` table)** claimed by a separate Node.js worker process using **row-level locking (`FOR UPDATE SKIP LOCKED`) and time-bounded leases**:

1. **Atomic Enqueue Transaction**:
   - The HTTP route handler inserts the `runs` record, the `jobs` record (`status = 'queued'`, `available_at = now()`), and the initial `run_events` record (`sequence = 1`, `event_type = 'run.queued'`) inside **one PostgreSQL ACID transaction**.
2. **Non-Blocking Worker Claim (`FOR UPDATE SKIP LOCKED`)**:
   - Workers claim eligible jobs using a short transaction:
     ```sql
     UPDATE jobs
     SET status = 'running',
         attempt = attempt + 1,
         locked_at = now(),
         locked_by = $1,
         lease_expires_at = now() + ($2 || ' milliseconds')::interval,
         updated_at = now()
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'queued' AND available_at <= now()
       ORDER BY available_at ASC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *;
     ```
   - Critically, the claim transaction **commits immediately** before any slow model or tool execution begins.
3. **Lease Heartbeats & Ownership Verification**:
   - While executing a job, the worker periodically renews `lease_expires_at` using a conditional update (`WHERE id = $1 AND locked_by = $2 AND status = 'running'`).
   - If a lease renewal returns `0` rows (meaning the lease expired and was reclaimed), the worker aborts further steps via an `AbortController`.
4. **Expired-Lease Recovery & Bounded Retries**:
   - A recovery sweep inspects `status = 'running' AND lease_expires_at < now()`.
   - If `attempt < max_attempts`, the job transitions back to `status = 'queued'` with exponential backoff on `available_at`.
   - If `attempt >= max_attempts`, the job transitions to `status = 'dead'` and the associated run transitions to `status = 'failed'` with an explicit `MAX_ATTEMPTS_EXCEEDED` error code.

---

## 3. Alternatives Considered

### Alternative A: In-Process Fire-and-Forget (`void runAgentLoop()`) in Route Handler
- **Pros:** Zero queue tables or worker processes.
- **Cons:** Process restart loses all active runs; no lease recovery, no retry scheduling, and no concurrency backpressure.
- **Verdict:** Rejected.

### Alternative B: Redis / BullMQ
- **Pros:** High throughput and built-in retry primitives.
- **Cons:** Requires running and managing Redis alongside PostgreSQL; creates a dual-write gap between committing the `runs` row in Postgres and pushing the job to Redis unless a transactional outbox poller is built anyway.
- **Verdict:** Rejected for MVP.

### Alternative C: Temporal / Managed Workflow Engine
- **Pros:** Industry-standard durable execution and timers at massive scale.
- **Cons:** Heavy local operational footprint or paid cloud dependency; hides the core durability mechanics (leases, heartbeats, checkpoints, idempotency) that this portfolio project is meant to demonstrate directly.
- **Verdict:** Rejected for MVP; documented as the natural scale-up path.

---

## 4. Consequences & Explicit Limitations

### Positive
- **Zero Dual-Write Gap**: If a `runs` row exists in `queued` state, its `jobs` row is guaranteed by PostgreSQL ACID semantics to exist.
- **Crash Resilience**: If a worker process crashes (`SIGKILL`), its lease expires and another worker safely recovers or dead-letters the job.
- **Clear Interview Demonstration**: Every queue invariant (`claimNextJob`, `renewLease`, `reclaimExpiredLeases`) is explicit, readable SQL tested with concurrency and crash tests.

### Explicit Limitations (Honest Scope Disclosure)
- **Not a High-Throughput Message Broker**: Polling PostgreSQL with `FOR UPDATE SKIP LOCKED` is designed for `1–10` worker processes and tens of jobs per second, not tens of thousands of messages per second.
- **At-Least-Once Step Semantics on Hard Crash**: Because leases expire after a crash, a step that triggered an external side effect right before process termination may run again upon recovery. All tools and steps must therefore use idempotency keys or be side-effect-safe.

