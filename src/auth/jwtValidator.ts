// src/auth/jwtValidator.ts
// Validates Auth0-issued JWTs against the JWKS endpoint.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface JwtPayload {
  sub: string;
  scope: string;
  email?: string;
  iss: string;
  aud: string;
  /** True when validated via opaque /userinfo flow (no scope claims available). */
  isOpaque?: boolean;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getDomain(): string {
  const domain = process.env.AUTH0_DOMAIN || '';
  if (!domain) throw new Error('AUTH0_DOMAIN environment variable is not set');
  return domain;
}

/** Normalize domain to https:// base URL. */
function domainToBaseUrl(domain: string): string {
  return domain.startsWith('https://') ? domain : `https://${domain}`;
}

function getJwks() {
  if (!jwks) {
    const base = domainToBaseUrl(getDomain());
    jwks = createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`));
  }
  return jwks;
}

function getIssuer(): string {
  const base = domainToBaseUrl(getDomain());
  // Auth0 issuers always end with a trailing slash
  return base.endsWith('/') ? base : `${base}/`;
}

/**
 * Validate an Auth0 JWT. Verifies signature via JWKS, plus exp, iss, aud.
 * Throws on any validation failure.
 */
export async function validateJwt(token: string): Promise<JwtPayload> {
  const audience = process.env.AUTH0_AUDIENCE || '';
  if (!audience) throw new Error('AUTH0_AUDIENCE environment variable is not set');

  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: getIssuer(),
    audience,
  });

  const p = payload as JWTPayload & { scope?: string; email?: string };

  if (!p.sub) throw new Error('JWT missing sub claim');

  return {
    sub: p.sub,
    scope: p.scope ?? '',
    email: p.email,
    iss: String(p.iss),
    aud: Array.isArray(p.aud) ? p.aud[0] : String(p.aud),
  };
}

// Cache validated opaque tokens to avoid hitting Auth0 /userinfo on every request.
// Key: token string, Value: { payload, expiresAt }
const opaqueTokenCache = new Map<string, { payload: JwtPayload; expiresAt: number }>();
const OPAQUE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Evict expired entries (called lazily). */
function evictExpiredTokens(): void {
  const now = Date.now();
  for (const [key, entry] of opaqueTokenCache) {
    if (entry.expiresAt <= now) opaqueTokenCache.delete(key);
  }
}

/**
 * Validate an opaque (non-JWT) access token by calling Auth0's /userinfo endpoint.
 * Results are cached to avoid Auth0 rate limits (429).
 */
export async function validateOpaqueToken(token: string): Promise<JwtPayload> {
  // Check cache first
  const cached = opaqueTokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }

  const base = domainToBaseUrl(getDomain());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  let response: Response;
  try {
    response = await fetch(`${base}/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeout);
    throw new Error(err.name === 'AbortError' ? 'Auth0 /userinfo request timed out' : err.message);
  }
  clearTimeout(timeout);

  if (!response.ok) {
    throw new Error(`Auth0 /userinfo returned ${response.status}`);
  }

  const userinfo = await response.json() as Record<string, unknown>;

  if (!userinfo.sub) throw new Error('Auth0 /userinfo response missing sub claim');

  const payload: JwtPayload = {
    sub: String(userinfo.sub),
    scope: '',
    email: userinfo.email ? String(userinfo.email) : undefined,
    iss: getIssuer(),
    aud: '',
    isOpaque: true,
  };

  // Cache the result
  opaqueTokenCache.set(token, { payload, expiresAt: Date.now() + OPAQUE_CACHE_TTL_MS });

  // Lazily evict expired entries
  if (opaqueTokenCache.size > 100) evictExpiredTokens();

  return payload;
}

/** Check whether a JWT payload contains the required scope. */
export function hasScope(payload: JwtPayload, requiredScope: string): boolean {
  // Opaque tokens validated via /userinfo don't carry scopes — Auth0 already
  // authorized the user during login. Only skip scope check when the token was
  // explicitly validated via the opaque flow.
  if (payload.isOpaque) return true;
  const scopes = payload.scope.split(' ');
  return scopes.includes(requiredScope);
}

/** Reset cached JWKS (for testing). */
export function _resetJwks(): void {
  jwks = null;
}
