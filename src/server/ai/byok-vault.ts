/**
 * Re-exports the in-RAM AES-256-GCM Session Key Vault (`src/server/security/session-key-vault.ts`).
 */
export {
  BYOK_SESSION_TTL_MS,
  MIN_SESSION_TOKEN_LENGTH,
  MAX_SESSION_TOKEN_LENGTH,
  ByokSessionValidationError,
  rotateEphemeralMasterKey,
  generateByokSessionToken,
  isValidByokSessionToken,
  normalizeByokProviderId,
  resolveByokScopeKey,
  maskApiKey,
  encryptSecret,
  decryptSecret,
  sweepExpiredByokKeys,
  saveByokProviderKey,
  clearByokScope,
  recordByokVerificationResult,
  resolveEffectiveEnvWithByok,
  listByokProviderStatuses,
  type ByokProviderId,
  type ByokResolutionTier,
  type EncryptedSecretRecord,
  type PublicByokProviderStatus,
} from '../security/session-key-vault';
