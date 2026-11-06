import crypto from 'node:crypto';
import { redactSecretsFromText, type AppEnv } from '../config/env';

/**
 * Ordaris Session-Scoped AES-256-GCM In-Memory BYOK Vault (`src/server/security/session-key-vault.ts`)
 *
 * Enforces Threat T-08 & ADR-001:
 * 1. Pure Server-RAM Storage: API keys live exclusively in process memory and are NEVER written
 *    to disk (no `.local/byok-vault.json` or filesystem persistence) or logs.
 * 2. Ephemeral CSPRNG Master Key: Generates a 256-bit (`32`-byte) master key via `crypto.randomBytes(32)`
 *    in RAM on process boot, with unique 96-bit (`12`-byte) IVs and 128-bit (`16`-byte) GCM auth tags.
 * 3. 2-Hour Sliding TTL (`BYOK_SESSION_TTL_MS = 7_200_000`): Every stored key expires after 2 hours
 *    of inactivity; active reads/decryptions slide the expiration window forward by 2 hours.
 * 4. High-Entropy Session Scoping: Rejects short or guessable client session strings and never
 *    accepts session IDs from URL query parameters.
 */

export const BYOK_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours (7,200,000 ms)
export const MIN_SESSION_TOKEN_LENGTH = 16;
export const MAX_SESSION_TOKEN_LENGTH = 128;

export type ByokProviderId =
  | 'gemini'
  | 'chatgpt'
  | 'claude'
  | 'grok'
  | 'openrouter';

export type ByokResolutionTier =
  | 'session_byok'
  | 'server_env'
  | 'deterministic_fallback';

export interface EncryptedSecretRecord {
  provider: ByokProviderId;
  ivHex: string;
  authTagHex: string;
  ciphertextHex: string;
  maskedPreview: string;
  createdAtMs: number;
  updatedAt: string;
  lastAccessedAtMs: number;
  expiresAtMs: number;
  ttlMs: number;
  lastVerifiedAt?: string | null;
  lastVerifyStatus?: 'verified' | 'failed' | null;
  lastVerifyMessage?: string | null;
}

export interface PublicByokProviderStatus {
  provider: ByokProviderId;
  label: string;
  envVarName: string;
  modelName: string;
  docsUrl: string;
  configured: boolean;
  configuredInVault: boolean;
  configuredInEnv: boolean;
  effectiveActive: boolean;
  source: 'vault' | 'env' | 'none';
  resolutionTier: ByokResolutionTier;
  resolutionLabel: string;
  maskedPreview: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  ttlSecondsRemaining: number | null;
  lastVerifiedAt: string | null;
  lastVerifyStatus: 'verified' | 'failed' | null;
  lastVerifyMessage: string | null;
  lastVerificationOk: boolean | null;
  lastVerificationMessage: string | null;
}

export const BYOK_PROVIDER_METADATA: Record<
  ByokProviderId,
  {
    label: string;
    envVarName: string;
    modelName: string;
    docsUrl: string;
  }
> = {
  gemini: {
    label: 'Google Gemini 3 Flash',
    envVarName: 'GEMINI_API_KEY',
    modelName: 'gemini-3-flash-preview',
    docsUrl: 'https://aistudio.google.com/apikey',
  },
  openrouter: {
    label: 'OpenRouter Free Router',
    envVarName: 'OPENROUTER_API_KEY',
    modelName: 'openrouter/free',
    docsUrl: 'https://openrouter.ai/settings/keys',
  },
  chatgpt: {
    label: 'OpenAI ChatGPT (gpt-4o-mini)',
    envVarName: 'OPENAI_API_KEY',
    modelName: 'gpt-4o-mini',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  claude: {
    label: 'Anthropic Claude 3.5 Haiku',
    envVarName: 'ANTHROPIC_API_KEY',
    modelName: 'claude-3-5-haiku-latest',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  grok: {
    label: 'xAI Grok 2 Latest',
    envVarName: 'XAI_API_KEY',
    modelName: 'grok-2-latest',
    docsUrl: 'https://console.x.ai/',
  },
};

export class ByokSessionValidationError extends Error {
  public readonly code = 'INVALID_BYOK_SESSION_TOKEN' as const;
  public readonly statusCode = 400;

  public constructor(message: string) {
    super(message);
    this.name = 'ByokSessionValidationError';
  }
}

// Ephemeral 256-bit CSPRNG master key held strictly in server RAM
let ephemeralMasterKey: Buffer = crypto.randomBytes(32);

// Pure in-RAM session store: Map<scopeKey, Partial<Record<ByokProviderId, EncryptedSecretRecord>>>
const inMemoryScopes = new Map<
  string,
  Partial<Record<ByokProviderId, EncryptedSecretRecord>>
>();

// Pure in-RAM provider verification log so probe results persist even for built-in free engines or unconfigured BYOK engines
const inMemoryVerificationHistory = new Map<
  string,
  Partial<
    Record<
      ByokProviderId,
      {
        lastVerifiedAt: string;
        lastVerifyStatus: 'verified' | 'failed';
        lastVerifyMessage: string;
      }
    >
  >
>();

/**
 * Rotates the in-RAM 256-bit CSPRNG master key and purges any existing ciphertexts.
 */
export function rotateEphemeralMasterKey(): void {
  ephemeralMasterKey = crypto.randomBytes(32);
  inMemoryScopes.clear();
  inMemoryVerificationHistory.clear();
}

/**
 * Generates a cryptographically random 192-bit session token (`sess_<48-hex-chars>`).
 */
export function generateByokSessionToken(): string {
  return `sess_${crypto.randomBytes(24).toString('hex')}`;
}

const KNOWN_GUESSABLE_PREFIXES = new Set([
  'test',
  'demo',
  'admin',
  'guest',
  'user',
  'default',
  'session',
  'visitor',
  'anonymous',
  'public',
  'shared',
  'global',
  '1234',
  '12345678',
  'password',
  'sess_browser_ephemeral_9f8e7d6c5b4a3210',
]);

/**
 * Validates that a client-supplied session token has high entropy and is not a short,
 * static fallback, or guessable string that could collide with other visitors.
 */
export function isValidByokSessionToken(rawToken: string | null | undefined): boolean {
  if (!rawToken || typeof rawToken !== 'string') {
    return false;
  }
  const trimmed = rawToken.trim();
  if (
    trimmed.length < MIN_SESSION_TOKEN_LENGTH ||
    trimmed.length > MAX_SESSION_TOKEN_LENGTH
  ) {
    return false;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  if (
    KNOWN_GUESSABLE_PREFIXES.has(lower) ||
    lower.includes('ephemeral') ||
    lower.includes('fallback') ||
    lower.includes('static') ||
    lower.includes('placeholder')
  ) {
    return false;
  }

  // Require at least 5 distinct characters to block trivial repetition like "aaaaaaaaaaaaaaaa"
  const uniqueChars = new Set(lower.replace(/[-_]/g, '')).size;
  if (uniqueChars < 5) {
    return false;
  }

  return true;
}

export function normalizeByokProviderId(raw: string): ByokProviderId | null {
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === 'gemini' ||
    normalized === 'gemini_api_key' ||
    normalized === 'gemini-free'
  ) {
    return 'gemini';
  }
  if (
    normalized === 'chatgpt' ||
    normalized === 'openai' ||
    normalized === 'openai_api_key' ||
    normalized === 'chatgpt-free'
  ) {
    return 'chatgpt';
  }
  if (
    normalized === 'claude' ||
    normalized === 'anthropic' ||
    normalized === 'anthropic_api_key' ||
    normalized === 'claude-free'
  ) {
    return 'claude';
  }
  if (
    normalized === 'grok' ||
    normalized === 'xai' ||
    normalized === 'xai_api_key' ||
    normalized === 'grok-free'
  ) {
    return 'grok';
  }
  if (
    normalized === 'openrouter' ||
    normalized === 'openrouter_api_key' ||
    normalized === 'openrouter-free'
  ) {
    return 'openrouter';
  }
  return null;
}

/**
 * Resolves the isolated in-RAM vault scope key for a request.
 * - When `sessionId` is provided, validates that it meets high-entropy requirements
 *   (or throws `ByokSessionValidationError` when `strictSessionValidation` is enabled)
 *   and hashes it with HMAC-SHA256 under the ephemeral master key.
 * - When `requireSessionToken` is enabled, fails closed with `ByokSessionValidationError`
 *   if no valid session token is provided.
 */
export function resolveByokScopeKey(input?: {
  sessionId?: string | null;
  organizationId?: string | null;
  fallbackScope?: string;
  strictSessionValidation?: boolean;
  requireSessionToken?: boolean;
}): string {
  const rawSession = (input?.sessionId ?? '').trim();
  if (rawSession) {
    if (!isValidByokSessionToken(rawSession)) {
      if (input?.strictSessionValidation || input?.requireSessionToken) {
        throw new ByokSessionValidationError(
          `Session BYOK token must be a high-entropy CSPRNG token of at least ${MIN_SESSION_TOKEN_LENGTH} characters (static or ephemeral fallback tokens are rejected).`
        );
      }
    } else {
      const digest = crypto
        .createHmac('sha256', ephemeralMasterKey)
        .update(`ordaris-session-scope:${rawSession}`, 'utf8')
        .digest('hex')
        .slice(0, 32);
      return `session:${digest}`;
    }
  } else if (input?.requireSessionToken) {
    throw new ByokSessionValidationError(
      'Missing required x-ordaris-demo-session header. Session BYOK mutations require a cryptographically secure session token.'
    );
  }

  const rawOrg = (input?.organizationId ?? '').trim();
  if (rawOrg) {
    return `org:${rawOrg}`;
  }
  return input?.fallbackScope || 'global';
}

export function maskApiKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.length <= 8) {
    return '••••••••';
  }
  return `••••••••${trimmed.slice(-4)}`;
}

/**
 * Encrypts a plaintext API key in RAM using AES-256-GCM with the process-ephemeral 256-bit master key,
 * a random 96-bit IV, and a 128-bit authentication tag.
 */
export function encryptSecret(plaintext: string): {
  ivHex: string;
  authTagHex: string;
  ciphertextHex: string;
} {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ephemeralMasterKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    ivHex: iv.toString('hex'),
    authTagHex: authTag.toString('hex'),
    ciphertextHex: encrypted.toString('hex'),
  };
}

/**
 * Decrypts an AES-256-GCM record using the process-ephemeral 256-bit master key.
 * Returns `null` if the authentication tag or key does not match.
 */
export function decryptSecret(
  record: Pick<EncryptedSecretRecord, 'ivHex' | 'authTagHex' | 'ciphertextHex'>
): string | null {
  try {
    const iv = Buffer.from(record.ivHex, 'hex');
    const authTag = Buffer.from(record.authTagHex, 'hex');
    const ciphertext = Buffer.from(record.ciphertextHex, 'hex');
    if (iv.length !== 12 || authTag.length !== 16) {
      return null;
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      ephemeralMasterKey,
      iv
    );
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Sweeps expired records across all in-RAM scopes and optionally slides the TTL window
 * for a target scope upon active read/use.
 */
export function sweepExpiredByokKeys(nowMs = Date.now()): number {
  let evictedCount = 0;
  for (const [scopeKey, records] of inMemoryScopes.entries()) {
    if (!records) continue;
    for (const provider of Object.keys(records) as ByokProviderId[]) {
      const rec = records[provider];
      if (rec && nowMs >= rec.expiresAtMs) {
        delete records[provider];
        evictedCount += 1;
      }
    }
    if (Object.keys(records).length === 0) {
      inMemoryScopes.delete(scopeKey);
    }
  }
  return evictedCount;
}

function getActiveScopeRecords(
  scopeKey: string,
  options?: { nowMs?: number; slideTtl?: boolean }
): Partial<Record<ByokProviderId, EncryptedSecretRecord>> {
  const nowMs = options?.nowMs ?? Date.now();
  const slideTtl = options?.slideTtl !== false;
  sweepExpiredByokKeys(nowMs);

  const isSessionScope = scopeKey.startsWith('session:');
  const targetScope = inMemoryScopes.get(scopeKey);
  const globalScope = isSessionScope ? undefined : inMemoryScopes.get('global');

  const combined: Partial<Record<ByokProviderId, EncryptedSecretRecord>> = {
    ...(globalScope ?? {}),
    ...(targetScope ?? {}),
  };

  if (slideTtl) {
    for (const provider of Object.keys(combined) as ByokProviderId[]) {
      const rec = combined[provider];
      if (rec && nowMs < rec.expiresAtMs) {
        rec.lastAccessedAtMs = nowMs;
        rec.expiresAtMs = nowMs + rec.ttlMs;
      }
    }
  }

  return combined;
}

export function saveByokProviderKey(input: {
  scopeKey?: string;
  provider: ByokProviderId;
  apiKey: string;
  authSecret?: string;
  nowMs?: number;
  ttlMs?: number;
}): PublicByokProviderStatus {
  const scope = input.scopeKey || 'global';
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? BYOK_SESSION_TTL_MS;

  sweepExpiredByokKeys(nowMs);

  let scopeRecords = inMemoryScopes.get(scope);
  if (!scopeRecords) {
    scopeRecords = {};
    inMemoryScopes.set(scope, scopeRecords);
  }

  const trimmed = input.apiKey.trim();
  if (!trimmed) {
    delete scopeRecords[input.provider];
    if (Object.keys(scopeRecords).length === 0) {
      inMemoryScopes.delete(scope);
    }
    const verScope = inMemoryVerificationHistory.get(scope);
    if (verScope) {
      delete verScope[input.provider];
    }
    const meta = BYOK_PROVIDER_METADATA[input.provider];
    const isAlwaysFree =
      input.provider === 'gemini' || input.provider === 'openrouter';
    return {
      provider: input.provider,
      ...meta,
      configured: false,
      configuredInVault: false,
      configuredInEnv: false,
      effectiveActive: isAlwaysFree,
      source: 'none',
      resolutionTier: 'deterministic_fallback',
      resolutionLabel: isAlwaysFree
        ? 'Free • Always Available (Default: gemini-free)'
        : 'No Longer Free • Requires Key in Session BYOK Vault',
      maskedPreview: null,
      updatedAt: null,
      expiresAt: null,
      ttlSecondsRemaining: null,
      lastVerifiedAt: null,
      lastVerifyStatus: null,
      lastVerifyMessage: null,
      lastVerificationOk: null,
      lastVerificationMessage: null,
    };
  }

  const encrypted = encryptSecret(trimmed);
  const updatedIso = new Date(nowMs).toISOString();
  const expiresAtMs = nowMs + ttlMs;
  const record: EncryptedSecretRecord = {
    provider: input.provider,
    ...encrypted,
    maskedPreview: maskApiKey(trimmed),
    createdAtMs: nowMs,
    updatedAt: updatedIso,
    lastAccessedAtMs: nowMs,
    expiresAtMs,
    ttlMs,
    lastVerifiedAt: null,
    lastVerifyStatus: null,
    lastVerifyMessage: null,
  };

  scopeRecords[input.provider] = record;
  const verScope = inMemoryVerificationHistory.get(scope);
  if (verScope) {
    delete verScope[input.provider];
  }
  const meta = BYOK_PROVIDER_METADATA[input.provider];

  return {
    provider: input.provider,
    ...meta,
    configured: true,
    configuredInVault: true,
    configuredInEnv: false,
    effectiveActive: true,
    source: 'vault',
    resolutionTier: 'session_byok',
    resolutionLabel: 'Tier 1: Session BYOK Vault (AES-256-GCM in RAM)',
    maskedPreview: record.maskedPreview,
    updatedAt: record.updatedAt,
    expiresAt: new Date(record.expiresAtMs).toISOString(),
    ttlSecondsRemaining: Math.max(0, Math.floor((record.expiresAtMs - nowMs) / 1000)),
    lastVerifiedAt: null,
    lastVerifyStatus: null,
    lastVerifyMessage: null,
    lastVerificationOk: null,
    lastVerificationMessage: null,
  };
}

/**
 * Purges all BYOK keys stored in RAM under `scopeKey` (or all scopes when `clearAllDemoScopes: true`).
 */
export function clearByokScope(
  scopeKey = 'global',
  options?: { clearAllDemoScopes?: boolean }
): { clearedCount: number; scopeKey: string } {
  let clearedCount = 0;

  if (options?.clearAllDemoScopes) {
    for (const records of inMemoryScopes.values()) {
      if (records) {
        clearedCount += Object.keys(records).length;
      }
    }
    inMemoryScopes.clear();
    inMemoryVerificationHistory.clear();
  } else {
    const targetRecords = inMemoryScopes.get(scopeKey);
    if (targetRecords) {
      clearedCount += Object.keys(targetRecords).length;
      inMemoryScopes.delete(scopeKey);
    }
    inMemoryVerificationHistory.delete(scopeKey);
  }

  return { clearedCount, scopeKey };
}

export function recordByokVerificationResult(input: {
  scopeKey?: string;
  provider: ByokProviderId;
  verified: boolean;
  message: string;
  nowMs?: number;
}): void {
  const scope = input.scopeKey || 'global';
  const nowMs = input.nowMs ?? Date.now();
  sweepExpiredByokKeys(nowMs);

  const isoNow = new Date(nowMs).toISOString();
  const statusVal: 'verified' | 'failed' = input.verified ? 'verified' : 'failed';
  const safeMsg = redactSecretsFromText(input.message).slice(0, 240);

  let verScope = inMemoryVerificationHistory.get(scope);
  if (!verScope) {
    verScope = {};
    inMemoryVerificationHistory.set(scope, verScope);
  }
  verScope[input.provider] = {
    lastVerifiedAt: isoNow,
    lastVerifyStatus: statusVal,
    lastVerifyMessage: safeMsg,
  };

  const existing =
    inMemoryScopes.get(scope)?.[input.provider] ??
    (scope.startsWith('session:')
      ? undefined
      : inMemoryScopes.get('global')?.[input.provider]);

  if (existing) {
    existing.lastVerifiedAt = isoNow;
    existing.lastVerifyStatus = statusVal;
    existing.lastVerifyMessage = safeMsg;
    existing.lastAccessedAtMs = nowMs;
    existing.expiresAtMs = nowMs + existing.ttlMs;
  }
}

export function resolveEffectiveEnvWithByok(
  env: AppEnv,
  scopeKey = 'global',
  options?: { nowMs?: number; slideTtl?: boolean }
): AppEnv {
  const scopedRecords = getActiveScopeRecords(scopeKey, options);
  // Paid BYOK engines (ChatGPT, Claude, Grok) are no longer free and must strictly require a Session BYOK Vault key
  const resolved: AppEnv = {
    ...env,
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    XAI_API_KEY: '',
  };

  const geminiRec = scopedRecords.gemini;
  if (geminiRec) {
    const plain = decryptSecret(geminiRec);
    if (plain) resolved.GEMINI_API_KEY = plain;
  }

  const chatgptRec = scopedRecords.chatgpt;
  if (chatgptRec) {
    const plain = decryptSecret(chatgptRec);
    if (plain) resolved.OPENAI_API_KEY = plain;
  }

  const claudeRec = scopedRecords.claude;
  if (claudeRec) {
    const plain = decryptSecret(claudeRec);
    if (plain) resolved.ANTHROPIC_API_KEY = plain;
  }

  const grokRec = scopedRecords.grok;
  if (grokRec) {
    const plain = decryptSecret(grokRec);
    if (plain) resolved.XAI_API_KEY = plain;
  }

  const openrouterRec = scopedRecords.openrouter;
  if (openrouterRec) {
    const plain = decryptSecret(openrouterRec);
    if (plain) resolved.OPENROUTER_API_KEY = plain;
  }

  return resolved;
}

export function listByokProviderStatuses(
  env: AppEnv,
  scopeKey = 'global',
  options?: { nowMs?: number; slideTtl?: boolean }
): PublicByokProviderStatus[] {
  const nowMs = options?.nowMs ?? Date.now();
  const scopedRecords = getActiveScopeRecords(scopeKey, {
    nowMs,
    slideTtl: options?.slideTtl,
  });

  const isCleanEnvKey = (val: string | undefined): boolean => {
    const v = (val ?? '').trim();
    return Boolean(v && v !== 'replace-me' && v !== 'MY_GEMINI_API_KEY');
  };

  // Only gemini-free and openrouter-free use server .env keys.
  // ChatGPT, Claude, and Grok are no longer free and strictly require a Session BYOK Vault key.
  const envMap: Record<ByokProviderId, string | undefined> = {
    gemini: env.GEMINI_API_KEY || env.AI_PROVIDER_API_KEY,
    chatgpt: undefined,
    claude: undefined,
    grok: undefined,
    openrouter: env.OPENROUTER_API_KEY,
  };

  const providers: ByokProviderId[] = [
    'gemini',
    'openrouter',
    'chatgpt',
    'claude',
    'grok',
  ];

  const verHistory = inMemoryVerificationHistory.get(scopeKey);

  return providers.map((provider) => {
    const rec = scopedRecords[provider];
    const hasVault = Boolean(rec && decryptSecret(rec) !== null);
    const envRaw = envMap[provider];
    const hasEnv = isCleanEnvKey(envRaw);
    const meta = BYOK_PROVIDER_METADATA[provider];
    const isAlwaysFree = provider === 'gemini' || provider === 'openrouter';

    const resolutionTier: ByokResolutionTier = hasVault
      ? 'session_byok'
      : hasEnv
        ? 'server_env'
        : 'deterministic_fallback';

    const resolutionLabel =
      resolutionTier === 'session_byok'
        ? 'Tier 1: Session BYOK Key (AES-256-GCM in RAM)'
        : resolutionTier === 'server_env'
          ? 'Tier 2: Server Default Key (.env)'
          : isAlwaysFree
            ? 'Free • Always Available (Default: gemini-free)'
            : 'No Longer Free • Requires Key in Session BYOK Vault';

    const verRec = verHistory?.[provider];
    const lastVerifiedAt =
      (hasVault ? rec?.lastVerifiedAt : null) ??
      verRec?.lastVerifiedAt ??
      null;
    const lastVerifyStatus =
      (hasVault ? rec?.lastVerifyStatus : null) ??
      verRec?.lastVerifyStatus ??
      null;
    const lastVerifyMessage =
      (hasVault ? rec?.lastVerifyMessage : null) ??
      verRec?.lastVerifyMessage ??
      null;
    const lastVerificationOk =
      lastVerifyStatus === 'verified'
        ? true
        : lastVerifyStatus === 'failed'
          ? false
          : null;

    return {
      provider,
      ...meta,
      configured: hasVault || hasEnv,
      configuredInVault: hasVault,
      configuredInEnv: hasEnv,
      effectiveActive: hasVault || hasEnv || isAlwaysFree,
      source: hasVault ? 'vault' : hasEnv ? 'env' : 'none',
      resolutionTier,
      resolutionLabel,
      maskedPreview: hasVault
        ? rec!.maskedPreview
        : hasEnv
          ? '•••••••• (server env)'
          : null,
      updatedAt: hasVault ? rec!.updatedAt : null,
      expiresAt: hasVault ? new Date(rec!.expiresAtMs).toISOString() : null,
      ttlSecondsRemaining: hasVault
        ? Math.max(0, Math.floor((rec!.expiresAtMs - nowMs) / 1000))
        : null,
      lastVerifiedAt,
      lastVerifyStatus,
      lastVerifyMessage,
      lastVerificationOk,
      lastVerificationMessage: lastVerifyMessage,
    };
  });
}
