import { z } from 'zod';
import { ALLOWED_TOOLS, type AllowedToolName } from '../../db/schema/agents';
import type {
  ModelToolCallRequest,
  RetrievedKnowledgeChunk,
} from '../../ai/model-provider';

/**
 * Tickets TOOL-001 & TOOL-002: Server-Authorized Tool Gateway & Safe Arithmetic Calculator
 *
 * Implements Blueprint Section 5.4, Section 6.3 & Threat Model T-03 / T-02:
 * 1. Central server-side ToolGateway enforcing that a model can ONLY invoke tools
 *    explicitly enabled in the immutable `AgentVersionSnapshot.allowedTools` allowlist.
 * 2. Strict Zod schema validation on tool arguments before execution.
 * 3. Input and output payload byte budgets (`maxPayloadBytes`, default 64 KiB) and
 *    per-call execution timeout guards (`timeoutMs`, default 5,000 ms).
 * 4. `calculator` tool implemented via a pure recursive-descent arithmetic parser
 *    supporting `+`, `-`, `*`, `/`, `%`, parentheses, unary signs, and decimals —
 *    strictly zero `eval()` or `new Function()`.
 * 5. `knowledge_search` tool adapter that always injects `organizationId` from the
 *    trusted server-side execution context and strips any model-supplied tenant overrides.
 */

export const MAX_CALCULATOR_EXPRESSION_LENGTH = 256;
export const MAX_CALCULATOR_PAREN_DEPTH = 16;
export const DEFAULT_TOOL_TIMEOUT_MS = 5_000;
export const DEFAULT_TOOL_MAX_PAYLOAD_BYTES = 65_536;

export type ToolErrorCode =
  | 'UNKNOWN_TOOL'
  | 'TOOL_NOT_ALLOWED_FOR_AGENT'
  | 'INVALID_TOOL_ARGUMENTS'
  | 'TOOL_INPUT_TOO_LARGE'
  | 'TOOL_OUTPUT_TOO_LARGE'
  | 'TOOL_TIMEOUT'
  | 'TOOL_EXECUTION_FAILED';

export class ToolAuthorizationError extends Error {
  public readonly code: 'UNKNOWN_TOOL' | 'TOOL_NOT_ALLOWED_FOR_AGENT';
  public readonly status: 400 | 403;
  public readonly toolName: string;

  constructor(
    code: 'UNKNOWN_TOOL' | 'TOOL_NOT_ALLOWED_FOR_AGENT',
    toolName: string,
    message: string
  ) {
    super(message);
    this.name = 'ToolAuthorizationError';
    this.code = code;
    this.status = code === 'UNKNOWN_TOOL' ? 400 : 403;
    this.toolName = toolName;
  }
}

export class ToolExecutionError extends Error {
  public readonly code: Exclude<
    ToolErrorCode,
    'UNKNOWN_TOOL' | 'TOOL_NOT_ALLOWED_FOR_AGENT'
  >;
  public readonly status: 413 | 422 | 500 | 504;
  public readonly toolName: string;

  constructor(
    code: Exclude<ToolErrorCode, 'UNKNOWN_TOOL' | 'TOOL_NOT_ALLOWED_FOR_AGENT'>,
    toolName: string,
    message: string,
    status: 413 | 422 | 500 | 504 = 422
  ) {
    super(message);
    this.name = 'ToolExecutionError';
    this.code = code;
    this.status = status;
    this.toolName = toolName;
  }
}

export class CalculatorExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalculatorExpressionError';
  }
}

type CalcToken =
  | { type: 'number'; value: number }
  | { type: 'op'; value: '+' | '-' | '*' | '/' | '%' }
  | { type: 'paren'; value: '(' | ')' };

/**
 * Tokenizes an arithmetic expression after verifying character safety and length bounds.
 */
function tokenizeArithmetic(expression: string): CalcToken[] {
  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    throw new CalculatorExpressionError('Arithmetic expression must not be empty.');
  }
  if (trimmed.length > MAX_CALCULATOR_EXPRESSION_LENGTH) {
    throw new CalculatorExpressionError(
      `Arithmetic expression exceeds maximum length of ${MAX_CALCULATOR_EXPRESSION_LENGTH} characters.`
    );
  }

  // Reject any characters outside digits, decimal points, whitespace, parentheses, and + - * / %
  if (!/^[0-9.+\-*/%()\s]+$/.test(trimmed)) {
    throw new CalculatorExpressionError(
      'Arithmetic expression contains disallowed characters. Only numbers, parentheses, and + - * / % are permitted.'
    );
  }

  const tokens: CalcToken[] = [];
  let index = 0;
  let parenDepth = 0;

  while (index < trimmed.length) {
    const ch = trimmed[index]!;

    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }

    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') {
      tokens.push({ type: 'op', value: ch });
      index += 1;
      continue;
    }

    if (ch === '(') {
      parenDepth += 1;
      if (parenDepth > MAX_CALCULATOR_PAREN_DEPTH) {
        throw new CalculatorExpressionError(
          `Parenthesis nesting depth exceeds maximum of ${MAX_CALCULATOR_PAREN_DEPTH}.`
        );
      }
      tokens.push({ type: 'paren', value: '(' });
      index += 1;
      continue;
    }

    if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth < 0) {
        throw new CalculatorExpressionError('Unbalanced closing parenthesis in expression.');
      }
      tokens.push({ type: 'paren', value: ')' });
      index += 1;
      continue;
    }

    if (/[0-9.]/.test(ch)) {
      let numStr = '';
      let dotCount = 0;
      while (index < trimmed.length && /[0-9.]/.test(trimmed[index]!)) {
        const digitChar = trimmed[index]!;
        if (digitChar === '.') {
          dotCount += 1;
          if (dotCount > 1) {
            throw new CalculatorExpressionError(`Invalid numeric literal near "${numStr}${digitChar}".`);
          }
        }
        numStr += digitChar;
        index += 1;
      }

      if (numStr === '.') {
        throw new CalculatorExpressionError('Standalone decimal point is not a valid number.');
      }

      const parsed = Number(numStr);
      if (!Number.isFinite(parsed)) {
        throw new CalculatorExpressionError(`Numeric literal "${numStr}" is not finite.`);
      }

      tokens.push({ type: 'number', value: parsed });
      continue;
    }

    throw new CalculatorExpressionError(`Unexpected character "${ch}" in expression.`);
  }

  if (parenDepth !== 0) {
    throw new CalculatorExpressionError('Unclosed parenthesis in expression.');
  }

  return tokens;
}

/**
 * Pure recursive-descent arithmetic evaluator (`TOOL-001`).
 *
 * Grammar:
 *   Expression := Term (('+' | '-') Term)*
 *   Term       := Factor (('*' | '/' | '%') Factor)*
 *   Factor     := ('+' | '-') Factor | '(' Expression ')' | Number
 *
 * Never calls `eval()` or `new Function()`.
 */
export function evaluateSafeArithmetic(expression: string): number {
  const tokens = tokenizeArithmetic(expression);
  let cursor = 0;
  let recursionDepth = 0;

  function peek(): CalcToken | undefined {
    return tokens[cursor];
  }

  function consume(): CalcToken {
    const token = tokens[cursor];
    if (!token) {
      throw new CalculatorExpressionError('Unexpected end of arithmetic expression.');
    }
    cursor += 1;
    return token;
  }

  function parseExpression(): number {
    let left = parseTerm();

    while (true) {
      const next = peek();
      if (next && next.type === 'op' && (next.value === '+' || next.value === '-')) {
        consume();
        const right = parseTerm();
        left = next.value === '+' ? left + right : left - right;
        if (!Number.isFinite(left)) {
          throw new CalculatorExpressionError('Arithmetic overflow resulted in a non-finite value.');
        }
      } else {
        break;
      }
    }

    return left;
  }

  function parseTerm(): number {
    let left = parseFactor();

    while (true) {
      const next = peek();
      if (
        next &&
        next.type === 'op' &&
        (next.value === '*' || next.value === '/' || next.value === '%')
      ) {
        consume();
        const right = parseFactor();
        if ((next.value === '/' || next.value === '%') && right === 0) {
          throw new CalculatorExpressionError('Division or modulo by zero is not permitted.');
        }
        if (next.value === '*') {
          left = left * right;
        } else if (next.value === '/') {
          left = left / right;
        } else {
          left = left % right;
        }
        if (!Number.isFinite(left)) {
          throw new CalculatorExpressionError('Arithmetic operation resulted in a non-finite value.');
        }
      } else {
        break;
      }
    }

    return left;
  }

  function parseFactor(): number {
    recursionDepth += 1;
    if (recursionDepth > 64) {
      throw new CalculatorExpressionError('Expression exceeds maximum unary/nesting depth.');
    }

    try {
      const next = peek();
      if (!next) {
        throw new CalculatorExpressionError('Unexpected end of arithmetic expression.');
      }

      if (next.type === 'op' && (next.value === '+' || next.value === '-')) {
        consume();
        const operand = parseFactor();
        return next.value === '-' ? -operand : operand;
      }

      if (next.type === 'paren' && next.value === '(') {
        consume();
        const inner = parseExpression();
        const closing = consume();
        if (closing.type !== 'paren' || closing.value !== ')') {
          throw new CalculatorExpressionError('Expected closing parenthesis ")".');
        }
        return inner;
      }

      if (next.type === 'number') {
        consume();
        return next.value;
      }

      throw new CalculatorExpressionError(
        `Unexpected token "${next.value}" while parsing arithmetic factor.`
      );
    } finally {
      recursionDepth -= 1;
    }
  }

  const rawResult = parseExpression();

  if (cursor < tokens.length) {
    const trailing = tokens[cursor]!;
    throw new CalculatorExpressionError(
      `Unexpected trailing token "${trailing.value}" in arithmetic expression.`
    );
  }

  if (!Number.isFinite(rawResult)) {
    throw new CalculatorExpressionError('Arithmetic evaluation produced a non-finite number.');
  }

  const normalized = Number(rawResult.toFixed(10));
  return Object.is(normalized, -0) ? 0 : normalized;
}

export const calculatorToolArgsSchema = z
  .object({
    expression: z
      .string()
      .trim()
      .min(1, 'Calculator expression must not be empty.')
      .max(
        MAX_CALCULATOR_EXPRESSION_LENGTH,
        `Calculator expression must not exceed ${MAX_CALCULATOR_EXPRESSION_LENGTH} characters.`
      ),
  })
  .strict();

export const knowledgeSearchToolArgsSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, 'Knowledge search query must not be empty.')
    .max(500, 'Knowledge search query must not exceed 500 characters.'),
  topK: z.number().int().min(1).max(10).optional().default(3),
});

export interface CalculatorToolOutput {
  expression: string;
  result: number;
}

export interface KnowledgeSearchToolOutput {
  organizationId: string;
  query: string;
  topK: number;
  chunks: RetrievedKnowledgeChunk[];
}

export type KnowledgeSearchRetriever = (params: {
  organizationId: string;
  query: string;
  topK: number;
}) => Promise<RetrievedKnowledgeChunk[]>;

export interface ToolExecutionContext {
  organizationId: string;
  runId?: string;
  allowedTools: readonly AllowedToolName[];
  timeoutMs?: number;
  maxPayloadBytes?: number;
}

export interface ToolExecutionResult<TOutput = CalculatorToolOutput | KnowledgeSearchToolOutput> {
  toolCallId: string;
  toolName: AllowedToolName;
  sanitizedArguments: Record<string, unknown>;
  output: TOutput;
  serializedOutput: string;
  durationMs: number;
  inputBytes: number;
  outputBytes: number;
}

export interface ToolGatewayOptions {
  knowledgeSearchRetriever?: KnowledgeSearchRetriever;
  defaultTimeoutMs?: number;
  defaultMaxPayloadBytes?: number;
}

function isKnownToolName(name: string): name is AllowedToolName {
  return (ALLOWED_TOOLS as readonly string[]).includes(name);
}

async function runWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  toolName: string
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new ToolExecutionError(
          'TOOL_TIMEOUT',
          toolName,
          `Tool "${toolName}" exceeded execution timeout of ${timeoutMs}ms.`,
          504
        )
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(), timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

/**
 * Central Server-Authorized Tool Gateway (`TOOL-001` & `TOOL-002`).
 *
 * Guarantees that every model-requested tool call is:
 * 1. Checked against the known server tool catalog (`ALLOWED_AGENT_TOOLS`).
 * 2. Checked against the immutable `AgentVersionSnapshot.allowedTools` allowlist.
 * 3. Bounded by input and output byte budgets (`maxPayloadBytes`).
 * 4. Validated via Zod and scoped to the server-authenticated `organizationId`.
 * 5. Bounded by a hard execution timeout (`timeoutMs`).
 */
export class ToolGateway {
  private readonly knowledgeSearchRetriever: KnowledgeSearchRetriever;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxPayloadBytes: number;

  constructor(options: ToolGatewayOptions = {}) {
    this.knowledgeSearchRetriever =
      options.knowledgeSearchRetriever ?? (async () => []);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.defaultMaxPayloadBytes =
      options.defaultMaxPayloadBytes ?? DEFAULT_TOOL_MAX_PAYLOAD_BYTES;
  }

  public async executeToolCall(
    call: ModelToolCallRequest,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const startMs = performance.now();

    if (!context.organizationId || context.organizationId.trim().length === 0) {
      throw new ToolExecutionError(
        'INVALID_TOOL_ARGUMENTS',
        call.name,
        'Tool execution requires a valid server-resolved organizationId.',
        422
      );
    }

    // 1. Verify the tool exists in the server-side catalog
    if (!isKnownToolName(call.name)) {
      throw new ToolAuthorizationError(
        'UNKNOWN_TOOL',
        call.name,
        `Tool "${call.name}" is not registered in the server tool gateway.`
      );
    }

    // 2. Enforce the immutable AgentVersionSnapshot.allowedTools allowlist (Threat T-03)
    if (!context.allowedTools.includes(call.name)) {
      throw new ToolAuthorizationError(
        'TOOL_NOT_ALLOWED_FOR_AGENT',
        call.name,
        `Tool "${call.name}" is not enabled in the published agent version allowlist.`
      );
    }

    const maxPayloadBytes = context.maxPayloadBytes ?? this.defaultMaxPayloadBytes;
    const timeoutMs = context.timeoutMs ?? this.defaultTimeoutMs;

    // 3. Enforce input payload size limit before parsing
    const serializedArgs = JSON.stringify(call.arguments ?? {});
    const inputBytes = Buffer.byteLength(serializedArgs, 'utf8');
    if (inputBytes > maxPayloadBytes) {
      throw new ToolExecutionError(
        'TOOL_INPUT_TOO_LARGE',
        call.name,
        `Tool "${call.name}" input arguments (${inputBytes} bytes) exceed limit of ${maxPayloadBytes} bytes.`,
        413
      );
    }

    // 4. Validate arguments and execute with timeout guard
    if (call.name === 'calculator') {
      const parsedArgs = calculatorToolArgsSchema.safeParse(call.arguments);
      if (!parsedArgs.success) {
        throw new ToolExecutionError(
          'INVALID_TOOL_ARGUMENTS',
          'calculator',
          `Invalid calculator arguments: ${parsedArgs.error.issues.map((i) => i.message).join('; ')}`,
          422
        );
      }

      const { expression } = parsedArgs.data;
      const output = await runWithTimeout<CalculatorToolOutput>(
        async () => {
          try {
            const result = evaluateSafeArithmetic(expression);
            return { expression, result };
          } catch (error) {
            if (error instanceof CalculatorExpressionError) {
              throw new ToolExecutionError(
                'INVALID_TOOL_ARGUMENTS',
                'calculator',
                error.message,
                422
              );
            }
            throw error;
          }
        },
        timeoutMs,
        'calculator'
      );

      return this.finalizeResult(
        call.id,
        'calculator',
        { expression },
        output,
        inputBytes,
        maxPayloadBytes,
        startMs
      );
    }

    // call.name === 'knowledge_search'
    // Note: knowledgeSearchToolArgsSchema intentionally strips any spoofed `organizationId`
    // passed by a prompt-injected model; the server context's organizationId is always used.
    const parsedArgs = knowledgeSearchToolArgsSchema.safeParse(call.arguments);
    if (!parsedArgs.success) {
      throw new ToolExecutionError(
        'INVALID_TOOL_ARGUMENTS',
        'knowledge_search',
        `Invalid knowledge_search arguments: ${parsedArgs.error.issues.map((i) => i.message).join('; ')}`,
        422
      );
    }

    const { query, topK } = parsedArgs.data;
    const output = await runWithTimeout<KnowledgeSearchToolOutput>(
      async () => {
        try {
          const chunks = await this.knowledgeSearchRetriever({
            organizationId: context.organizationId,
            query,
            topK,
          });
          return {
            organizationId: context.organizationId,
            query,
            topK,
            chunks,
          };
        } catch (error) {
          if (error instanceof ToolExecutionError) {
            throw error;
          }
          throw new ToolExecutionError(
            'TOOL_EXECUTION_FAILED',
            'knowledge_search',
            error instanceof Error ? error.message : 'Knowledge search retriever failed.',
            500
          );
        }
      },
      timeoutMs,
      'knowledge_search'
    );

    return this.finalizeResult(
      call.id,
      'knowledge_search',
      { query, topK },
      output,
      inputBytes,
      maxPayloadBytes,
      startMs
    );
  }

  private finalizeResult(
    toolCallId: string,
    toolName: AllowedToolName,
    sanitizedArguments: Record<string, unknown>,
    output: CalculatorToolOutput | KnowledgeSearchToolOutput,
    inputBytes: number,
    maxPayloadBytes: number,
    startMs: number
  ): ToolExecutionResult {
    const serializedOutput = JSON.stringify(output);
    const outputBytes = Buffer.byteLength(serializedOutput, 'utf8');

    if (outputBytes > maxPayloadBytes) {
      throw new ToolExecutionError(
        'TOOL_OUTPUT_TOO_LARGE',
        toolName,
        `Tool "${toolName}" output payload (${outputBytes} bytes) exceeds limit of ${maxPayloadBytes} bytes.`,
        413
      );
    }

    const durationMs = Math.max(0, Math.round(performance.now() - startMs));

    return {
      toolCallId,
      toolName,
      sanitizedArguments,
      output,
      serializedOutput,
      durationMs,
      inputBytes,
      outputBytes,
    };
  }
}
