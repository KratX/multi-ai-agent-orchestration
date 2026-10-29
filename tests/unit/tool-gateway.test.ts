import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CalculatorExpressionError,
  ToolAuthorizationError,
  ToolExecutionError,
  ToolGateway,
  evaluateSafeArithmetic,
  type CalculatorToolOutput,
  type KnowledgeSearchToolOutput,
} from '../../src/server/modules/tools/tool-gateway';
import { MockModelProvider } from '../../src/server/ai/model-provider';
import { DEFAULT_AGENT_MODEL_CONFIG } from '../../src/server/db/schema/agents';

/**
 * Tickets TOOL-001 & TOOL-002: Unit & Security Tests for ToolGateway and Safe Calculator
 *
 * Verifies:
 * 1. Safe recursive-descent arithmetic parser (`evaluateSafeArithmetic`) operator precedence,
 *    parentheses, unary signs, modulo, and decimals without `eval()`.
 * 2. Rejection of code injection payloads, division by zero, unbalanced parens, and deep nesting.
 * 3. Threat T-03 mitigation: `ToolGateway` blocks tools omitted from `AgentVersionSnapshot.allowedTools`
 *    and rejects unknown tool names.
 * 4. Threat T-01/T-02 mitigation: `knowledge_search` ignores spoofed `organizationId` in model
 *    arguments and strictly scopes retrieval to `context.organizationId`.
 * 5. Payload byte budget (`TOOL_INPUT_TOO_LARGE` / `TOOL_OUTPUT_TOO_LARGE`) and timeout (`TOOL_TIMEOUT`) guards.
 * 6. End-to-end integration between `MockModelProvider` tool call outputs and `ToolGateway`.
 */

test('TOOL-001: evaluateSafeArithmetic computes operator precedence, parentheses, unary signs, and decimals without eval', () => {
  assert.equal(evaluateSafeArithmetic('2 + 3 * 4'), 14);
  assert.equal(evaluateSafeArithmetic('(2 + 3) * 4'), 20);
  assert.equal(evaluateSafeArithmetic('(1450 * 12) + 3200 - 850'), 19750);
  assert.equal(evaluateSafeArithmetic('-10 + +25 / 2'), 2.5);
  assert.equal(evaluateSafeArithmetic('17 % 5'), 2);
  assert.equal(evaluateSafeArithmetic('0.1 + 0.2'), 0.3);
  assert.equal(evaluateSafeArithmetic('-0 * 5'), 0);
});

test('TOOL-001: evaluateSafeArithmetic rejects code injection payloads, division by zero, and excessive parenthesis depth', () => {
  const maliciousInputs = [
    'process.exit(1)',
    'globalThis.constructor.constructor("return process.env")()',
    '2 + 2; console.log(1)',
    '__proto__',
    'Math.sqrt(16)',
    '10 / 0',
    '15 % (3 - 3)',
    '(1 + 2',
    '1 + 2)',
    '10 + * 5',
    '(((((((((((((((((1)))))))))))))))))', // 17 nested parentheses > MAX_CALCULATOR_PAREN_DEPTH (16)
  ];

  for (const payload of maliciousInputs) {
    assert.throws(
      () => evaluateSafeArithmetic(payload),
      (err: unknown) => err instanceof CalculatorExpressionError,
      `Expected CalculatorExpressionError for payload: ${payload}`
    );
  }
});

test('TOOL-002: ToolGateway blocks tools omitted from AgentVersionSnapshot.allowedTools (Threat T-03) and unknown tools', async () => {
  const gateway = new ToolGateway();

  // 1. Model attempts to invoke `calculator` when the published agent version only allows `knowledge_search`
  await assert.rejects(
    async () =>
      gateway.executeToolCall(
        {
          id: 'call_unauth_calc',
          name: 'calculator',
          arguments: { expression: '6 * 7' },
        },
        {
          organizationId: 'org_alpha',
          allowedTools: ['knowledge_search'],
        }
      ),
    (err: unknown) => {
      assert.ok(err instanceof ToolAuthorizationError);
      assert.equal(err.code, 'TOOL_NOT_ALLOWED_FOR_AGENT');
      assert.equal(err.status, 403);
      return true;
    }
  );

  // 2. Prompt-injected model attempts to invoke an unregistered shell/HTTP tool
  await assert.rejects(
    async () =>
      gateway.executeToolCall(
        {
          id: 'call_unknown_shell',
          name: 'shell_exec',
          arguments: { cmd: 'cat /etc/passwd' },
        },
        {
          organizationId: 'org_alpha',
          allowedTools: ['calculator', 'knowledge_search'],
        }
      ),
    (err: unknown) => {
      assert.ok(err instanceof ToolAuthorizationError);
      assert.equal(err.code, 'UNKNOWN_TOOL');
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('TOOL-002: ToolGateway enforces server-side organizationId on knowledge_search and ignores spoofed tenant arguments', async () => {
  const capturedCalls: Array<{ organizationId: string; query: string; topK: number }> = [];

  const gateway = new ToolGateway({
    knowledgeSearchRetriever: async (params) => {
      capturedCalls.push(params);
      return [
        {
          chunkId: 'chunk_tenant_safe_1',
          documentId: 'doc_tenant_safe_1',
          documentTitle: 'Tenant Alpha Security Policy',
          content: 'All tool invocations are mediated by the server-side ToolGateway.',
          score: 0.95,
        },
      ];
    },
  });

  // Model attempts to pass a spoofed `organizationId: "org_victim"` inside tool arguments
  const execution = await gateway.executeToolCall(
    {
      id: 'call_rag_spoof',
      name: 'knowledge_search',
      arguments: {
        query: 'tool invocations policy',
        topK: 2,
        organizationId: 'org_victim_tenant_id',
      },
    },
    {
      organizationId: 'org_authenticated_alpha',
      allowedTools: ['knowledge_search'],
    }
  );

  assert.equal(capturedCalls.length, 1);
  assert.equal(capturedCalls[0]?.organizationId, 'org_authenticated_alpha');
  assert.equal(capturedCalls[0]?.query, 'tool invocations policy');
  assert.equal(capturedCalls[0]?.topK, 2);

  // Sanitized arguments never retain the spoofed organizationId field
  assert.deepEqual(execution.sanitizedArguments, {
    query: 'tool invocations policy',
    topK: 2,
  });

  const output = execution.output as KnowledgeSearchToolOutput;
  assert.equal(output.organizationId, 'org_authenticated_alpha');
  assert.equal(output.chunks.length, 1);
  assert.equal(output.chunks[0]?.chunkId, 'chunk_tenant_safe_1');
});

test('TOOL-002: ToolGateway enforces input/output payload byte budgets and execution timeouts', async () => {
  // 1. Input byte budget exceeded
  const strictBudgetGateway = new ToolGateway({ defaultMaxPayloadBytes: 64 });

  await assert.rejects(
    async () =>
      strictBudgetGateway.executeToolCall(
        {
          id: 'call_huge_input',
          name: 'knowledge_search',
          arguments: {
            query: 'x'.repeat(120),
          },
        },
        {
          organizationId: 'org_alpha',
          allowedTools: ['knowledge_search'],
        }
      ),
    (err: unknown) => {
      assert.ok(err instanceof ToolExecutionError);
      assert.equal(err.code, 'TOOL_INPUT_TOO_LARGE');
      assert.equal(err.status, 413);
      return true;
    }
  );

  // 2. Output byte budget exceeded
  const hugeOutputGateway = new ToolGateway({
    defaultMaxPayloadBytes: 256,
    knowledgeSearchRetriever: async () => [
      {
        chunkId: 'chunk_huge',
        documentId: 'doc_huge',
        documentTitle: 'Large Document',
        content: 'A'.repeat(500),
      },
    ],
  });

  await assert.rejects(
    async () =>
      hugeOutputGateway.executeToolCall(
        {
          id: 'call_huge_output',
          name: 'knowledge_search',
          arguments: { query: 'short' },
        },
        {
          organizationId: 'org_alpha',
          allowedTools: ['knowledge_search'],
        }
      ),
    (err: unknown) => {
      assert.ok(err instanceof ToolExecutionError);
      assert.equal(err.code, 'TOOL_OUTPUT_TOO_LARGE');
      assert.equal(err.status, 413);
      return true;
    }
  );

  // 3. Execution timeout exceeded
  const slowGateway = new ToolGateway({
    defaultTimeoutMs: 25,
    knowledgeSearchRetriever: async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return [];
    },
  });

  await assert.rejects(
    async () =>
      slowGateway.executeToolCall(
        {
          id: 'call_timeout',
          name: 'knowledge_search',
          arguments: { query: 'slow query' },
        },
        {
          organizationId: 'org_alpha',
          allowedTools: ['knowledge_search'],
        }
      ),
    (err: unknown) => {
      assert.ok(err instanceof ToolExecutionError);
      assert.equal(err.code, 'TOOL_TIMEOUT');
      assert.equal(err.status, 504);
      return true;
    }
  );
});

test('TOOL-001 & TOOL-002: ToolGateway integrates end-to-end with MockModelProvider multi-step calculator turn', async () => {
  const provider = new MockModelProvider();
  const gateway = new ToolGateway();

  // Step 1: Model requests calculator tool call
  const step1 = await provider.generate({
    systemPrompt: 'You are a financial calculator assistant.',
    modelConfig: DEFAULT_AGENT_MODEL_CONFIG,
    allowedTools: ['calculator'],
    messages: [{ role: 'user', content: 'Compute (250 * 4) + 175' }],
    stepIndex: 0,
  });

  assert.equal(step1.finishReason, 'tool_calls');
  assert.equal(step1.toolCalls.length, 1);

  // Execute tool call through the server-authorized ToolGateway
  const toolResult = await gateway.executeToolCall(step1.toolCalls[0]!, {
    organizationId: 'org_alpha',
    allowedTools: ['calculator'],
  });

  const calcOutput = toolResult.output as CalculatorToolOutput;
  assert.equal(calcOutput.result, 1175);

  // Step 2: Feed ToolGateway result back into MockModelProvider
  const step2 = await provider.generate({
    systemPrompt: 'You are a financial calculator assistant.',
    modelConfig: DEFAULT_AGENT_MODEL_CONFIG,
    allowedTools: ['calculator'],
    messages: [
      { role: 'user', content: 'Compute (250 * 4) + 175' },
      {
        role: 'assistant',
        content: step1.reasoningSummary,
        toolCalls: step1.toolCalls,
      },
      {
        role: 'tool',
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
        content: toolResult.serializedOutput,
        toolOutput: toolResult.output,
      },
    ],
    stepIndex: 1,
  });

  assert.equal(step2.finishReason, 'stop');
  assert.ok(step2.answer?.includes('1175'));
});
