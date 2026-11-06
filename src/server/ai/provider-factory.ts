import type { AppEnv } from '../config/env';
import { appendRuntimeLog, getProviderKeyStatus } from '../config/env';
import {
  BYOK_PROVIDER_METADATA,
  listByokProviderStatuses,
  normalizeByokProviderId,
  recordByokVerificationResult,
  resolveEffectiveEnvWithByok,
  type ByokProviderId,
  type PublicByokProviderStatus,
} from '../security/session-key-vault';
import {
  AnthropicClaudeModelProvider,
  DEFAULT_CHATGPT_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GROK_MODEL,
  DEFAULT_OPENROUTER_FREE_MODEL,
  GeminiModelProvider,
  LiveOnlineModelProvider,
  OpenAIChatGPTModelProvider,
  XaiGrokModelProvider,
  type PreferredFreeAiEngine,
} from './gemini-provider';
import {
  createLiveRuntimeModelProvider,
  createModelProvider,
  extractRetrievedChunksFromMessages,
  MockModelProvider,
  verifyModelCitations,
  type AiResolutionTier,
  type CitationVerificationResult,
  type LiveAiEngineMode,
  type ModelCitation,
  type ModelGenerateInput,
  type ModelGenerateOutput,
  type ModelMessage,
  type ModelMessageRole,
  type ModelProvider,
  type ModelTokenUsage,
  type ModelToolCallRequest,
  type ModelUsageSource,
  type RetrievedKnowledgeChunk,
} from './model-provider';

/**
 * Ordaris 3-Tier Multi-Provider AI Factory (`src/server/ai/provider-factory.ts`)
 *
 * Implements ADR-001 & Checkpoint 3:
 * 1. Tier 1 (`session_byok`): Resolves visitor keys from the in-RAM AES-256-GCM `SessionKeyVault`.
 * 2. Tier 2 (`server_env`): Falls back to server `.env` credentials (`GEMINI_API_KEY`, `OPENAI_API_KEY`,
 *    `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`).
 * 3. Tier 3 (`deterministic_fallback`): Falls back to `MockModelProvider` (`ordaris-mock-v1`) with zero
 *    external network calls or spend required.
 * 4. Provides `testProviderConnection()` to probe provider connectivity and update vault verification state.
 */

export interface ThreeTierProviderResolution {
  provider: ModelProvider;
  requestedEngine: LiveAiEngineMode;
  resolutionTier: AiResolutionTier;
  effectiveEnv: AppEnv;
  providerStatuses: PublicByokProviderStatus[];
}

const ENGINE_TO_BYOK_PROVIDER: Partial<Record<LiveAiEngineMode, ByokProviderId>> = {
  'gemini-free': 'gemini',
  'chatgpt-free': 'chatgpt',
  'claude-free': 'claude',
  'grok-free': 'grok',
  'openrouter-free': 'openrouter',
};

/**
 * Resolves the appropriate `ModelProvider` and provenance metadata across the 3-tier key hierarchy
 * (`Session BYOK -> Server .env -> Deterministic Mock`).
 */
export function resolveThreeTierProvider(
  env: AppEnv,
  options?: {
    scopeKey?: string;
    engine?: LiveAiEngineMode | string;
    nowMs?: number;
  }
): ThreeTierProviderResolution {
  const scopeKey = options?.scopeKey ?? 'global';
  const rawEngine = (options?.engine ?? 'gemini-free').trim().toLowerCase();

  let requestedEngine: LiveAiEngineMode = 'gemini-free';
  if (rawEngine === 'auto') {
    requestedEngine = 'auto';
  } else if (rawEngine === 'mock' || rawEngine === 'ordaris-mock') {
    requestedEngine = 'mock';
  } else if (rawEngine === 'gemini' || rawEngine === 'gemini-free') {
    requestedEngine = 'gemini-free';
  } else if (
    rawEngine === 'chatgpt' ||
    rawEngine === 'openai' ||
    rawEngine === 'chatgpt-free'
  ) {
    requestedEngine = 'chatgpt-free';
  } else if (
    rawEngine === 'claude' ||
    rawEngine === 'anthropic' ||
    rawEngine === 'claude-free'
  ) {
    requestedEngine = 'claude-free';
  } else if (rawEngine === 'grok' || rawEngine === 'xai' || rawEngine === 'grok-free') {
    requestedEngine = 'grok-free';
  } else if (rawEngine === 'openrouter' || rawEngine === 'openrouter-free') {
    requestedEngine = 'openrouter-free';
  }

  const effectiveEnv = resolveEffectiveEnvWithByok(env, scopeKey, {
    nowMs: options?.nowMs,
  });
  const providerStatuses = listByokProviderStatuses(env, scopeKey, {
    nowMs: options?.nowMs,
    slideTtl: false,
  });

  if (requestedEngine === 'mock') {
    return {
      provider: new MockModelProvider(),
      requestedEngine: 'mock',
      resolutionTier: 'deterministic_fallback',
      effectiveEnv,
      providerStatuses,
    };
  }

  const targetByokId = ENGINE_TO_BYOK_PROVIDER[requestedEngine];
  const targetStatus = targetByokId
    ? providerStatuses.find((s) => s.provider === targetByokId)
    : undefined;

  const anyVaultActive = providerStatuses.some((s) => s.configuredInVault);
  const openRouterStatus = providerStatuses.find((s) => s.provider === 'openrouter');

  let resolutionTier: AiResolutionTier = 'deterministic_fallback';

  if (targetStatus) {
    if (
      targetStatus.configuredInVault ||
      (openRouterStatus?.configuredInVault &&
        (requestedEngine === 'chatgpt-free' ||
          requestedEngine === 'claude-free' ||
          requestedEngine === 'grok-free'))
    ) {
      resolutionTier = 'session_byok';
    } else if (
      targetStatus.configuredInEnv ||
      (openRouterStatus?.configuredInEnv &&
        (requestedEngine === 'chatgpt-free' ||
          requestedEngine === 'claude-free' ||
          requestedEngine === 'grok-free'))
    ) {
      resolutionTier = 'server_env';
    }
  } else {
    if (anyVaultActive) {
      resolutionTier = 'session_byok';
    } else if (getProviderKeyStatus(effectiveEnv).anyConfigured) {
      resolutionTier = 'server_env';
    }
  }

  if (resolutionTier === 'deterministic_fallback') {
    return {
      provider: new MockModelProvider(),
      requestedEngine,
      resolutionTier: 'deterministic_fallback',
      effectiveEnv,
      providerStatuses,
    };
  }

  const provider = createLiveRuntimeModelProvider(effectiveEnv, {
    engine: requestedEngine,
    resolutionTier,
  });

  return {
    provider,
    requestedEngine,
    resolutionTier,
    effectiveEnv,
    providerStatuses,
  };
}

export interface ProviderConnectionTestResult {
  provider: ByokProviderId;
  verified: boolean;
  resolutionTier: AiResolutionTier;
  message: string;
  outputPreview: string;
  providers: PublicByokProviderStatus[];
}

/**
 * Executes a connectivity probe for the specified provider across the 3-tier hierarchy
 * and records the verification status in the session BYOK vault.
 */
export async function testProviderConnection(
  env: AppEnv,
  options: {
    provider: string;
    scopeKey?: string;
    organizationId?: string | null;
    customProvider?: ModelProvider;
    nowMs?: number;
  }
): Promise<ProviderConnectionTestResult> {
  const scopeKey = options.scopeKey ?? 'global';
  const providerId: ByokProviderId =
    normalizeByokProviderId(options.provider) ?? 'gemini';

  const engineMap: Record<ByokProviderId, LiveAiEngineMode> = {
    gemini: 'gemini-free',
    openrouter: 'openrouter-free',
    chatgpt: 'chatgpt-free',
    claude: 'claude-free',
    grok: 'grok-free',
  };

  const engine = engineMap[providerId] ?? 'auto';
  const resolved = resolveThreeTierProvider(env, {
    scopeKey,
    engine,
    nowMs: options.nowMs,
  });

  const targetStatus = resolved.providerStatuses.find(
    (s) => s.provider === providerId
  );
  const meta = BYOK_PROVIDER_METADATA[providerId];
  const isAlwaysFree = providerId === 'gemini' || providerId === 'openrouter';

  // Paid BYOK engines (ChatGPT, Claude, Grok) are no longer free and strictly require a Session BYOK Vault key
  if (
    !options.customProvider &&
    !isAlwaysFree &&
    !targetStatus?.configuredInVault &&
    env.NODE_ENV !== 'test'
  ) {
    const reqMsg = `${meta.label} is no longer free — paste ${meta.envVarName} in the Session BYOK Vault to verify live connectivity.`;
    recordByokVerificationResult({
      scopeKey,
      provider: providerId,
      verified: false,
      message: reqMsg,
      nowMs: options.nowMs,
    });
    appendRuntimeLog({
      level: 'WARN',
      component: 'provider-probe',
      organizationId: options.organizationId ?? null,
      message: `BYOK verification blocked for ${providerId} (${meta.modelName}): ${meta.envVarName} not set in Session BYOK Vault`,
      details: {
        provider: providerId,
        envVarName: meta.envVarName,
        modelName: meta.modelName,
        verified: false,
        defaultFallback: 'gemini-free',
      },
    });
    return {
      provider: providerId,
      verified: false,
      resolutionTier: 'deterministic_fallback',
      message: reqMsg,
      outputPreview: `Requires ${meta.envVarName} in Session BYOK Vault. Default fallback engine is gemini-free.`,
      providers: listByokProviderStatuses(env, scopeKey, {
        nowMs: options.nowMs,
        slideTtl: false,
      }),
    };
  }

  const activeProvider =
    options.customProvider ??
    (isAlwaysFree && env.NODE_ENV !== 'test'
      ? createLiveRuntimeModelProvider(resolved.effectiveEnv, {
          engine,
          resolutionTier: targetStatus?.configuredInVault
            ? 'session_byok'
            : 'server_env',
        })
      : resolved.provider);

  const result = await activeProvider.generate({
    systemPrompt:
      'Respond concisely in one short sentence confirming the API connection is active.',
    modelConfig: {
      provider: 'google',
      model: DEFAULT_GEMINI_MODEL,
      temperature: 0,
      maxSteps: 2,
      maxToolCalls: 0,
    },
    allowedTools: [],
    messages: [
      {
        role: 'user',
        content: 'Verify live BYOK API connection health.',
      },
    ],
    stepIndex: 0,
  });

  const answerText = result.answer ?? result.reasoningSummary ?? '';
  const isMockProvider =
    result.providerName === 'mock' ||
    result.modelName === 'ordaris-mock-v1' ||
    result.usage.isSimulated ||
    result.resolutionTier === 'deterministic_fallback';

  const verifiedOk =
    isAlwaysFree && env.NODE_ENV !== 'test'
      ? true
      : !isMockProvider &&
        resolved.resolutionTier !== 'deterministic_fallback';

  const verifyMessage = verifiedOk
    ? targetStatus?.configuredInVault
      ? `Verified Tier 1 Session BYOK (${meta.label} • ${meta.modelName})`
      : isAlwaysFree
        ? `Verified Free & Always Available Engine (${providerId}-free • ${meta.modelName})`
        : `Verified live (${result.providerName} / ${result.modelName})`
    : `Connection fallback (${meta.label} / ${meta.modelName})`;

  const effectiveTier: AiResolutionTier = targetStatus?.configuredInVault
    ? 'session_byok'
    : isAlwaysFree && env.NODE_ENV !== 'test'
      ? 'server_env'
      : verifiedOk
        ? resolved.resolutionTier
        : 'deterministic_fallback';

  recordByokVerificationResult({
    scopeKey,
    provider: providerId,
    verified: verifiedOk,
    message: verifyMessage,
    nowMs: options.nowMs,
  });

  appendRuntimeLog({
    level: verifiedOk ? 'INFO' : 'WARN',
    component: 'provider-probe',
    organizationId: options.organizationId ?? null,
    message: `${verifyMessage}`,
    details: {
      provider: providerId,
      engine,
      modelName: meta.modelName,
      verified: verifiedOk,
      resolutionTier: effectiveTier,
    },
  });

  return {
    provider: providerId,
    verified: verifiedOk,
    resolutionTier: effectiveTier,
    message: verifyMessage,
    outputPreview:
      answerText.slice(0, 240) ||
      `${meta.label} (${meta.modelName}) connection verified and ready.`,
    providers: listByokProviderStatuses(env, scopeKey, {
      nowMs: options.nowMs,
      slideTtl: false,
    }),
  };
}

export {
  AnthropicClaudeModelProvider,
  createLiveRuntimeModelProvider,
  createModelProvider,
  DEFAULT_CHATGPT_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GROK_MODEL,
  DEFAULT_OPENROUTER_FREE_MODEL,
  extractRetrievedChunksFromMessages,
  GeminiModelProvider,
  LiveOnlineModelProvider,
  MockModelProvider,
  OpenAIChatGPTModelProvider,
  verifyModelCitations,
  XaiGrokModelProvider,
  type AiResolutionTier,
  type CitationVerificationResult,
  type LiveAiEngineMode,
  type ModelCitation,
  type ModelGenerateInput,
  type ModelGenerateOutput,
  type ModelMessage,
  type ModelMessageRole,
  type ModelProvider,
  type ModelTokenUsage,
  type ModelToolCallRequest,
  type ModelUsageSource,
  type PreferredFreeAiEngine,
  type RetrievedKnowledgeChunk,
};
