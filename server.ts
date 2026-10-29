import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { parseEnv } from './src/server/config/env';
import { createModelProvider } from './src/server/ai/model-provider';
import { closeSharedDatabase, getSharedDatabase } from './src/server/db/client';
import {
  createApiApp,
  ensureWorkspaceSeededWithPendingHitl,
} from './src/server/http/app';
import { RuntimeWorker } from './src/server/worker/main';

/**
 * Full-Stack Aegis Runtime Server (`server.ts`)
 *
 * Starts on port 3000 (`0.0.0.0`):
 * 1. Validates environment configuration (`parseEnv`).
 * 2. Initializes persistent PGlite PostgreSQL (`PGLITE_DATA_DIR`, default `.local/aegis-db`).
 * 3. Seeds the Flagship Multi-Tenant Workspace on first boot if empty.
 * 4. Starts the background `RuntimeWorker` polling loop (`FOR UPDATE SKIP LOCKED`).
 * 5. Mounts all `/api/v1/*` routes and serves the Vite React frontend.
 */

export async function startAegisServer(port = 3000) {
  const env = parseEnv(process.env);
  const dbContext = await getSharedDatabase({ dataDir: env.PGLITE_DATA_DIR });

  // Seed default workspace on first startup if empty
  await ensureWorkspaceSeededWithPendingHitl(dbContext.db, { forceReset: false });

  const modelProvider = createModelProvider(env);
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
      `Aegis Runtime server listening on http://localhost:${port} (AI_MODE=${env.AI_MODE}, storage=${dbContext.storageMode})\n`
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
  startAegisServer(port).catch((error) => {
    process.stderr.write(
      `Failed to start Aegis Runtime server: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
}
