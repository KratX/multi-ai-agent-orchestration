import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';

// Prevent bundled sub-modules (demo-seed.ts, seed.ts, worker/main.ts) from thinking
// they were invoked directly as CLI entrypoints when esbuild bundles into dist/server.js.
const originalCliArgv1 = process.argv[1] ?? '';
if (originalCliArgv1.replace(/\\/g, '/').endsWith('server.js') || originalCliArgv1.replace(/\\/g, '/').endsWith('server.ts')) {
  process.argv[1] = '__ordaris_bundled_server_entry__';
}

// Configure low-memory PostgreSQL buffers on PGlite globally before any DB instance is created
// so PGlite uses 2MB shared_buffers instead of the 128MB Postgres default (keeps RSS ~185MB on Render 512Mi plan).
if (!PGlite.defaultStartParams.includes('shared_buffers=2MB')) {
  PGlite.defaultStartParams.push(
    '-c',
    'shared_buffers=2MB',
    '-c',
    'work_mem=1MB',
    '-c',
    'maintenance_work_mem=2MB',
    '-c',
    'temp_buffers=1MB',
    '-c',
    'wal_buffers=256kB'
  );
}

function runGarbageCollectionIfAvailable(): void {
  const maybeGc = (globalThis as unknown as { gc?: () => void }).gc;
  if (typeof maybeGc === 'function') {
    try {
      maybeGc();
    } catch {
      // Ignore GC errors
    }
  }
}

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
  const isPreseed = process.argv.includes('--preseed-only');
  const isStaticCloud =
    isRender || normalized.SERVE_STATIC === 'true' || isPreseed;

  if (normalized.RENDER_EXTERNAL_URL && !normalized.APP_URL) {
    normalized.APP_URL = normalized.RENDER_EXTERNAL_URL;
  }

  if (isStaticCloud) {
    process.env.SERVE_STATIC = 'true';
    normalized.SERVE_STATIC = 'true';

    // Store pre-seeded PGlite database inside dist/ordaris-db on static cloud builds so
    // Render's build artifact uploader always carries the pre-initialized DB to the runtime container.
    if (!normalized.PGLITE_DATA_DIR || normalized.PGLITE_DATA_DIR === '.local/ordaris-db') {
      normalized.PGLITE_DATA_DIR = 'dist/ordaris-db';
      process.env.PGLITE_DATA_DIR = 'dist/ordaris-db';
    }

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

export async function preseedDatabaseForBuild(): Promise<void> {
  const { parseEnv } = await import('./src/server/config/env');
  const { closeSharedDatabase, getSharedDatabase } = await import('./src/server/db/client');
  const { ensureWorkspaceSeededWithPendingHitl } = await import('./src/server/http/app');

  const env = parseEnv(normalizeRenderRuntimeEnv(process.env));
  const dbContext = await getSharedDatabase({ dataDir: env.PGLITE_DATA_DIR });
  runGarbageCollectionIfAvailable();
  await ensureWorkspaceSeededWithPendingHitl(dbContext.db, { forceReset: false });
  if (dbContext.dataDir) {
    try {
      fs.writeFileSync(
        path.join(dbContext.dataDir, '.ordaris-migrated-v1'),
        'ok\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(dbContext.dataDir, '.ordaris-seeded-v1'),
        new Date().toISOString() + '\n',
        'utf8'
      );
    } catch {
      // Ignore marker write error
    }
  }
  await closeSharedDatabase();
  runGarbageCollectionIfAvailable();
}

export async function startOrdarisServer(port = 3000) {
  const {
    appendRuntimeLog,
    getProviderKeyStatus,
    LOG_FILE_PATH,
    parseEnv,
  } = await import('./src/server/config/env');
  const { createLiveRuntimeModelProvider } = await import('./src/server/ai/model-provider');
  const { closeSharedDatabase, getSharedDatabase } = await import('./src/server/db/client');
  const {
    createApiApp,
    ensureWorkspaceSeededWithPendingHitl,
  } = await import('./src/server/http/app');
  const { RuntimeWorker } = await import('./src/server/worker/main');

  const env = parseEnv(normalizeRenderRuntimeEnv(process.env));
  const dbContext = await getSharedDatabase({ dataDir: env.PGLITE_DATA_DIR });
  runGarbageCollectionIfAvailable();

  const seedMarkerPath = dbContext.dataDir
    ? path.join(dbContext.dataDir, '.ordaris-seeded-v1')
    : null;
  const alreadyPreseeded = Boolean(
    seedMarkerPath &&
      fs.existsSync(seedMarkerPath) &&
      dbContext.dataDir &&
      fs.existsSync(path.join(dbContext.dataDir, 'PG_VERSION'))
  );

  // Seed default workspace on first startup if not already pre-seeded during build
  if (!alreadyPreseeded) {
    try {
      await ensureWorkspaceSeededWithPendingHitl(dbContext.db, { forceReset: false });
      if (seedMarkerPath) {
        try {
          fs.writeFileSync(seedMarkerPath, new Date().toISOString() + '\n', 'utf8');
        } catch {
          // Ignore marker write error
        }
      }
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
    runGarbageCollectionIfAvailable();
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
    const { createServer: createViteServer } = await import('vite');
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
    runGarbageCollectionIfAvailable();
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
  process.argv[1] === '__ordaris_bundled_server_entry__' ||
  (Boolean(originalCliArgv1) &&
    fileURLToPath(import.meta.url).endsWith(
      originalCliArgv1.replace(/^file:\/\//, '')
    ));

if (isDirectExecution) {
  if (process.argv.includes('--preseed-only')) {
    preseedDatabaseForBuild()
      .then(() => {
        process.stdout.write('Pre-seeded dist/ordaris-db for low-memory startup.\n');
        process.exit(0);
      })
      .catch((error) => {
        process.stderr.write(
          `Pre-seed warning: ${error instanceof Error ? error.message : String(error)}\n`
        );
        process.exit(0);
      });
  } else {
    const port = resolveCliPort(process.argv.slice(2));
    startOrdarisServer(port).catch((error) => {
      process.stderr.write(
        `Failed to start Ordaris Runtime server: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exit(1);
    });
  }
}
