import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, getPublicEnvSummary } from '../../src/server/config/env';

test('REPO-003: parseEnv succeeds in default AI_MODE="demo" with zero API keys', () => {
  const env = parseEnv({
    NODE_ENV: 'development',
    AI_MODE: 'demo',
    AI_PROVIDER_API_KEY: '',
    GEMINI_API_KEY: '',
  });

  assert.equal(env.AI_MODE, 'demo');
  assert.equal(env.DEMO_MODE, true);
  assert.equal(env.RUN_MAX_STEPS, 8);
  assert.equal(env.RUN_MAX_TOOL_CALLS, 6);
  assert.equal(env.RUN_TIMEOUT_SECONDS, 120);
  assert.equal(env.MAX_UPLOAD_BYTES, 10_485_760);
});

test('REPO-003: parseEnv normalizes MY_APP_URL placeholder to http://localhost:3000', () => {
  const env = parseEnv({
    APP_URL: 'MY_APP_URL',
    AI_MODE: 'demo',
  });

  assert.equal(env.APP_URL, 'http://localhost:3000');
});

test('REPO-003: parseEnv rejects AI_MODE="provider" when API key is missing or placeholder', () => {
  assert.throws(
    () =>
      parseEnv({
        AI_MODE: 'provider',
        AI_PROVIDER_API_KEY: '',
        GEMINI_API_KEY: 'MY_GEMINI_API_KEY',
      }),
    /AI_PROVIDER_API_KEY \(or GEMINI_API_KEY\) is required when AI_MODE="provider"/
  );
});

test('REPO-003: parseEnv accepts AI_MODE="provider" when a non-placeholder key is provided', () => {
  const env = parseEnv({
    AI_MODE: 'provider',
    AI_PROVIDER_API_KEY: 'live-secret-key-12345',
  });

  assert.equal(env.AI_MODE, 'provider');
  assert.equal(env.AI_PROVIDER_API_KEY, 'live-secret-key-12345');
});

test('REPO-003: parseEnv rejects out-of-range numeric guardrails (RUN_MAX_STEPS > 25)', () => {
  assert.throws(
    () =>
      parseEnv({
        AI_MODE: 'demo',
        RUN_MAX_STEPS: '999',
      }),
    /RUN_MAX_STEPS cannot exceed 25/
  );
});

test('REPO-003: parseEnv rejects default AUTH_SECRET in production mode', () => {
  assert.throws(
    () =>
      parseEnv({
        NODE_ENV: 'production',
        AI_MODE: 'demo',
        AUTH_SECRET: 'local-dev-only-auth-secret-change-me',
      }),
    /Production environment requires a non-default AUTH_SECRET/
  );
});

test('REPO-003: getPublicEnvSummary redacts raw secret values and exposes only safe booleans and limits', () => {
  const env = parseEnv({
    AI_MODE: 'provider',
    AI_PROVIDER_API_KEY: 'super-secret-provider-key',
    AUTH_SECRET: 'custom-secret-with-at-least-16-chars',
    DATABASE_URL: 'postgresql://user:secret_pass@localhost:5432/agent_platform',
  });

  const summary = getPublicEnvSummary(env);
  const serialized = JSON.stringify(summary);

  assert.equal(summary.aiMode, 'provider');
  assert.equal(summary.hasLiveProviderKey, true);
  assert.equal(summary.limits.runMaxSteps, 8);
  assert.equal(serialized.includes('super-secret-provider-key'), false);
  assert.equal(serialized.includes('custom-secret-with-at-least-16-chars'), false);
  assert.equal(serialized.includes('secret_pass'), false);
});

