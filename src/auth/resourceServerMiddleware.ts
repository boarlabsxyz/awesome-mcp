// src/auth/resourceServerMiddleware.ts
// Express middleware that enforces OAuth 2.1 JWT auth on MCP proxy routes.

import type { Request, Response, NextFunction } from 'express';
import { validateJwt, hasScope } from './jwtValidator.js';
import { getRequiredScope } from './scopeMap.js';
import { mapJwtToUser } from './userMapping.js';

/** Detect whether a bearer token is a JWT (vs an API key). */
function looksLikeJwt(token: string): boolean {
  return token.startsWith('eyJ') && (token.match(/\./g) || []).length === 2;
}

/**
 * Resource Server middleware for MCP proxy routes.
 *
 * - JWT tokens: validated against Auth0 JWKS, scope checked, user mapped
 * - API keys: forwarded as-is during dual-mode migration (deprecated)
 * - No auth: returns 401 with RFC 9728 WWW-Authenticate header
 */
export async function resourceServerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const baseUrl = process.env.BASE_URL || 'http://localhost:8080';
  const dualAuthMode = process.env.DUAL_AUTH_MODE !== 'false'; // default: true (dual mode)

  const authHeader = req.headers.authorization;
  const wwwAuth = `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // Check for apiKey query param in dual mode
    const apiKey = req.query.apiKey as string | undefined;
    if (apiKey && dualAuthMode) {
      // Legacy API-key via query param — let it through with deprecation warning
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
    // --- JWT path ---
    // Step 1: Validate token and check scopes (401 on failure)
    let payload;
    try {
      payload = await validateJwt(token);
    } catch (err: any) {
      console.error('[jwt-auth] Token validation failed:', err.message);
      res.status(401).setHeader('WWW-Authenticate', wwwAuth).json({
        error: 'invalid_token',
        message: 'The provided JWT is invalid or expired.',
      });
      return;
    }

    const requiredScope = getRequiredScope(req.path);
    if (requiredScope && !hasScope(payload, requiredScope)) {
      res.status(403).json({
        error: 'insufficient_scope',
        message: `This endpoint requires the "${requiredScope}" scope.`,
        required_scope: requiredScope,
      });
      return;
    }

    // Step 2: Map JWT subject to internal user (5xx on failure)
    try {
      const user = await mapJwtToUser(payload);

      // Forward user identity to downstream FastMCP servers via trusted headers
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

  // --- API-key path (dual-mode migration) ---
  if (dualAuthMode) {
    console.warn(`[auth-migration] API key auth via Bearer header (deprecated) from ${req.ip}`);
    res.setHeader('X-Auth-Migration', 'deprecated');
    next();
    return;
  }

  // JWT-only mode: reject non-JWT tokens
  res.status(401).setHeader('WWW-Authenticate', wwwAuth).json({
    error: 'invalid_token',
    message: 'API key authentication has been deprecated. Use OAuth 2.1 Bearer tokens.',
  });
}
