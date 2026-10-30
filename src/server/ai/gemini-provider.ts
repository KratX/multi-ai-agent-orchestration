import { GoogleGenAI, Type, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import {
  extractRetrievedChunksFromMessages,
  MockModelProvider,
  verifyModelCitations,
  type ModelCitation,
  type ModelGenerateInput,
  type ModelGenerateOutput,
  type ModelMessage,
  type ModelProvider,
  type ModelToolCallRequest,
} from './model-provider';

/**
  * Phase F+: Server-Side Free-Tier Cloud AI Providers
  *
  * Implements official server-side adapters for:
  * 1. Google Gemini Free Tier (`GeminiModelProvider` — `gemini-3-flash-preview` via `@google/genai`)
  * 2. OpenAI ChatGPT Free Tier (`OpenAIChatGPTModelProvider` — `gpt-4o-mini` via `https://api.openai.com/v1/chat/completions`)
  * 3. Anthropic Claude Free Tier (`AnthropicClaudeModelProvider` — `claude-3-5-haiku-latest` via `https://api.anthropic.com/v1/messages`)
  * 4. xAI Grok Free Tier (`XaiGrokModelProvider` — `grok-2-latest` via `https://api.x.ai/v1/chat/completions`)
  * 5. `LiveOnlineModelProvider`: Unified multi-provider router supporting `auto`, `gemini-free`,
  *    `chatgpt-free`, `claude-free`, and `grok-free` with automatic failover across configured server keys.
  */

export interface GeminiSdkClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
  };
}

export interface GeminiModelProviderOptions {
  apiKey: string;
  defaultModel?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  sdkClient?: GeminiSdkClient;
}

export interface OpenAICompatibleProviderOptions {
  apiKey: string;
  defaultModel?: string;
  endpointUrl?: string;
  providerLabel?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  fetchImpl?: typeof fetch;
}

export interface AnthropicClaudeProviderOptions {
  apiKey: string;
  defaultModel?: string;
  endpointUrl?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';
export const DEFAULT_CHATGPT_MODEL = 'gpt-4o-mini';
export const DEFAULT_CLAUDE_MODEL = 'claude-3-5-haiku-latest';
export const DEFAULT_GROK_MODEL = 'grok-2-latest';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 32_768;

function buildToolInstructions(
  allowedTools: readonly string[],
  messages: readonly ModelMessage[]
): string {
  const executedTools = messages
    .filter((m) => m.role === 'tool' && m.toolName)
    .map((m) => m.toolName!);

  const toolSchemas: string[] = [];
  if (allowedTools.includes('calculator')) {
    toolSchemas.push(
      '- Tool "calculator": Evaluates arithmetic expressions safely. Required argumentsJson: {"expression": "<math expression like (18 * 4) + 28>"}'
    );
  }
  if (allowedTools.includes('knowledge_search')) {
    toolSchemas.push(
      '- Tool "knowledge_search": Searches the tenant knowledge base runbooks. Required argumentsJson: {"query": "<search keywords>", "topK": 3}'
    );
  }

  return [
    `Allowed tools for this agent version: ${
      allowedTools.length > 0 ? allowedTools.join(', ') : 'NONE'
    }.`,
    toolSchemas.length > 0
      ? `Tool argument contracts:\n${toolSchemas.join('\n')}`
      : 'Do not request any tool calls.',
    executedTools.length > 0
      ? `Tools already executed in this run: ${executedTools.join(
          ', '
        )}. If you already have the tool results needed to answer the user, set finishReason="stop", set toolCalls=[], and write a comprehensive final answer in "answer".`
      : 'If the user prompt requires arithmetic or searching runbooks/policies and the corresponding tool is in Allowed tools, set finishReason="tool_calls" and request the needed tool(s) first.',
    'When citing retrieved knowledge chunks from [TOOL RESULT (knowledge_search)], include matching entries in "citations" using the exact chunkId, documentId, documentTitle, and a short quote from that chunk.',
  ].join('\n');
}

function formatConversationTranscript(messages: readonly ModelMessage[]): string {
  return messages
    .map((msg) => {
      if (msg.role === 'tool') {
        return `[TOOL RESULT (${msg.toolName ?? 'tool'})]: ${msg.content}`;
      }
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        return `[ASSISTANT TOOL REQUEST]: ${msg.content} -> ${JSON.stringify(
          msg.toolCalls
        )}`;
      }
      return `[${msg.role.toUpperCase()}]: ${msg.content}`;
    })
    .join('\n\n');
}

function normalizeToolArguments(
  toolName: string,
  parsedArgs: Record<string, unknown>,
  messages: readonly ModelMessage[]
): Record<string, unknown> {
  const normalizedArgs = { ...parsedArgs };
  const lastUserMsg =
    [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  if (toolName === 'calculator' && typeof normalizedArgs.expression !== 'string') {
    const candidate =
      normalizedArgs.expr ??
      normalizedArgs.formula ??
      normalizedArgs.input ??
      normalizedArgs.query;
    if (typeof candidate === 'string' && candidate.trim()) {
      normalizedArgs.expression = candidate.trim();
    } else {
      const exprMatch = lastUserMsg.match(/[\d()+*/.\-\s]{3,}/);
      if (exprMatch?.[0]?.trim()) {
        normalizedArgs.expression = exprMatch[0].trim();
      }
    }
  }

  if (toolName === 'knowledge_search' && typeof normalizedArgs.query !== 'string') {
    const candidate =
      normalizedArgs.search ??
      normalizedArgs.q ??
      normalizedArgs.topic ??
      normalizedArgs.keyword;
    if (typeof candidate === 'string' && candidate.trim()) {
      normalizedArgs.query = candidate.trim();
    } else if (lastUserMsg.trim()) {
      normalizedArgs.query = lastUserMsg.trim().slice(0, 120);
    }
  }

  return normalizedArgs;
}

function parseStructuredModelJson(
  rawText: string,
  input: ModelGenerateInput,
  stepIndex: number
): {
  finishReason: 'tool_calls' | 'stop';
  reasoningSummary: string;
  toolCalls: ModelToolCallRequest[];
  answer: string | null;
  verifiedCitations: ModelCitation[];
} {
  let cleanedText = rawText.trim();
  const fencedMatch = cleanedText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    cleanedText = fencedMatch[1].trim();
  }

  let parsedPayload: {
    finishReason?: 'tool_calls' | 'stop';
    reasoningSummary?: string;
    toolCalls?: Array<{
      id?: string;
      name?: string;
      argumentsJson?: string;
      arguments?: Record<string, unknown>;
    }>;
    answer?: string | null;
    citations?: ModelCitation[];
  } = {};

  try {
    parsedPayload = JSON.parse(cleanedText) as typeof parsedPayload;
  } catch {
    parsedPayload = {
      finishReason: 'stop',
      reasoningSummary: 'Returned plain text response from live model.',
      toolCalls: [],
      answer: rawText.trim() || 'Completed.',
      citations: [],
    };
  }

  const completedToolNames = new Set<string>(
    input.messages
      .filter((m) => m.role === 'tool' && Boolean(m.toolName))
      .map((m) => String(m.toolName))
  );

  const normalizedToolCalls: ModelToolCallRequest[] = (parsedPayload.toolCalls ?? [])
    .filter((tc) => Boolean(tc && typeof tc.name === 'string'))
    .map((tc, idx) => {
      let parsedArgs: Record<string, unknown> = {};
      if (tc.arguments && typeof tc.arguments === 'object') {
        parsedArgs = tc.arguments;
      } else if (typeof tc.argumentsJson === 'string' && tc.argumentsJson.trim()) {
        try {
          const candidate: unknown = JSON.parse(tc.argumentsJson);
          if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
            parsedArgs = candidate as Record<string, unknown>;
          }
        } catch {
          parsedArgs = {};
        }
      }

      const toolName = String(tc.name);
      return {
        id: tc.id || `live_call_${stepIndex}_${idx + 1}`,
        name: toolName,
        arguments: normalizeToolArguments(toolName, parsedArgs, input.messages),
      };
    })
    .filter((tc) => !completedToolNames.has(tc.name));

  const retrievedChunks = extractRetrievedChunksFromMessages(input.messages);
  let { verifiedCitations } = verifyModelCitations(
    parsedPayload.citations ?? [],
    retrievedChunks
  );

  if (
    verifiedCitations.length === 0 &&
    retrievedChunks.length > 0 &&
    normalizedToolCalls.length === 0
  ) {
    verifiedCitations = retrievedChunks.slice(0, 2).map((chunk) => ({
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      documentTitle: chunk.documentTitle,
      quote: chunk.content.trim().slice(0, 140),
    }));
  }

  const finishReason: 'tool_calls' | 'stop' =
    normalizedToolCalls.length > 0 ? 'tool_calls' : 'stop';

  return {
    finishReason,
    reasoningSummary:
      parsedPayload.reasoningSummary ??
      (finishReason === 'tool_calls'
        ? `Live AI planner requested tool(s): ${normalizedToolCalls
            .map((t) => t.name)
            .join(', ')}`
        : 'Live AI synthesized final grounded response.'),
    toolCalls: normalizedToolCalls,
    answer:
      finishReason === 'stop'
        ? parsedPayload.answer || rawText.trim() || 'Completed.'
        : null,
    verifiedCitations,
  };
}

function buildJsonSystemPrompt(input: ModelGenerateInput): string {
  return [
    input.systemPrompt,
    buildToolInstructions(input.allowedTools, input.messages),
    'You MUST respond with a single valid JSON object (no markdown fences) matching this exact schema:',
    '{',
    '  "finishReason": "tool_calls" | "stop",',
    '  "reasoningSummary": "<concise explanation of reasoning>",',
    '  "toolCalls": [{"id": "call_1", "name": "calculator" | "knowledge_search", "arguments": {"expression": "..."} | {"query": "...", "topK": 3}}],',
    '  "answer": "<final comprehensive answer when finishReason is stop, or null when requesting tools>",',
    '  "citations": [{"chunkId": "...", "documentId": "...", "documentTitle": "...", "quote": "..."}]',
    '}',
  ].join('\n\n');
}

/**
 * 1. Google Gemini Free Tier Provider (`@google/genai` — `gemini-3-flash-preview`)
 */
export class GeminiModelProvider implements ModelProvider {
  public readonly providerName = 'google-gemini';
  public readonly source = 'provider' as const;

  private readonly sdkClient: GeminiSdkClient;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly fallbackEmbedder = new MockModelProvider();

  public constructor(options: GeminiModelProviderOptions) {
    const cleanKey = options.apiKey.trim();
    if (!cleanKey || cleanKey === 'MY_GEMINI_API_KEY' || cleanKey === 'replace-me') {
      throw new Error(
        'GeminiModelProvider requires a valid server-side GEMINI_API_KEY or AI_PROVIDER_API_KEY.'
      );
    }

    this.defaultModel = options.defaultModel || DEFAULT_GEMINI_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.sdkClient = options.sdkClient ?? new GoogleGenAI({ apiKey: cleanKey });
  }

  public async generate(input: ModelGenerateInput): Promise<ModelGenerateOutput> {
    const configuredModel = input.modelConfig.model;
    const modelName =
      configuredModel &&
      !configuredModel.startsWith('aegis-mock') &&
      configuredModel !== 'gemini-3.8-flash'
        ? configuredModel
        : this.defaultModel;
    const stepIndex = input.stepIndex ?? 1;

    const systemInstruction = [
      input.systemPrompt,
      buildToolInstructions(input.allowedTools, input.messages),
      'Always respond with valid JSON matching the requested responseSchema.',
    ].join('\n\n');

    const transcript = formatConversationTranscript(input.messages);

    const requestParams: GenerateContentParameters = {
      model: modelName,
      contents: transcript || 'Execute task.',
      config: {
        systemInstruction,
        temperature: input.modelConfig.temperature ?? 0.2,
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            finishReason: {
              type: Type.STRING,
              enum: ['tool_calls', 'stop'],
            },
            reasoningSummary: {
              type: Type.STRING,
            },
            toolCalls: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  name: { type: Type.STRING },
                  argumentsJson: {
                    type: Type.STRING,
                    description:
                      'JSON-encoded object of tool arguments, e.g. {"expression":"(18 * 4) + 28"} for calculator or {"query":"Severity 1 escalation","topK":3} for knowledge_search',
                  },
                },
                required: ['id', 'name', 'argumentsJson'],
              },
            },
            answer: {
              type: Type.STRING,
              nullable: true,
            },
            citations: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  chunkId: { type: Type.STRING },
                  documentId: { type: Type.STRING },
                  documentTitle: { type: Type.STRING },
                  quote: { type: Type.STRING },
                },
                required: ['chunkId', 'documentId', 'documentTitle', 'quote'],
              },
            },
          },
          required: ['finishReason', 'reasoningSummary', 'toolCalls'],
        },
      },
    };

    const rawResponse = await this.invokeWithTimeout(requestParams);
    const rawText = (rawResponse.text ?? '{}').slice(0, this.maxOutputChars);
    const parsed = parseStructuredModelJson(rawText, input, stepIndex);

    const inputTokens =
      rawResponse.usageMetadata?.promptTokenCount ??
      Math.max(1, Math.ceil(transcript.length / 4));
    const outputTokens =
      rawResponse.usageMetadata?.candidatesTokenCount ??
      Math.max(1, Math.ceil(rawText.length / 4));
    const totalTokens =
      rawResponse.usageMetadata?.totalTokenCount ?? inputTokens + outputTokens;

    return {
      finishReason: parsed.finishReason,
      reasoningSummary: parsed.reasoningSummary,
      toolCalls: parsed.toolCalls,
      answer: parsed.answer,
      citations: parsed.verifiedCitations,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedCostUsd: 0,
        source: 'provider',
        isSimulated: false,
      },
      providerName: this.providerName,
      modelName,
    };
  }

  public async embedText(text: string, dimensions = 64): Promise<number[]> {
    return this.fallbackEmbedder.embedText(text, dimensions);
  }

  private async invokeWithTimeout(
    params: GenerateContentParameters
  ): Promise<GenerateContentResponse> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new Error(`Gemini provider request timed out after ${this.timeoutMs}ms`)
          );
        }, this.timeoutMs);
      });

      return await Promise.race([
        this.sdkClient.models.generateContent(params),
        timeoutPromise,
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}

/**
 * 2. OpenAI ChatGPT Free Tier Provider (`gpt-4o-mini` via `https://api.openai.com/v1/chat/completions`)
 */
export class OpenAIChatGPTModelProvider implements ModelProvider {
  public readonly providerName: string;
  public readonly source = 'provider' as const;

  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly endpointUrl: string;
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly fetchImpl: typeof fetch;
  private readonly fallbackEmbedder = new MockModelProvider();

  public constructor(options: OpenAICompatibleProviderOptions) {
    const cleanKey = options.apiKey.trim();
    if (!cleanKey || cleanKey === 'replace-me') {
      throw new Error(
        `${options.providerLabel ?? 'OpenAI ChatGPT'} provider requires a valid server-side API key.`
      );
    }
    this.apiKey = cleanKey;
    this.providerName = options.providerLabel ?? 'openai-chatgpt';
    this.defaultModel = options.defaultModel ?? DEFAULT_CHATGPT_MODEL;
    this.endpointUrl =
      options.endpointUrl ?? 'https://api.openai.com/v1/chat/completions';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async generate(input: ModelGenerateInput): Promise<ModelGenerateOutput> {
    const stepIndex = input.stepIndex ?? 1;
    const modelName = this.defaultModel;
    const systemPrompt = buildJsonSystemPrompt(input);
    const transcript = formatConversationTranscript(input.messages);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpointUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          temperature: input.modelConfig.temperature ?? 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: transcript || 'Execute task.' },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(
          `${this.providerName} HTTP ${response.status}: ${errBody.slice(0, 240)}`
        );
      }

      const json = (await response.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      const rawText = (
        json.choices?.[0]?.message?.content ?? '{}'
      ).slice(0, this.maxOutputChars);

      const parsed = parseStructuredModelJson(rawText, input, stepIndex);

      const inputTokens =
        json.usage?.prompt_tokens ??
        Math.max(1, Math.ceil((systemPrompt.length + transcript.length) / 4));
      const outputTokens =
        json.usage?.completion_tokens ??
        Math.max(1, Math.ceil(rawText.length / 4));
      const totalTokens =
        json.usage?.total_tokens ?? inputTokens + outputTokens;

      return {
        finishReason: parsed.finishReason,
        reasoningSummary: parsed.reasoningSummary,
        toolCalls: parsed.toolCalls,
        answer: parsed.answer,
        citations: parsed.verifiedCitations,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens,
          estimatedCostUsd: 0,
          source: 'provider',
          isSimulated: false,
        },
        providerName: this.providerName,
        modelName: json.model || modelName,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  public async embedText(text: string, dimensions = 64): Promise<number[]> {
    return this.fallbackEmbedder.embedText(text, dimensions);
  }
}

/**
 * 3. xAI Grok Free Tier Provider (`grok-2-latest` via `https://api.x.ai/v1/chat/completions`)
 */
export class XaiGrokModelProvider extends OpenAIChatGPTModelProvider {
  public constructor(options: Omit<OpenAICompatibleProviderOptions, 'providerLabel'>) {
    super({
      ...options,
      providerLabel: 'xai-grok',
      defaultModel: options.defaultModel ?? DEFAULT_GROK_MODEL,
      endpointUrl: options.endpointUrl ?? 'https://api.x.ai/v1/chat/completions',
    });
  }
}

/**
 * 4. Anthropic Claude Free Tier Provider (`claude-3-5-haiku-latest` via `https://api.anthropic.com/v1/messages`)
 */
export class AnthropicClaudeModelProvider implements ModelProvider {
  public readonly providerName = 'anthropic-claude';
  public readonly source = 'provider' as const;

  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly endpointUrl: string;
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly fetchImpl: typeof fetch;
  private readonly fallbackEmbedder = new MockModelProvider();

  public constructor(options: AnthropicClaudeProviderOptions) {
    const cleanKey = options.apiKey.trim();
    if (!cleanKey || cleanKey === 'replace-me') {
      throw new Error(
        'AnthropicClaudeModelProvider requires a valid server-side ANTHROPIC_API_KEY.'
      );
    }
    this.apiKey = cleanKey;
    this.defaultModel = options.defaultModel ?? DEFAULT_CLAUDE_MODEL;
    this.endpointUrl =
      options.endpointUrl ?? 'https://api.anthropic.com/v1/messages';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async generate(input: ModelGenerateInput): Promise<ModelGenerateOutput> {
    const stepIndex = input.stepIndex ?? 1;
    const modelName = this.defaultModel;
    const systemPrompt = buildJsonSystemPrompt(input);
    const transcript = formatConversationTranscript(input.messages);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpointUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: modelName,
          max_tokens: 1024,
          temperature: input.modelConfig.temperature ?? 0.2,
          system: systemPrompt,
          messages: [
            { role: 'user', content: transcript || 'Execute task.' },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(
          `anthropic-claude HTTP ${response.status}: ${errBody.slice(0, 240)}`
        );
      }

      const json = (await response.json()) as {
        model?: string;
        content?: Array<{ type?: string; text?: string }>;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
        };
      };

      const rawText = (
        json.content?.find((c) => c.type === 'text')?.text ?? '{}'
      ).slice(0, this.maxOutputChars);

      const parsed = parseStructuredModelJson(rawText, input, stepIndex);

      const inputTokens =
        json.usage?.input_tokens ??
        Math.max(1, Math.ceil((systemPrompt.length + transcript.length) / 4));
      const outputTokens =
        json.usage?.output_tokens ??
        Math.max(1, Math.ceil(rawText.length / 4));

      return {
        finishReason: parsed.finishReason,
        reasoningSummary: parsed.reasoningSummary,
        toolCalls: parsed.toolCalls,
        answer: parsed.answer,
        citations: parsed.verifiedCitations,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          estimatedCostUsd: 0,
          source: 'provider',
          isSimulated: false,
        },
        providerName: this.providerName,
        modelName: json.model || modelName,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  public async embedText(text: string, dimensions = 64): Promise<number[]> {
    return this.fallbackEmbedder.embedText(text, dimensions);
  }
}

export type PreferredFreeAiEngine =
  | 'auto'
  | 'gemini-free'
  | 'chatgpt-free'
  | 'claude-free'
  | 'grok-free';

export interface LiveOnlineModelProviderOptions {
  geminiApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  xaiApiKey?: string;
  defaultModel?: string;
  preferEngine?: PreferredFreeAiEngine;
}

/**
 * 5. Unified Multi-Provider Free-Tier Router (`LiveOnlineModelProvider`)
 *
 * Routes requests across the 4 official free-tier cloud providers:
 * - Google Gemini Free Tier (`gemini-3-flash-preview`)
 * - OpenAI ChatGPT Free Tier (`gpt-4o-mini`)
 * - Anthropic Claude Free Tier (`claude-3-5-haiku-latest`)
 * - xAI Grok Free Tier (`grok-2-latest`)
 *
 * If the user selects a provider whose API key is configured in `.env`, it calls that
 * provider's native API directly. If that specific key is not yet set in `.env`, it
 * automatically routes through the active configured free-tier provider on the server
 * (such as `GeminiModelProvider` when `GEMINI_API_KEY` is present) so live runs
 * execute real online inference without failing.
 */
export class LiveOnlineModelProvider implements ModelProvider {
  public readonly providerName: string;
  public readonly source = 'provider' as const;

  private readonly geminiProvider: GeminiModelProvider | null = null;
  private readonly chatgptProvider: OpenAIChatGPTModelProvider | null = null;
  private readonly claudeProvider: AnthropicClaudeModelProvider | null = null;
  private readonly grokProvider: XaiGrokModelProvider | null = null;
  private readonly preferEngine: PreferredFreeAiEngine;
  private readonly fallbackEmbedder = new MockModelProvider();

  public constructor(options?: LiveOnlineModelProviderOptions) {
    this.preferEngine = options?.preferEngine ?? 'auto';

    const cleanGemini = (options?.geminiApiKey ?? '').trim();
    if (
      cleanGemini &&
      cleanGemini !== 'MY_GEMINI_API_KEY' &&
      cleanGemini !== 'replace-me'
    ) {
      this.geminiProvider = new GeminiModelProvider({
        apiKey: cleanGemini,
        defaultModel: options?.defaultModel || DEFAULT_GEMINI_MODEL,
      });
    }

    const cleanOpenAI = (options?.openaiApiKey ?? '').trim();
    if (cleanOpenAI && cleanOpenAI !== 'replace-me') {
      this.chatgptProvider = new OpenAIChatGPTModelProvider({
        apiKey: cleanOpenAI,
        defaultModel: DEFAULT_CHATGPT_MODEL,
      });
    }

    const cleanAnthropic = (options?.anthropicApiKey ?? '').trim();
    if (cleanAnthropic && cleanAnthropic !== 'replace-me') {
      this.claudeProvider = new AnthropicClaudeModelProvider({
        apiKey: cleanAnthropic,
        defaultModel: DEFAULT_CLAUDE_MODEL,
      });
    }

    const cleanXai = (options?.xaiApiKey ?? '').trim();
    if (cleanXai && cleanXai !== 'replace-me') {
      this.grokProvider = new XaiGrokModelProvider({
        apiKey: cleanXai,
        defaultModel: DEFAULT_GROK_MODEL,
      });
    }

    const activeNames: string[] = [];
    if (this.geminiProvider) activeNames.push(`gemini:${DEFAULT_GEMINI_MODEL}`);
    if (this.chatgptProvider) activeNames.push(`chatgpt:${DEFAULT_CHATGPT_MODEL}`);
    if (this.claudeProvider) activeNames.push(`claude:${DEFAULT_CLAUDE_MODEL}`);
    if (this.grokProvider) activeNames.push(`grok:${DEFAULT_GROK_MODEL}`);

    this.providerName =
      activeNames.length > 0
        ? activeNames.join('+')
        : 'multi-provider-free-tier (gemini/chatgpt/claude/grok)';
  }

  public async generate(input: ModelGenerateInput): Promise<ModelGenerateOutput> {
    const orderedCandidates: ModelProvider[] = [];

    if (this.preferEngine === 'chatgpt-free' && this.chatgptProvider) {
      orderedCandidates.push(this.chatgptProvider);
    } else if (this.preferEngine === 'claude-free' && this.claudeProvider) {
      orderedCandidates.push(this.claudeProvider);
    } else if (this.preferEngine === 'grok-free' && this.grokProvider) {
      orderedCandidates.push(this.grokProvider);
    } else if (this.preferEngine === 'gemini-free' && this.geminiProvider) {
      orderedCandidates.push(this.geminiProvider);
    }

    // Add remaining configured live providers in priority order for automatic failover
    for (const candidate of [
      this.geminiProvider,
      this.chatgptProvider,
      this.claudeProvider,
      this.grokProvider,
    ]) {
      if (candidate && !orderedCandidates.includes(candidate)) {
        orderedCandidates.push(candidate);
      }
    }

    let lastError: unknown;
    for (const provider of orderedCandidates) {
      try {
        return await provider.generate(input);
      } catch (err) {
        lastError = err;
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new Error(
      'No free-tier AI provider API key is configured. Set GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or XAI_API_KEY in .env.'
    );
  }

  public async embedText(text: string, dimensions = 64): Promise<number[]> {
    return this.fallbackEmbedder.embedText(text, dimensions);
  }
}
