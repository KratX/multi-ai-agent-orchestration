import { GoogleGenAI, Type, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import {
  extractRetrievedChunksFromMessages,
  MockModelProvider,
  verifyModelCitations,
  type ModelCitation,
  type ModelGenerateInput,
  type ModelGenerateOutput,
  type ModelProvider,
  type ModelToolCallRequest,
} from './model-provider';

/**
 * Phase F: Optional Server-Only Live Gemini ModelProvider Adapter (`AI_MODE=provider`)
 *
 * Security & Architectural Invariants:
 * 1. Server-only execution: Never imported by browser/Vite client code; API keys remain on the server.
 * 2. Initializes `GoogleGenAI` with `User-Agent: 'aistudio-build'` telemetry header.
 * 3. Supports dependency injection (`sdkClient`) so CI contract tests verify request formatting,
 *    tool call parsing, citation verification, timeout bounds, and error mapping with zero network calls.
 * 4. Applies `verifyModelCitations()` on every turn so hallucinated citations are stripped.
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

const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 32_768;

export class GeminiModelProvider implements ModelProvider {
  public readonly providerName = 'google-gemini';
  public readonly source = 'provider' as const;

  private readonly client: GeminiSdkClient;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly fallbackEmbedder = new MockModelProvider();

  constructor(options: GeminiModelProviderOptions) {
    const cleanKey = options.apiKey?.trim() ?? '';
    if (!cleanKey || cleanKey === 'MY_GEMINI_API_KEY' || cleanKey === 'replace-me') {
      throw new Error(
        'GeminiModelProvider requires a valid server-side API key when AI_MODE="provider".'
      );
    }

    this.defaultModel = options.defaultModel?.trim() || DEFAULT_GEMINI_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

    this.client =
      options.sdkClient ??
      new GoogleGenAI({
        apiKey: cleanKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
  }

  public async generate(input: ModelGenerateInput): Promise<ModelGenerateOutput> {
    const requestedModel = input.modelConfig.model?.trim();
    const modelName =
      !requestedModel || requestedModel.startsWith('aegis-mock')
        ? this.defaultModel
        : requestedModel;

    const retrievedChunks = extractRetrievedChunksFromMessages(input.messages);
    const transcript = input.messages
      .map((msg) => {
        if (msg.role === 'tool') {
          return `[TOOL RESULT (${msg.toolName ?? 'tool'})]: ${msg.content}`;
        }
        return `[${msg.role.toUpperCase()}]: ${msg.content}`;
      })
      .join('\n\n');

    const systemInstruction = [
      input.systemPrompt,
      `Allowed tools for this agent version: ${
        input.allowedTools.length > 0 ? input.allowedTools.join(', ') : 'NONE'
      }.`,
      'Return a JSON object matching the responseSchema. Only request tools listed in Allowed tools.',
      'When citing retrieved knowledge chunks, reference only chunkId values present in the conversation tool results.',
    ].join('\n');

    const callPromise = this.client.models.generateContent({
      model: modelName,
      contents: transcript || 'Proceed with the task.',
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            finishReason: {
              type: Type.STRING,
              description: 'Either "tool_calls" or "stop".',
            },
            reasoningSummary: {
              type: Type.STRING,
              description: 'Concise summary of the step decision.',
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
                    description: 'JSON-encoded object of tool arguments.',
                  },
                },
              },
            },
            answer: {
              type: Type.STRING,
              description: 'Final response text when finishReason is "stop".',
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
              },
            },
          },
        },
      },
    });

    const response = await this.withTimeout(callPromise, this.timeoutMs);
    const rawText = (response.text ?? '{}').slice(0, this.maxOutputChars).trim();

    let parsed: {
      finishReason?: string;
      reasoningSummary?: string;
      toolCalls?: Array<{ id?: string; name?: string; argumentsJson?: string; arguments?: Record<string, unknown> }>;
      answer?: string | null;
      citations?: ModelCitation[];
    } = {};

    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = {
        finishReason: 'stop',
        reasoningSummary: 'Completed response turn.',
        answer: rawText,
        toolCalls: [],
        citations: [],
      };
    }

    const toolCalls: ModelToolCallRequest[] = (parsed.toolCalls ?? [])
      .filter((tc) => typeof tc?.name === 'string' && tc.name.trim().length > 0)
      .map((tc, idx) => {
        let args: Record<string, unknown> = {};
        if (tc.arguments && typeof tc.arguments === 'object') {
          args = tc.arguments;
        } else if (typeof tc.argumentsJson === 'string' && tc.argumentsJson.trim()) {
          try {
            const decoded = JSON.parse(tc.argumentsJson);
            if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
              args = decoded as Record<string, unknown>;
            }
          } catch {
            args = {};
          }
        }
        return {
          id: tc.id?.trim() || `gemini-call-${input.stepIndex ?? 1}-${idx + 1}`,
          name: tc.name!.trim(),
          arguments: args,
        };
      });

    const finishReason: 'tool_calls' | 'stop' =
      parsed.finishReason === 'tool_calls' && toolCalls.length > 0 ? 'tool_calls' : 'stop';

    const { verifiedCitations } = verifyModelCitations(
      Array.isArray(parsed.citations) ? parsed.citations : [],
      retrievedChunks
    );

    const usageMeta = (
      response as unknown as {
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        };
      }
    ).usageMetadata;

    const inputTokens = Math.max(0, usageMeta?.promptTokenCount ?? 0);
    const outputTokens = Math.max(0, usageMeta?.candidatesTokenCount ?? 0);
    const totalTokens = Math.max(
      inputTokens + outputTokens,
      usageMeta?.totalTokenCount ?? inputTokens + outputTokens
    );
    const hasProviderUsage = Boolean(usageMeta && totalTokens > 0);

    return {
      finishReason,
      reasoningSummary:
        parsed.reasoningSummary?.trim() ||
        `Gemini (${modelName}) completed turn (${finishReason}).`,
      toolCalls: finishReason === 'tool_calls' ? toolCalls : [],
      answer:
        finishReason === 'stop'
          ? (parsed.answer ?? rawText)
          : null,
      citations: verifiedCitations,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedCostUsd: Number(((totalTokens / 1_000_000) * 0.15).toFixed(6)),
        source: 'provider',
        isSimulated: !hasProviderUsage,
      },
      providerName: this.providerName,
      modelName,
    };
  }

  public async embedText(text: string, dimensions = 64): Promise<number[]> {
    return this.fallbackEmbedder.embedText(text, dimensions);
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Gemini provider request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
