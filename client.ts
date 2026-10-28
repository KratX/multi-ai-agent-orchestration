import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import * as tenantSchema from './schema/tenant';
import { MIGRATION_0001_TENANT_SQL } from './schema/tenant';
import type { DatabaseReadinessCheck } from '../../app/api/v1/health/route';

/**
 * Ticket REPO-005 (Part 2): Drizzle ORM Database Client & Migration Runner
 *
 * Provides:
 * 1. `createDatabaseClient()`: Creates an isolated PostgreSQL instance backed by PGlite
 *    (real PostgreSQL engine compiled to WASM) or persistent data directory, wrapped
 *    with Drizzle ORM and our typed `tenantSchema`.
 * 2. `applyTenantMigrations()`: Applies versioned SQL DDL (`MIGRATION_0001_TENANT_SQL`)
 *    idempotently so all tables, composite primary keys, and SQL CHECK constraints are active.
 * 3. `createDrizzleReadinessProbe()`: Concrete `DatabaseReadinessCheck` implementation
 *    that runs a real `SELECT 1 AS ok` query against PostgreSQL for `/api/v1/health`.
 */

export type AegisDatabase = PgliteDatabase<typeof tenantSchema>;

export interface DatabaseContext {
  pg: PGlite;
  db: AegisDatabase;
  close: () => Promise<void>;
}

/**
 * Applies the foundational multi-tenant SQL migration (0001) to the given PGlite instance.
 * Safe to call multiple times because statements use `IF NOT EXISTS`.
 */
export async function applyTenantMigrations(pg: PGlite): Promise<void> {
  await pg.exec(MIGRATION_0001_TENANT_SQL);
}

/**
 * Creates a fresh, migrated PostgreSQL + Drizzle database context.
 * - Pass no arguments (or `dataDir: 'memory://'`) for an isolated in-memory PostgreSQL
 *   instance in unit/integration tests.
 * - Pass a filesystem path (e.g. `.aegis-pgdata`) for local persistent storage when
 *   Docker is not running.
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

  const db = drizzle(pg, { schema: tenantSchema });

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
