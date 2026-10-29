import { createHash } from 'node:crypto';
import type { AgentModelConfig, AllowedToolName } from '../db/schema/agents';
import type { AppEnv } from '../config/env';
import { GeminiModelProvider } from './gemini-provider';

/**
 * Ticket AGENT-003: Provider-Neutral ModelProvider Interface & Deterministic MockModelProvider
 *
 * Implements Blueprint Section 6.1, Section 6.2 & ADR-001:
 * 1. Defines the provider-neutral `ModelProvider` contract consumed by the bounded agent runtime.
 * 2. Implements `MockModelProvider` (`AI_MODE=demo`) requiring zero API keys and zero network calls.
 * 3. Guarantees 100% deterministic tool call IDs, multi-step calculator & knowledge_search plans,
 *    grounded source citations, and simulated token usage labeled with `source: 'mock'` and `isSimulated: true`.
 * 4. Provides `verifyModelCitations()` to ensure models never attach fabricated chunk citations
 *    that were not actually returned by `knowledge_search` in the current run.
 */

export type ModelUsageSource = 'mock' | 'provider' | 'local';

export type ModelMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ModelToolCallRequest {
  id: string;
  name: AllowedToolName | string;
  arguments: Record<string, unknown>;
}

export interface RetrievedKnowledgeChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  score?: number;
}

export interface ModelCitation {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  quote: string;
}

export interface ModelMessage {
  role: ModelMessageRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ModelToolCallRequest[];
  toolOutput?: unknown;
}

export interface ModelGenerateInput {
  systemPrompt: string;
  modelConfig: AgentModelConfig;
  allowedTools: readonly AllowedToolName[];
  messages: readonly ModelMessage[];
  stepIndex?: number;
}

export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  source: ModelUsageSource;
  isSimulated: boolean;
}

export interface ModelGenerateOutput {
  finishReason: 'tool_calls' | 'stop';
  reasoningSummary: string;
  toolCalls: ModelToolCallRequest[];
  answer: string | null;
  citations: ModelCitation[];
  usage: ModelTokenUsage;
  providerName: string;
  modelName: string;
}

export interface ModelProvider {
  readonly providerName: string;
  readonly source: ModelUsageSource;
  generate(input: ModelGenerateInput): Promise<ModelGenerateOutput>;
  embedText(text: string, dimensions?: number): Promise<number[]>;
}

export interface CitationVerificationResult {
  verifiedCitations: ModelCitation[];
  rejectedChunkIds: string[];
}

/**
 * Extracts all `RetrievedKnowledgeChunk` records returned by `knowledge_search`
 * tool messages in the conversation history.
 */
export function extractRetrievedChunksFromMessages(
  messages: readonly ModelMessage[]
): RetrievedKnowledgeChunk[] {
  const chunksById = new Map<string, RetrievedKnowledgeChunk>();

  for (const message of messages) {
    if (message.role !== 'tool') {
      continue;
    }

    const candidates: unknown[] = [];

    if (
      message.toolOutput &&
      typeof message.toolOutput === 'object' &&
      'chunks' in message.toolOutput &&
      Array.isArray((message.toolOutput as { chunks?: unknown[] }).chunks)
    ) {
      candidates.push(...((message.toolOutput as { chunks: unknown[] }).chunks ?? []));
    } else if (message.content.trim().startsWith('{') || message.content.trim().startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(message.content);
        if (Array.isArray(parsed)) {
          candidates.push(...parsed);
        } else if (
          parsed &&
          typeof parsed === 'object' &&
          'chunks' in parsed &&
          Array.isArray((parsed as { chunks?: unknown[] }).chunks)
        ) {
          candidates.push(...((parsed as { chunks: unknown[] }).chunks ?? []));
        }
      } catch {
        // Ignore non-JSON tool message content
      }
    }

    for (const item of candidates) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const record = item as Record<string, unknown>;
      if (
        typeof record.chunkId === 'string' &&
        typeof record.documentId === 'string' &&
        typeof record.documentTitle === 'string' &&
        typeof record.content === 'string'
      ) {
        chunksById.set(record.chunkId, {
          chunkId: record.chunkId,
          documentId: record.documentId,
          documentTitle: record.documentTitle,
          content: record.content,
          score: typeof record.score === 'number' ? record.score : undefined,
        });
      }
    }
  }

  return Array.from(chunksById.values());
}

/**
 * Enforces Blueprint Section 6.2 & Threat T-02:
 * Ensures every citation returned by a model references a real `chunkId`
 * retrieved during the current run and normalizes `documentId` / `documentTitle`
 * from trusted server provenance metadata rather than trusting model strings.
 */
export function verifyModelCitations(
  proposedCitations: readonly ModelCitation[],
  retrievedChunks: readonly RetrievedKnowledgeChunk[]
): CitationVerificationResult {
  const chunkMap = new Map<string, RetrievedKnowledgeChunk>(
    retrievedChunks.map((chunk) => [chunk.chunkId, chunk])
  );

  const verifiedCitations: ModelCitation[] = [];
  const rejectedChunkIds: string[] = [];
  const seenChunkIds = new Set<string>();

  for (const citation of proposedCitations) {
    const trustedChunk = chunkMap.get(citation.chunkId);
    if (!trustedChunk) {
      rejectedChunkIds.push(citation.chunkId);
      continue;
    }

    if (seenChunkIds.has(citation.chunkId)) {
      continue;
    }
    seenChunkIds.add(citation.chunkId);

    verifiedCitations.push({
      chunkId: trustedChunk.chunkId,
      documentId: trustedChunk.documentId,
      documentTitle: trustedChunk.documentTitle,
      quote: citation.quote.trim() || trustedChunk.content.slice(0, 160),
    });
  }

  return {
    verifiedCitations,
    rejectedChunkIds,
  };
}

function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 1;
  }
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function createDeterministicId(prefix: string, seed: string): string {
  const digest = createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

function extractArithmeticExpression(prompt: string): string | null {
  // Match explicit arithmetic expressions such as "(145 * 12) + 380" or "2500 / 4 + 15"
  const match = prompt.match(
    /(?:\(\s*\d+(?:\.\d+)?(?:\s*[+\-*/]\s*\d+(?:\.\d+)?)+\s*\)|(?:\d+(?:\.\d+)?\s*[+\-*/]\s*)+\d+(?:\.\d+)?)(?:\s*[+\-*/]\s*(?:\(\s*\d+(?:\.\d+)?(?:\s*[+\-*/]\s*\d+(?:\.\d+)?)+\s*\)|\d+(?:\.\d+)?))*/
  );
  return match ? match[0].trim() : null;
}

function extractSearchQuery(prompt: string): string | null {
  const explicitTag = prompt.match(/\[search:\s*([^\]]+)\]/i);
  if (explicitTag?.[1]) {
    return explicitTag[1].trim();
  }

  const normalized = prompt.toLowerCase();
  const knowledgeKeywords = [
    'policy',
    'runbook',
    'incident',
    'sla',
    'onboarding',
    'security',
    'documentation',
    'knowledge',
    'search',
    'guide',
    'procedure',
    'according to',
    'what is our',
    'retention',
    'escalation',
  ];

  const hasKeyword = knowledgeKeywords.some((kw) => normalized.includes(kw));
  if (!hasKeyword) {
    return null;
  }

  // Strip control tags like [mock:...] and clean punctuation for search query
  const cleaned = prompt
    .replace(/\[mock:[^\]]+\]/gi, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.slice(0, 120) || 'general knowledge query';
}

export class MockModelProvider implements ModelProvider {
  public readonly providerName = 'aegis-mock';
  public readonly source: ModelUsageSource = 'mock';

  public async generate(input: ModelGenerateInput): Promise<ModelGenerateOutput> {
    const stepIndex = input.stepIndex ?? 1;
    const modelName = input.modelConfig.model || 'aegis-mock-v1';

    const latestUserMessage =
      [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    const completedToolNames = new Set<string>(
      input.messages
        .filter((m) => m.role === 'tool' && Boolean(m.toolName))
        .map((m) => String(m.toolName))
    );

    const serializedInput = JSON.stringify({
      systemPrompt: input.systemPrompt,
      messages: input.messages.map((m) => ({
        role: m.role,
        content: m.content,
        toolName: m.toolName,
      })),
    });
    const inputTokens = estimateTokens(serializedInput);

    const buildOutput = (params: {
      finishReason: 'tool_calls' | 'stop';
      reasoningSummary: string;
      toolCalls?: ModelToolCallRequest[];
      answer?: string | null;
      citations?: ModelCitation[];
    }): ModelGenerateOutput => {
      const toolCalls = params.toolCalls ?? [];
      const answer = params.answer ?? null;
      const citations = params.citations ?? [];
      const serializedOutput = JSON.stringify({
        reasoningSummary: params.reasoningSummary,
        toolCalls,
        answer,
        citations,
      });
      const outputTokens = estimateTokens(serializedOutput);

      return {
        finishReason: params.finishReason,
        reasoningSummary: params.reasoningSummary,
        toolCalls,
        answer,
        citations,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          estimatedCostUsd: 0,
          source: 'mock',
          isSimulated: true,
        },
        providerName: this.providerName,
        modelName,
      };
    };

    // 1. Deterministic Security & Fault-Injection Directives for Automated Testing
    if (latestUserMessage.includes('[mock:unauthorized-tool]')) {
      const callId = createDeterministicId('call', `${latestUserMessage}:${stepIndex}:unauth`);
      return buildOutput({
        finishReason: 'tool_calls',
        reasoningSummary:
          'Mock directive [mock:unauthorized-tool]: requesting non-allowlisted tool shell_exec to test gateway denial.',
        toolCalls: [
          {
            id: callId,
            name: 'shell_exec',
            arguments: { command: 'whoami' },
          },
        ],
      });
    }

    if (latestUserMessage.includes('[mock:malformed-tool-args]')) {
      const callId = createDeterministicId('call', `${latestUserMessage}:${stepIndex}:badargs`);
      return buildOutput({
        finishReason: 'tool_calls',
        reasoningSummary:
          'Mock directive [mock:malformed-tool-args]: emitting malformed calculator arguments to test Zod schema validation.',
        toolCalls: [
          {
            id: callId,
            name: 'calculator',
            arguments: { expression: '' },
          },
        ],
      });
    }

    if (latestUserMessage.includes('[mock:infinite-loop]')) {
      const callId = createDeterministicId('call', `${latestUserMessage}:${stepIndex}:loop`);
      return buildOutput({
        finishReason: 'tool_calls',
        reasoningSummary: `Mock directive [mock:infinite-loop]: requesting repeated calculator call at step ${stepIndex} to test budget limits.`,
        toolCalls: [
          {
            id: callId,
            name: 'calculator',
            arguments: { expression: `${stepIndex} + 1` },
          },
        ],
      });
    }

    // 2. Plan Pending Tool Calls Based on User Prompt & Agent Tool Allowlist
    const pendingToolCalls: ModelToolCallRequest[] = [];

    const canUseCalculator = input.allowedTools.includes('calculator');
    const arithmeticExpression = extractArithmeticExpression(latestUserMessage);

    if (
      canUseCalculator &&
      arithmeticExpression &&
      !completedToolNames.has('calculator')
    ) {
      pendingToolCalls.push({
        id: createDeterministicId('call_calc', `${latestUserMessage}:${arithmeticExpression}:${stepIndex}`),
        name: 'calculator',
        arguments: { expression: arithmeticExpression },
      });
    }

    const canUseKnowledgeSearch = input.allowedTools.includes('knowledge_search');
    const searchQuery = extractSearchQuery(latestUserMessage);

    if (
      canUseKnowledgeSearch &&
      searchQuery &&
      !completedToolNames.has('knowledge_search')
    ) {
      pendingToolCalls.push({
        id: createDeterministicId('call_search', `${latestUserMessage}:${searchQuery}:${stepIndex}`),
        name: 'knowledge_search',
        arguments: { query: searchQuery, limit: 3 },
      });
    }

    if (pendingToolCalls.length > 0) {
      const toolNamesList = pendingToolCalls.map((tc) => tc.name).join(', ');
      return buildOutput({
        finishReason: 'tool_calls',
        reasoningSummary: `Deterministic mock planner selected tool(s) [${toolNamesList}] for step ${stepIndex}.`,
        toolCalls: pendingToolCalls,
      });
    }

    // 3. Synthesize Grounded Final Answer from Tool Outputs & Conversation Context
    const calculatorMessages = input.messages.filter(
      (m) => m.role === 'tool' && m.toolName === 'calculator'
    );
    const retrievedChunks = extractRetrievedChunksFromMessages(input.messages);

    const answerParts: string[] = [];
    const proposedCitations: ModelCitation[] = [];

    if (calculatorMessages.length > 0) {
      const lastCalc = calculatorMessages[calculatorMessages.length - 1];
      let formattedResult = lastCalc.content;

      if (
        lastCalc.toolOutput &&
        typeof lastCalc.toolOutput === 'object' &&
        'result' in lastCalc.toolOutput
      ) {
        const resVal = (lastCalc.toolOutput as { result: unknown }).result;
        formattedResult = String(resVal);
      } else {
        try {
          const parsed: unknown = JSON.parse(lastCalc.content);
          if (parsed && typeof parsed === 'object' && 'result' in parsed) {
            formattedResult = String((parsed as { result: unknown }).result);
          }
        } catch {
          // Keep raw string content
        }
      }

      answerParts.push(`Calculation result: ${formattedResult}.`);
    }

    if (retrievedChunks.length > 0) {
      const summaries = retrievedChunks.map((chunk) => {
        const snippet = chunk.content.trim().slice(0, 140);
        proposedCitations.push({
          chunkId: chunk.chunkId,
          documentId: chunk.documentId,
          documentTitle: chunk.documentTitle,
          quote: snippet,
        });
        return `According to "${chunk.documentTitle}" [${chunk.chunkId}]: ${snippet}`;
      });
      answerParts.push(summaries.join(' '));
    }

    if (latestUserMessage.includes('[mock:unverified-citation]')) {
      proposedCitations.push({
        chunkId: 'chunk_fabricated_999999',
        documentId: 'doc_fabricated_999999',
        documentTitle: 'Fabricated External Document',
        quote: 'This citation was never retrieved from the knowledge base.',
      });
    }

    const { verifiedCitations } = verifyModelCitations(
      proposedCitations,
      retrievedChunks
    );

    if (answerParts.length === 0) {
      const cleanPrompt = latestUserMessage.replace(/\[mock:[^\]]+\]/gi, '').trim();
      answerParts.push(
        `Deterministic mock response (${modelName}): Processed request "${cleanPrompt || 'empty prompt'}".`
      );
    }

    return buildOutput({
      finishReason: 'stop',
      reasoningSummary: `Synthesized deterministic final response at step ${stepIndex} with ${verifiedCitations.length} verified citation(s).`,
      answer: answerParts.join(' '),
      citations: verifiedCitations,
    });
  }

  /**
   * Generates a deterministic, unit-normalized embedding vector (L2 norm = 1.0)
   * using SHA-256 token projection so local similarity tests require zero network calls.
   */
  public async embedText(text: string, dimensions = 64): Promise<number[]> {
    if (dimensions <= 0 || !Number.isInteger(dimensions)) {
      throw new Error(`Invalid embedding dimensions: ${dimensions}`);
    }

    const vector = new Array<number>(dimensions).fill(0);
    const tokens = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    const effectiveTokens = tokens.length > 0 ? tokens : ['__empty__'];

    for (const token of effectiveTokens) {
      const digest = createHash('sha256').update(token, 'utf8').digest();
      for (let i = 0; i < dimensions; i++) {
        const byteVal = digest[i % digest.length];
        // Map [0..255] -> [-1..1]
        const weight = byteVal / 127.5 - 1;
        vector[i] += weight;
      }
    }

    const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (norm === 0) {
      vector[0] = 1;
      return vector;
    }

    return vector.map((val) => Number((val / norm).toFixed(8)));
  }
}

/**
 * Factory that resolves the configured `ModelProvider` from validated environment config.
 * Defaults to `MockModelProvider` in `AI_MODE=demo` and `AI_MODE=local`.
 * Routes to `GeminiModelProvider` when `AI_MODE=provider`.
 */
export function createModelProvider(
  env: Pick<AppEnv, 'AI_MODE' | 'AI_PROVIDER_MODEL'> & {
    AI_PROVIDER_API_KEY?: string;
    GEMINI_API_KEY?: string;
  },
  customProvider?: ModelProvider
): ModelProvider {
  if (customProvider) {
    return customProvider;
  }

  if (env.AI_MODE === 'demo' || env.AI_MODE === 'local') {
    return new MockModelProvider();
  }

  const apiKey = (
    env.AI_PROVIDER_API_KEY ||
    env.GEMINI_API_KEY ||
    process.env.AI_PROVIDER_API_KEY ||
    process.env.GEMINI_API_KEY ||
    ''
  ).trim();

  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey === 'replace-me') {
    throw new Error(
      `AI_MODE="provider" requires a valid server-side AI_PROVIDER_API_KEY or GEMINI_API_KEY for model "${env.AI_PROVIDER_MODEL}". Use AI_MODE="demo" for zero-key deterministic execution.`
    );
  }

  return new GeminiModelProvider({
    apiKey,
    defaultModel: env.AI_PROVIDER_MODEL,
  });
}

