import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import * as tenantSchema from './schema/tenant';
import { MIGRATION_0001_TENANT_SQL } from './schema/tenant';
import * as agentsSchema from './schema/agents';
import { MIGRATION_0002_AGENTS_SQL } from './schema/agents';
import * as runsSchema from './schema/runs';
import { MIGRATION_0003_RUNS_SQL } from './schema/runs';
import type { DatabaseReadinessCheck } from '../../app/api/v1/health/route';

/**
 * Ticket REPO-005, AGENT-001 & RUN-001: Drizzle ORM Database Client & Migration Runner
 *
 * Combines all domain schemas (`tenantSchema` + `agentsSchema` + `runsSchema`) and applies
 * sequential versioned SQL migrations (`0001` + `0002` + `0003`) idempotently.
 */

export const aegisSchema = {
  ...tenantSchema,
  ...agentsSchema,
  ...runsSchema,
};

export type AegisDatabase = PgliteDatabase<typeof aegisSchema>;

export interface DatabaseContext {
  pg: PGlite;
  db: AegisDatabase;
  close: () => Promise<void>;
}

/**
 * Applies all sequential SQL migrations (0001 Tenant + 0002 Agents + 0003 Runs/Queue)
 * to the given PGlite instance. Safe to call multiple times because statements use `IF NOT EXISTS`.
 */
export async function applyTenantMigrations(pg: PGlite): Promise<void> {
  await pg.exec(MIGRATION_0001_TENANT_SQL);
  await pg.exec(MIGRATION_0002_AGENTS_SQL);
  await pg.exec(MIGRATION_0003_RUNS_SQL);
}

/**
 * Creates a fresh, migrated PostgreSQL + Drizzle database context.
 */
export async function createDatabaseClient(options?: {
  dataDir?: string;
  autoMigrate?: boolean;
}): Promise<DatabaseContext> {
  const pg = new PGlite(options?.dataDir);
  await pg.waitReady;

  if (options?.autoMigrate !== false) {
    await applyTenantMigrations(pg);
  }

  const db = drizzle(pg, { schema: aegisSchema });

  return {
    pg,
    db,
    close: async () => {
      if (!pg.closed) {
        await pg.close();
      }
    },
  };
}

let sharedContextPromise: Promise<DatabaseContext> | null = null;

/**
 * Returns a process-wide singleton PostgreSQL + Drizzle context for runtime routes.
 */
export function getSharedDatabase(): Promise<DatabaseContext> {
  if (!sharedContextPromise) {
    sharedContextPromise = createDatabaseClient({ autoMigrate: true });
  }
  return sharedContextPromise;
}

/**
 * Adapts a `DatabaseContext` into the `DatabaseReadinessCheck` interface expected by
 * `GET /api/v1/health` (`src/app/api/v1/health/route.ts`).
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
