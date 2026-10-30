import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppEnv } from '../config/env';

/**
 * Ordaris BYOK Provider Integration & Encrypted Session-Isolated Secret Vault (`src/server/ai/byok-vault.ts`)
 *
 * - Encrypts user-supplied provider API keys at rest using AES-256-GCM derived from
 *   the server-side `AUTH_SECRET`. Plaintext keys are never returned to the browser
 *   or written to logs; only masked previews and connection status are exposed.
 * - Supports browser-session isolation (`session:<x-ordaris-demo-session>`) so visitors
 *   testing their own keys on the interactive demo sandbox never leak keys to other visitors.
 * - Supports 1-click key purging (`clearByokScope`) for the "Wipe Session BYOK Keys"
 *   and "Factory Reset Everything" workspace reset options.
 */

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

interface EncryptedSecretRecord {
  provider: ByokProviderId;
  ivHex: string;
  authTagHex: string;
  ciphertextHex: string;
  maskedPreview: string;
  updatedAt: string;
  lastVerifiedAt?: string | null;
  lastVerifyStatus?: 'verified' | 'failed' | null;
  lastVerifyMessage?: string | null;
}

interface VaultFilePayload {
  version: 1;
  scopes: Record<string, Partial<Record<ByokProviderId, EncryptedSecretRecord>>>;
}

export interface PublicByokProviderStatus {
  provider: ByokProviderId;
  configuredInVault: boolean;
  configuredInEnv: boolean;
  effectiveActive: boolean;
  source: 'vault' | 'env' | 'none';
  resolutionTier: ByokResolutionTier;
  resolutionLabel: string;
  maskedPreview: string | null;
  updatedAt: string | null;
  lastVerifiedAt: string | null;
  lastVerifyStatus: 'verified' | 'failed' | null;
  lastVerifyMessage: string | null;
}

const VAULT_FILE_PATH = path.resolve(process.cwd(), '.local', 'byok-vault.json');

const inMemoryVault: VaultFilePayload = {
  version: 1,
  scopes: {},
};

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
 * Resolves the isolated vault scope key for a request.
 * When `x-ordaris-demo-session` is provided, isolates keys strictly to that browser session.
 */
export function resolveByokScopeKey(input?: {
  sessionId?: string | null;
  organizationId?: string | null;
  fallbackScope?: string;
}): string {
  const rawSession = (input?.sessionId ?? '').trim();
  if (rawSession) {
    const cleanSession = rawSession.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (cleanSession.length >= 4) {
      return `session:${cleanSession}`;
    }
  }
  const rawOrg = (input?.organizationId ?? '').trim();
  if (rawOrg) {
    return `org:${rawOrg}`;
  }
  return input?.fallbackScope || 'global';
}

function deriveEncryptionKey(authSecret: string): Buffer {
  return crypto
    .createHash('sha256')
    .update(`ordaris-byok-v1:${authSecret}`)
    .digest();
}

function deriveLegacyEncryptionKey(authSecret: string): Buffer {
  return crypto
    .createHash('sha256')
    .update(`aegis-byok-v1:${authSecret}`)
    .digest();
}

function maskApiKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}••••`;
  }
  return `${trimmed.slice(0, 5)}••••${trimmed.slice(-4)}`;
}

function readVaultFromDisk(): VaultFilePayload {
  try {
    if (fs.existsSync(VAULT_FILE_PATH)) {
      const raw = fs.readFileSync(VAULT_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as VaultFilePayload;
      if (parsed && parsed.version === 1 && typeof parsed.scopes === 'object') {
        inMemoryVault.scopes = parsed.scopes;
      }
    }
  } catch {
    // Fall back to in-memory vault if disk read fails
  }
  return inMemoryVault;
}

function writeVaultToDisk(payload: VaultFilePayload): void {
  try {
    const dir = path.dirname(VAULT_FILE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(VAULT_FILE_PATH, JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // Ignore write failure in read-only test sandboxes
  }
}

export function encryptSecret(plaintext: string, authSecret: string): {
  ivHex: string;
  authTagHex: string;
  ciphertextHex: string;
} {
  const key = deriveEncryptionKey(authSecret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
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

export function decryptSecret(
  record: Pick<EncryptedSecretRecord, 'ivHex' | 'authTagHex' | 'ciphertextHex'>,
  authSecret: string
): string | null {
  for (const keyFn of [deriveEncryptionKey, deriveLegacyEncryptionKey]) {
    try {
      const key = keyFn(authSecret);
      const iv = Buffer.from(record.ivHex, 'hex');
      const authTag = Buffer.from(record.authTagHex, 'hex');
      const ciphertext = Buffer.from(record.ciphertextHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch {
      // Try next key derivation if applicable
    }
  }
  return null;
}

export function saveByokProviderKey(input: {
  scopeKey?: string;
  provider: ByokProviderId;
  apiKey: string;
  authSecret: string;
}): PublicByokProviderStatus {
  const scope = input.scopeKey || 'global';
  const vault = readVaultFromDisk();
  if (!vault.scopes[scope]) {
    vault.scopes[scope] = {};
  }

  const trimmed = input.apiKey.trim();
  if (!trimmed) {
    delete vault.scopes[scope]![input.provider];
    writeVaultToDisk(vault);
    return {
      provider: input.provider,
      configuredInVault: false,
      configuredInEnv: false,
      effectiveActive: false,
      source: 'none',
      resolutionTier: 'deterministic_fallback',
      resolutionLabel: 'Tier 3: Deterministic Simulation Fallback',
      maskedPreview: null,
      updatedAt: null,
      lastVerifiedAt: null,
      lastVerifyStatus: null,
      lastVerifyMessage: null,
    };
  }

  const encrypted = encryptSecret(trimmed, input.authSecret);
  const now = new Date().toISOString();
  const record: EncryptedSecretRecord = {
    provider: input.provider,
    ...encrypted,
    maskedPreview: maskApiKey(trimmed),
    updatedAt: now,
    lastVerifiedAt: null,
    lastVerifyStatus: null,
    lastVerifyMessage: null,
  };

  vault.scopes[scope]![input.provider] = record;
  writeVaultToDisk(vault);

  return {
    provider: input.provider,
    configuredInVault: true,
    configuredInEnv: false,
    effectiveActive: true,
    source: 'vault',
    resolutionTier: 'session_byok',
    resolutionLabel: 'Tier 1: Session BYOK Vault (AES-256-GCM)',
    maskedPreview: record.maskedPreview,
    updatedAt: record.updatedAt,
    lastVerifiedAt: null,
    lastVerifyStatus: null,
    lastVerifyMessage: null,
  };
}

/**
 * Purges all BYOK keys stored under `scopeKey` (or all session/global keys when `clearAllScopes: true`).
 * Used when the visitor selects "Wipe Session BYOK Keys Only" or "Factory Reset Everything".
 */
export function clearByokScope(
  scopeKey = 'global',
  options?: { clearAllDemoScopes?: boolean }
): { clearedCount: number; scopeKey: string } {
  const vault = readVaultFromDisk();
  let clearedCount = 0;

  if (options?.clearAllDemoScopes) {
    for (const key of Object.keys(vault.scopes)) {
      const records = vault.scopes[key];
      if (records) {
        clearedCount += Object.keys(records).length;
      }
      delete vault.scopes[key];
    }
  } else {
    const targetRecords = vault.scopes[scopeKey];
    if (targetRecords) {
      clearedCount += Object.keys(targetRecords).length;
      delete vault.scopes[scopeKey];
    }
  }

  writeVaultToDisk(vault);
  return { clearedCount, scopeKey };
}

export function recordByokVerificationResult(input: {
  scopeKey?: string;
  provider: ByokProviderId;
  verified: boolean;
  message: string;
}): void {
  const scope = input.scopeKey || 'global';
  const vault = readVaultFromDisk();
  const existing =
    vault.scopes[scope]?.[input.provider] ??
    vault.scopes.global?.[input.provider];
  if (existing) {
    existing.lastVerifiedAt = new Date().toISOString();
    existing.lastVerifyStatus = input.verified ? 'verified' : 'failed';
    existing.lastVerifyMessage = input.message.slice(0, 240);
    writeVaultToDisk(vault);
  }
}

export function resolveEffectiveEnvWithByok(
  env: AppEnv,
  scopeKey = 'global'
): AppEnv {
  const vault = readVaultFromDisk();
  // Session-isolated keys strictly override global keys; two different session:* scopes never mix
  const isSessionScope = scopeKey.startsWith('session:');
  const scopedRecords = isSessionScope
    ? { ...(vault.scopes[scopeKey] ?? {}) }
    : {
        ...(vault.scopes.global ?? {}),
        ...(vault.scopes[scopeKey] ?? {}),
      };

  const resolved: AppEnv = { ...env };

  const geminiRec = scopedRecords.gemini;
  if (geminiRec) {
    const plain = decryptSecret(geminiRec, env.AUTH_SECRET);
    if (plain) resolved.GEMINI_API_KEY = plain;
  }

  const chatgptRec = scopedRecords.chatgpt;
  if (chatgptRec) {
    const plain = decryptSecret(chatgptRec, env.AUTH_SECRET);
    if (plain) resolved.OPENAI_API_KEY = plain;
  }

  const claudeRec = scopedRecords.claude;
  if (claudeRec) {
    const plain = decryptSecret(claudeRec, env.AUTH_SECRET);
    if (plain) resolved.ANTHROPIC_API_KEY = plain;
  }

  const grokRec = scopedRecords.grok;
  if (grokRec) {
    const plain = decryptSecret(grokRec, env.AUTH_SECRET);
    if (plain) resolved.XAI_API_KEY = plain;
  }

  const openrouterRec = scopedRecords.openrouter;
  if (openrouterRec) {
    const plain = decryptSecret(openrouterRec, env.AUTH_SECRET);
    if (plain) resolved.OPENROUTER_API_KEY = plain;
  }

  return resolved;
}

export function listByokProviderStatuses(
  env: AppEnv,
  scopeKey = 'global'
): PublicByokProviderStatus[] {
  const vault = readVaultFromDisk();
  const isSessionScope = scopeKey.startsWith('session:');
  const scopedRecords = isSessionScope
    ? { ...(vault.scopes[scopeKey] ?? {}) }
    : {
        ...(vault.scopes.global ?? {}),
        ...(vault.scopes[scopeKey] ?? {}),
      };

  const isCleanEnvKey = (val: string | undefined): boolean => {
    const v = (val ?? '').trim();
    return Boolean(v && v !== 'replace-me' && v !== 'MY_GEMINI_API_KEY');
  };

  const envMap: Record<ByokProviderId, string | undefined> = {
    gemini: env.GEMINI_API_KEY || env.AI_PROVIDER_API_KEY,
    chatgpt: env.OPENAI_API_KEY,
    claude: env.ANTHROPIC_API_KEY,
    grok: env.XAI_API_KEY,
    openrouter: env.OPENROUTER_API_KEY,
  };

  const providers: ByokProviderId[] = [
    'gemini',
    'chatgpt',
    'claude',
    'grok',
    'openrouter',
  ];

  return providers.map((provider) => {
    const rec = scopedRecords[provider];
    const hasVault = Boolean(rec);
    const envRaw = envMap[provider];
    const hasEnv = isCleanEnvKey(envRaw);

    const resolutionTier: ByokResolutionTier = hasVault
      ? 'session_byok'
      : hasEnv
        ? 'server_env'
        : 'deterministic_fallback';

    const resolutionLabel =
      resolutionTier === 'session_byok'
        ? 'Tier 1: Session BYOK Key (AES-256-GCM)'
        : resolutionTier === 'server_env'
          ? 'Tier 2: Server Default Key (.env)'
          : 'Tier 3: Deterministic Simulation Fallback';

    return {
      provider,
      configuredInVault: hasVault,
      configuredInEnv: hasEnv,
      effectiveActive: hasVault || hasEnv,
      source: hasVault ? 'vault' : hasEnv ? 'env' : 'none',
      resolutionTier,
      resolutionLabel,
      maskedPreview: hasVault
        ? rec!.maskedPreview
        : hasEnv
          ? maskApiKey(envRaw!)
          : null,
      updatedAt: rec?.updatedAt ?? null,
      lastVerifiedAt: rec?.lastVerifiedAt ?? null,
      lastVerifyStatus: rec?.lastVerifyStatus ?? null,
      lastVerifyMessage: rec?.lastVerifyMessage ?? null,
    };
  });
}
