// src/auth/jwtValidator.ts
// Validates Auth0-issued JWTs against the JWKS endpoint.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface JwtPayload {
  sub: string;
  scope: string;
  email?: string;
  iss: string;
  aud: string;
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

/**
 * Validate an opaque (non-JWT) access token by calling Auth0's /userinfo endpoint.
 * Used when Auth0 issues opaque tokens (e.g., for DCR clients without audience).
 */
export async function validateOpaqueToken(token: string): Promise<JwtPayload> {
  const base = domainToBaseUrl(getDomain());
  const response = await fetch(`${base}/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Auth0 /userinfo returned ${response.status}`);
  }

  const userinfo = await response.json() as Record<string, unknown>;

  if (!userinfo.sub) throw new Error('Auth0 /userinfo missing sub claim');

  return {
    sub: String(userinfo.sub),
    scope: '', // opaque tokens don't carry scopes — skip scope checks
    email: userinfo.email ? String(userinfo.email) : undefined,
    iss: base,
    aud: '',
  };
}

/** Check whether a JWT payload contains the required scope. */
export function hasScope(payload: JwtPayload, requiredScope: string): boolean {
  // Opaque tokens have empty scope — allow all (Auth0 already authorized the user)
  if (!payload.scope) return true;
  const scopes = payload.scope.split(' ');
  return scopes.includes(requiredScope);
}

/** Reset cached JWKS (for testing). */
export function _resetJwks(): void {
  jwks = null;
}
