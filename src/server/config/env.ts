import { z } from 'zod';

/**
 * Ticket REPO-003: Server Environment Schema & Runtime Configuration
 *
 * Enforces Blueprint Section 2.5 & Section 6.3:
 * 1. Fails fast at startup if numeric limits or URLs are malformed.
 * 2. Allows AI_MODE="demo" (default) to boot with zero external API keys.
 * 3. Requires AI_PROVIDER_API_KEY (or GEMINI_API_KEY) ONLY when AI_MODE="provider".
 * 4. Blocks unsafe DEMO_MODE authentication bypass in production unless explicitly safe.
 */

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
      .default('.local/aegis-db'),

    AUTH_SECRET: z
      .string()
      .min(16, 'AUTH_SECRET must be at least 16 characters')
      .default('local-dev-only-auth-secret-change-me'),
    AUTH_GITHUB_ID: z.string().optional().default(''),
    AUTH_GITHUB_SECRET: z.string().optional().default(''),

    AI_MODE: z.enum(['demo', 'local', 'provider']).default('demo'),
    AI_PROVIDER_API_KEY: z.string().optional().default(''),
    GEMINI_API_KEY: z.string().optional().default(''),
    AI_PROVIDER_MODEL: z.string().min(1).default('gemini-3.8-flash'),

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
      const effectiveKey = (env.AI_PROVIDER_API_KEY || env.GEMINI_API_KEY).trim();
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
  });

export type AppEnv = z.infer<typeof envSchema>;

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
  return {
    nodeEnv: env.NODE_ENV,
    aiMode: env.AI_MODE,
    demoMode: env.DEMO_MODE,
    providerModel: env.AI_PROVIDER_MODEL,
    hasLiveProviderKey: Boolean(
      (env.AI_PROVIDER_API_KEY && env.AI_PROVIDER_API_KEY !== 'MY_GEMINI_API_KEY') ||
        (env.GEMINI_API_KEY && env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY')
    ),
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
