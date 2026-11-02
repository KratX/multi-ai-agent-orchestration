import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as tenantSchema from './schema/tenant';
import { MIGRATION_0001_TENANT_SQL } from './schema/tenant';
import * as agentsSchema from './schema/agents';
import { MIGRATION_0002_AGENTS_SQL } from './schema/agents';
import * as runsSchema from './schema/runs';
import { MIGRATION_0003_RUNS_SQL } from './schema/runs';
import * as knowledgeSchema from './schema/knowledge';
import { MIGRATION_0004_KNOWLEDGE_SQL } from './schema/knowledge';
import * as workflowsSchema from './schema/workflows';
import { MIGRATION_0005_WORKFLOWS_SQL } from './schema/workflows';
import * as evalsSchema from './schema/evals';
import { MIGRATION_0006_EVALS_SQL } from './schema/evals';
import type { DatabaseReadinessCheck } from '../../app/api/v1/health/route';
import { parseEnv } from '../config/env';

/**
 * Ticket REPO-005, AGENT-001, RUN-001, RAG-001, WORKFLOW-001 & EVAL-001:
 * Dual-Adapter Drizzle ORM Database Client (External PostgreSQL `pg.Pool` + Local `PGlite`) & Migration Runner
 *
 * Combines all domain schemas (`tenantSchema` + `agentsSchema` + `runsSchema` +
 * `knowledgeSchema` + `workflowsSchema` + `evalsSchema`) and applies sequential
 * versioned SQL migrations (`0001`..`0006`) idempotently on both external PostgreSQL 16+
 * (`drizzle-orm/node-postgres`) and embedded PGlite (`drizzle-orm/pglite`).
 */

export const ordarisSchema = {
  ...tenantSchema,
  ...agentsSchema,
  ...runsSchema,
  ...knowledgeSchema,
  ...workflowsSchema,
  ...evalsSchema,
};

export type OrdarisDatabase = PgliteDatabase<typeof ordarisSchema>;

export interface RawSqlClient {
  query: <TRow = Record<string, unknown>>(
    sqlText: string,
    params?: unknown[]
  ) => Promise<{ rows: TRow[] }>;
  exec: (sqlText: string) => Promise<unknown>;
  close: () => Promise<void>;
  closed?: boolean;
}

export interface DatabaseContext {
  pg: RawSqlClient;
  pool?: pg.Pool;
  db: OrdarisDatabase;
  engine: 'postgres' | 'pglite';
  storageMode: 'file' | 'memory';
  dataDir?: string;
  close: () => Promise<void>;
}

/**
 * Applies all sequential SQL migrations (0001 Tenant + 0002 Agents + 0003 Runs/Queue +
 * 0004 Knowledge + 0005 Workflows/HITL/Audit/Usage + 0006 Evals) to the given SQL executor.
 * Safe to call multiple times because statements use `IF NOT EXISTS`.
 */
export async function applyTenantMigrations(
  pgClient: Pick<RawSqlClient, 'exec'>
): Promise<void> {
  await pgClient.exec(MIGRATION_0001_TENANT_SQL);
  await pgClient.exec(MIGRATION_0002_AGENTS_SQL);
  await pgClient.exec(MIGRATION_0003_RUNS_SQL);
  await pgClient.exec(MIGRATION_0004_KNOWLEDGE_SQL);
  await pgClient.exec(MIGRATION_0005_WORKFLOWS_SQL);
  await pgClient.exec(MIGRATION_0006_EVALS_SQL);
}

/**
 * Creates a migrated PostgreSQL + Drizzle database context.
 * Supports:
 * 1. External PostgreSQL (`driver: 'postgres'` or `databaseUrl` with `DB_DRIVER='postgres'`) via `pg.Pool` + `drizzle-orm/node-postgres`.
 * 2. Embedded PGlite (`driver: 'pglite'` or default local/test mode) via `@electric-sql/pglite` + `drizzle-orm/pglite`.
 */
export async function createDatabaseClient(options?: {
  dataDir?: string;
  databaseUrl?: string;
  driver?: 'auto' | 'postgres' | 'pglite';
  autoMigrate?: boolean;
}): Promise<DatabaseContext> {
  const rawDir = options?.dataDir?.trim();
  const explicitDriver = options?.driver;
  const explicitDatabaseUrl = options?.databaseUrl?.trim();

  const shouldUseExternalPostgres =
    explicitDriver === 'postgres' ||
    Boolean(explicitDatabaseUrl && explicitDriver !== 'pglite' && rawDir !== 'memory://');

  if (shouldUseExternalPostgres) {
    const connectionString =
      explicitDatabaseUrl ||
      process.env.DATABASE_URL ||
      'postgresql://ordaris:ordaris@localhost:5432/ordaris_runtime';

    const pool = new pg.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    let poolClosed = false;
    const rawAdapter: RawSqlClient = {
      async query<TRow = Record<string, unknown>>(
        sqlText: string,
        params?: unknown[]
      ): Promise<{ rows: TRow[] }> {
        const res = await pool.query(sqlText, params);
        return { rows: (res.rows ?? []) as TRow[] };
      },
      async exec(sqlText: string) {
        return pool.query(sqlText);
      },
      async close() {
        if (!poolClosed) {
          poolClosed = true;
          await pool.end();
        }
      },
      get closed() {
        return poolClosed;
      },
    };

    if (options?.autoMigrate !== false) {
      await applyTenantMigrations(rawAdapter);
    }

    const db = drizzleNodePg(pool, {
      schema: ordarisSchema,
    }) as unknown as OrdarisDatabase;

    return {
      pg: rawAdapter,
      pool,
      db,
      engine: 'postgres',
      storageMode: 'file',
      close: async () => {
        await rawAdapter.close();
      },
    };
  }

  const isFileBacked = Boolean(rawDir && rawDir !== 'memory://');
  let resolvedDir: string | undefined;

  if (isFileBacked && rawDir) {
    resolvedDir = path.resolve(rawDir);
    fs.mkdirSync(resolvedDir, { recursive: true });
    // Remove stale Emscripten postmaster.pid lock left behind by abrupt container stop/snapshot
    try {
      const pidFile = path.join(resolvedDir, 'postmaster.pid');
      if (fs.existsSync(pidFile)) {
        fs.rmSync(pidFile, { force: true });
      }
    } catch {
      // Ignore lock cleanup errors
    }
  }

  let pglite: PGlite;
  let effectiveStorageMode: 'file' | 'memory' = isFileBacked ? 'file' : 'memory';

  const lowMemStartParams = [
    ...PGlite.defaultStartParams,
    '-c',
    'shared_buffers=2MB',
    '-c',
    'work_mem=1MB',
    '-c',
    'maintenance_work_mem=2MB',
    '-c',
    'temp_buffers=1MB',
    '-c',
    'wal_buffers=256kB',
  ];

  const initPgliteInstance = async (dir?: string): Promise<PGlite> => {
    const hasExistingMigratedDb = Boolean(
      dir &&
        fs.existsSync(path.join(dir, 'PG_VERSION')) &&
        fs.existsSync(path.join(dir, '.ordaris-migrated-v1'))
    );
    const instance = new PGlite(dir, {
      relaxedDurability: true,
      startParams: lowMemStartParams,
    });
    await instance.waitReady;
    if (options?.autoMigrate !== false && !hasExistingMigratedDb) {
      await applyTenantMigrations(instance);
      if (dir) {
        try {
          fs.writeFileSync(path.join(dir, '.ordaris-migrated-v1'), 'ok\n', 'utf8');
        } catch {
          // Ignore marker write error on read-only FS
        }
      }
    }
    return instance;
  };

  try {
    pglite = await initPgliteInstance(resolvedDir);
  } catch {
    if (resolvedDir) {
      try {
        // Recover from corrupted WASM WAL/data directory after an unclean process kill
        fs.rmSync(resolvedDir, { recursive: true, force: true });
        fs.mkdirSync(resolvedDir, { recursive: true });
        pglite = await initPgliteInstance(resolvedDir);
      } catch {
        // Final fallback to in-memory PGlite so server startup never fails
        effectiveStorageMode = 'memory';
        resolvedDir = undefined;
        pglite = await initPgliteInstance(undefined);
      }
    } else {
      throw new Error('Failed to initialize in-memory PGlite database');
    }
  }

  const db = drizzlePglite(pglite, { schema: ordarisSchema });

  return {
    pg: pglite as unknown as RawSqlClient,
    db,
    engine: 'pglite',
    storageMode: effectiveStorageMode,
    dataDir: resolvedDir,
    close: async () => {
      if (!pglite.closed) {
        await pglite.close();
      }
    },
  };
}

let sharedContextPromise: Promise<DatabaseContext> | null = null;

/**
 * Returns a process-wide singleton PostgreSQL + Drizzle context for runtime routes and workers.
 * - Connects to external PostgreSQL (`DATABASE_URL`) when `DB_DRIVER="postgres"` (or when `DB_DRIVER="auto"` and an external PostgreSQL instance is configured and reachable outside test mode).
 * - Uses file-backed PGlite persistence (`PGLITE_DATA_DIR`, default `.local/ordaris-db`) in local zero-dependency mode, or in-memory storage when `PGLITE_DATA_DIR="memory://"` or `NODE_ENV="test"`.
 */
export function getSharedDatabase(options?: {
  dataDir?: string;
  databaseUrl?: string;
  driver?: 'auto' | 'postgres' | 'pglite';
}): Promise<DatabaseContext> {
  if (!sharedContextPromise) {
    sharedContextPromise = (async () => {
      let targetDir = options?.dataDir;
      let targetDriver = options?.driver;
      let targetDatabaseUrl = options?.databaseUrl;

      try {
        const env = parseEnv(process.env);
        const isTestRunner =
          env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);

        if (!targetDriver) {
          targetDriver = env.DB_DRIVER;
        }
        if (!targetDatabaseUrl && env.DB_DRIVER === 'postgres') {
          targetDatabaseUrl = env.DATABASE_URL;
        }
        if (targetDir === undefined) {
          targetDir =
            isTestRunner && !process.env.PGLITE_DATA_DIR
              ? 'memory://'
              : env.PGLITE_DATA_DIR;
        }

        if (targetDriver === 'postgres' && targetDir !== 'memory://') {
          return createDatabaseClient({
            driver: 'postgres',
            databaseUrl: targetDatabaseUrl ?? env.DATABASE_URL,
            autoMigrate: true,
          });
        }

        // When DB_DRIVER="auto" outside test mode and a non-default DATABASE_URL is explicitly provided in process.env, probe external Postgres first
        const hasExplicitExternalUrl =
          targetDriver === 'auto' &&
          !isTestRunner &&
          targetDir !== 'memory://' &&
          Boolean(process.env.DATABASE_URL?.trim());

        if (hasExplicitExternalUrl) {
          try {
            return await createDatabaseClient({
              driver: 'postgres',
              databaseUrl: process.env.DATABASE_URL!.trim(),
              autoMigrate: true,
            });
          } catch {
            // Fall back to embedded PGlite when external Postgres is not running locally
          }
        }
      } catch {
        if (targetDir === undefined) {
          targetDir = '.local/ordaris-db';
        }
      }

      return createDatabaseClient({
        driver: 'pglite',
        dataDir: targetDir,
        autoMigrate: true,
      });
    })();
  }
  return sharedContextPromise;
}

/**
 * Allows the application server or integration tests to inject or reset the shared database context.
 */
export function setSharedDatabaseForRuntime(context: DatabaseContext | null): void {
  sharedContextPromise = context ? Promise.resolve(context) : null;
}

export async function closeSharedDatabase(): Promise<void> {
  if (sharedContextPromise) {
    const ctx = await sharedContextPromise;
    sharedContextPromise = null;
    await ctx.close();
  }
}

/**
 * Adapts a `DatabaseContext` into the `DatabaseReadinessCheck` interface expected by
 * `GET /api/v1/health` and `GET /api/v1/health/ready`.
 */
export function createDrizzleReadinessProbe(
  contextProvider: () => Promise<DatabaseContext> = getSharedDatabase
): DatabaseReadinessCheck {
  return {
    async ping() {
      const start = performance.now();
      try {
        const { pg: sqlClient } = await contextProvider();
        await sqlClient.query('SELECT 1 AS ok;');
        const latencyMs = Math.max(0, Math.round(performance.now() - start));
        return {
          reachable: true,
          latencyMs,
        };
      } catch (err) {
        const latencyMs = Math.max(0, Math.round(performance.now() - start));
        const message =
          err instanceof Error ? err.message : 'Database readiness query failed';
        return {
          reachable: false,
          latencyMs,
          error: message,
        };
      }
    },
  };
}
