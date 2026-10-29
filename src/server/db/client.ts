import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
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
 * Drizzle ORM Database Client, File-Backed Persistence & Migration Runner
 *
 * Combines all domain schemas (`tenantSchema` + `agentsSchema` + `runsSchema` +
 * `knowledgeSchema` + `workflowsSchema` + `evalsSchema`) and applies sequential
 * versioned SQL migrations (`0001`..`0006`) idempotently.
 */

export const aegisSchema = {
  ...tenantSchema,
  ...agentsSchema,
  ...runsSchema,
  ...knowledgeSchema,
  ...workflowsSchema,
  ...evalsSchema,
};

export type AegisDatabase = PgliteDatabase<typeof aegisSchema>;

export interface DatabaseContext {
  pg: PGlite;
  db: AegisDatabase;
  storageMode: 'file' | 'memory';
  dataDir?: string;
  close: () => Promise<void>;
}

/**
 * Applies all sequential SQL migrations (0001 Tenant + 0002 Agents + 0003 Runs/Queue +
 * 0004 Knowledge + 0005 Workflows/HITL/Audit/Usage + 0006 Evals) to the given PGlite instance.
 * Safe to call multiple times because statements use `IF NOT EXISTS`.
 */
export async function applyTenantMigrations(pg: PGlite): Promise<void> {
  await pg.exec(MIGRATION_0001_TENANT_SQL);
  await pg.exec(MIGRATION_0002_AGENTS_SQL);
  await pg.exec(MIGRATION_0003_RUNS_SQL);
  await pg.exec(MIGRATION_0004_KNOWLEDGE_SQL);
  await pg.exec(MIGRATION_0005_WORKFLOWS_SQL);
  await pg.exec(MIGRATION_0006_EVALS_SQL);
}

/**
 * Creates a migrated PostgreSQL + Drizzle database context.
 * When `options.dataDir` is provided (and not `'memory://'`), persists PostgreSQL data on disk.
 */
export async function createDatabaseClient(options?: {
  dataDir?: string;
  autoMigrate?: boolean;
}): Promise<DatabaseContext> {
  const rawDir = options?.dataDir?.trim();
  const isFileBacked = Boolean(rawDir && rawDir !== 'memory://');
  let resolvedDir: string | undefined;

  if (isFileBacked && rawDir) {
    resolvedDir = path.resolve(rawDir);
    fs.mkdirSync(resolvedDir, { recursive: true });
  }

  const pg = new PGlite(resolvedDir);
  await pg.waitReady;

  if (options?.autoMigrate !== false) {
    await applyTenantMigrations(pg);
  }

  const db = drizzle(pg, { schema: aegisSchema });

  return {
    pg,
    db,
    storageMode: isFileBacked ? 'file' : 'memory',
    dataDir: resolvedDir,
    close: async () => {
      if (!pg.closed) {
        await pg.close();
      }
    },
  };
}

let sharedContextPromise: Promise<DatabaseContext> | null = null;

/**
 * Returns a process-wide singleton PostgreSQL + Drizzle context for runtime routes and workers.
 * Uses file-backed persistence (`PGLITE_DATA_DIR`, default `.local/aegis-db`) in development/production,
 * or in-memory storage when `PGLITE_DATA_DIR="memory://"` or `NODE_ENV="test"`.
 */
export function getSharedDatabase(options?: { dataDir?: string }): Promise<DatabaseContext> {
  if (!sharedContextPromise) {
    let targetDir = options?.dataDir;
    if (targetDir === undefined) {
      try {
        const env = parseEnv(process.env);
        const isTestRunner =
          env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
        targetDir =
          isTestRunner && !process.env.PGLITE_DATA_DIR
            ? 'memory://'
            : env.PGLITE_DATA_DIR;
      } catch {
        targetDir = '.local/aegis-db';
      }
    }
    sharedContextPromise = createDatabaseClient({
      dataDir: targetDir,
      autoMigrate: true,
    });
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
        const { pg } = await contextProvider();
        await pg.query('SELECT 1 AS ok;');
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
