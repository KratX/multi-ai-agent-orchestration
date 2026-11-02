import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import {
  appendRuntimeLog,
  getProviderKeyStatus,
  LOG_FILE_PATH,
  parseEnv,
} from './src/server/config/env';
import { createLiveRuntimeModelProvider } from './src/server/ai/model-provider';
import { closeSharedDatabase, getSharedDatabase } from './src/server/db/client';
import {
  createApiApp,
  ensureWorkspaceSeededWithPendingHitl,
} from './src/server/http/app';
import { RuntimeWorker } from './src/server/worker/main';

/**
 * Normalizes Render.com / cloud container environment variables so deploying via
 * Render Blueprint (`render.yaml`) or standard Render Web Service (`npm run build && npm start`)
 * boots out-of-the-box with zero manual env configuration required.
 */
function normalizeRenderRuntimeEnv(
  raw: Record<string, string | undefined>
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = { ...raw };
  const isRender =
    normalized.RENDER === 'true' || Boolean(normalized.RENDER_EXTERNAL_URL);
  const isStaticCloud = isRender || normalized.SERVE_STATIC === 'true';

  if (normalized.RENDER_EXTERNAL_URL && !normalized.APP_URL) {
    normalized.APP_URL = normalized.RENDER_EXTERNAL_URL;
  }

  if (isStaticCloud) {
    process.env.SERVE_STATIC = 'true';
    normalized.SERVE_STATIC = 'true';

    // Generate a strong ephemeral AUTH_SECRET if none was configured in Render dashboard
    if (
      !normalized.AUTH_SECRET ||
      normalized.AUTH_SECRET === 'local-dev-only-auth-secret-change-me' ||
      normalized.AUTH_SECRET === 'replace-with-local-random-value-at-least-16-chars'
    ) {
      const generatedSecret = crypto.randomBytes(32).toString('hex');
      process.env.AUTH_SECRET = generatedSecret;
      normalized.AUTH_SECRET = generatedSecret;
    }

    // Keep the 8-Persona Interactive Sandbox active on Render unless LOCKDOWN_PRODUCTION="true"
    if (normalized.LOCKDOWN_PRODUCTION !== 'true') {
      normalized.NODE_ENV = 'development';
      normalized.DEMO_MODE = 'true';
      process.env.NODE_ENV = 'development';
      process.env.DEMO_MODE = 'true';
    }
  }

  return normalized;
}

export async function startOrdarisServer(port = 3000) {
  const env = parseEnv(normalizeRenderRuntimeEnv(process.env));
  const dbContext = await getSharedDatabase({ dataDir: env.PGLITE_DATA_DIR });

  // Seed default workspace on first startup if empty
  try {
    await ensureWorkspaceSeededWithPendingHitl(dbContext.db, { forceReset: false });
  } catch (seedErr) {
    appendRuntimeLog({
      level: 'WARN',
      component: 'server.ts',
      message: `Initial workspace seed check encountered an issue, retrying with clean reset: ${
        seedErr instanceof Error ? seedErr.message : String(seedErr)
      }`,
    });
    try {
      await ensureWorkspaceSeededWithPendingHitl(dbContext.db, { forceReset: true });
    } catch {
      // Continue booting server even if seed retry fails
    }
  }

  const modelProvider = createLiveRuntimeModelProvider(env, { engine: 'auto' });
  const keyStatus = getProviderKeyStatus(env);

  appendRuntimeLog({
    level: keyStatus.anyConfigured ? 'INFO' : 'WARN',
    component: 'server.ts',
    message: keyStatus.anyConfigured
      ? `Ordaris Runtime booted with active cloud AI provider (${modelProvider.providerName}).`
      : `Ordaris Runtime booted with 0 cloud API keys in .env; using local fallback until GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or XAI_API_KEY is added to .env.`,
    details: {
      storageMode: dbContext.storageMode,
      logFilePath: LOG_FILE_PATH,
      providerKeys: keyStatus,
    },
  });

  const worker = new RuntimeWorker({
    db: dbContext.db,
    modelProvider,
  });
  worker.start();

  const app = createApiApp({
    contextProvider: async () => dbContext,
    worker,
    modelProvider,
  });

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const distPath = fs.existsSync(path.join(currentDir, 'index.html'))
    ? currentDir
    : path.join(currentDir, 'dist');
  const shouldServeStaticDist =
    env.NODE_ENV === 'production' ||
    (process.env.SERVE_STATIC === 'true' &&
      fs.existsSync(path.join(distPath, 'index.html')));

  if (!shouldServeStaticDist) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = app.listen(port, '0.0.0.0', () => {
    process.stdout.write(
      `Ordaris Runtime server listening on http://localhost:${port} (AI=${modelProvider.providerName}, storage=${dbContext.storageMode}, logs=${LOG_FILE_PATH})\n`
    );
  });

  const shutdown = async () => {
    await worker.stop();
    httpServer.close();
    await closeSharedDatabase();
  };

  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));

  return { app, httpServer, worker, dbContext, shutdown };
}

function resolveCliPort(argv: string[]): number {
  const portFlagIndex = argv.findIndex((arg) => arg === '--port' || arg === '-p');
  if (portFlagIndex !== -1 && argv[portFlagIndex + 1]) {
    const parsed = Number(argv[portFlagIndex + 1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const inlinePortArg = argv.find((arg) => arg.startsWith('--port='));
  if (inlinePortArg) {
    const parsed = Number(inlinePortArg.slice('--port='.length));
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return Number(process.env.PORT ?? 3000) || 3000;
}

const isDirectExecution =
  process.argv[1] &&
  fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^file:\/\//, ''));

if (isDirectExecution) {
  const port = resolveCliPort(process.argv.slice(2));
  startOrdarisServer(port).catch((error) => {
    process.stderr.write(
      `Failed to start Ordaris Runtime server: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
}
