import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Ticket REPO-003: Ordaris (v1.0.0-demo) Server Environment Schema, Runtime Configuration & Diagnostic Logger
 *
 * Enforces Blueprint Section 2.5 & Section 6.3:
 * 1. Fails fast at startup if numeric limits or URLs are malformed.
 * 2. Allows AI_MODE="demo" (default) to boot with zero external API keys.
 * 3. Requires AI_PROVIDER_API_KEY (or GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / XAI_API_KEY / OPENROUTER_API_KEY)
 *    ONLY when AI_MODE="provider".
 * 4. Blocks unsafe DEMO_MODE authentication bypass in production unless explicitly safe.
 * 5. Writes structured diagnostic logs to `.local/logs/ordaris-runtime.log`, stdout/stderr,
 *    and an in-memory ring buffer exposed at `GET /api/v1/logs`.
 */

export const LOG_FILE_PATH = '.local/logs/ordaris-runtime.log';

export interface RuntimeLogEntry {
  id: string;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  component: string;
  message: string;
  details?: Record<string, unknown>;
}

const runtimeLogBuffer: RuntimeLogEntry[] = [];
const MAX_LOG_BUFFER_SIZE = 200;

export function appendRuntimeLog(entry: {
  level: 'INFO' | 'WARN' | 'ERROR';
  component: string;
  message: string;
  details?: Record<string, unknown>;
}): RuntimeLogEntry {
  const record: RuntimeLogEntry = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    level: entry.level,
    component: entry.component,
    message: entry.message,
    details: entry.details,
  };

  runtimeLogBuffer.unshift(record);
  if (runtimeLogBuffer.length > MAX_LOG_BUFFER_SIZE) {
    runtimeLogBuffer.length = MAX_LOG_BUFFER_SIZE;
  }

  const formattedLine = `[${record.timestamp}] [${record.level}] [${record.component}] ${record.message}${
    record.details ? ` | ${JSON.stringify(record.details)}` : ''
  }\n`;

  // Print to terminal stdout/stderr when not running quiet unit tests
  if (!process.env.NODE_TEST_CONTEXT) {
    if (record.level === 'ERROR') {
      process.stderr.write(formattedLine);
    } else {
      process.stdout.write(formattedLine);
    }
  }

  // Persist to .local/logs/ordaris-runtime.log
  try {
    const absLogPath = path.resolve(process.cwd(), LOG_FILE_PATH);
    fs.mkdirSync(path.dirname(absLogPath), { recursive: true });
    fs.appendFileSync(absLogPath, formattedLine, 'utf8');
  } catch {
    // Ignore file write errors in read-only containers
  }

  return record;
}

export function getRuntimeLogs(limit = 80): RuntimeLogEntry[] {
  return runtimeLogBuffer.slice(0, limit);
}

export function clearRuntimeLogs(): void {
  runtimeLogBuffer.length = 0;
}

const booleanStringSchema = z
  .enum(['true', 'false', '1', '0'])
  .default('true')
  .transform((val) => val === 'true' || val === '1');

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_URL: z.string().url().default('http://localhost:3000'),
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL must not be empty')
      .default('postgresql://postgres:postgres@localhost:5432/agent_platform'),
    PGLITE_DATA_DIR: z
      .string()
      .min(1, 'PGLITE_DATA_DIR must not be empty')
      .default('.local/ordaris-db'),

    AUTH_SECRET: z
      .string()
      .min(16, 'AUTH_SECRET must be at least 16 characters')
      .default('local-dev-only-auth-secret-change-me'),
    AUTH_GITHUB_ID: z.string().optional().default(''),
    AUTH_GITHUB_SECRET: z.string().optional().default(''),

    AI_MODE: z.enum(['demo', 'local', 'provider']).default('demo'),
    AI_PROVIDER_API_KEY: z.string().optional().default(''),
    GEMINI_API_KEY: z.string().optional().default(''),
    OPENAI_API_KEY: z.string().optional().default(''),
    OPENAI_BASE_URL: z
      .string()
      .url()
      .optional()
      .default('https://api.openai.com/v1/chat/completions'),
    ANTHROPIC_API_KEY: z.string().optional().default(''),
    XAI_API_KEY: z.string().optional().default(''),
    XAI_BASE_URL: z
      .string()
      .url()
      .optional()
      .default('https://api.x.ai/v1/chat/completions'),
    OPENROUTER_API_KEY: z.string().optional().default(''),
    AI_PROVIDER_MODEL: z.string().min(1).default('gemini-3-flash-preview'),

    UPLOAD_DIR: z.string().min(1).default('.local/uploads'),
    MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .min(1024, 'MAX_UPLOAD_BYTES must be at least 1 KiB')
      .max(52_428_800, 'MAX_UPLOAD_BYTES cannot exceed 50 MiB')
      .default(10_485_760),

    RUN_MAX_STEPS: z.coerce
      .number()
      .int()
      .min(1, 'RUN_MAX_STEPS must be at least 1')
      .max(25, 'RUN_MAX_STEPS cannot exceed 25')
      .default(8),
    RUN_MAX_TOOL_CALLS: z.coerce
      .number()
      .int()
      .min(0, 'RUN_MAX_TOOL_CALLS cannot be negative')
      .max(20, 'RUN_MAX_TOOL_CALLS cannot exceed 20')
      .default(6),
    RUN_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .min(5, 'RUN_TIMEOUT_SECONDS must be at least 5 seconds')
      .max(600, 'RUN_TIMEOUT_SECONDS cannot exceed 600 seconds')
      .default(120),

    WORKER_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(1000),
    WORKER_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(2),
    WORKER_LEASE_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(300_000)
      .default(30_000),

    DEMO_MODE: booleanStringSchema,
  })
  .superRefine((env, ctx) => {
    // Rule 1: If AI_MODE is "provider", a real non-placeholder API key is mandatory.
    if (env.AI_MODE === 'provider') {
      const effectiveKey = (
        env.AI_PROVIDER_API_KEY ||
        env.GEMINI_API_KEY ||
        env.OPENAI_API_KEY ||
        env.ANTHROPIC_API_KEY ||
        env.XAI_API_KEY ||
        env.OPENROUTER_API_KEY
      ).trim();
      const isPlaceholder =
        !effectiveKey ||
        effectiveKey === 'MY_GEMINI_API_KEY' ||
        effectiveKey === 'replace-me';

      if (isPlaceholder) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AI_PROVIDER_API_KEY'],
          message:
            'AI_PROVIDER_API_KEY (or GEMINI_API_KEY) is required when AI_MODE="provider". Use AI_MODE="demo" for zero-key local execution.',
        });
      }
    }

    // Rule 2: In production, reject the default local placeholder AUTH_SECRET.
    if (
      env.NODE_ENV === 'production' &&
      (env.AUTH_SECRET === 'local-dev-only-auth-secret-change-me' ||
        env.AUTH_SECRET === 'replace-with-local-random-value-at-least-16-chars')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_SECRET'],
        message: 'Production environment requires a non-default AUTH_SECRET.',
      });
    }

    // Rule 3: Block DEMO_MODE authentication bypass in production.
    if (env.NODE_ENV === 'production' && env.DEMO_MODE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DEMO_MODE'],
        message:
          'DEMO_MODE authentication bypass cannot be enabled when NODE_ENV="production". Set DEMO_MODE="false" in production.',
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

export function isConfiguredApiKey(val: string | undefined): boolean {
  const clean = (val ?? '').trim();
  return Boolean(clean && clean !== 'MY_GEMINI_API_KEY' && clean !== 'replace-me');
}

export function getProviderKeyStatus(env: Partial<AppEnv> = process.env as unknown as Partial<AppEnv>) {
  const gemini =
    isConfiguredApiKey(env.AI_PROVIDER_API_KEY) ||
    isConfiguredApiKey(env.GEMINI_API_KEY) ||
    isConfiguredApiKey(process.env.AI_PROVIDER_API_KEY) ||
    isConfiguredApiKey(process.env.GEMINI_API_KEY);
  const chatgpt =
    isConfiguredApiKey(env.OPENAI_API_KEY) ||
    isConfiguredApiKey(process.env.OPENAI_API_KEY);
  const claude =
    isConfiguredApiKey(env.ANTHROPIC_API_KEY) ||
    isConfiguredApiKey(process.env.ANTHROPIC_API_KEY);
  const grok =
    isConfiguredApiKey(env.XAI_API_KEY) ||
    isConfiguredApiKey(process.env.XAI_API_KEY);
  const openrouter =
    isConfiguredApiKey(env.OPENROUTER_API_KEY) ||
    isConfiguredApiKey(process.env.OPENROUTER_API_KEY);

  return {
    gemini,
    chatgpt,
    claude,
    grok,
    openrouter,
    anyConfigured: gemini || chatgpt || claude || grok || openrouter,
  };
}

/**
 * Parses an arbitrary environment record (e.g., process.env or test fixture)
 * and throws a descriptive error if any variable violates runtime guardrails.
 */
export function parseEnv(rawEnv: Record<string, string | undefined> = process.env): AppEnv {
  const normalized: Record<string, string | undefined> = { ...rawEnv };

  // Normalize AI Studio placeholder APP_URL="MY_APP_URL" so local dev doesn't fail URL parsing
  if (!normalized.APP_URL || normalized.APP_URL === 'MY_APP_URL') {
    normalized.APP_URL = 'http://localhost:3000';
  }
  if (!normalized.OPENAI_BASE_URL) {
    normalized.OPENAI_BASE_URL = 'https://api.openai.com/v1/chat/completions';
  }
  if (!normalized.XAI_BASE_URL) {
    normalized.XAI_BASE_URL = 'https://api.x.ai/v1/chat/completions';
  }
  // In production, default DEMO_MODE to 'false' unless explicitly supplied (which Rule 3 will reject if 'true')
  if (normalized.NODE_ENV === 'production' && normalized.DEMO_MODE === undefined) {
    normalized.DEMO_MODE = 'false';
  }

  const result = envSchema.safeParse(normalized);
  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${formatted}`);
  }

  return result.data;
}

/**
 * Returns a redacted, client-safe summary of the runtime configuration
 * for health/readiness inspection (never exposes secrets or DATABASE_URL credentials).
 */
export function getPublicEnvSummary(env: AppEnv = parseEnv()) {
  const keyStatus = getProviderKeyStatus(env);
  return {
    nodeEnv: env.NODE_ENV,
    aiMode: env.AI_MODE,
    demoMode: env.DEMO_MODE,
    githubOAuthConfigured: Boolean(
      env.AUTH_GITHUB_ID?.trim() && env.AUTH_GITHUB_SECRET?.trim()
    ),
    providerModel: env.AI_PROVIDER_MODEL,
    hasLiveProviderKey: keyStatus.anyConfigured,
    providerKeys: keyStatus,
    logFilePath: LOG_FILE_PATH,
    limits: {
      runMaxSteps: env.RUN_MAX_STEPS,
      runMaxToolCalls: env.RUN_MAX_TOOL_CALLS,
      runTimeoutSeconds: env.RUN_TIMEOUT_SECONDS,
      maxUploadBytes: env.MAX_UPLOAD_BYTES,
      workerConcurrency: env.WORKER_CONCURRENCY,
      workerLeaseMs: env.WORKER_LEASE_MS,
    },
  };
}
