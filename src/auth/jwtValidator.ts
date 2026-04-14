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

/** Check whether a JWT payload contains the required scope. */
export function hasScope(payload: JwtPayload, requiredScope: string): boolean {
  const scopes = payload.scope.split(' ');
  return scopes.includes(requiredScope);
}

/** Reset cached JWKS (for testing). */
export function _resetJwks(): void {
  jwks = null;
}
