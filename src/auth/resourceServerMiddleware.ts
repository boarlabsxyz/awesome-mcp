// src/auth/resourceServerMiddleware.ts
// Express middleware that enforces OAuth 2.1 JWT auth on MCP proxy routes.

import type { Request, Response, NextFunction } from 'express';
import { validateJwt, validateOpaqueToken, hasScope, type JwtPayload } from './jwtValidator.js';
import { getRequiredScope } from './scopeMap.js';
import { mapJwtToUser } from './userMapping.js';
import type { UserRecord } from '../userStore.js';

/** Dependencies for the middleware, injectable for testing. */
export interface MiddlewareDeps {
  validateJwt: (token: string) => Promise<JwtPayload>;
  validateOpaqueToken: (token: string) => Promise<JwtPayload>;
  hasScope: (payload: JwtPayload, scope: string) => boolean;
  getRequiredScope: (path: string) => string | null;
  mapJwtToUser: (payload: JwtPayload) => Promise<UserRecord>;
}

const defaultDeps: MiddlewareDeps = { validateJwt, validateOpaqueToken, hasScope, getRequiredScope, mapJwtToUser };

/** Detect whether a bearer token is a JWT (vs an API key). */
export function looksLikeJwt(token: string): boolean {
  return token.startsWith('eyJ') && (token.match(/\./g) || []).length === 2;
}

/** Create the resource server middleware with injectable dependencies. */
export function createResourceServerMiddleware(deps: MiddlewareDeps = defaultDeps) {
  return async function resourceServerMiddlewareHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const baseUrl = process.env.BASE_URL || 'http://localhost:8080';
    const dualAuthMode = process.env.DUAL_AUTH_MODE !== 'false';

    const authHeader = req.headers.authorization;
    const wwwAuth = `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      const apiKey = req.query.apiKey as string | undefined;
      if (apiKey && dualAuthMode) {
        console.warn(`[auth-migration] API key auth via query param (deprecated) from ${req.ip}`);
        res.setHeader('X-Auth-Migration', 'deprecated');
        next();
        return;
      }

      res.status(401).setHeader('WWW-Authenticate', wwwAuth).json({
        error: 'unauthorized',
        message: 'Missing Authorization header. This server requires OAuth 2.1 Bearer tokens.',
      });
      return;
    }

    const token = authHeader.slice(7);

    if (looksLikeJwt(token)) {
      // Step 1: Validate token and check scopes (401 on failure)
      let payload;
      try {
        payload = await deps.validateJwt(token);
      } catch (err: any) {
        console.error('[jwt-auth] Token validation failed:', err.message);
        res.status(401).setHeader('WWW-Authenticate', wwwAuth).json({
          error: 'invalid_token',
          message: 'The provided JWT is invalid or expired.',
        });
        return;
      }

      const requiredScope = deps.getRequiredScope(req.path);
      if (requiredScope && !deps.hasScope(payload, requiredScope)) {
        res.status(403).json({
          error: 'insufficient_scope',
          message: `This endpoint requires the "${requiredScope}" scope.`,
          required_scope: requiredScope,
        });
        return;
      }

      // Step 2: Map JWT subject to internal user (5xx on failure)
      try {
        const user = await deps.mapJwtToUser(payload);

        req.headers['x-mcp-user-id'] = String(user.id);
        req.headers['x-mcp-user-sub'] = payload.sub;
        if (user.email) req.headers['x-mcp-user-email'] = user.email;

        next();
      } catch (err: any) {
        console.error('[jwt-auth] User mapping failed:', err.message);
        res.status(503).json({
          error: 'user_mapping_error',
          message: 'Failed to resolve user identity. Please try again.',
        });
      }
      return;
    }

    // --- Opaque token path (Auth0 DCR clients without audience) ---
    // Try validating via Auth0's /userinfo endpoint before falling back to API-key
    try {
      const payload = await deps.validateOpaqueToken(token);
      console.error(`[oauth] Opaque token validated for sub=${payload.sub}`);

      const requiredScope = deps.getRequiredScope(req.path);
      if (requiredScope && !deps.hasScope(payload, requiredScope)) {
        res.status(403).json({
          error: 'insufficient_scope',
          message: `This endpoint requires the "${requiredScope}" scope.`,
          required_scope: requiredScope,
        });
        return;
      }

      try {
        const user = await deps.mapJwtToUser(payload);
        req.headers['x-mcp-user-id'] = String(user.id);
        req.headers['x-mcp-user-sub'] = payload.sub;
        if (user.email) req.headers['x-mcp-user-email'] = user.email;
        next();
      } catch (err: any) {
        console.error('[oauth] User mapping failed:', err.message);
        res.status(503).json({
          error: 'user_mapping_error',
          message: 'Failed to resolve user identity. Please try again.',
        });
      }
      return;
    } catch {
      // Not a valid opaque token either — fall through to API-key / reject
    }

    // API-key path (dual-mode migration)
    if (dualAuthMode) {
      console.warn(`[auth-migration] API key auth via Bearer header (deprecated) from ${req.ip}`);
      res.setHeader('X-Auth-Migration', 'deprecated');
      next();
      return;
    }

    // No valid token
    res.status(401).setHeader('WWW-Authenticate', wwwAuth).json({
      error: 'invalid_token',
      message: 'The provided token is invalid.',
    });
  };
}

/** Default middleware instance using real dependencies. */
export const resourceServerMiddleware = createResourceServerMiddleware();
