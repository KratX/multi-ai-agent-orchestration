import type { AppEnv } from '../config/env';
import { getProviderKeyStatus } from '../config/env';
import {
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
  const rawEngine = (options?.engine ?? 'auto').trim().toLowerCase();

  let requestedEngine: LiveAiEngineMode = 'auto';
  if (rawEngine === 'mock' || rawEngine === 'ordaris-mock') {
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

  const activeProvider = options.customProvider ?? resolved.provider;

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
  const isFallback =
    result.usage.isSimulated ||
    result.usage.source === 'mock' ||
    result.resolutionTier === 'deterministic_fallback' ||
    result.modelName.includes('fallback') ||
    result.modelName.includes('mock');

  const verifyMessage = isFallback
    ? `Tier 3 Deterministic Fallback used (${result.providerName} / ${result.modelName})`
    : `Verified live (${result.providerName} / ${result.modelName})`;

  recordByokVerificationResult({
    scopeKey,
    provider: providerId,
    verified: !isFallback,
    message: verifyMessage,
    nowMs: options.nowMs,
  });

  return {
    provider: providerId,
    verified: !isFallback,
    resolutionTier: isFallback ? 'deterministic_fallback' : resolved.resolutionTier,
    message: verifyMessage,
    outputPreview: answerText.slice(0, 240),
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
