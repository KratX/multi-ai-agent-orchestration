import crypto from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { isPublicDemoModeAllowed, parseEnv, type AppEnv } from '../config/env';
import type { DatabaseContext, OrdarisDatabase } from '../db/client';
import {
  createOrganizationWithOwner,
  ensureUser,
  listUserOrganizations,
  resolveActorContext,
} from '../db/repositories/tenant-repository';
import type { TenantRole } from '../db/schema/tenant';
import type { AuthenticatedActor } from '../policies/authorization';
import type { DemoPersonaId } from './demo-routes';

/**
 * Ordaris Cryptographic Authentication & Session Token Verification (`src/server/http/auth.ts`)
 *
 * Implements:
 * 1. RFC 7519 / HS256 JWT signing and constant-time verification using `AUTH_SECRET`.
 * 2. Request token extraction from `Authorization: Bearer <token>`, `x-ordaris-auth-token`,
 *    or `Cookie: ordaris_session=<token>`.
 * 3. Signed CSRF `state` tokens and HTTP endpoints for GitHub OAuth 2.0 (`AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`).
 */

export interface AuthTokenClaims {
  sub: string;
  org: string;
  role: TenantRole;
  personaId?: string;
  iat: number;
  exp: number;
  iss: 'ordaris-auth';
}

export interface SignAuthTokenInput {
  userId: string;
  organizationId: string;
  role: TenantRole;
  personaId?: string;
  expiresInSeconds?: number;
}

const JWT_HEADER_B64 = Buffer.from(
  JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  'utf8'
).toString('base64url');

function computeHmacSignature(signingInput: string, authSecret: string): string {
  return crypto
    .createHmac('sha256', authSecret)
    .update(signingInput, 'utf8')
    .digest('base64url');
}

function timingSafeStringMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifies a pre-shared secret against `AUTH_SECRET` in constant time.
 */
export function verifyAuthSecretHeader(
  candidate: string | undefined,
  authSecret: string
): boolean {
  if (!candidate || !authSecret) return false;
  return timingSafeStringMatch(candidate.trim(), authSecret);
}

/**
 * Determines whether session cookies (`ordaris_session`, `ordaris_oauth_state`) must carry the
 * `; Secure` attribute. Enabled in `production`, when `APP_URL` is `https://`, or behind an HTTPS proxy.
 */
export function shouldUseSecureCookie(req: Request, env: AppEnv): boolean {
  if (env.NODE_ENV === 'production') return true;
  if (env.APP_URL.toLowerCase().startsWith('https://')) return true;
  if (req.secure) return true;
  const forwardedProto = req.header('x-forwarded-proto');
  if (
    forwardedProto &&
    forwardedProto.toLowerCase().split(',')[0]?.trim() === 'https'
  ) {
    return true;
  }
  return false;
}

/**
 * Signs an HS256 JWT containing the authenticated user ID, organization ID, and role.
 */
export function signAuthToken(
  input: SignAuthTokenInput,
  authSecret: string
): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttl = input.expiresInSeconds ?? 8 * 3600;
  const claims: AuthTokenClaims = {
    sub: input.userId,
    org: input.organizationId,
    role: input.role,
    ...(input.personaId ? { personaId: input.personaId } : {}),
    iat: nowSeconds,
    exp: nowSeconds + ttl,
    iss: 'ordaris-auth',
  };

  const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString(
    'base64url'
  );
  const signingInput = `${JWT_HEADER_B64}.${payloadB64}`;
  const signatureB64 = computeHmacSignature(signingInput, authSecret);
  return `${signingInput}.${signatureB64}`;
}

/**
 * Verifies an HS256 JWT against `authSecret` in constant time and validates expiration.
 * Returns the verified claims or `null` if tampered, malformed, or expired.
 */
export function verifyAuthToken(
  token: string,
  authSecret: string
): AuthTokenClaims | null {
  if (!token || !authSecret) return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) return null;

  try {
    const headerJson = JSON.parse(
      Buffer.from(headerB64, 'base64url').toString('utf8')
    ) as { alg?: string; typ?: string };
    if (headerJson.alg !== 'HS256') {
      return null;
    }

    const signingInput = `${headerB64}.${payloadB64}`;
    const expectedSig = computeHmacSignature(signingInput, authSecret);
    if (!timingSafeStringMatch(signatureB64, expectedSig)) {
      return null;
    }

    const claims = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    ) as Partial<AuthTokenClaims>;

    if (
      typeof claims.sub !== 'string' ||
      !claims.sub ||
      typeof claims.org !== 'string' ||
      !claims.org ||
      typeof claims.role !== 'string' ||
      typeof claims.exp !== 'number' ||
      claims.iss !== 'ordaris-auth'
    ) {
      return null;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (claims.exp <= nowSeconds) {
      return null;
    }

    return claims as AuthTokenClaims;
  } catch {
    return null;
  }
}

/**
 * Signs a short-lived OAuth 2.0 CSRF `state` token using `AUTH_SECRET`.
 */
export function signOAuthState(
  redirectAfter: string,
  authSecret: string
): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payloadB64 = Buffer.from(
    JSON.stringify({
      nonce: crypto.randomBytes(12).toString('hex'),
      redirectAfter,
      exp: nowSeconds + 600,
    }),
    'utf8'
  ).toString('base64url');
  const sig = computeHmacSignature(`oauth_state.${payloadB64}`, authSecret);
  return `${payloadB64}.${sig}`;
}

/**
 * Verifies a signed OAuth 2.0 CSRF `state` token.
 */
export function verifyOAuthState(
  stateToken: string | undefined,
  authSecret: string
): { redirectAfter: string } | null {
  if (!stateToken || !authSecret) return null;
  const parts = stateToken.trim().split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return null;

  const expectedSig = computeHmacSignature(
    `oauth_state.${payloadB64}`,
    authSecret
  );
  if (!timingSafeStringMatch(sig, expectedSig)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    ) as { redirectAfter?: string; exp?: number };
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof parsed.exp !== 'number' || parsed.exp <= nowSeconds) {
      return null;
    }
    return {
      redirectAfter:
        typeof parsed.redirectAfter === 'string' &&
        parsed.redirectAfter.startsWith('/')
          ? parsed.redirectAfter
          : '/',
    };
  } catch {
    return null;
  }
}

export function parseCookies(
  cookieHeader: string | undefined
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

export interface ExtractedRequestToken {
  token: string | null;
  source: 'bearer' | 'header' | 'cookie' | 'none';
  hadExplicitAuthAttempt: boolean;
}

/**
 * Extracts a session token from `Authorization: Bearer <token>`,
 * `x-ordaris-auth-token`, or `Cookie: ordaris_session=<token>`.
 */
export function extractTokenFromRequest(req: Request): ExtractedRequestToken {
  const authHeader = req.header('authorization')?.trim();
  if (authHeader) {
    if (authHeader.toLowerCase().startsWith('bearer ')) {
      const token = authHeader.slice(7).trim();
      return {
        token: token || null,
        source: 'bearer',
        hadExplicitAuthAttempt: true,
      };
    }
    return {
      token: null,
      source: 'bearer',
      hadExplicitAuthAttempt: true,
    };
  }

  const customTokenHeader = req.header('x-ordaris-auth-token')?.trim();
  if (customTokenHeader) {
    return {
      token: customTokenHeader,
      source: 'header',
      hadExplicitAuthAttempt: true,
    };
  }

  const cookies = parseCookies(req.header('cookie'));
  if (cookies.ordaris_session) {
    return {
      token: cookies.ordaris_session,
      source: 'cookie',
      hadExplicitAuthAttempt: true,
    };
  }

  return {
    token: null,
    source: 'none',
    hadExplicitAuthAttempt: false,
  };
}

export interface AuthRoutesDeps {
  contextProvider: () => Promise<DatabaseContext>;
  rawEnv?: Record<string, string | undefined>;
  getReqId: (req: Request) => string;
  sendProblemDetails: (
    res: Response,
    requestId: string,
    status: number,
    code: string,
    title: string,
    detail: string
  ) => void;
  resolveActorFromRequest: (
    req: Request,
    db: OrdarisDatabase,
    env: AppEnv
  ) => Promise<AuthenticatedActor | null>;
  resolvePersonaActor: (
    db: OrdarisDatabase,
    personaId: DemoPersonaId
  ) => Promise<AuthenticatedActor | null>;
  ensureWorkspaceSeededWithPendingHitl: (
    db: OrdarisDatabase,
    options?: { forceReset?: boolean }
  ) => Promise<unknown>;
}

export function registerAuthRoutes(app: Express, deps: AuthRoutesDeps): void {
  const {
    contextProvider,
    rawEnv,
    getReqId,
    sendProblemDetails,
    resolveActorFromRequest,
    resolvePersonaActor,
    ensureWorkspaceSeededWithPendingHitl,
  } = deps;

  app.get(
    '/api/v1/auth/status',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(rawEnv ?? process.env);
        const { db } = await contextProvider();
        const actor = await resolveActorFromRequest(req, db, env);
        const authMethod =
          (req as Request & { authMethod?: string }).authMethod ?? 'none';

        res.status(200).json({
          data: {
            authenticated: Boolean(actor),
            actor,
            authMethod: actor ? authMethod : 'none',
            demoMode: isPublicDemoModeAllowed(env),
            publicDemoSandbox: Boolean(env.PUBLIC_DEMO_SANDBOX),
            githubOAuthConfigured: Boolean(
              env.AUTH_GITHUB_ID?.trim() && env.AUTH_GITHUB_SECRET?.trim()
            ),
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/v1/auth/token',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(rawEnv ?? process.env);
        const { db } = await contextProvider();

        const providedSecret =
          req.header('x-auth-secret') ??
          (typeof req.body?.authSecret === 'string' ? req.body.authSecret : undefined);
        const hasValidPreSharedSecret = verifyAuthSecretHeader(
          providedSecret,
          env.AUTH_SECRET
        );

        if (!isPublicDemoModeAllowed(env) && !hasValidPreSharedSecret) {
          sendProblemDetails(
            res,
            getReqId(req),
            403,
            'DEMO_AUTH_DISABLED',
            'Demo authentication disabled in production',
            'Unauthenticated demo persona token issuance is disabled when DEMO_MODE=false or NODE_ENV=production without PUBLIC_DEMO_SANDBOX=true. Authenticate via GitHub OAuth (/api/v1/auth/github/login) or supply a valid x-auth-secret header.'
          );
          return;
        }

        await ensureWorkspaceSeededWithPendingHitl(db, { forceReset: false });

        const rawPersonaId =
          typeof req.body?.personaId === 'string' && req.body.personaId.trim()
            ? (req.body.personaId.trim() as DemoPersonaId)
            : undefined;
        const rawUserId =
          typeof req.body?.userId === 'string' && req.body.userId.trim()
            ? req.body.userId.trim()
            : undefined;
        const rawOrgId =
          typeof req.body?.organizationId === 'string' &&
          req.body.organizationId.trim()
            ? req.body.organizationId.trim()
            : undefined;

        let actor: AuthenticatedActor | null = null;
        if (rawUserId && rawOrgId) {
          if (!hasValidPreSharedSecret) {
            sendProblemDetails(
              res,
              getReqId(req),
              403,
              'DEMO_AUTH_RESTRICTED_TO_SANDBOX_PERSONAS',
              'Direct userId/organizationId token minting requires x-auth-secret',
              'Unauthenticated demo token issuance is strictly limited to the 8 seeded sandbox personas (acme-* and beta-*). Supply a valid x-auth-secret header to mint tokens by userId/organizationId.'
            );
            return;
          }
          actor = await resolveActorContext(db, rawUserId, rawOrgId);
        } else if (rawPersonaId) {
          actor = await resolvePersonaActor(db, rawPersonaId);
        }

        if (!actor) {
          sendProblemDetails(
            res,
            getReqId(req),
            401,
            'INVALID_AUTH_SUBJECT',
            'Invalid authentication subject',
            'Provide a valid personaId or verified (userId, organizationId) membership pair.'
          );
          return;
        }

        const expiresIn = 8 * 3600;
        const token = signAuthToken(
          {
            userId: actor.userId,
            organizationId: actor.organizationId,
            role: actor.role,
            personaId: rawPersonaId,
            expiresInSeconds: expiresIn,
          },
          env.AUTH_SECRET
        );

        const secureFlag = shouldUseSecureCookie(req, env) ? '; Secure' : '';
        res.setHeader(
          'Set-Cookie',
          `ordaris_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${expiresIn}${secureFlag}`
        );

        res.status(200).json({
          data: {
            token,
            tokenType: 'Bearer',
            expiresIn,
            actor,
            personaId: rawPersonaId ?? null,
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post('/api/v1/auth/logout', (req: Request, res: Response) => {
    const env = parseEnv(rawEnv ?? process.env);
    const secureFlag = shouldUseSecureCookie(req, env) ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `ordaris_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureFlag}`
    );
    res.status(200).json({ data: { loggedOut: true } });
  });

  app.get(
    '/api/v1/auth/github/login',
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(rawEnv ?? process.env);
        const clientId = env.AUTH_GITHUB_ID?.trim();
        const clientSecret = env.AUTH_GITHUB_SECRET?.trim();

        if (!clientId || !clientSecret) {
          sendProblemDetails(
            res,
            getReqId(req),
            501,
            'GITHUB_OAUTH_NOT_CONFIGURED',
            'GitHub OAuth is not configured',
            'Set AUTH_GITHUB_ID and AUTH_GITHUB_SECRET in the server environment to enable GitHub OAuth 2.0 login.'
          );
          return;
        }

        const redirectAfter =
          typeof req.query.redirect === 'string' &&
          req.query.redirect.startsWith('/')
            ? req.query.redirect
            : '/';
        const state = signOAuthState(redirectAfter, env.AUTH_SECRET);
        const callbackUrl = `${env.APP_URL.replace(/\/$/, '')}/api/v1/auth/github/callback`;
        const secureFlag = shouldUseSecureCookie(req, env) ? '; Secure' : '';

        res.setHeader(
          'Set-Cookie',
          `ordaris_oauth_state=${encodeURIComponent(state)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${secureFlag}`
        );

        const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
        authorizeUrl.searchParams.set('client_id', clientId);
        authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
        authorizeUrl.searchParams.set('scope', 'read:user user:email');
        authorizeUrl.searchParams.set('state', state);

        res.redirect(302, authorizeUrl.toString());
      } catch (err) {
        next(err);
      }
    }
  );

  app.get(
    '/api/v1/auth/github/callback',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const env = parseEnv(rawEnv ?? process.env);
        const clientId = env.AUTH_GITHUB_ID?.trim();
        const clientSecret = env.AUTH_GITHUB_SECRET?.trim();

        if (!clientId || !clientSecret) {
          sendProblemDetails(
            res,
            getReqId(req),
            501,
            'GITHUB_OAUTH_NOT_CONFIGURED',
            'GitHub OAuth is not configured',
            'Set AUTH_GITHUB_ID and AUTH_GITHUB_SECRET in the server environment to enable GitHub OAuth 2.0 login.'
          );
          return;
        }

        const code =
          typeof req.query.code === 'string' ? req.query.code.trim() : '';
        const stateParam =
          typeof req.query.state === 'string' ? req.query.state.trim() : '';
        const cookies = parseCookies(req.header('cookie'));
        const verifiedState = verifyOAuthState(stateParam, env.AUTH_SECRET);

        if (
          !code ||
          !verifiedState ||
          (cookies.ordaris_oauth_state &&
            cookies.ordaris_oauth_state !== stateParam)
        ) {
          sendProblemDetails(
            res,
            getReqId(req),
            400,
            'INVALID_OAUTH_STATE',
            'Invalid or expired OAuth state',
            'The GitHub OAuth callback was missing a valid code or failed HMAC-SHA256 CSRF state verification.'
          );
          return;
        }

        const tokenRes = await fetch(
          'https://github.com/login/oauth/access_token',
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              client_id: clientId,
              client_secret: clientSecret,
              code,
            }),
          }
        );

        const tokenJson = (await tokenRes.json()) as {
          access_token?: string;
          error?: string;
          error_description?: string;
        };

        if (!tokenRes.ok || !tokenJson.access_token) {
          sendProblemDetails(
            res,
            getReqId(req),
            401,
            'OAUTH_TOKEN_EXCHANGE_FAILED',
            'GitHub OAuth token exchange failed',
            tokenJson.error_description ||
              tokenJson.error ||
              'Could not exchange GitHub authorization code for an access token.'
          );
          return;
        }

        const profileRes = await fetch('https://api.github.com/user', {
          headers: {
            authorization: `Bearer ${tokenJson.access_token}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'ordaris-runtime',
          },
        });

        if (!profileRes.ok) {
          sendProblemDetails(
            res,
            getReqId(req),
            401,
            'OAUTH_PROFILE_FETCH_FAILED',
            'Failed to fetch GitHub user profile',
            'GitHub API rejected the access token when querying /user.'
          );
          return;
        }

        const ghUser = (await profileRes.json()) as {
          id?: number | string;
          login?: string;
          name?: string;
          email?: string | null;
        };

        if (!ghUser.id || !ghUser.login) {
          sendProblemDetails(
            res,
            getReqId(req),
            401,
            'OAUTH_PROFILE_INVALID',
            'Invalid GitHub profile payload',
            'GitHub profile did not include a user ID and login.'
          );
          return;
        }

        const { db } = await contextProvider();
        const userRecord = await ensureUser(db, {
          authSubject: `github:${ghUser.id}`,
          email: ghUser.email ?? `${ghUser.login}@users.noreply.github.com`,
          displayName: ghUser.name ?? ghUser.login,
        });

        let userOrgs = await listUserOrganizations(db, userRecord.id);
        if (userOrgs.length === 0) {
          const slugBase = `gh-${ghUser.login
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .slice(0, 32)}-${String(ghUser.id).slice(-4)}`;
          await createOrganizationWithOwner(db, {
            name: `${ghUser.name || ghUser.login} Workspace`,
            slug: slugBase,
            creatorUserId: userRecord.id,
          });
          userOrgs = await listUserOrganizations(db, userRecord.id);
        }

        const primaryOrg = userOrgs[0]!;
        const actor: AuthenticatedActor = {
          userId: userRecord.id,
          organizationId: primaryOrg.organization.id,
          role: primaryOrg.role,
        };

        const expiresIn = 8 * 3600;
        const sessionJwt = signAuthToken(
          {
            userId: actor.userId,
            organizationId: actor.organizationId,
            role: actor.role,
            expiresInSeconds: expiresIn,
          },
          env.AUTH_SECRET
        );

        const secureFlag = shouldUseSecureCookie(req, env) ? '; Secure' : '';
        res.setHeader(
          'Set-Cookie',
          `ordaris_session=${encodeURIComponent(sessionJwt)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${expiresIn}${secureFlag}`
        );

        if ((req.header('accept') ?? '').includes('text/html')) {
          res.redirect(302, verifiedState.redirectAfter || '/');
          return;
        }

        res.status(200).json({
          data: {
            token: sessionJwt,
            tokenType: 'Bearer',
            expiresIn,
            actor,
          },
        });
      } catch (err) {
        next(err);
      }
    }
  );
}
