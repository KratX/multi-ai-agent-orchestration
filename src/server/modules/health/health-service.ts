import { createDrizzleReadinessProbe, getSharedDatabase, type DatabaseContext } from '../../db/client';
import type { ReadinessCheckResult } from '../../../app/api/v1/health/route';

/**
 * Framework-neutral Health & Readiness Service
 *
 * Separates process liveness (`/api/v1/health/live`) from dependency readiness
 * (`/api/v1/health/ready` and `/api/v1/health`), executing a real `SELECT 1`
 * query against the active database context.
 */

export interface LivenessPayload {
  status: 'alive';
  service: 'aegis-runtime';
  version: string;
  timestamp: string;
  uptimeSeconds: number;
}

export function evaluateLiveness(): LivenessPayload {
  return {
    status: 'alive',
    service: 'aegis-runtime',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

export async function evaluateDatabaseReadiness(
  contextProvider: () => Promise<DatabaseContext> = getSharedDatabase
): Promise<ReadinessCheckResult> {
  const probe = createDrizzleReadinessProbe(contextProvider);
  const res = await probe.ping();
  return {
    databaseReady: res.reachable,
    latencyMs: res.latencyMs,
    engine: 'pglite',
  };
}
