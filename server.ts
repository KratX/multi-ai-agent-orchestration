import 'dotenv/config';
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
 * Full-Stack Ordaris Runtime Server (`server.ts`)
 *
 * Starts on port 3000 (`0.0.0.0`):
 * 1. Loads `.env` automatically via `dotenv/config` and validates configuration (`parseEnv`).
 * 2. Initializes persistent PGlite PostgreSQL (`PGLITE_DATA_DIR`, default `.local/ordaris-db`).
 * 3. Seeds the Flagship Multi-Tenant Workspace on first boot if empty.
 * 4. Starts the background `RuntimeWorker` polling loop (`FOR UPDATE SKIP LOCKED`) wired to
 *    free-tier cloud AI (`Gemini 3 Flash`, `ChatGPT gpt-4o-mini`, `Claude 3.5 Haiku`, `Grok 2`)
 *    with automatic zero-key local fallback.
 * 5. Mounts all `/api/v1/*` routes (including `/api/v1/logs`) and serves the Vite React UI.
 */

export async function startOrdarisServer(port = 3000) {
  const env = parseEnv(process.env);
  const dbContext = await getSharedDatabase({ dataDir: env.PGLITE_DATA_DIR });

  // Seed default workspace on first startup if empty
  await ensureWorkspaceSeededWithPendingHitl(dbContext.db, { forceReset: false });

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

  const rootDir = path.dirname(fileURLToPath(import.meta.url));

  if (env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(rootDir, 'dist');
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

const isDirectExecution =
  process.argv[1] &&
  fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^file:\/\//, ''));

if (isDirectExecution) {
  const port = Number(process.env.PORT ?? 3000) || 3000;
  startOrdarisServer(port).catch((error) => {
    process.stderr.write(
      `Failed to start Ordaris Runtime server: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
}
