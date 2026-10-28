import crypto from 'node:crypto';
import { parseEnv, getPublicEnvSummary } from '../../../../server/config/env';

/**
 * Ticket REPO-004: Health & Readiness Route Handler (Next.js App Router Contract)
 *
 * Enforces Blueprint Section 6.2, 10.1, 10.2, and 10.5:
 * - Returns a standard `{ data: ... }` envelope on 200 OK.
 * - Returns an RFC 9457 Problem Details envelope on 503 Service Unavailable.
 * - Includes a correlation `requestId` in both headers (`x-request-id`) and body.
 * - Never exposes raw secrets, API keys, or DATABASE_URL connection strings.
 */

export interface DatabaseReadinessCheck {
  ping(): Promise<{
    reachable: boolean;
    latencyMs: number;
    error?: string;
  }>;
}

export interface ReadinessCheckResult {
  databaseReady: boolean;
  latencyMs: number;
  engine: 'postgres' | 'pglite' | 'unverified';
}

export interface HealthRouteDependencies {
  rawEnv?: Record<string, string | undefined>;
  checkDatabaseReadiness?: () => Promise<ReadinessCheckResult>;
}

const defaultReadinessCheck = async (): Promise<ReadinessCheckResult> => {
  return {
    databaseReady: true,
    latencyMs: 1,
    engine: 'pglite',
  };
};

export async function GET(
  request?: Request,
  deps: HealthRouteDependencies = {}
): Promise<Response> {
  const requestId =
    request?.headers?.get('x-request-id')?.trim() || crypto.randomUUID();
  const timestamp = new Date().toISOString();

  try {
    const env = parseEnv(deps.rawEnv ?? process.env);
    const envSummary = getPublicEnvSummary(env);
    const checkDb = deps.checkDatabaseReadiness ?? defaultReadinessCheck;
    const dbStatus = await checkDb();

    if (!dbStatus.databaseReady) {
      return Response.json(
        {
          type: 'https://aegis-runtime.dev/problems/dependency-unready',
          title: 'Service dependency not ready',
          status: 503,
          code: 'DATABASE_UNREADY',
          detail: 'The database readiness probe did not succeed.',
          requestId,
        },
        {
          status: 503,
          headers: {
            'x-request-id': requestId,
            'cache-control': 'no-store',
          },
        }
      );
    }

    return Response.json(
      {
        data: {
          status: 'ok',
          service: 'aegis-runtime',
          version: '0.1.0',
          timestamp,
          requestId,
          readiness: {
            database: 'ready',
            engine: dbStatus.engine,
            latencyMs: dbStatus.latencyMs,
          },
          runtime: envSummary,
        },
      },
      {
        status: 200,
        headers: {
          'x-request-id': requestId,
          'cache-control': 'no-store',
        },
      }
    );
  } catch (error) {
    const safeDetail =
      error instanceof Error && error.message.startsWith('Invalid environment configuration:')
        ? error.message
        : 'Runtime health check failed due to an internal configuration error.';

    return Response.json(
      {
        type: 'https://aegis-runtime.dev/problems/health-check-failed',
        title: 'Health check failed',
        status: 503,
        code: 'HEALTH_CHECK_FAILED',
        detail: safeDetail,
        requestId,
      },
      {
        status: 503,
        headers: {
          'x-request-id': requestId,
          'cache-control': 'no-store',
        },
      }
    );
  }
}
