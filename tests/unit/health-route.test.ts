import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../../src/app/api/v1/health/route';

test('REPO-004: GET /api/v1/health returns 200 OK with { data } envelope and redacted runtime config', async () => {
  const req = new Request('http://localhost:3000/api/v1/health', {
    headers: { 'x-request-id': 'req-health-test-001' },
  });

  const res = await GET(req, {
    rawEnv: {
      NODE_ENV: 'development',
      AI_MODE: 'demo',
      DATABASE_URL: 'postgresql://postgres:super_secret_pw@localhost:5432/agent_platform',
      AUTH_SECRET: 'local-dev-only-auth-secret-change-me',
    },
    checkDatabaseReadiness: async () => ({
      databaseReady: true,
      latencyMs: 2,
      engine: 'pglite',
    }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-request-id'), 'req-health-test-001');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const body = await res.json();
  assert.equal(body.data.status, 'ok');
  assert.equal(body.data.service, 'aegis-runtime');
  assert.equal(body.data.requestId, 'req-health-test-001');
  assert.equal(body.data.readiness.database, 'ready');
  assert.equal(body.data.readiness.engine, 'pglite');
  assert.equal(body.data.runtime.aiMode, 'demo');
  assert.equal(body.data.runtime.limits.runMaxSteps, 8);

  const rawText = JSON.stringify(body);
  assert.equal(rawText.includes('super_secret_pw'), false);
  assert.equal(rawText.includes('local-dev-only-auth-secret-change-me'), false);
});

test('REPO-004: GET /api/v1/health generates a UUID x-request-id when header is omitted', async () => {
  const res = await GET(undefined, {
    rawEnv: { AI_MODE: 'demo' },
  });

  assert.equal(res.status, 200);
  const requestId = res.headers.get('x-request-id');
  assert.ok(requestId && requestId.length >= 32);
});

test('REPO-004: GET /api/v1/health returns 503 Problem Details when database readiness probe fails', async () => {
  const req = new Request('http://localhost:3000/api/v1/health', {
    headers: { 'x-request-id': 'req-db-down-002' },
  });

  const res = await GET(req, {
    rawEnv: { AI_MODE: 'demo' },
    checkDatabaseReadiness: async () => ({
      databaseReady: false,
      latencyMs: 5000,
      engine: 'postgres',
    }),
  });

  assert.equal(res.status, 503);
  assert.equal(res.headers.get('x-request-id'), 'req-db-down-002');

  const problem = await res.json();
  assert.equal(problem.status, 503);
  assert.equal(problem.code, 'DATABASE_UNREADY');
  assert.equal(problem.requestId, 'req-db-down-002');
  assert.equal(problem.title, 'Service dependency not ready');
});

test('REPO-004: GET /api/v1/health returns 503 Problem Details when environment validation fails', async () => {
  const res = await GET(undefined, {
    rawEnv: {
      AI_MODE: 'provider',
      AI_PROVIDER_API_KEY: '',
    },
  });

  assert.equal(res.status, 503);
  const problem = await res.json();
  assert.equal(problem.code, 'HEALTH_CHECK_FAILED');
  assert.match(problem.detail, /Invalid environment configuration/);
});

