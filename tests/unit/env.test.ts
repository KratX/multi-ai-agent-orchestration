import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendRuntimeLog,
  clearRuntimeLogs,
  getPublicEnvSummary,
  getRuntimeLogs,
  isPublicDemoModeAllowed,
  parseEnv,
} from '../../src/server/config/env';
import { normalizeRenderRuntimeEnv } from '../../server';
import {
  shouldUseSecureCookie,
  signAuthToken,
  verifyAuthToken,
  signOAuthState,
  verifyOAuthState,
} from '../../src/server/http/auth';
import {
  ByokSessionValidationError,
  isValidByokSessionToken,
  resolveByokScopeKey,
} from '../../src/server/security/session-key-vault';

test('REPO-003: parseEnv succeeds in default AI_MODE="demo" with zero API keys and generates CSPRNG AUTH_SECRET', () => {
  const env = parseEnv({
    NODE_ENV: 'development',
    AI_MODE: 'demo',
    AI_PROVIDER_API_KEY: '',
    GEMINI_API_KEY: '',
  });

  assert.equal(env.AI_MODE, 'demo');
  assert.equal(env.DEMO_MODE, true);
  assert.equal(env.DB_DRIVER, 'auto');
  assert.equal(env.RUN_MAX_STEPS, 8);
  assert.equal(env.RUN_MAX_TOOL_CALLS, 6);
  assert.equal(env.RUN_TIMEOUT_SECONDS, 120);
  assert.equal(env.MAX_UPLOAD_BYTES, 10_485_760);
  assert.notEqual(env.AUTH_SECRET, 'local-dev-only-auth-secret-change-me');
  assert.equal(env.AUTH_SECRET.length, 64);
});

test('REPO-003: parseEnv normalizes MY_APP_URL placeholder to http://localhost:3000', () => {
  const env = parseEnv({
    APP_URL: 'MY_APP_URL',
    AI_MODE: 'demo',
  });

  assert.equal(env.APP_URL, 'http://localhost:3000');
});

test('REPO-003: parseEnv rejects AI_MODE="provider" when API key is missing or placeholder', () => {
  assert.throws(
    () =>
      parseEnv({
        AI_MODE: 'provider',
        AI_PROVIDER_API_KEY: '',
        GEMINI_API_KEY: 'MY_GEMINI_API_KEY',
      }),
    /AI_PROVIDER_API_KEY \(or GEMINI_API_KEY\) is required when AI_MODE="provider"/
  );
});

test('REPO-003: parseEnv accepts AI_MODE="provider" when a non-placeholder key is provided', () => {
  const env = parseEnv({
    AI_MODE: 'provider',
    AI_PROVIDER_API_KEY: 'live-secret-key-12345',
  });

  assert.equal(env.AI_MODE, 'provider');
  assert.equal(env.AI_PROVIDER_API_KEY, 'live-secret-key-12345');
});

test('REPO-003: parseEnv rejects out-of-range numeric guardrails (RUN_MAX_STEPS > 25)', () => {
  assert.throws(
    () =>
      parseEnv({
        AI_MODE: 'demo',
        RUN_MAX_STEPS: '999',
      }),
    /RUN_MAX_STEPS cannot exceed 25/
  );
});

test('REPO-003: parseEnv rejects default AUTH_SECRET in production mode', () => {
  assert.throws(
    () =>
      parseEnv({
        NODE_ENV: 'production',
        AI_MODE: 'demo',
        AUTH_SECRET: 'local-dev-only-auth-secret-change-me',
      }),
    /Production environment requires a non-default AUTH_SECRET/
  );
});

test('REPO-003: parseEnv blocks DEMO_MODE="true" in production mode without PUBLIC_DEMO_SANDBOX and respects explicit DEMO_MODE="false"', () => {
  assert.throws(
    () =>
      parseEnv({
        NODE_ENV: 'production',
        AI_MODE: 'demo',
        AUTH_SECRET: 'prod-strong-random-auth-secret-9999',
        DEMO_MODE: 'true',
      }),
    /DEMO_MODE authentication bypass cannot be enabled when NODE_ENV="production"/
  );

  const prodEnv = parseEnv({
    NODE_ENV: 'production',
    AI_MODE: 'demo',
    AUTH_SECRET: 'prod-strong-random-auth-secret-9999',
  });
  assert.equal(prodEnv.NODE_ENV, 'production');
  assert.equal(prodEnv.DEMO_MODE, false);
  assert.equal(isPublicDemoModeAllowed(prodEnv), false);

  // Proof check: SERVE_STATIC=true NODE_ENV=production DEMO_MODE=false (and even with PUBLIC_DEMO_SANDBOX=true) must keep demo mode disabled
  const staticDisabledEnv = parseEnv(
    normalizeRenderRuntimeEnv({
      SERVE_STATIC: 'true',
      NODE_ENV: 'production',
      DEMO_MODE: 'false',
      PUBLIC_DEMO_SANDBOX: 'true',
      AUTH_SECRET: 'prod-strong-random-auth-secret-9999',
    })
  );
  assert.equal(staticDisabledEnv.NODE_ENV, 'production');
  assert.equal(staticDisabledEnv.DEMO_MODE, false);
  assert.equal(staticDisabledEnv.PUBLIC_DEMO_SANDBOX, false);
  assert.equal(isPublicDemoModeAllowed(staticDisabledEnv), false);

  // Default SERVE_STATIC=true (npm start / Dockerfile) without PUBLIC_DEMO_SANDBOX=true defaults to locked-down production
  const defaultStaticEnv = parseEnv(
    normalizeRenderRuntimeEnv({
      SERVE_STATIC: 'true',
    })
  );
  assert.equal(defaultStaticEnv.NODE_ENV, 'production');
  assert.equal(defaultStaticEnv.DEMO_MODE, false);
  assert.equal(defaultStaticEnv.PUBLIC_DEMO_SANDBOX, false);
  assert.equal(isPublicDemoModeAllowed(defaultStaticEnv), false);

  // Explicit Render Blueprint opt-in: PUBLIC_DEMO_SANDBOX=true enables sandbox when DEMO_MODE is not false
  const publicDemoProdEnv = parseEnv(
    normalizeRenderRuntimeEnv({
      SERVE_STATIC: 'true',
      NODE_ENV: 'production',
      AI_MODE: 'demo',
      AUTH_SECRET: 'prod-strong-random-auth-secret-9999',
      DEMO_MODE: 'true',
      PUBLIC_DEMO_SANDBOX: 'true',
    })
  );
  assert.equal(publicDemoProdEnv.NODE_ENV, 'production');
  assert.equal(publicDemoProdEnv.PUBLIC_DEMO_SANDBOX, true);
  assert.equal(isPublicDemoModeAllowed(publicDemoProdEnv), true);
  assert.equal(
    shouldUseSecureCookie({ secure: false, headers: {} } as never, publicDemoProdEnv),
    true
  );
});

test('AUTH-001: signAuthToken and verifyAuthToken enforce HMAC-SHA256 signature and expiration with AUTH_SECRET', () => {
  const secret = 'production-auth-secret-at-least-16-chars';
  const token = signAuthToken(
    {
      userId: 'user-uuid-1',
      organizationId: 'org-uuid-1',
      role: 'owner',
      personaId: 'acme-owner',
      expiresInSeconds: 3600,
    },
    secret
  );

  const verified = verifyAuthToken(token, secret);
  assert.ok(verified);
  assert.equal(verified.sub, 'user-uuid-1');
  assert.equal(verified.org, 'org-uuid-1');
  assert.equal(verified.role, 'owner');

  // Wrong secret must fail verification
  assert.equal(verifyAuthToken(token, 'wrong-secret-at-least-16-chars'), null);

  // Tampered payload must fail verification
  const parts = token.split('.');
  const tamperedPayload = Buffer.from(
    JSON.stringify({ ...verified, org: 'org-uuid-2' }),
    'utf8'
  ).toString('base64url');
  assert.equal(
    verifyAuthToken(`${parts[0]}.${tamperedPayload}.${parts[2]}`, secret),
    null
  );

  // Expired token must fail verification
  const expiredToken = signAuthToken(
    {
      userId: 'user-uuid-1',
      organizationId: 'org-uuid-1',
      role: 'owner',
      expiresInSeconds: -10,
    },
    secret
  );
  assert.equal(verifyAuthToken(expiredToken, secret), null);

  // OAuth CSRF state signing & verification
  const state = signOAuthState('/studio', secret);
  const verifiedState = verifyOAuthState(state, secret);
  assert.deepEqual(verifiedState, { redirectAfter: '/studio' });
  assert.equal(verifyOAuthState(state, 'wrong-secret'), null);
});

test('REPO-003: getPublicEnvSummary redacts raw secret values and exposes only safe booleans and limits', () => {
  const env = parseEnv({
    AI_MODE: 'provider',
    AI_PROVIDER_API_KEY: 'super-secret-provider-key',
    AUTH_SECRET: 'custom-secret-with-at-least-16-chars',
    DATABASE_URL: 'postgresql://user:secret_pass@localhost:5432/agent_platform',
  });

  const summary = getPublicEnvSummary(env);
  const serialized = JSON.stringify(summary);

  assert.equal(summary.aiMode, 'provider');
  assert.equal(summary.hasLiveProviderKey, true);
  assert.equal(summary.limits.runMaxSteps, 8);
  assert.equal(summary.limits.workerLeaseMs, 30_000);
  assert.equal(summary.limits.workerHeartbeatIntervalMs, 10_000);
  assert.equal(serialized.includes('super-secret-provider-key'), false);
  assert.equal(serialized.includes('custom-secret-with-at-least-16-chars'), false);
  assert.equal(serialized.includes('secret_pass'), false);
});

test('REPO-003: parseEnv rejects WORKER_HEARTBEAT_INTERVAL_MS >= WORKER_LEASE_MS and scales default heartbeat when WORKER_LEASE_MS is customized', () => {
  assert.throws(
    () =>
      parseEnv({
        AI_MODE: 'demo',
        WORKER_LEASE_MS: '10000',
        WORKER_HEARTBEAT_INTERVAL_MS: '10000',
      }),
    /WORKER_HEARTBEAT_INTERVAL_MS must be strictly less than WORKER_LEASE_MS/
  );

  const scaledEnv = parseEnv({
    AI_MODE: 'demo',
    WORKER_LEASE_MS: '6000',
  });
  assert.equal(scaledEnv.WORKER_LEASE_MS, 6000);
  assert.equal(scaledEnv.WORKER_HEARTBEAT_INTERVAL_MS, 2000);
});

test('BYOK-002 & LOG-001: rejects static/ephemeral BYOK session fallback tokens and enforces tenant-scoped runtime log isolation', () => {
  assert.equal(
    isValidByokSessionToken('sess_browser_ephemeral_9f8e7d6c5b4a3210'),
    false
  );
  assert.equal(isValidByokSessionToken('sess_static_fallback_token_12345'), false);
  assert.throws(
    () =>
      resolveByokScopeKey({
        sessionId: 'sess_browser_ephemeral_9f8e7d6c5b4a3210',
        organizationId: 'org-acme',
        strictSessionValidation: true,
      }),
    ByokSessionValidationError
  );
  assert.throws(
    () =>
      resolveByokScopeKey({
        sessionId: '',
        organizationId: 'org-acme',
        requireSessionToken: true,
      }),
    ByokSessionValidationError
  );

  clearRuntimeLogs();
  appendRuntimeLog({
    level: 'INFO',
    component: 'tenant-test',
    organizationId: 'org-acme-111',
    message: 'Acme tenant diagnostic event',
  });
  appendRuntimeLog({
    level: 'INFO',
    component: 'tenant-test',
    organizationId: 'org-beta-222',
    message: 'Beta tenant diagnostic event',
  });

  const acmeLogs = getRuntimeLogs(50, { organizationId: 'org-acme-111' });
  assert.equal(acmeLogs.some((l) => l.message.includes('Acme tenant')), true);
  assert.equal(acmeLogs.some((l) => l.message.includes('Beta tenant')), false);

  // Scoped clear for org-acme-111 must not delete org-beta-222 logs
  clearRuntimeLogs({ organizationId: 'org-acme-111' });
  const betaLogsAfterAcmeClear = getRuntimeLogs(50, {
    organizationId: 'org-beta-222',
  });
  assert.equal(
    betaLogsAfterAcmeClear.some((l) => l.message.includes('Beta tenant')),
    true
  );
});

test('CI-001 & SEC-SCAN-001: repository files contain zero secret-scanner-triggering API keys and CI workflow uses Ordaris Runtime', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const rootDir = process.cwd();

  const legacyBrandRegex = new RegExp('ae' + 'gis', 'i');
  const ciWorkflowPath = path.join(rootDir, '.github/workflows/ci.yml');
  assert.equal(fs.existsSync(ciWorkflowPath), true, 'Expected .github/workflows/ci.yml to exist');
  const ciContent = fs.readFileSync(ciWorkflowPath, 'utf8');
  assert.match(ciContent, /^name:\s*Ordaris Runtime CI/m);
  assert.equal(legacyBrandRegex.test(ciContent), false, 'CI workflow must not reference legacy branding');

  const secretScanningPath = path.join(rootDir, '.github/secret_scanning.yml');
  assert.equal(fs.existsSync(secretScanningPath), true, 'Expected .github/secret_scanning.yml to exist');
  const secretScanningContent = fs.readFileSync(secretScanningPath, 'utf8');
  assert.match(secretScanningContent, /paths-ignore:/);
  assert.match(secretScanningContent, /tests\/\*\*/);

  const gitignoreContent = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8');
  assert.equal(legacyBrandRegex.test(gitignoreContent), false, '.gitignore must not reference legacy branding');

  // Construct scanner pattern dynamically so the test itself never embeds a literal prefix
  const googlePrefix = 'AI' + 'za';
  const scannerRegex = new RegExp(
    `(${googlePrefix}[0-9A-Za-z_-]{10,}|sk-proj-[0-9A-Za-z_-]{8,}|sk-ant-[0-9A-Za-z_-]{8,}|sk-or-v1-[0-9A-Za-z_-]{8,}|xai-[0-9A-Za-z_-]{8,})`
  );

  const scanDir = (relDir: string): string[] => {
    const violations: string[] = [];
    const absDir = path.join(rootDir, relDir);
    if (!fs.existsSync(absDir)) return violations;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const childRel = path.posix.join(relDir, entry.name);
      if (entry.isDirectory()) {
        violations.push(...scanDir(childRel));
      } else if (entry.isFile() && /\.(ts|tsx|md|json|yml|yaml)$/i.test(entry.name)) {
        const text = fs.readFileSync(path.join(rootDir, childRel), 'utf8');
        if (scannerRegex.test(text)) {
          violations.push(childRel);
        }
      }
    }
    return violations;
  };

  const detected = [...scanDir('src'), ...scanDir('tests'), ...scanDir('docs')];
  assert.deepEqual(
    detected,
    [],
    `Found secret-scanner-triggering key pattern in: ${detected.join(', ')}`
  );

  // Verify that exported src/App.tsx and src/server/http/demo-routes.ts have zero utils/zip references
  const startTag = '__PREVIEW_ZIP_' + 'START__';
  const endTag = '__PREVIEW_ZIP_' + 'END__';
  const stripMarkers = (raw: string): string =>
    raw
      .replace(
        new RegExp(
          `\\n?[ \\t]*\\{\\/\\* ${startTag} \\*\\/\\}[\\s\\S]*?\\{\\/\\* ${endTag} \\*\\/\\}[ \\t]*\\n?`,
          'g'
        ),
        '\n'
      )
      .replace(
        new RegExp(
          `\\n?[ \\t]*\\/\\* ${startTag} \\*\\/[\\s\\S]*?\\/\\* ${endTag} \\*\\/[ \\t]*\\n?`,
          'g'
        ),
        '\n'
      );

  const rawApp = fs.readFileSync(path.join(rootDir, 'src/App.tsx'), 'utf8');
  const rawDemoRoutes = fs.readFileSync(
    path.join(rootDir, 'src/server/http/demo-routes.ts'),
    'utf8'
  );
  const strippedApp = stripMarkers(rawApp);
  const strippedDemoRoutes = stripMarkers(rawDemoRoutes);

  assert.equal(strippedApp.includes('utils/zip'), false);
  assert.equal(strippedApp.includes(startTag), false);
  assert.equal(strippedDemoRoutes.includes('utils/zip'), false);
  assert.equal(rawDemoRoutes.includes('../../utils/zip'), false);
  assert.equal(strippedDemoRoutes.includes(startTag), false);

  // Verify Render npm ERESOLVE fix (.npmrc + esbuild range in package.json) and README hosted link
  const npmrcContent = fs.readFileSync(path.join(rootDir, '.npmrc'), 'utf8');
  assert.match(npmrcContent, /legacy-peer-deps=true/);

  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')
  ) as { dependencies?: Record<string, string> };
  assert.match(String(pkgJson.dependencies?.esbuild ?? ''), /0\.28\.0/);

  const readmeContent = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');
  assert.match(readmeContent, /https:\/\/ordaris-runtime\.onrender\.com/);
  assert.equal(scannerRegex.test(readmeContent), false, 'README.md must not contain secret-scanner-triggering keys');
  assert.equal(legacyBrandRegex.test(readmeContent), false, 'README.md must not reference legacy branding');
});



