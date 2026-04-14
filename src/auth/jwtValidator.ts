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

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || '';
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE || '';

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks) {
    if (!AUTH0_DOMAIN) throw new Error('AUTH0_DOMAIN environment variable is not set');
    const issuer = AUTH0_DOMAIN.startsWith('https://') ? AUTH0_DOMAIN : `https://${AUTH0_DOMAIN}`;
    jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  }
  return jwks;
}

function getIssuer(): string {
  const domain = AUTH0_DOMAIN.startsWith('https://') ? AUTH0_DOMAIN : `https://${AUTH0_DOMAIN}`;
  // Auth0 issuers always end with a trailing slash
  return domain.endsWith('/') ? domain : `${domain}/`;
}

/**
 * Validate an Auth0 JWT. Verifies signature via JWKS, plus exp, iss, aud.
 * Throws on any validation failure.
 */
export async function validateJwt(token: string): Promise<JwtPayload> {
  if (!AUTH0_AUDIENCE) throw new Error('AUTH0_AUDIENCE environment variable is not set');

  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: getIssuer(),
    audience: AUTH0_AUDIENCE,
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
