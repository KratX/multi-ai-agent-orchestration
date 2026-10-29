import { fileURLToPath } from 'node:url';
import { parseEnv } from '../config/env';
import { createModelProvider, type ModelProvider } from '../ai/model-provider';
import {
  closeSharedDatabase,
  getSharedDatabase,
  type AegisDatabase,
} from '../db/client';
import {
  processNextQueuedJob,
  recoverExpiredJobLeases,
} from '../modules/runs/run-executor';
import type { JobQueueRow, RunRow } from '../db/schema/runs';

/**
 * Phase D: Background Queue Worker Process (`src/server/worker/main.ts`)
 *
 * Responsibilities:
 * 1. Validates environment guardrails on startup via `parseEnv()`.
 * 2. Periodically recovers expired worker leases (`recoverExpiredJobLeases`) so crashed
 *    workers never leave runs stranded in `'locked'` state (`ADR-003`).
 * 3. Polls and claims pending jobs from PostgreSQL `job_queue` using `FOR UPDATE SKIP LOCKED`
 *    with bounded concurrency (`WORKER_CONCURRENCY`) and lease duration (`WORKER_LEASE_MS`).
 * 4. Handles `SIGINT` and `SIGTERM` signals for graceful in-flight job completion.
 */

export interface RuntimeWorkerOptions {
  db: AegisDatabase;
  workerId?: string;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  concurrency?: number;
  maxStepsCeiling?: number;
  maxToolCallsCeiling?: number;
  runTimeoutMs?: number;
  modelProvider?: ModelProvider;
}

export class RuntimeWorker {
  public readonly workerId: string;
  private readonly db: AegisDatabase;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly concurrency: number;
  private readonly maxStepsCeiling: number;
  private readonly maxToolCallsCeiling: number;
  private readonly runTimeoutMs: number;
  private readonly modelProvider: ModelProvider;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeTasks = new Set<Promise<void>>();
  private processedCount = 0;

  constructor(options: RuntimeWorkerOptions) {
    const env = parseEnv(process.env);
    this.db = options.db;
    this.workerId = options.workerId ?? `worker-${process.pid}`;
    this.pollIntervalMs = options.pollIntervalMs ?? env.WORKER_POLL_INTERVAL_MS;
    this.leaseDurationMs = options.leaseDurationMs ?? env.WORKER_LEASE_MS;
    this.concurrency = options.concurrency ?? env.WORKER_CONCURRENCY;
    this.maxStepsCeiling = options.maxStepsCeiling ?? env.RUN_MAX_STEPS;
    this.maxToolCallsCeiling = options.maxToolCallsCeiling ?? env.RUN_MAX_TOOL_CALLS;
    this.runTimeoutMs = options.runTimeoutMs ?? env.RUN_TIMEOUT_SECONDS * 1000;
    this.modelProvider = options.modelProvider ?? createModelProvider(env);
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getProcessedCount(): number {
    return this.processedCount;
  }

  /**
   * Recovers expired leases and claims/executes one pending job if available.
   */
  public async tickOnce(): Promise<{ job: JobQueueRow; run: RunRow } | null> {
    await recoverExpiredJobLeases(this.db);

    const outcome = await processNextQueuedJob(this.db, {
      workerId: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
      modelProvider: this.modelProvider,
      maxStepsCeiling: this.maxStepsCeiling,
      maxToolCallsCeiling: this.maxToolCallsCeiling,
      timeoutMs: this.runTimeoutMs,
    });

    if (outcome) {
      this.processedCount += 1;
    }

    return outcome;
  }

  /**
   * Drains all currently pending jobs up to `maxJobs` in sequence.
   */
  public async drainPendingJobs(maxJobs = 10): Promise<Array<{ job: JobQueueRow; run: RunRow }>> {
    const results: Array<{ job: JobQueueRow; run: RunRow }> = [];
    for (let i = 0; i < maxJobs; i++) {
      const next = await this.tickOnce();
      if (!next) {
        break;
      }
      results.push(next);
    }
    return results;
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleNextPoll(10);
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.activeTasks.size > 0) {
      await Promise.allSettled(Array.from(this.activeTasks));
    }
  }

  private scheduleNextPoll(delayMs = this.pollIntervalMs): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(async () => {
      await this.pollCycle();
      this.scheduleNextPoll(this.pollIntervalMs);
    }, delayMs);
  }

  private async pollCycle(): Promise<void> {
    if (!this.running) {
      return;
    }

    try {
      await recoverExpiredJobLeases(this.db);

      const availableSlots = Math.max(0, this.concurrency - this.activeTasks.size);
      for (let i = 0; i < availableSlots; i++) {
        const taskPromise = (async () => {
          try {
            await this.tickOnce();
          } catch {
            // Individual job errors are persisted on runs/job_queue
          }
        })();

        this.activeTasks.add(taskPromise);
        void taskPromise.finally(() => {
          this.activeTasks.delete(taskPromise);
        });
      }
    } catch {
      // Ignore transient poll errors while shutting down
    }
  }
}

export async function runStandaloneWorkerCli(): Promise<void> {
  const env = parseEnv(process.env);
  const ctx = await getSharedDatabase({ dataDir: env.PGLITE_DATA_DIR });
  const worker = new RuntimeWorker({ db: ctx.db });

  const shutdown = async () => {
    await worker.stop();
    await closeSharedDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  worker.start();
  process.stdout.write(
    JSON.stringify({
      status: 'worker_started',
      workerId: worker.workerId,
      aiMode: env.AI_MODE,
      storageMode: ctx.storageMode,
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
      concurrency: env.WORKER_CONCURRENCY,
    }) + '\n'
  );
}

const isDirectExecution =
  process.argv[1] &&
  fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^file:\/\//, ''));

if (isDirectExecution) {
  runStandaloneWorkerCli().catch((error) => {
    process.stderr.write(
      `Worker startup failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
}
