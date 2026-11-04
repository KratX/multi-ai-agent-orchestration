import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';

// Prevent bundled sub-modules (demo-seed.ts, seed.ts, worker/main.ts) from thinking
// they were invoked directly as CLI entrypoints when esbuild bundles into dist/server.js.
const originalCliArgv1 = process.argv[1] ?? '';
if (
  originalCliArgv1.replace(/\\/g, '/').endsWith('server.js') ||
  originalCliArgv1.replace(/\\/g, '/').endsWith('server.ts')
) {
  process.argv[1] = '__ordaris_bundled_server_entry__';
}

const LOW_MEM_POSTGRES_FLAGS = [
  '-c',
  'shared_buffers=1MB',
  '-c',
  'work_mem=256kB',
  '-c',
  'maintenance_work_mem=1MB',
  '-c',
  'temp_buffers=800kB',
  '-c',
  'wal_buffers=64kB',
];

// Configure low-memory PostgreSQL buffers on PGlite globally before any DB instance is created
if (!PGlite.defaultStartParams.includes('shared_buffers=1MB')) {
  PGlite.defaultStartParams.push(...LOW_MEM_POSTGRES_FLAGS);
}

const REQUIRED_PGDATA_SUBDIRS = [
  'base',
  'global',
  'pg_commit_ts',
  'pg_dynshmem',
  'pg_logical',
  'pg_logical/mappings',
  'pg_logical/snapshots',
  'pg_multixact',
  'pg_multixact/members',
  'pg_multixact/offsets',
  'pg_notify',
  'pg_replslot',
  'pg_serial',
  'pg_snapshots',
  'pg_stat',
  'pg_stat_tmp',
  'pg_subtrans',
  'pg_tblspc',
  'pg_twophase',
  'pg_wal',
  'pg_wal/archive_status',
  'pg_wal/summaries',
  'pg_xact',
];

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
 * Ensures all required PostgreSQL PGDATA subdirectories exist (cloud artifact uploaders
 * often strip empty directories like `pg_notify`, `pg_tblspc`, `pg_twophase`, causing
 * PGlite to fail resume and trigger an expensive second WASM initdb in RAM), removes stale
 * `postmaster.pid`, and tunes `postgresql.conf` for minimal RAM usage (~130MB RSS).
 */
export function repairPreseededPostgresDir(rawDir?: string): string | undefined {
  if (!rawDir || rawDir === 'memory://') {
    return undefined;
  }
  const resolvedDir = path.resolve(rawDir);
  fs.mkdirSync(resolvedDir, { recursive: true });

  const pidFile = path.join(resolvedDir, 'postmaster.pid');
  if (fs.existsSync(pidFile)) {
    try {
      fs.rmSync(pidFile, { force: true });
    } catch {
      // Ignore lock cleanup error
    }
  }

  if (fs.existsSync(path.join(resolvedDir, 'PG_VERSION'))) {
    for (const sub of REQUIRED_PGDATA_SUBDIRS) {
      const targetSub = path.join(resolvedDir, sub);
      if (!fs.existsSync(targetSub)) {
        try {
          fs.mkdirSync(targetSub, { recursive: true });
        } catch {
          // Ignore mkdir error
        }
      }
    }

    const confPath = path.join(resolvedDir, 'postgresql.conf');
    if (fs.existsSync(confPath)) {
      try {
        let conf = fs.readFileSync(confPath, 'utf8');
        conf = conf
          .replace(/^max_connections\s*=.*$/m, 'max_connections = 10')
          .replace(/^shared_buffers\s*=.*$/m, 'shared_buffers = 1MB')
          .replace(/^max_wal_size\s*=.*$/m, 'max_wal_size = 32MB')
          .replace(/^min_wal_size\s*=.*$/m, 'min_wal_size = 32MB');
        fs.writeFileSync(confPath, conf, 'utf8');
      } catch {
        // Ignore read-only conf error
      }
    }
  }

  return resolvedDir;
}

/**
 * Normalizes Render.com / cloud container environment variables.
 * Never forces DEMO_MODE=true or PUBLIC_DEMO_SANDBOX=true: production and SERVE_STATIC=true
 * default to locked-down mode (DEMO_MODE=false, PUBLIC_DEMO_SANDBOX=false) unless
 * PUBLIC_DEMO_SANDBOX="true" is explicitly opted in (such as in render.yaml) and DEMO_MODE is not "false".
 */
export function normalizeRenderRuntimeEnv(
  raw: Record<string, string | undefined>
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = { ...raw };
  const isMutatingProcessEnv = raw === process.env;
  const isRender =
    normalized.RENDER === 'true' || Boolean(normalized.RENDER_EXTERNAL_URL);
  const isPreseed = process.argv.includes('--preseed-only');
  const isStaticCloud =
    isRender || normalized.SERVE_STATIC === 'true' || isPreseed;

  if (normalized.RENDER_EXTERNAL_URL && !normalized.APP_URL) {
    normalized.APP_URL = normalized.RENDER_EXTERNAL_URL;
    if (isMutatingProcessEnv) {
      process.env.APP_URL = normalized.RENDER_EXTERNAL_URL;
    }
  }

  if (isStaticCloud) {
    normalized.SERVE_STATIC = 'true';
    if (isMutatingProcessEnv) {
      process.env.SERVE_STATIC = 'true';
    }

    if (!normalized.NODE_ENV) {
      normalized.NODE_ENV = 'production';
      if (isMutatingProcessEnv) {
        process.env.NODE_ENV = 'production';
      }
    }

    // Store pre-seeded PGlite database inside dist/ordaris-db on static cloud builds so
    // Render's build artifact uploader always carries the pre-initialized DB to the runtime container.
    if (
      !normalized.PGLITE_DATA_DIR ||
      normalized.PGLITE_DATA_DIR === '.local/ordaris-db'
    ) {
      normalized.PGLITE_DATA_DIR = 'dist/ordaris-db';
      if (isMutatingProcessEnv) {
        process.env.PGLITE_DATA_DIR = 'dist/ordaris-db';
      }
    }

    // Reduce background worker polling frequency on constrained cloud instances
    if (!normalized.WORKER_CONCURRENCY) {
      normalized.WORKER_CONCURRENCY = '1';
      if (isMutatingProcessEnv) {
        process.env.WORKER_CONCURRENCY = '1';
      }
    }
    if (!normalized.WORKER_POLL_INTERVAL_MS) {
      normalized.WORKER_POLL_INTERVAL_MS = '2500';
      if (isMutatingProcessEnv) {
        process.env.WORKER_POLL_INTERVAL_MS = '2500';
      }
    }

    // Generate a strong ephemeral AUTH_SECRET if none was configured
    if (
      !normalized.AUTH_SECRET ||
      normalized.AUTH_SECRET === 'local-dev-only-auth-secret-change-me' ||
      normalized.AUTH_SECRET ===
        'replace-with-local-random-value-at-least-16-chars'
    ) {
      const generatedSecret = crypto.randomBytes(32).toString('hex');
      normalized.AUTH_SECRET = generatedSecret;
      if (isMutatingProcessEnv) {
        process.env.AUTH_SECRET = generatedSecret;
      }
    }

    // Respect explicit DEMO_MODE="false", PUBLIC_DEMO_SANDBOX="false", or LOCKDOWN_PRODUCTION="true".
    // Default PUBLIC_DEMO_SANDBOX to "false" unless explicitly opted in via PUBLIC_DEMO_SANDBOX="true".
    const explicitDemoDisabled =
      normalized.LOCKDOWN_PRODUCTION === 'true' ||
      normalized.LOCKDOWN_PRODUCTION === '1' ||
      normalized.DEMO_MODE === 'false' ||
      normalized.DEMO_MODE === '0' ||
      normalized.PUBLIC_DEMO_SANDBOX === 'false' ||
      normalized.PUBLIC_DEMO_SANDBOX === '0';

    const explicitSandboxOptIn =
      !explicitDemoDisabled &&
      (normalized.PUBLIC_DEMO_SANDBOX === 'true' ||
        normalized.PUBLIC_DEMO_SANDBOX === '1');

    if (explicitSandboxOptIn) {
      normalized.PUBLIC_DEMO_SANDBOX = 'true';
      normalized.DEMO_MODE = 'true';
      if (isMutatingProcessEnv) {
        process.env.PUBLIC_DEMO_SANDBOX = 'true';
        process.env.DEMO_MODE = 'true';
      }
    } else if (explicitDemoDisabled || normalized.NODE_ENV === 'production') {
      normalized.PUBLIC_DEMO_SANDBOX = 'false';
      normalized.DEMO_MODE = 'false';
      if (isMutatingProcessEnv) {
        process.env.PUBLIC_DEMO_SANDBOX = 'false';
        process.env.DEMO_MODE = 'false';
      }
    }
  }

  return normalized;
}

// Normalize process.env immediately at module load time before submodules are imported
normalizeRenderRuntimeEnv(process.env);

export async function preseedDatabaseForBuild(): Promise<void> {
  const { parseEnv } = await import('./src/server/config/env');
  const { closeSharedDatabase, getSharedDatabase } = await import(
    './src/server/db/client'
  );
  const { ensureWorkspaceSeededWithPendingHitl } = await import(
    './src/server/http/app'
  );

  const env = parseEnv(normalizeRenderRuntimeEnv(process.env));
  const resolvedDir = repairPreseededPostgresDir(env.PGLITE_DATA_DIR);
  const dbContext = await getSharedDatabase({ dataDir: resolvedDir });
  runGarbageCollectionIfAvailable();

  await ensureWorkspaceSeededWithPendingHitl(dbContext.db, { forceReset: false });

  if (dbContext.dataDir) {
    try {
      await dbContext.pg.exec('CHECKPOINT;');
    } catch {
      // Ignore checkpoint error
    }

    repairPreseededPostgresDir(dbContext.dataDir);

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

    // Also export a compact 4.8MB gzipped tarball snapshot in dist/ordaris-db-seed.tar.gz
    // so if the cloud artifact uploader strips any PGDATA files, runtime restores via loadDataDir
    // without ever invoking initdb.wasm in the 512Mi runtime container.
    try {
      const rawPglite = dbContext.pg as unknown as PGlite;
      if (typeof rawPglite.dumpDataDir === 'function') {
        const dumpBlob = await rawPglite.dumpDataDir('gzip');
        const dumpBuffer = Buffer.from(await dumpBlob.arrayBuffer());
        const tarballPath = path.resolve(
          path.dirname(dbContext.dataDir),
          'ordaris-db-seed.tar.gz'
        );
        fs.writeFileSync(tarballPath, dumpBuffer);
      }
    } catch {
      // Ignore optional tarball snapshot error
    }
  }

  await closeSharedDatabase();
  if (resolvedDir) {
    repairPreseededPostgresDir(resolvedDir);
  }
  runGarbageCollectionIfAvailable();
}

export async function startOrdarisServer(port = 3000) {
  const {
    appendRuntimeLog,
    getProviderKeyStatus,
    LOG_FILE_PATH,
    parseEnv,
  } = await import('./src/server/config/env');
  const { createLiveRuntimeModelProvider } = await import(
    './src/server/ai/model-provider'
  );
  const {
    closeSharedDatabase,
    getSharedDatabase,
    ordarisSchema,
    setSharedDatabaseForRuntime,
  } = await import('./src/server/db/client');
  const {
    createApiApp,
    ensureWorkspaceSeededWithPendingHitl,
  } = await import('./src/server/http/app');
  const { RuntimeWorker } = await import('./src/server/worker/main');

  const env = parseEnv(normalizeRenderRuntimeEnv(process.env));
  const resolvedDir = repairPreseededPostgresDir(env.PGLITE_DATA_DIR);

  // If pre-seeded directory was stripped by build cache but dist/ordaris-db-seed.tar.gz exists,
  // restore directly via PGlite loadDataDir (avoids running multi-WASM initdb in 512Mi container).
  if (
    resolvedDir &&
    !fs.existsSync(path.join(resolvedDir, 'PG_VERSION')) &&
    env.DB_DRIVER !== 'postgres'
  ) {
    const tarballPath = path.resolve(
      path.dirname(resolvedDir),
      'ordaris-db-seed.tar.gz'
    );
    if (fs.existsSync(tarballPath)) {
      try {
        fs.rmSync(resolvedDir, { recursive: true, force: true });
        fs.mkdirSync(resolvedDir, { recursive: true });
        const tarBuf = fs.readFileSync(tarballPath);
        const pglite = new PGlite(resolvedDir, {
          relaxedDurability: true,
          loadDataDir: new Blob([tarBuf]),
          startParams: [...PGlite.defaultStartParams],
        });
        await pglite.waitReady;
        repairPreseededPostgresDir(resolvedDir);
        fs.writeFileSync(path.join(resolvedDir, '.ordaris-migrated-v1'), 'ok\n', 'utf8');
        fs.writeFileSync(
          path.join(resolvedDir, '.ordaris-seeded-v1'),
          new Date().toISOString() + '\n',
          'utf8'
        );
        const db = drizzlePglite(pglite, { schema: ordarisSchema });
        setSharedDatabaseForRuntime({
          pg: pglite as unknown as Awaited<ReturnType<typeof getSharedDatabase>>['pg'],
          db,
          engine: 'pglite',
          storageMode: 'file',
          dataDir: resolvedDir,
          close: async () => {
            if (!pglite.closed) {
              await pglite.close();
            }
          },
        });
      } catch {
        // Fall through to standard getSharedDatabase
      }
    }
  }

  const dbContext = await getSharedDatabase({ dataDir: resolvedDir ?? env.PGLITE_DATA_DIR });
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

  // Prevent Render Free Tier 15-minute inactivity spin-down by pinging the external HTTPS edge URL
  // every 10 minutes (600,000ms) when KEEP_ALIVE_URL or RENDER_EXTERNAL_URL is set.
  let keepAliveTimer: NodeJS.Timeout | null = null;
  const keepAliveDisabled =
    process.env.KEEP_ALIVE_ENABLED === 'false' ||
    process.env.KEEP_ALIVE_ENABLED === '0' ||
    Boolean(process.env.NODE_TEST_CONTEXT);
  const rawKeepAliveBase = (
    process.env.KEEP_ALIVE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.RENDER === 'true' ? 'https://ordaris-runtime.onrender.com' : '')
  )
    .trim()
    .replace(/\/+$/, '');

  if (!keepAliveDisabled && rawKeepAliveBase.startsWith('http')) {
    const parsedInterval = Number(process.env.KEEP_ALIVE_INTERVAL_MS ?? 600_000);
    const intervalMs =
      Number.isFinite(parsedInterval) && parsedInterval >= 60_000
        ? parsedInterval
        : 600_000;
    const targetHealthUrl = `${rawKeepAliveBase}/api/v1/health/live`;

    keepAliveTimer = setInterval(() => {
      void fetch(targetHealthUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Ordaris-EdgeKeepAlive/1.0',
          'Cache-Control': 'no-cache',
        },
        signal: AbortSignal.timeout(15_000),
      }).catch(() => {
        // Ignore transient network errors during background keep-alive ping
      });
    }, intervalMs);

    if (typeof keepAliveTimer.unref === 'function') {
      keepAliveTimer.unref();
    }
  }

  const shutdown = async () => {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
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
