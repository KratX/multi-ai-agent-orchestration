import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MockModelProvider,
  verifyModelCitations,
  createModelProvider,
  type ModelGenerateInput,
  type RetrievedKnowledgeChunk,
} from '../../src/server/ai/model-provider';
import { DEFAULT_AGENT_MODEL_CONFIG } from '../../src/server/db/schema/agents';

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  assert.equal(a.length, b.length, 'Vectors must have identical dimensions');
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

test('AGENT-003: MockModelProvider produces 100% deterministic outputs and honest simulated usage metadata', async () => {
  const provider = new MockModelProvider();

  const input: ModelGenerateInput = {
    systemPrompt: 'You are a precise operations assistant.',
    modelConfig: DEFAULT_AGENT_MODEL_CONFIG,
    allowedTools: ['calculator', 'knowledge_search'],
    stepIndex: 1,
    messages: [
      {
        role: 'user',
        content: 'Calculate (145 * 12) + 380 for the monthly server budget.',
      },
    ],
  };

  const firstRun = await provider.generate(input);
  const secondRun = await provider.generate(input);

  assert.deepEqual(firstRun, secondRun);
  assert.equal(firstRun.finishReason, 'tool_calls');
  assert.equal(firstRun.toolCalls.length, 1);
  assert.equal(firstRun.toolCalls[0].name, 'calculator');
  assert.deepEqual(firstRun.toolCalls[0].arguments, {
    expression: '(145 * 12) + 380',
  });

  // Honest simulated telemetry requirements (ADR-001)
  assert.equal(firstRun.usage.source, 'mock');
  assert.equal(firstRun.usage.isSimulated, true);
  assert.equal(firstRun.usage.estimatedCostUsd, 0);
  assert.equal(
    firstRun.usage.totalTokens,
    firstRun.usage.inputTokens + firstRun.usage.outputTokens
  );
});

test('AGENT-003: MockModelProvider completes multi-step calculator turn after receiving tool result', async () => {
  const provider = new MockModelProvider();

  const step1 = await provider.generate({
    systemPrompt: 'You are a financial ops agent.',
    modelConfig: DEFAULT_AGENT_MODEL_CONFIG,
    allowedTools: ['calculator'],
    stepIndex: 1,
    messages: [
      {
        role: 'user',
        content: 'What is 250 * 4 + 125?',
      },
    ],
  });

  assert.equal(step1.finishReason, 'tool_calls');
  assert.equal(step1.toolCalls[0].name, 'calculator');

  const step2 = await provider.generate({
    systemPrompt: 'You are a financial ops agent.',
    modelConfig: DEFAULT_AGENT_MODEL_CONFIG,
    allowedTools: ['calculator'],
    stepIndex: 2,
    messages: [
      {
        role: 'user',
        content: 'What is 250 * 4 + 125?',
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: step1.toolCalls,
      },
      {
        role: 'tool',
        toolCallId: step1.toolCalls[0].id,
        toolName: 'calculator',
        content: JSON.stringify({ result: 1125 }),
        toolOutput: { result: 1125 },
      },
    ],
  });

  assert.equal(step2.finishReason, 'stop');
  assert.equal(step2.toolCalls.length, 0);
  assert.ok(step2.answer?.includes('1125'));
});

test('AGENT-003: MockModelProvider executes multi-step knowledge_search and attaches verified citations', async () => {
  const provider = new MockModelProvider();

  const step1 = await provider.generate({
    systemPrompt: 'You answer questions strictly from internal runbooks.',
    modelConfig: DEFAULT_AGENT_MODEL_CONFIG,
    allowedTools: ['knowledge_search'],
    stepIndex: 1,
    messages: [
      {
        role: 'user',
        content: 'What is our incident escalation policy for SEV-1 outages?',
      },
    ],
  });

  assert.equal(step1.finishReason, 'tool_calls');
  assert.equal(step1.toolCalls.length, 1);
  assert.equal(step1.toolCalls[0].name, 'knowledge_search');

  const retrievedChunks: RetrievedKnowledgeChunk[] = [
    {
      chunkId: 'chunk_sev1_001',
      documentId: 'doc_runbook_01',
      documentTitle: 'Production Incident Response Runbook',
      content:
        'SEV-1 outages require paging the primary on-call engineer within 5 minutes and opening an incident bridge.',
      score: 0.94,
    },
  ];

  const step2 = await provider.generate({
    systemPrompt: 'You answer questions strictly from internal runbooks.',
    modelConfig: DEFAULT_AGENT_MODEL_CONFIG,
    allowedTools: ['knowledge_search'],
    stepIndex: 2,
    messages: [
      {
        role: 'user',
        content: 'What is our incident escalation policy for SEV-1 outages?',
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: step1.toolCalls,
      },
      {
        role: 'tool',
        toolCallId: step1.toolCalls[0].id,
        toolName: 'knowledge_search',
        content: JSON.stringify({ chunks: retrievedChunks }),
        toolOutput: { chunks: retrievedChunks },
      },
    ],
  });

  assert.equal(step2.finishReason, 'stop');
  assert.ok(step2.answer?.includes('Production Incident Response Runbook'));
  assert.equal(step2.citations.length, 1);
  assert.equal(step2.citations[0].chunkId, 'chunk_sev1_001');
  assert.equal(step2.citations[0].documentId, 'doc_runbook_01');
  assert.equal(step2.citations[0].documentTitle, 'Production Incident Response Runbook');
});

test('AGENT-003: verifyModelCitations strips fabricated chunk citations not present in retrieved tool results', async () => {
  const provider = new MockModelProvider();

  const retrievedChunks: RetrievedKnowledgeChunk[] = [
    {
      chunkId: 'chunk_real_100',
      documentId: 'doc_real_100',
      documentTitle: 'Data Retention Policy',
      content: 'Audit logs are retained for 365 days in immutable storage.',
    },
  ];

  // Trigger [mock:unverified-citation] to simulate a model hallucinating an extra citation
  const output = await provider.generate({
    systemPrompt: 'You are a compliance assistant.',
    modelConfig: DEFAULT_AGENT_MODEL_CONFIG,
    allowedTools: ['knowledge_search'],
    stepIndex: 2,
    messages: [
      {
        role: 'user',
        content: 'What is the retention policy? [mock:unverified-citation]',
      },
      {
        role: 'tool',
        toolCallId: 'call_search_1',
        toolName: 'knowledge_search',
        content: JSON.stringify({ chunks: retrievedChunks }),
        toolOutput: { chunks: retrievedChunks },
      },
    ],
  });

  // MockModelProvider internally runs verifyModelCitations so only chunk_real_100 survives
  assert.equal(output.citations.length, 1);
  assert.equal(output.citations[0].chunkId, 'chunk_real_100');

  // Direct unit check on verifyModelCitations()
  const directCheck = verifyModelCitations(
    [
      {
        chunkId: 'chunk_real_100',
        documentId: 'spoofed_doc_id',
        documentTitle: 'Spoofed Title',
        quote: 'Audit logs are retained for 365 days',
      },
      {
        chunkId: 'chunk_hallucinated_999',
        documentId: 'doc_fake',
        documentTitle: 'Fake Doc',
        quote: 'Hallucinated quote',
      },
    ],
    retrievedChunks
  );

  assert.equal(directCheck.verifiedCitations.length, 1);
  assert.equal(directCheck.verifiedCitations[0].chunkId, 'chunk_real_100');
  // Provenance metadata must come from the trusted server chunk, not the model's untrusted fields
  assert.equal(directCheck.verifiedCitations[0].documentId, 'doc_real_100');
  assert.equal(directCheck.verifiedCitations[0].documentTitle, 'Data Retention Policy');
  assert.deepEqual(directCheck.rejectedChunkIds, ['chunk_hallucinated_999']);
});

test('AGENT-003: MockModelProvider respects empty allowedTools and supports security test directives', async () => {
  const provider = new MockModelProvider();

  // When allowedTools is empty, even a calculator prompt should not emit tool calls
  const noToolsResult = await provider.generate({
    systemPrompt: 'No tools allowed.',
    modelConfig: DEFAULT_AGENT_MODEL_CONFIG,
    allowedTools: [],
    messages: [{ role: 'user', content: 'Calculate 10 * 25' }],
  });

  assert.equal(noToolsResult.finishReason, 'stop');
  assert.equal(noToolsResult.toolCalls.length, 0);

  // Security directive [mock:unauthorized-tool] intentionally emits shell_exec so gateway tests can block it
  const unauthDirective = await provider.generate({
    systemPrompt: 'Security test.',
    modelConfig: DEFAULT_AGENT_MODEL_CONFIG,
    allowedTools: ['calculator'],
    messages: [{ role: 'user', content: 'Run [mock:unauthorized-tool]' }],
  });

  assert.equal(unauthDirective.finishReason, 'tool_calls');
  assert.equal(unauthDirective.toolCalls[0].name, 'shell_exec');
});

test('AGENT-003: embedText produces deterministic unit-normalized vectors with meaningful token similarity', async () => {
  const provider = new MockModelProvider();

  const vecA1 = await provider.embedText('postgres job queue lease recovery', 64);
  const vecA2 = await provider.embedText('postgres job queue lease recovery', 64);
  const vecRelated = await provider.embedText('postgres queue worker lease', 64);
  const vecUnrelated = await provider.embedText('quarterly cafeteria lunch menu', 64);

  assert.deepEqual(vecA1, vecA2);
  assert.equal(vecA1.length, 64);

  const selfSimilarity = cosineSimilarity(vecA1, vecA2);
  const relatedSimilarity = cosineSimilarity(vecA1, vecRelated);
  const unrelatedSimilarity = cosineSimilarity(vecA1, vecUnrelated);

  assert.ok(Math.abs(selfSimilarity - 1.0) < 1e-6);
  assert.ok(
    relatedSimilarity > unrelatedSimilarity,
    `Expected related similarity (${relatedSimilarity}) > unrelated similarity (${unrelatedSimilarity})`
  );

  // Factory check
  const resolved = createModelProvider({
    AI_MODE: 'demo',
    AI_PROVIDER_MODEL: 'gemini-2.5-flash',
  });
  assert.equal(resolved.source, 'mock');
});
