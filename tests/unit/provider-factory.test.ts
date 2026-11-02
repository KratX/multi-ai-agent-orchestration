import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from '../../src/server/config/env';
import {
  MockModelProvider,
  resolveThreeTierProvider,
  testProviderConnection,
} from '../../src/server/ai/provider-factory';
import {
  BYOK_SESSION_TTL_MS,
  clearByokScope,
  listByokProviderStatuses,
  resolveByokScopeKey,
  saveByokProviderKey,
} from '../../src/server/security/session-key-vault';

const SESSION_TOKEN = 'sess_factory_9f8e7d6c5b4a3210fedcba';

test('Provider Factory: resolves Tier 1 (session_byok) when an active key exists in the Session BYOK Vault', () => {
  clearByokScope('global', { clearAllDemoScopes: true });
  const scopeKey = resolveByokScopeKey({
    sessionId: SESSION_TOKEN,
    strictSessionValidation: true,
  });

  saveByokProviderKey({
    scopeKey,
    provider: 'gemini',
    apiKey: 'gm_test_tier_one_session_byok_key_123456',
  });

  const envWithServerKey = parseEnv({
    NODE_ENV: 'test',
    AI_MODE: 'demo',
    DEMO_MODE: 'true',
    GEMINI_API_KEY: 'gm_test_tier_two_server_env_key_999999',
  });

  const resolution = resolveThreeTierProvider(envWithServerKey, {
    scopeKey,
    engine: 'gemini-free',
  });

  assert.equal(resolution.resolutionTier, 'session_byok');
  assert.equal(resolution.requestedEngine, 'gemini-free');
  assert.equal(
    resolution.effectiveEnv.GEMINI_API_KEY,
    'gm_test_tier_one_session_byok_key_123456'
  );
});

test('Provider Factory: falls back to Tier 2 (server_env) when the Session BYOK Vault has no key for the engine', () => {
  clearByokScope('global', { clearAllDemoScopes: true });
  const scopeKey = resolveByokScopeKey({
    sessionId: SESSION_TOKEN,
    strictSessionValidation: true,
  });

  const envWithOpenRouter = parseEnv({
    NODE_ENV: 'test',
    AI_MODE: 'demo',
    DEMO_MODE: 'true',
    OPENROUTER_API_KEY: 'or_test_server_env_fallback_key_12345',
  });

  const resolution = resolveThreeTierProvider(envWithOpenRouter, {
    scopeKey,
    engine: 'openrouter-free',
  });

  assert.equal(resolution.resolutionTier, 'server_env');
  const openrouterStatus = resolution.providerStatuses.find(
    (s) => s.provider === 'openrouter'
  );
  assert.equal(openrouterStatus?.configuredInEnv, true);
  assert.equal(openrouterStatus?.source, 'env');
});

test('Provider Factory: falls back to Tier 3 (deterministic_fallback) MockModelProvider when neither BYOK nor .env is configured', async () => {
  clearByokScope('global', { clearAllDemoScopes: true });
  const scopeKey = resolveByokScopeKey({
    sessionId: SESSION_TOKEN,
    strictSessionValidation: true,
  });

  const emptyEnv = parseEnv({
    NODE_ENV: 'test',
    AI_MODE: 'demo',
    DEMO_MODE: 'true',
  });

  const resolution = resolveThreeTierProvider(emptyEnv, {
    scopeKey,
    engine: 'gemini-free',
  });

  assert.equal(resolution.resolutionTier, 'deterministic_fallback');
  assert.equal(resolution.provider.providerName, 'ordaris-mock');

  const output = await resolution.provider.generate({
    systemPrompt: 'Summarize tenant audit posture.',
    modelConfig: {
      provider: 'mock',
      model: 'ordaris-mock-v1',
      temperature: 0,
      maxSteps: 2,
      maxToolCalls: 0,
    },
    allowedTools: [],
    messages: [{ role: 'user', content: 'Summarize tenant audit posture.' }],
    stepIndex: 0,
  });
  assert.ok(output.answer || output.reasoningSummary);
});

test('Provider Factory: automatically demotes from Tier 1 (session_byok) to Tier 3 once the 2-hour sliding TTL expires', () => {
  clearByokScope('global', { clearAllDemoScopes: true });
  const scopeKey = resolveByokScopeKey({
    sessionId: SESSION_TOKEN,
    strictSessionValidation: true,
  });
  const emptyEnv = parseEnv({
    NODE_ENV: 'test',
    AI_MODE: 'demo',
    DEMO_MODE: 'true',
  });

  const t0 = 1_700_000_000_000;
  saveByokProviderKey({
    scopeKey,
    provider: 'chatgpt',
    apiKey: 'oa_test_ephemeral_session_key_123456',
    nowMs: t0,
  });

  const activeResolution = resolveThreeTierProvider(emptyEnv, {
    scopeKey,
    engine: 'chatgpt-free',
    nowMs: t0 + 1_000,
  });
  assert.equal(activeResolution.resolutionTier, 'session_byok');

  // After 2 hours of inactivity from t0 + 1_000
  const expiredResolution = resolveThreeTierProvider(emptyEnv, {
    scopeKey,
    engine: 'chatgpt-free',
    nowMs: t0 + 1_000 + BYOK_SESSION_TTL_MS + 5_000,
  });
  assert.equal(expiredResolution.resolutionTier, 'deterministic_fallback');
});

test('Provider Factory: resolves engine-specific provider status across gemini, openrouter, chatgpt, claude, and grok', () => {
  clearByokScope('global', { clearAllDemoScopes: true });
  const scopeKey = resolveByokScopeKey({
    sessionId: SESSION_TOKEN,
    strictSessionValidation: true,
  });

  saveByokProviderKey({
    scopeKey,
    provider: 'claude',
    apiKey: 'cl_test_session_claude_key_1234567890',
  });

  const mixedEnv = parseEnv({
    NODE_ENV: 'test',
    AI_MODE: 'demo',
    DEMO_MODE: 'true',
    GEMINI_API_KEY: 'gm_test_env_gemini_key_123456789',
  });

  const claudeResolution = resolveThreeTierProvider(mixedEnv, {
    scopeKey,
    engine: 'claude-free',
  });
  const geminiResolution = resolveThreeTierProvider(mixedEnv, {
    scopeKey,
    engine: 'gemini-free',
  });
  const grokResolution = resolveThreeTierProvider(mixedEnv, {
    scopeKey,
    engine: 'grok-free',
  });

  assert.equal(claudeResolution.resolutionTier, 'session_byok');
  assert.equal(geminiResolution.resolutionTier, 'server_env');
  assert.equal(grokResolution.resolutionTier, 'deterministic_fallback');
});

test('Provider Factory: executes testProviderConnection() and records verification status in the Session BYOK Vault', async () => {
  clearByokScope('global', { clearAllDemoScopes: true });
  const scopeKey = resolveByokScopeKey({
    sessionId: SESSION_TOKEN,
    strictSessionValidation: true,
  });
  const emptyEnv = parseEnv({
    NODE_ENV: 'test',
    AI_MODE: 'demo',
    DEMO_MODE: 'true',
  });

  const fallbackResult = await testProviderConnection(emptyEnv, {
    provider: 'gemini',
    scopeKey,
  });
  assert.equal(fallbackResult.verified, false);
  assert.equal(fallbackResult.resolutionTier, 'deterministic_fallback');

  saveByokProviderKey({
    scopeKey,
    provider: 'gemini',
    apiKey: 'gm_test_vault_verification_key_000',
  });
  const vaultResult = await testProviderConnection(emptyEnv, {
    provider: 'gemini',
    scopeKey,
    customProvider: new MockModelProvider(),
  });
  assert.equal(vaultResult.provider, 'gemini');

  const summary = listByokProviderStatuses(emptyEnv, scopeKey).find(
    (item) => item.provider === 'gemini'
  );
  assert.ok(summary?.lastVerifiedAt);
});
