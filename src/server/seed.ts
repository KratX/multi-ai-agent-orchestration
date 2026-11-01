import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from './db/client';
import {
  BETA_LOGISTICS_HITL_WORKFLOW_GRAPH,
  FLAGSHIP_HITL_WORKFLOW_GRAPH,
  seedFlagshipWorkspace,
  type FlagshipSeedReport,
} from './seed/demo-seed';
import {
  getSystemDiagnostics as getDatabaseDiagnostics,
  getSystemDiagnostics,
  resetDemoSandboxOnly,
  verifyMultiTenantIsolation,
  type DemoResetMode,
  type DemoResetOptions,
  type DemoResetResult,
  type SystemDiagnosticsReport,
} from './modules/workspace/demo-workspace-service';

/**
 * Ordaris Flagship Multi-Tenant Seed, 3-Mode Sandbox Reset & Database Diagnostics (`src/server/seed.ts`)
 *
 * Implements Checkpoint 4 (`SEED-001`):
 * - Seeds 8 RBAC personas across `Acme Cyber Defense` (`acme-owner`, `acme-admin`, `acme-dev`, `acme-viewer`)
 *   and `Beta Logistics` (`beta-owner`, `beta-admin`, `beta-dev`, `beta-viewer`).
 * - Supports 3-choice sandbox reset (`workspace_only`, `keys_only`, `factory_reset`).
 * - Exposes live PostgreSQL table diagnostics (`getDatabaseDiagnostics`).
 */

export {
  BETA_LOGISTICS_HITL_WORKFLOW_GRAPH,
  FLAGSHIP_HITL_WORKFLOW_GRAPH,
  getDatabaseDiagnostics,
  getSystemDiagnostics,
  resetDemoSandboxOnly,
  seedFlagshipWorkspace,
  verifyMultiTenantIsolation,
  type DemoResetMode,
  type DemoResetOptions,
  type DemoResetResult,
  type FlagshipSeedReport,
  type SystemDiagnosticsReport,
};

const isDirectExecution =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  (async () => {
    const ctx = await createDatabaseClient();
    try {
      const report = await seedFlagshipWorkspace(ctx.db);
      console.log(
        JSON.stringify(
          {
            status: 'seeded',
            mode: 'AI_MODE=demo',
            report,
          },
          null,
          2
        )
      );
    } finally {
      await ctx.close();
    }
  })();
}
