import crypto from 'node:crypto';
import type { Request } from 'express';
import type { TenantRole } from '../db/schema/tenant';

/**
 * Aegis Cryptographic Authentication & Session Token Verification (`src/server/http/auth.ts`)
 *
 * Implements:
 * 1. RFC 7519 / HS256 JWT signing and constant-time verification using `AUTH_SECRET`.
 * 2. Request token extraction from `Authorization: Bearer <token>`, `x-aegis-auth-token`,
 *    or `Cookie: aegis_session=<token>`.
 * 3. Signed CSRF `state` tokens for GitHub OAuth 2.0 (`AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`).
 */

export interface AuthTokenClaims {
  sub: string;
  org: string;
  role: TenantRole;
  personaId?: string;
  iat: number;
  exp: number;
  iss: 'aegis-auth';
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
    iss: 'aegis-auth',
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
      claims.iss !== 'aegis-auth'
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
 * `x-aegis-auth-token`, or `Cookie: aegis_session=<token>`.
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

  const customTokenHeader = req.header('x-aegis-auth-token')?.trim();
  if (customTokenHeader) {
    return {
      token: customTokenHeader,
      source: 'header',
      hadExplicitAuthAttempt: true,
    };
  }

  const cookies = parseCookies(req.header('cookie'));
  if (cookies.aegis_session) {
    return {
      token: cookies.aegis_session,
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
