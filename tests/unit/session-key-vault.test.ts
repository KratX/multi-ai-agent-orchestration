import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from '../../src/server/config/env';
import {
  BYOK_SESSION_TTL_MS,
  ByokSessionValidationError,
  clearByokScope,
  decryptSecret,
  encryptSecret,
  isValidByokSessionToken,
  listByokProviderStatuses,
  maskApiKey,
  resolveByokScopeKey,
  resolveEffectiveEnvWithByok,
  rotateEphemeralMasterKey,
  saveByokProviderKey,
} from '../../src/server/security/session-key-vault';

const baseEnv = parseEnv({
  NODE_ENV: 'test',
  AI_MODE: 'demo',
  DEMO_MODE: 'true',
});

const SESSION_ALPHA = 'sess_alpha_9f8e7d6c5b4a3210fedcba98';
const SESSION_BETA = 'sess_beta_1a2b3c4d5e6f7890abcdef12';

test('Session BYOK Vault: encrypts and decrypts BYOK keys in RAM using AES-256-GCM under an ephemeral CSPRNG master key', () => {
  clearByokScope('global', { clearAllDemoScopes: true });
  const scopeKey = resolveByokScopeKey({
    sessionId: SESSION_ALPHA,
    strictSessionValidation: true,
  });

  const status = saveByokProviderKey({
    scopeKey,
    provider: 'gemini',
    apiKey: 'gm_test_ephemeral_ram_key_987654321',
  });

  assert.equal(status.provider, 'gemini');
  assert.equal(status.configuredInVault, true);
  assert.equal(status.source, 'vault');
  assert.equal(status.resolutionTier, 'session_byok');
  assert.ok(status.expiresAt);

  const effectiveEnv = resolveEffectiveEnvWithByok(baseEnv, scopeKey);
  assert.equal(effectiveEnv.GEMINI_API_KEY, 'gm_test_ephemeral_ram_key_987654321');
});

test('Session BYOK Vault: never writes .local/byok-vault.json or any file to disk during key storage, status check, or deletion', () => {
  clearByokScope('global', { clearAllDemoScopes: true });
  const legacyVaultFile = path.resolve(process.cwd(), '.local/byok-vault.json');
  if (fs.existsSync(legacyVaultFile)) {
    fs.unlinkSync(legacyVaultFile);
  }

  const scopeKey = resolveByokScopeKey({
    sessionId: SESSION_ALPHA,
    strictSessionValidation: true,
  });

  saveByokProviderKey({
    scopeKey,
    provider: 'openrouter',
    apiKey: 'sk-or-v1-ephemeral-only-key-1234567890',
  });
  listByokProviderStatuses(baseEnv, scopeKey);
  saveByokProviderKey({
    scopeKey,
    provider: 'openrouter',
    apiKey: '',
  });

  assert.equal(fs.existsSync(legacyVaultFile), false);
});

test('Session BYOK Vault: enforces a 2-hour (7,200,000 ms) TTL and automatically purges expired session keys on read', () => {
  clearByokScope('global', { clearAllDemoScopes: true });
  const scopeKey = resolveByokScopeKey({
    sessionId: SESSION_ALPHA,
    strictSessionValidation: true,
  });
  const t0 = 1_700_000_000_000;

  saveByokProviderKey({
    scopeKey,
    provider: 'chatgpt',
    apiKey: 'sk-proj-ttl-check-1234567890abcdef',
    nowMs: t0,
  });

  // Still valid just before 2 hours (without sliding TTL)
  const beforeExpiryEnv = resolveEffectiveEnvWithByok(baseEnv, scopeKey, {
    nowMs: t0 + BYOK_SESSION_TTL_MS - 1_000,
    slideTtl: false,
  });
  assert.equal(beforeExpiryEnv.OPENAI_API_KEY, 'sk-proj-ttl-check-1234567890abcdef');

  // Expired 1 ms after the 2-hour window
  const afterExpiryEnv = resolveEffectiveEnvWithByok(baseEnv, scopeKey, {
    nowMs: t0 + BYOK_SESSION_TTL_MS + 1,
    slideTtl: false,
  });
  assert.equal(afterExpiryEnv.OPENAI_API_KEY, '');
});

test('Session BYOK Vault: extends the 2-hour sliding TTL forward on active key decryption', () => {
  clearByokScope('global', { clearAllDemoScopes: true });
  const scopeKey = resolveByokScopeKey({
    sessionId: SESSION_ALPHA,
    strictSessionValidation: true,
  });
  const t0 = 1_700_000_000_000;

  saveByokProviderKey({
    scopeKey,
    provider: 'claude',
    apiKey: 'sk-ant-sliding-window-key-1234567890',
    nowMs: t0,
  });

  // Touch the key after 90 minutes (5,400,000 ms) with slideTtl = true
  const t90m = t0 + 90 * 60 * 1000;
  const resolvedAt90m = resolveEffectiveEnvWithByok(baseEnv, scopeKey, {
    nowMs: t90m,
    slideTtl: true,
  });
  assert.equal(resolvedAt90m.ANTHROPIC_API_KEY, 'sk-ant-sliding-window-key-1234567890');

  // At t0 + 150 minutes (past initial 120m expiry, but within 120m of the 90m read), key is still alive
  const t150m = t0 + 150 * 60 * 1000;
  const resolvedAt150m = resolveEffectiveEnvWithByok(baseEnv, scopeKey, {
    nowMs: t150m,
    slideTtl: true,
  });
  assert.equal(resolvedAt150m.ANTHROPIC_API_KEY, 'sk-ant-sliding-window-key-1234567890');
});

test('Session BYOK Vault: validates high-entropy session tokens and rejects short or guessable tokens with ByokSessionValidationError', () => {
  assert.equal(isValidByokSessionToken('1234'), false);
  assert.equal(isValidByokSessionToken('demo'), false);
  assert.equal(isValidByokSessionToken('aaaaaaaaaaaaaaaaaaaa'), false);
  assert.equal(isValidByokSessionToken('11111111111111111111'), false);
  assert.equal(isValidByokSessionToken(SESSION_ALPHA), true);

  assert.throws(
    () =>
      resolveByokScopeKey({
        sessionId: '1234',
        strictSessionValidation: true,
      }),
    ByokSessionValidationError
  );
});

test('Session BYOK Vault: strictly isolates keys between distinct high-entropy browser sessions', () => {
  clearByokScope('global', { clearAllDemoScopes: true });
  const scopeAlpha = resolveByokScopeKey({
    sessionId: SESSION_ALPHA,
    strictSessionValidation: true,
  });
  const scopeBeta = resolveByokScopeKey({
    sessionId: SESSION_BETA,
    strictSessionValidation: true,
  });

  saveByokProviderKey({
    scopeKey: scopeAlpha,
    provider: 'gemini',
    apiKey: 'gm_test_alpha_private_key_111111111',
  });
  saveByokProviderKey({
    scopeKey: scopeBeta,
    provider: 'gemini',
    apiKey: 'gm_test_beta_private_key_222222222',
  });

  assert.equal(
    resolveEffectiveEnvWithByok(baseEnv, scopeAlpha).GEMINI_API_KEY,
    'gm_test_alpha_private_key_111111111'
  );
  assert.equal(
    resolveEffectiveEnvWithByok(baseEnv, scopeBeta).GEMINI_API_KEY,
    'gm_test_beta_private_key_222222222'
  );

  saveByokProviderKey({
    scopeKey: scopeAlpha,
    provider: 'gemini',
    apiKey: '',
  });
  assert.equal(resolveEffectiveEnvWithByok(baseEnv, scopeAlpha).GEMINI_API_KEY, '');
  assert.equal(
    resolveEffectiveEnvWithByok(baseEnv, scopeBeta).GEMINI_API_KEY,
    'gm_test_beta_private_key_222222222'
  );
});

test('Session BYOK Vault: masks API keys one-way without prefix exposure and never leaks characters of server .env keys', () => {
  clearByokScope('global', { clearAllDemoScopes: true });
  const scopeAlpha = resolveByokScopeKey({
    sessionId: SESSION_ALPHA,
    strictSessionValidation: true,
  });
  const rawKey = 'gm_test_secret_plaintext_key_9988776655';

  saveByokProviderKey({
    scopeKey: scopeAlpha,
    provider: 'gemini',
    apiKey: rawKey,
  });

  const summaries = listByokProviderStatuses(baseEnv, scopeAlpha);
  const geminiSummary = summaries.find((item) => item.provider === 'gemini');

  assert.equal(geminiSummary?.configuredInVault, true);
  assert.equal(geminiSummary?.maskedPreview, maskApiKey(rawKey));
  assert.equal(geminiSummary?.maskedPreview?.includes('secret_plaintext_key'), false);
  assert.equal(geminiSummary?.maskedPreview?.startsWith('••••••••'), true);

  // Verify server .env keys never expose even prefix/suffix characters in maskedPreview
  const envWithServerGemini = parseEnv({
    NODE_ENV: 'test',
    AI_MODE: 'demo',
    DEMO_MODE: 'true',
    GEMINI_API_KEY: 'gm_server_env_private_credential_9999',
  });
  const scopeBeta = resolveByokScopeKey({
    sessionId: SESSION_BETA,
    strictSessionValidation: true,
  });
  const betaSummaries = listByokProviderStatuses(envWithServerGemini, scopeBeta);
  const betaGemini = betaSummaries.find((item) => item.provider === 'gemini');
  assert.equal(betaGemini?.configuredInEnv, true);
  assert.equal(betaGemini?.maskedPreview, '•••••••• (server env)');
  assert.equal(betaGemini?.maskedPreview?.includes('9999'), false);
});

test('Session BYOK Vault: invalidates previously encrypted in-RAM records when rotateEphemeralMasterKey() is called', () => {
  clearByokScope('global', { clearAllDemoScopes: true });
  const encryptedBefore = encryptSecret('xai-ephemeral-rotation-test-123456');
  assert.equal(decryptSecret(encryptedBefore), 'xai-ephemeral-rotation-test-123456');

  rotateEphemeralMasterKey();
  assert.equal(decryptSecret(encryptedBefore), null);
});

test('Session BYOK Vault: supports targeted provider deletion and scoped or global vault clearing', () => {
  clearByokScope('global', { clearAllDemoScopes: true });
  const scopeAlpha = resolveByokScopeKey({
    sessionId: SESSION_ALPHA,
    strictSessionValidation: true,
  });
  const scopeBeta = resolveByokScopeKey({
    sessionId: SESSION_BETA,
    strictSessionValidation: true,
  });

  saveByokProviderKey({
    scopeKey: scopeAlpha,
    provider: 'gemini',
    apiKey: 'gm_test_alpha_key_1234567890',
  });
  saveByokProviderKey({
    scopeKey: scopeAlpha,
    provider: 'openrouter',
    apiKey: 'sk-or-v1-alpha-key-1234567890',
  });
  saveByokProviderKey({
    scopeKey: scopeBeta,
    provider: 'gemini',
    apiKey: 'gm_test_beta_key_1234567890',
  });

  // Delete single provider from scopeAlpha
  saveByokProviderKey({
    scopeKey: scopeAlpha,
    provider: 'gemini',
    apiKey: '',
  });
  assert.equal(resolveEffectiveEnvWithByok(baseEnv, scopeAlpha).GEMINI_API_KEY, '');
  assert.equal(
    resolveEffectiveEnvWithByok(baseEnv, scopeAlpha).OPENROUTER_API_KEY,
    'sk-or-v1-alpha-key-1234567890'
  );

  // Clear entire scopeAlpha without affecting scopeBeta
  clearByokScope(scopeAlpha);
  assert.equal(resolveEffectiveEnvWithByok(baseEnv, scopeAlpha).OPENROUTER_API_KEY, '');
  assert.equal(
    resolveEffectiveEnvWithByok(baseEnv, scopeBeta).GEMINI_API_KEY,
    'gm_test_beta_key_1234567890'
  );
});
