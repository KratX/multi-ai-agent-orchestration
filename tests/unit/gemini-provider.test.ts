import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import { createModelProvider } from '../../src/server/ai/model-provider';
import { GeminiModelProvider, type GeminiSdkClient } from '../../src/server/ai/gemini-provider';
import { DEFAULT_AGENT_MODEL_CONFIG } from '../../src/server/db/schema/agents';

/**
 * Phase F Unit & Contract Tests:
 * Verifies `GeminiModelProvider` and `createModelProvider({ AI_MODE: 'provider' })`
 * using a mocked `@google/genai` SDK client so CI executes with zero network access.
 */

test('Phase F: createModelProvider returns GeminiModelProvider when AI_MODE="provider" with valid key', () => {
  const provider = createModelProvider({
    AI_MODE: 'provider',
    AI_PROVIDER_MODEL: 'gemini-3.8-flash',
    AI_PROVIDER_API_KEY: 'live-server-side-key-123456',
  });

  assert.equal(provider.providerName, 'google-gemini');
  assert.equal(provider.source, 'provider');
});

test('Phase F: GeminiModelProvider parses structured tool calls, strips fabricated citations, and records live usage', async () => {
  const capturedRequests: GenerateContentParameters[] = [];

  const mockSdkClient: GeminiSdkClient = {
    models: {
      async generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse> {
        capturedRequests.push(params);
        return {
          text: JSON.stringify({
            finishReason: 'stop',
            reasoningSummary: 'Verified SEV-1 policy from retrieved chunk.',
            toolCalls: [],
            answer: 'SEV-1 escalation requires paging the on-call incident commander within 5 minutes.',
            citations: [
              {
                chunkId: 'chunk-real-001',
                documentId: 'spoofed-doc-id',
                documentTitle: 'Spoofed Title',
                quote: 'Page the on-call incident commander within 5 minutes.',
              },
              {
                chunkId: 'chunk-fabricated-999',
                documentId: 'doc-999',
                documentTitle: 'Hallucinated Runbook',
                quote: 'Never happened',
              },
            ],
          }),
          usageMetadata: {
            promptTokenCount: 140,
            candidatesTokenCount: 35,
            totalTokenCount: 175,
          },
        } as unknown as GenerateContentResponse;
      },
    },
  };

  const provider = new GeminiModelProvider({
    apiKey: 'test-gemini-api-key-987654',
    defaultModel: 'gemini-3.8-flash',
    sdkClient: mockSdkClient,
  });

  const output = await provider.generate({
    systemPrompt: 'You are an SRE escalation assistant.',
    modelConfig: {
      ...DEFAULT_AGENT_MODEL_CONFIG,
      provider: 'google',
      model: 'gemini-3.8-flash',
    },
    allowedTools: ['knowledge_search'],
    messages: [
      { role: 'user', content: 'What is our SEV-1 escalation policy?' },
      {
        role: 'tool',
        toolName: 'knowledge_search',
        content: JSON.stringify({
          chunks: [
            {
              chunkId: 'chunk-real-001',
              documentId: 'doc-trusted-001',
              documentTitle: 'Incident Escalation Runbook',
              content: 'Page the on-call incident commander within 5 minutes.',
            },
          ],
        }),
      },
    ],
  });

  assert.equal(capturedRequests.length, 1);
  assert.equal(capturedRequests[0]?.model, 'gemini-3.8-flash');
  assert.equal(output.finishReason, 'stop');
  assert.equal(output.providerName, 'google-gemini');
  assert.equal(output.usage.source, 'provider');
  assert.equal(output.usage.isSimulated, false);
  assert.equal(output.usage.inputTokens, 140);
  assert.equal(output.usage.outputTokens, 35);
  assert.equal(output.usage.totalTokens, 175);

  // Hallucinated chunk-fabricated-999 stripped; real chunk normalized to trusted server metadata
  assert.equal(output.citations.length, 1);
  assert.equal(output.citations[0]?.chunkId, 'chunk-real-001');
  assert.equal(output.citations[0]?.documentId, 'doc-trusted-001');
  assert.equal(output.citations[0]?.documentTitle, 'Incident Escalation Runbook');
});

test('Phase F: GeminiModelProvider enforces per-call timeout bounds', async () => {
  const slowSdkClient: GeminiSdkClient = {
    models: {
      async generateContent(): Promise<GenerateContentResponse> {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { text: '{}' } as unknown as GenerateContentResponse;
      },
    },
  };

  const provider = new GeminiModelProvider({
    apiKey: 'test-gemini-api-key-timeout',
    timeoutMs: 25,
    sdkClient: slowSdkClient,
  });

  await assert.rejects(
    async () => {
      await provider.generate({
        systemPrompt: 'Test timeout',
        modelConfig: DEFAULT_AGENT_MODEL_CONFIG,
        allowedTools: [],
        messages: [{ role: 'user', content: 'Hello' }],
      });
    },
    /Gemini provider request timed out after 25ms/
  );
});
