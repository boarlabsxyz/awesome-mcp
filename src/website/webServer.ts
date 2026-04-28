// src/webServer.ts
import express, { Request, Response, NextFunction } from 'express';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { resourceServerMiddleware } from '../auth/resourceServerMiddleware.js';
import { ALL_SCOPES, getScopesForSlug } from '../auth/scopeMap.js';
import { validateJwt, validateOpaqueToken } from '../auth/jwtValidator.js';
import { mapJwtToUser } from '../auth/userMapping.js';
import { looksLikeJwt } from '../auth/resourceServerMiddleware.js';

/** Normalize Auth0 domain to https:// URL. */
function auth0Issuer(): string {
  const domain = process.env.AUTH0_DOMAIN || '';
  if (!domain) return '';
  return domain.startsWith('https://') ? domain : `https://${domain}`;
}

/** Register OAuth discovery + proxy endpoints (RFC 9728 + RFC 8414 + /authorize, /token, /register). */
function registerOAuthProxy(app: express.Express, resource: string, scopes: string[]): void {
  const auth0Audience = process.env.AUTH0_AUDIENCE || '';

  // RFC 9728: OAuth Protected Resource Metadata
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    const issuer = auth0Issuer();
    if (!issuer) { res.status(503).json({ error: 'AUTH0_DOMAIN not configured' }); return; }
    res.json({
      resource,
      authorization_servers: [resource], // Point to ourselves — we proxy OAuth endpoints
      scopes_supported: scopes,
      bearer_methods_supported: ['header'],
    });
  });

  // RFC 8414: OAuth Authorization Server Metadata
  // Advertise our own URLs for authorize/token/register so Claude talks to us.
  app.get('/.well-known/oauth-authorization-server', async (_req, res) => {
    const issuer = auth0Issuer();
    if (!issuer) { res.status(503).json({ error: 'AUTH0_DOMAIN not configured' }); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${issuer}/.well-known/oauth-authorization-server`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) { res.status(502).json({ error: 'Failed to fetch Auth0 metadata' }); return; }
      const metadata = await response.json() as Record<string, unknown>;
      // Rewrite endpoints to point to our proxy routes
      const asMeta: Record<string, unknown> = {
        ...metadata,
        issuer: resource,
        authorization_endpoint: `${resource}/oauth/authorize`,
        token_endpoint: `${resource}/oauth/token`,
        registration_endpoint: `${resource}/oauth/register`,
        scopes_supported: [
          ...((metadata.scopes_supported as string[]) || []),
          ...scopes.filter(s => !((metadata.scopes_supported as string[]) || []).includes(s)),
        ],
      };
      // registration_endpoint always points to our proxy, which returns
      // the static client_id (if AUTH0_CLIENT_ID is set) or proxies to Auth0 DCR
      res.json(asMeta);
    } catch (err: any) {
      clearTimeout(timeout);
      const msg = err.name === 'AbortError' ? 'Auth0 metadata request timed out' : err.message;
      console.error(`[oauth-metadata] Failed to fetch Auth0 metadata: ${msg}`);
      res.status(502).json({ error: 'Failed to fetch Auth0 metadata' });
    }
  });

  // --- OAuth proxy routes: forward Claude's requests to Auth0 ---

  /** Guard that checks AUTH0_DOMAIN is configured, returns issuer or sends 503. */
  function requireIssuer(res: express.Response): string | null {
    const issuer = auth0Issuer();
    if (!issuer) { res.status(503).json({ error: 'AUTH0_DOMAIN not configured' }); return null; }
    return issuer;
  }

  // Client Registration — returns static client or proxies to Auth0 DCR
  app.post('/oauth/register', express.json(), async (req, res) => {
    // If a static client is configured, return it directly (no DCR needed)
    const staticClientId = process.env.AUTH0_CLIENT_ID;
    if (staticClientId) {
      res.status(200).json({
        client_id: staticClientId,
        client_name: req.body?.client_name || 'MCP Client',
        redirect_uris: req.body?.redirect_uris || [],
        token_endpoint_auth_method: 'none',
      });
      return;
    }

    // Fallback: proxy to Auth0 DCR
    const issuer = requireIssuer(res);
    if (!issuer) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${issuer}/oidc/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (err: any) {
      clearTimeout(timeout);
      console.error('[oauth-proxy] Registration failed:', err.message);
      res.status(502).json({ error: 'OAuth proxy failed' });
    }
  });

  // Authorization endpoint proxy (redirect to Auth0)
  app.get('/oauth/authorize', (req, res) => {
    const issuer = requireIssuer(res);
    if (!issuer) return;
    const params = new URLSearchParams(req.query as Record<string, string>);
    params.delete('audience');
    // Force re-authentication so Auth0 doesn't reuse its SSO session.
    // Combined with upstream_params.prompt=select_account on the Google connection,
    // this ensures Google shows the account picker every time.
    if (!params.has('prompt')) params.set('prompt', 'login');
    // Ensure openid and email scopes are requested so /userinfo returns identity claims
    const scopes = (params.get('scope') || '').split(' ').filter(Boolean);
    for (const required of ['openid', 'email']) {
      if (!scopes.includes(required)) scopes.push(required);
    }
    params.set('scope', scopes.join(' '));
    res.redirect(`${issuer}/authorize?${params.toString()}`);
  });

  // Token endpoint proxy — supports both JSON and form-urlencoded from clients
  app.post('/oauth/token', express.urlencoded({ extended: false }), express.json(), async (req, res) => {
    const issuer = requireIssuer(res);
    if (!issuer) return;
    try {
      const contentType = req.headers['content-type'] || '';
      let forwardBody: string;
      let forwardContentType: string;

      if (contentType.includes('application/json')) {
        forwardBody = JSON.stringify(req.body);
        forwardContentType = 'application/json';
      } else {
        forwardBody = new URLSearchParams(req.body).toString();
        forwardContentType = 'application/x-www-form-urlencoded';
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(`${issuer}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': forwardContentType },
        body: forwardBody,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await response.json() as Record<string, unknown>;
      res.status(response.status).json(data);
    } catch (err: any) {
      console.error('[oauth-proxy] Token exchange failed:', err.message);
      res.status(502).json({ error: 'OAuth proxy failed' });
    }
  });
}
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import { loadUsers, createOrUpdateUser, getUserByGoogleId, getUserByApiKey, getUserById, regenerateApiKey, getAllUsers, UserRecord } from '../userStore.js';
import { loadClientCredentials } from '../auth.js';
import { getOAuthState, deleteOAuthState, storeAuthCode } from './oauthServer.js';
import { createSession, getSession, deleteSession, Session } from './sessionStore.js';
import { clearSessionCache, createUserSession, createUserSessionFromConnection, UserSession } from '../userSession.js';
import { listMcpCatalogs, getMcpCatalog } from '../mcpCatalogStore.js';
import {
  connectMcp,
  getMcpConnection,
  getUserConnectedMcps,
  disconnectMcp,
  createMcpInstance,
  getMcpConnectionByInstanceId,
  updateMcpInstanceName,
  updateMcpInstanceTokens,
  updateMcpInstanceGoogleEmail,
  disconnectMcpInstance
} from '../mcpConnectionStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '..', 'public');

// Base scopes for registration/login (only profile info, no MCP permissions)
const BASE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-secret-change-me';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Extend Express Request to include session
interface AuthenticatedRequest extends Request {
  session?: Session;
}

// Extend Express Request for API key auth
interface ApiAuthenticatedRequest extends Request {
  userSession?: UserSession;
  user?: UserRecord;
}

/**
 * Computes the token status for a connection, used in /api/me response.
 * Extracted for testability.
 */
export function computeTokenStatus(
  googleTokens: { refresh_token?: string; expiry_date?: number } | null | undefined,
  provider?: string
): {
  hasRefreshToken: boolean;
  expiryDate: number | null;
  isExpired: boolean;
} {
  // ClickUp and Slack tokens are long-lived (no refresh needed, no expiry)
  if (provider === 'clickup' || provider === 'slack-bot' || provider === 'slack') {
    return { hasRefreshToken: false, expiryDate: null, isExpired: false };
  }
  return {
    hasRefreshToken: !!googleTokens?.refresh_token,
    expiryDate: googleTokens?.expiry_date || null,
    isExpired: !googleTokens?.refresh_token && googleTokens?.expiry_date
      ? googleTokens.expiry_date < Date.now()
      : false,
  };
}

/**
 * Merges new OAuth tokens with existing ones, preserving refresh_token if not provided.
 * Used during reconnect flow.
 */
export function mergeReconnectTokens(
  newTokens: { access_token: string; refresh_token: string; scope: string; token_type: string; expiry_date: number },
  existingRefreshToken: string | undefined
): { access_token: string; refresh_token: string; scope: string; token_type: string; expiry_date: number } {
  if (!newTokens.refresh_token && existingRefreshToken) {
    return { ...newTokens, refresh_token: existingRefreshToken };
  }
  return newTokens;
}

/**
 * Registers all shared routes used by both single-service and multi-service modes.
 * Includes: auth, dashboard, connect/reconnect OAuth, API endpoints, admin, catalogs.
 */
function registerSharedRoutes(app: express.Express): void {
  // Serve config to frontend (BASE_URL, auth mode)
  app.get('/api/config', (_req, res) => {
    res.json({ baseUrl: BASE_URL, authMode: process.env.DUAL_AUTH_MODE !== 'false' ? 'dual' : 'jwt' });
  });

  // Redirect to landing page on Vercel
  app.get('/', (_req, res) => {
    res.redirect('/dashboard');
  });

  // Login shortcut - redirect to Google OAuth
  app.get('/login', (_req, res) => {
    res.redirect('/auth/google');
  });

  // Dashboard - always serve the page (JS handles auth via /api/me)
  app.get('/dashboard', (_req, res) => {
    res.sendFile(path.join(publicDir, 'dashboard.html'));
  });

  // Serve static files
  app.use(express.static(publicDir));

  // Start OAuth flow - only requests basic profile scopes
  // MCP-specific scopes are requested when user connects each MCP
  app.get('/auth/google', async (_req, res) => {
    try {
      const { client_id, client_secret } = await loadClientCredentials();
      const redirectUri = `${BASE_URL}/auth/callback`;
      const oauthClient = new OAuth2Client(client_id, client_secret, redirectUri);

      // Only request basic profile scopes for registration/login.
      // No consent screen needed here — scopes are granted once when
      // the user connects each MCP on the dashboard.
      const authorizeUrl = oauthClient.generateAuthUrl({
        access_type: 'online',
        scope: BASE_SCOPES,
        prompt: 'select_account',
      });

      res.redirect(authorizeUrl);
    } catch (err: any) {
      console.error('Error starting OAuth flow:', err);
      res.status(500).send('Failed to start authentication. Check server configuration.');
    }
  });

  // OAuth callback — handles both direct registration and MCP OAuth flows
  app.get('/auth/callback', async (req, res) => {
    const code = req.query.code as string | undefined;
    const stateParam = req.query.state as string | undefined;

    if (!code) {
      res.status(400).send('Missing authorization code.');
      return;
    }

    try {
      // Determine which Google credentials to use:
      // If this callback is from an MCP OAuth flow, use MCP-specific credentials if available
      let client_id: string;
      let client_secret: string;

      if (stateParam) {
        const oauthState = await getOAuthState(stateParam);
        if (oauthState?.mcpSlug) {
          const mcp = await getMcpCatalog(oauthState.mcpSlug);
          if (mcp?.googleClientId && mcp?.googleClientSecret) {
            client_id = mcp.googleClientId;
            client_secret = mcp.googleClientSecret;
            console.error(`[auth/callback] Using MCP-specific credentials for "${oauthState.mcpSlug}"`);
          } else {
            const globalCreds = await loadClientCredentials();
            client_id = globalCreds.client_id;
            client_secret = globalCreds.client_secret;
          }
          // Don't delete the state yet - we still need it below
        } else {
          const globalCreds = await loadClientCredentials();
          client_id = globalCreds.client_id;
          client_secret = globalCreds.client_secret;
        }
      } else {
        const globalCreds = await loadClientCredentials();
        client_id = globalCreds.client_id;
        client_secret = globalCreds.client_secret;
      }

      const redirectUri = `${BASE_URL}/auth/callback`;
      const oauthClient = new OAuth2Client(client_id, client_secret, redirectUri);

      // Exchange Google auth code for tokens
      const { tokens } = await oauthClient.getToken(code);
      oauthClient.setCredentials(tokens);

      // Fetch user profile
      const oauth2 = google.oauth2({ version: 'v2', auth: oauthClient });
      const { data: profile } = await oauth2.userinfo.get();

      if (!profile.email || !profile.id) {
        res.status(400).send('Could not retrieve Google profile information.');
        return;
      }

      // Create or update user
      await loadUsers();

      // Get existing user to preserve refresh_token if Google didn't send a new one
      const existingUser = await getUserByGoogleId(profile.id);

      const user = await createOrUpdateUser(
        {
          email: profile.email,
          googleId: profile.id,
          name: profile.name || profile.email,
        },
        {
          access_token: tokens.access_token!,
          // Preserve existing refresh_token if Google didn't send a new one
          refresh_token: tokens.refresh_token || existingUser?.tokens?.refresh_token || '',
          scope: tokens.scope!,
          token_type: tokens.token_type!,
          expiry_date: tokens.expiry_date!,
        }
      );

      // Clear cached session so new tokens take effect immediately
      clearSessionCache(user.apiKey);

      console.error(`User registered/updated: ${user.email} (API key: ${user.apiKey.substring(0, 8)}...)`);

      // Check if this is an MCP OAuth flow
      if (stateParam) {
        const oauthState = await getOAuthState(stateParam);
        if (oauthState) {
          await deleteOAuthState(stateParam);

          // Generate single-use authorization code
          const authCode = crypto.randomBytes(32).toString('hex');
          await storeAuthCode(authCode, {
            apiKey: user.apiKey,
            clientId: oauthState.clientId,
            codeChallenge: oauthState.codeChallenge,
            codeChallengeMethod: oauthState.codeChallengeMethod,
            redirectUri: oauthState.redirectUri,
            expiresAt: Date.now() + 600_000,
          });

          // Redirect back to Claude.ai with the authorization code
          const callbackUrl = new URL(oauthState.redirectUri);
          callbackUrl.searchParams.set('code', authCode);
          callbackUrl.searchParams.set('state', oauthState.state);

          console.error(`MCP OAuth: redirecting to ${callbackUrl.origin} for client ${oauthState.clientId}`);
          res.redirect(callbackUrl.toString());
          return;
        }
      }

      // Direct registration flow — create session and redirect to dashboard
      const sessionId = await createSession(profile.id);
      res.cookie('session', sessionId, {
        signed: true,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: SESSION_MAX_AGE,
      });
      res.redirect('/dashboard');
    } catch (err: any) {
      console.error('OAuth callback error:', err);
      res.status(500).send('Authentication failed. Please try again.');
    }
  });

  // Authentication middleware for protected routes
  async function requireAuth(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const sessionId = req.signedCookies?.session;
    console.error(`[requireAuth] path=${req.path}, sessionId=${sessionId ? sessionId.substring(0, 8) + '...' : 'none'}`);
    if (!sessionId) {
      console.error(`[requireAuth] No session cookie`);
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const session = await getSession(sessionId);
    console.error(`[requireAuth] session found=${!!session}, googleId=${session?.googleId || 'none'}`);
    if (!session || session.expiresAt < Date.now()) {
      console.error(`[requireAuth] Session expired or not found`);
      res.clearCookie('session');
      res.status(401).json({ error: 'Session expired' });
      return;
    }
    req.session = session;
    next();
  }

  // JSON body parser for API routes
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // === Per-MCP OAuth Connection ===

  // GET /connect/:mcpSlug - Start OAuth for specific MCP (legacy single-instance)
  // GET /connect/:mcpSlug/new?name=... - Start OAuth for new instance
  app.get('/connect/:mcpSlug', async (req: AuthenticatedRequest, res) => {
    const mcpSlug = req.params.mcpSlug as string;
    const instanceName = req.query.name as string | undefined;
    const sessionId = req.signedCookies?.session;

    if (!sessionId) {
      const redirectUrl = instanceName
        ? `/connect/${mcpSlug}?name=${encodeURIComponent(instanceName)}`
        : `/connect/${mcpSlug}`;
      res.redirect(`/?redirect=${encodeURIComponent(redirectUrl)}`);
      return;
    }
    const session = await getSession(sessionId);
    if (!session || session.expiresAt < Date.now()) {
      res.clearCookie('session');
      const redirectUrl = instanceName
        ? `/connect/${mcpSlug}?name=${encodeURIComponent(instanceName)}`
        : `/connect/${mcpSlug}`;
      res.redirect(`/?redirect=${encodeURIComponent(redirectUrl)}`);
      return;
    }

    try {
      const mcp = await getMcpCatalog(mcpSlug);
      if (!mcp) {
        res.status(404).send('MCP not found');
        return;
      }

      // Use MCP's Google credentials if available, otherwise use global credentials
      const { client_id, client_secret } = mcp.googleClientId && mcp.googleClientSecret
        ? { client_id: mcp.googleClientId, client_secret: mcp.googleClientSecret }
        : await loadClientCredentials();

      console.error(`[MCP Connect] Starting OAuth for MCP: ${mcpSlug}${instanceName ? ` (instance: ${instanceName})` : ''}`);
      console.error(`[MCP Connect] Provider: ${mcp.provider || 'google'}`);
      console.error(`[MCP Connect] Using MCP-specific credentials: ${!!(mcp.googleClientId)}`);
      console.error(`[MCP Connect] Client ID prefix: ${client_id?.substring(0, 20)}...`);

      const redirectUri = `${BASE_URL}/connect/${mcpSlug}/callback`;

      // Generate state to verify callback
      const state = crypto.randomBytes(32).toString('hex');

      // Store state with session info (now includes instanceName for new instances)
      // reconnectInstanceId: if provided, callback will update existing instance tokens
      const reconnectInstanceId = req.query.reconnect as string | undefined;
      const redis = await import('../db.js').then(m => m.isDatabaseAvailable() ? m.getRedis() : null);
      const stateData = JSON.stringify({
        sessionId,
        mcpSlug,
        googleId: session.googleId,
        instanceName: instanceName || null, // null means legacy single-instance mode
        reconnectInstanceId: reconnectInstanceId || null,
        provider: mcp.provider || 'google',
      });

      if (redis) {
        await redis.set(`mcp_connect_state:${state}`, stateData, 'EX', 600);
      } else {
        // Fallback to memory (not recommended for production)
        (global as any).__mcpConnectStates = (global as any).__mcpConnectStates || new Map();
        (global as any).__mcpConnectStates.set(state, stateData);
        setTimeout(() => (global as any).__mcpConnectStates?.delete(state), 600_000);
      }

      // Branch on provider for authorization URL
      if (mcp.provider && mcp.provider !== 'google') {
        // Non-Google OAuth (e.g. ClickUp, Slack): simple redirect with client_id
        if (!mcp.oauthAuthorizationUrl) {
          // Direct-token providers (e.g. Slack Bot) don't use OAuth — connect via dashboard token input
          res.status(400).send(`${mcpSlug} uses direct token authentication. Please connect via the dashboard.`);
          return;
        }
        if (mcp.provider === 'slack') {
          // Slack V2 OAuth: user tokens require user_scope instead of scope
          const userScopes = (mcp.oauthScopes || []).join(',');
          const authorizeUrl = `${mcp.oauthAuthorizationUrl}?client_id=${encodeURIComponent(client_id)}&user_scope=${encodeURIComponent(userScopes)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
          res.redirect(authorizeUrl);
        } else {
          const authorizeUrl = `${mcp.oauthAuthorizationUrl}?client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
          res.redirect(authorizeUrl);
        }
      } else {
        // Google OAuth (default)
        const oauthClient = new OAuth2Client(client_id, client_secret, redirectUri);

        // Use MCP's OAuth scopes
        const scopes = mcp.oauthScopes.length > 0 ? mcp.oauthScopes : [
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/userinfo.profile',
          ...mcp.scopes,
        ];

        const authorizeUrl = oauthClient.generateAuthUrl({
          access_type: 'offline',
          scope: scopes,
          prompt: 'consent select_account',
          state,
        });

        res.redirect(authorizeUrl);
      }
    } catch (err: any) {
      console.error('MCP connect error:', err);
      res.status(500).send('Failed to start connection. Please try again.');
    }
  });

  // GET /connect/:mcpSlug/callback - OAuth callback for specific MCP
  app.get('/connect/:mcpSlug/callback', async (req: AuthenticatedRequest, res) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const mcpSlug = req.params.mcpSlug as string;

    if (!code || !state) {
      res.status(400).send('Missing authorization code or state.');
      return;
    }

    try {
      // Verify state
      let stateData: any;
      const redis = await import('../db.js').then(m => m.isDatabaseAvailable() ? m.getRedis() : null);

      if (redis) {
        const stateJson = await redis.get(`mcp_connect_state:${state}`);
        if (!stateJson) {
          res.status(400).send('Invalid or expired state. Please try again.');
          return;
        }
        stateData = JSON.parse(stateJson);
        await redis.del(`mcp_connect_state:${state}`);
      } else {
        const stateJson = (global as any).__mcpConnectStates?.get(state);
        if (!stateJson) {
          res.status(400).send('Invalid or expired state. Please try again.');
          return;
        }
        stateData = JSON.parse(stateJson);
        (global as any).__mcpConnectStates?.delete(state);
      }

      if (stateData.mcpSlug !== mcpSlug) {
        res.status(400).send('MCP slug mismatch.');
        return;
      }

      const mcp = await getMcpCatalog(mcpSlug);
      if (!mcp) {
        res.status(404).send('MCP not found');
        return;
      }

      // Use MCP's credentials if available
      const { client_id, client_secret } = mcp.googleClientId && mcp.googleClientSecret
        ? { client_id: mcp.googleClientId, client_secret: mcp.googleClientSecret }
        : await loadClientCredentials();

      const redirectUri = `${BASE_URL}/connect/${mcpSlug}/callback`;

      // Get user from session
      const user = await getUserByGoogleId(stateData.googleId);
      if (!user?.id) {
        res.status(401).send('User not found. Please log in again.');
        return;
      }

      let connection;
      const provider = stateData.provider || mcp.provider || 'google';

      if (provider === 'slack') {
        // Slack V2 OAuth: exchange code for user access_token
        const tokenUrl = mcp.oauthTokenUrl || 'https://slack.com/api/oauth.v2.access';
        const tokenController = new AbortController();
        const tokenTimeout = setTimeout(() => tokenController.abort(), 15_000);
        let tokenResponse: globalThis.Response;
        try {
          tokenResponse = await fetch(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: client_id,
              client_secret: client_secret,
              code,
              redirect_uri: redirectUri,
            }),
            signal: tokenController.signal,
          });
        } catch (err) {
          clearTimeout(tokenTimeout);
          console.error('[MCP Connect] Slack token exchange failed:', err);
          res.status(500).send('Slack token exchange failed. Please try again.');
          return;
        } finally {
          clearTimeout(tokenTimeout);
        }

        const tokenData = await tokenResponse.json() as {
          ok: boolean; error?: string;
          authed_user?: { id: string; access_token: string; scope: string };
          team?: { id: string; name: string };
        };
        if (!tokenData.ok || !tokenData.authed_user?.access_token) {
          console.error('[MCP Connect] Slack token response error:', tokenData.error || 'no access_token');
          res.status(500).send(`Slack OAuth failed: ${tokenData.error || 'no access token'}. Please try again.`);
          return;
        }

        const slackUserToken = tokenData.authed_user.access_token;
        const providerTokens = { access_token: slackUserToken, allowedChannels: [] as string[] };
        const providerEmail = null;
        const emptyGoogleTokens = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };
        const instanceName = stateData.instanceName || `Slack - ${tokenData.team?.name || 'workspace'}`;

        connection = await createMcpInstance(
          user.id, mcpSlug, instanceName, emptyGoogleTokens, null,
          'slack', providerTokens, providerEmail
        );
        console.error(`User ${user.id} connected Slack User MCP: ${connection.instanceId}`);

        // Redirect to dashboard with channelSetup param to trigger channel picker
        res.redirect(`/dashboard?channelSetup=${encodeURIComponent(connection.instanceId)}`);
        return;

      } else if (provider === 'clickup') {
        // ClickUp OAuth: exchange code for access_token
        const tokenUrl = mcp.oauthTokenUrl || 'https://api.clickup.com/api/v2/oauth/token';
        const tokenController = new AbortController();
        const tokenTimeout = setTimeout(() => tokenController.abort(), 15_000);
        let tokenResponse: globalThis.Response;
        try {
          tokenResponse = await fetch(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id, client_secret, code }),
            signal: tokenController.signal,
          });
        } catch (fetchErr: any) {
          clearTimeout(tokenTimeout);
          const msg = fetchErr.name === 'AbortError' ? 'ClickUp token exchange timed out.' : `ClickUp token exchange failed: ${fetchErr.message}`;
          console.error(`[MCP Connect] ${msg}`);
          res.status(502).send(`${msg} Please try again.`);
          return;
        } finally {
          clearTimeout(tokenTimeout);
        }

        if (!tokenResponse.ok) {
          const errText = await tokenResponse.text();
          console.error(`[MCP Connect] ClickUp token exchange failed: ${errText}`);
          res.status(500).send('ClickUp token exchange failed. Please try again.');
          return;
        }

        const tokenData = await tokenResponse.json() as { access_token?: string };
        const clickUpAccessToken = tokenData.access_token;
        if (!clickUpAccessToken) {
          console.error('[MCP Connect] ClickUp token response missing access_token:', tokenData);
          res.status(500).send('ClickUp returned no access token. Please try again.');
          return;
        }

        // Fetch ClickUp user info for email
        let providerEmail: string | null = null;
        try {
          const userController = new AbortController();
          const userTimeout = setTimeout(() => userController.abort(), 10_000);
          const userResponse = await fetch('https://api.clickup.com/api/v2/user', {
            headers: { 'Authorization': `Bearer ${clickUpAccessToken}` },
            signal: userController.signal,
          });
          clearTimeout(userTimeout);
          if (userResponse.ok) {
            const userData = await userResponse.json() as { user?: { email?: string; username?: string } };
            providerEmail = userData.user?.email || null;
            console.error(`[MCP Connect] ClickUp user email: ${providerEmail}`);
          }
        } catch (emailErr) {
          console.error('[MCP Connect] Could not fetch ClickUp user info:', emailErr);
        }

        const providerTokens = { access_token: clickUpAccessToken };
        // Use empty GoogleTokens placeholder (ClickUp doesn't use them)
        const emptyGoogleTokens = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };

        if (stateData.instanceName) {
          connection = await createMcpInstance(
            user.id, mcpSlug, stateData.instanceName, emptyGoogleTokens, null,
            'clickup', providerTokens, providerEmail
          );
        } else {
          connection = await createMcpInstance(
            user.id, mcpSlug, mcpSlug, emptyGoogleTokens, null,
            'clickup', providerTokens, providerEmail
          );
        }
        console.error(`User ${user.id} connected ClickUp MCP: ${connection.instanceId}`);
      } else {
        // Google OAuth (default)
        const oauthClient = new OAuth2Client(client_id, client_secret, redirectUri);

        // Exchange code for tokens
        const { tokens } = await oauthClient.getToken(code);
        oauthClient.setCredentials(tokens);

        // Fetch the connected Google account's email
        let googleEmail: string | null = null;
        try {
          const oauth2 = google.oauth2({ version: 'v2', auth: oauthClient });
          const { data: profile } = await oauth2.userinfo.get();
          googleEmail = profile.email || null;
          console.error(`[MCP Connect] Google account email: ${googleEmail}`);
        } catch (emailErr) {
          console.error('[MCP Connect] Could not fetch Google email:', emailErr);
        }

        const googleTokens = {
          access_token: tokens.access_token!,
          refresh_token: tokens.refresh_token || '',
          scope: tokens.scope!,
          token_type: tokens.token_type!,
          expiry_date: tokens.expiry_date!,
        };

        if (!tokens.refresh_token) {
          console.error(`[MCP Connect] WARNING: No refresh_token received for ${googleEmail} on ${mcpSlug}. Token will expire and cannot be refreshed.`);
        } else {
          console.error(`[MCP Connect] Got refresh_token for ${googleEmail} on ${mcpSlug}`);
        }

        // Check if this is a reconnect (update existing instance tokens)
        if (stateData.reconnectInstanceId) {
          const existing = await getMcpConnectionByInstanceId(stateData.reconnectInstanceId);
          if (!existing || existing.userId !== user.id || existing.mcpSlug !== mcpSlug) {
            res.status(404).send('Instance not found or access denied.');
            return;
          }
          // Preserve existing refresh_token if Google didn't send a new one
          const mergedTokens = mergeReconnectTokens(googleTokens, existing.googleTokens.refresh_token);
          Object.assign(googleTokens, mergedTokens);
          await updateMcpInstanceTokens(existing.instanceId, googleTokens);
          // Persist google email if it changed
          if (googleEmail && googleEmail !== existing.googleEmail) {
            await updateMcpInstanceGoogleEmail(existing.instanceId, googleEmail);
          }
          connection = { ...existing, googleTokens, googleEmail: googleEmail || existing.googleEmail };
          console.error(`User ${user.id} reconnected MCP instance: ${existing.instanceId} (${existing.instanceName})`);
        } else if (stateData.instanceName) {
          // Create new instance with unique ID
          connection = await createMcpInstance(
            user.id,
            mcpSlug,
            stateData.instanceName,
            googleTokens,
            googleEmail
          );
          console.error(`User ${user.id} created MCP instance: ${connection.instanceId} (${stateData.instanceName})`);
        } else {
          // Legacy: single instance per MCP type
          connection = await connectMcp(user.id, mcpSlug, googleTokens, undefined, googleEmail);
          console.error(`User ${user.id} connected MCP: ${mcpSlug}`);
        }
      }

      // Redirect to dashboard with success message
      const successParam = stateData.reconnectInstanceId ? 'reconnected' : 'connected';
      res.redirect(`/dashboard?${successParam}=` + encodeURIComponent(connection.instanceName || mcpSlug));
    } catch (err: any) {
      console.error('MCP connect callback error:', err);
      res.status(500).send('Connection failed. Please try again.');
    }
  });

  // POST /api/connect-token - Connect an MCP via direct token (e.g., Slack bot token)
  app.post('/api/connect-token', requireAuth, express.json(), async (req: AuthenticatedRequest, res) => {
    try {
      const { mcpSlug, token, instanceName } = req.body as { mcpSlug?: string; token?: string; instanceName?: string };
      if (!mcpSlug || !token) {
        res.status(400).json({ error: 'mcpSlug and token are required' });
        return;
      }

      const mcp = await getMcpCatalog(mcpSlug);
      if (!mcp) {
        res.status(404).json({ error: `MCP "${mcpSlug}" not found in catalog` });
        return;
      }

      const googleId = (req as any).session?.googleId;
      if (!googleId) { res.status(401).json({ error: 'Not authenticated' }); return; }
      const user = await getUserByGoogleId(googleId);
      if (!user?.id) { res.status(401).json({ error: 'User not found' }); return; }

      if (mcpSlug === 'slack-bot') {
        // Validate the xoxb- bot token by calling auth.test
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
          const response = await fetch('https://slack.com/api/auth.test', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            signal: controller.signal,
          });
          clearTimeout(timeout);
          const data = await response.json() as { ok: boolean; error?: string; team?: string; user_id?: string; bot_id?: string };
          if (!data.ok) {
            res.status(400).json({ error: `Invalid Slack token: ${data.error}` });
            return;
          }

          const providerEmail = null; // Slack bot tokens don't have an associated email
          const emptyGoogleTokens = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };
          const providerTokens = { access_token: token };
          const name = instanceName || `Slack - ${data.team || 'workspace'}`;

          const connection = await createMcpInstance(
            user.id, mcpSlug, name, emptyGoogleTokens, null,
            'slack-bot', providerTokens, providerEmail
          );
          console.error(`User ${user.id} connected Slack Bot MCP: ${connection.instanceId}`);
          res.json({ success: true, instanceId: connection.instanceId, instanceName: connection.instanceName });
        } catch (err: any) {
          clearTimeout(timeout);
          console.error('[connect-token] Slack token validation failed:', err);
          res.status(502).json({ error: 'Failed to validate Slack token. Check the token and try again.' });
        }
        return;
      }

      res.status(400).json({ error: `Direct token connection not supported for "${mcpSlug}"` });
    } catch (err) {
      console.error('[connect-token] error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/instances/:instanceId/channels - List available Slack channels for allowlist configuration
  app.get('/api/instances/:instanceId/channels', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const instanceId = req.params.instanceId as string;
      const googleId = (req as any).session?.googleId;
      if (!googleId) { res.status(401).json({ error: 'Not authenticated' }); return; }
      const user = await getUserByGoogleId(googleId);
      if (!user?.id) { res.status(401).json({ error: 'User not found' }); return; }

      const connection = await getMcpConnectionByInstanceId(instanceId);
      if (!connection || connection.userId !== user.id || connection.provider !== 'slack') {
        res.status(404).json({ error: 'Slack connection not found' });
        return;
      }

      const accessToken = (connection.providerTokens as any)?.access_token;
      if (!accessToken) { res.status(400).json({ error: 'No Slack token found' }); return; }

      const { SlackClient } = await import('../slack/apiHelpers.js');
      const client = new SlackClient(accessToken);

      // Paginate through all channels, including DMs
      const allChannels: Array<{ id: string; name: string; is_private: boolean; is_external: boolean; is_dm: boolean; topic?: string; num_members?: number }> = [];
      const dmUserIds: string[] = [];
      let cursor: string | undefined;
      do {
        const result = await client.conversationsList(cursor, 'public_channel,private_channel,im,mpim');
        for (const ch of result.channels) {
          const isDm = !!(ch as any).is_im;
          const isMpim = !!(ch as any).is_mpim;
          if (isDm && (ch as any).user) dmUserIds.push((ch as any).user);
          allChannels.push({
            id: ch.id,
            name: isDm ? (ch as any).user || ch.id : ch.name, // DMs don't have names, use user ID for now
            is_private: ch.is_private || isDm || isMpim,
            is_external: !!(ch as any).is_ext_shared || !!(ch as any).is_org_shared,
            is_dm: isDm || isMpim,
            topic: ch.topic?.value || undefined,
            num_members: ch.num_members,
          });
        }
        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      // Resolve DM user IDs to display names + clean up group DM names
      if (dmUserIds.length > 0) {
        const uniqueIds = [...new Set(dmUserIds)];
        const nameMap = new Map<string, string>();
        await Promise.all(uniqueIds.slice(0, 50).map(async (uid) => {
          try {
            const { user } = await client.usersInfo(uid);
            nameMap.set(uid, user.profile?.display_name || user.real_name || user.name);
          } catch { /* skip */ }
        }));
        for (const ch of allChannels) {
          if (ch.is_dm && nameMap.has(ch.name)) {
            ch.name = nameMap.get(ch.name)!;
          }
        }
      }

      // Clean up group DM (mpim) names: "mpdm-user1--user2--user3-1" → "User1, User2, User3"
      for (const ch of allChannels) {
        if (ch.is_dm && ch.name.startsWith('mpdm-')) {
          const raw = ch.name.replace(/^mpdm-/, '').replace(/-\d+$/, '');
          const usernames = raw.split('--').filter(Boolean);
          ch.name = usernames
            .map(u => u.split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' '))
            .join(', ');
        }
      }

      const currentAllowed = (connection.providerTokens as any)?.allowedChannels || [];
      res.json({ channels: allChannels, currentAllowed });
    } catch (err) {
      console.error('[channels] error:', err);
      res.status(500).json({ error: 'Failed to list channels' });
    }
  });

  // POST /api/instances/:instanceId/channels - Save allowed channels for Slack connection
  app.post('/api/instances/:instanceId/channels', requireAuth, express.json(), async (req: AuthenticatedRequest, res) => {
    try {
      const instanceId = req.params.instanceId as string;
      const { channelIds } = req.body as { channelIds?: string[] };
      if (!channelIds || !Array.isArray(channelIds)) {
        res.status(400).json({ error: 'channelIds array is required' });
        return;
      }

      const googleId = (req as any).session?.googleId;
      if (!googleId) { res.status(401).json({ error: 'Not authenticated' }); return; }
      const user = await getUserByGoogleId(googleId);
      if (!user?.id) { res.status(401).json({ error: 'User not found' }); return; }

      const connection = await getMcpConnectionByInstanceId(instanceId);
      if (!connection || connection.userId !== user.id || connection.provider !== 'slack') {
        res.status(404).json({ error: 'Slack connection not found' });
        return;
      }

      const { updateMcpInstanceProviderTokens } = await import('../mcpConnectionStore.js');
      const updatedTokens = {
        ...(connection.providerTokens as any),
        allowedChannels: channelIds,
      };
      await updateMcpInstanceProviderTokens(instanceId, updatedTokens);

      // Clear session cache so new allowedChannels take effect
      const { clearMcpSessionCache } = await import('../userSession.js');
      clearMcpSessionCache(user.apiKey, instanceId);

      console.error(`User ${user.id} updated Slack channels for ${instanceId}: ${channelIds.length} channels`);
      res.json({ success: true, allowedChannels: channelIds });
    } catch (err) {
      console.error('[channels] error:', err);
      res.status(500).json({ error: 'Failed to save channels' });
    }
  });

  // POST /api/disconnect/:mcpSlug - Disconnect an MCP
  app.post('/api/disconnect/:mcpSlug', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const mcpSlug = req.params.mcpSlug as string;

      // Get user from session
      const googleId = req.session!.googleId;
      if (!googleId) {
        res.clearCookie('session');
        res.status(401).json({ error: 'Session invalid' });
        return;
      }

      const user = await getUserByGoogleId(googleId);
      if (!user?.id) {
        res.status(401).json({ error: 'User not found' });
        return;
      }

      const disconnected = await disconnectMcp(user.id, mcpSlug);
      if (!disconnected) {
        res.status(404).json({ error: 'Connection not found' });
        return;
      }

      console.error(`User ${user.id} disconnected MCP: ${mcpSlug}`);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Disconnect error:', err);
      res.status(500).json({ error: 'Failed to disconnect' });
    }
  });

  // API endpoint to get current user info (protected)
  app.get('/api/me', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      await loadUsers();

      // Get user from session - handle old sessions that might not have googleId
      const googleId = req.session!.googleId;
      if (!googleId) {
        console.error('/api/me: Session missing googleId, clearing session');
        res.clearCookie('session');
        res.status(401).json({ error: 'Session invalid, please sign in again' });
        return;
      }

      const user = await getUserByGoogleId(googleId);
      if (!user) {
        console.error(`/api/me: User not found for googleId=${googleId}`);
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // Get user's MCP connections
      const connections = user.id ? await getUserConnectedMcps(user.id) : [];

      res.json({
        email: user.email,
        name: user.name,
        apiKey: user.apiKey,
        authMethod: user.authMethod,
        connections: connections.map(c => ({
          mcpSlug: c.mcpSlug,
          instanceId: c.instanceId,
          instanceName: c.instanceName,
          googleEmail: c.googleEmail || c.providerEmail,
          connectedAt: c.connectedAt,
          provider: c.provider || 'google',
          tokenStatus: computeTokenStatus(c.googleTokens, c.provider),
        })),
      });
    } catch (err: any) {
      console.error('Error fetching user:', err);
      res.status(500).json({ error: 'Failed to fetch user data' });
    }
  });

  // API endpoint to get user's MCP connections
  app.get('/api/me/connections', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      // Get user from session
      const googleId = req.session!.googleId;
      if (!googleId) {
        res.clearCookie('session');
        res.status(401).json({ error: 'Session invalid' });
        return;
      }

      const user = await getUserByGoogleId(googleId);
      if (!user?.id) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const connections = await getUserConnectedMcps(user.id);

      res.json({
        connections: connections.map(c => ({
          mcpSlug: c.mcpSlug,
          connectedAt: c.connectedAt,
        })),
      });
    } catch (err: any) {
      console.error('Error fetching connections:', err);
      res.status(500).json({ error: 'Failed to fetch connections' });
    }
  });

  // API endpoint to get user's MCP instances (new multi-instance API)
  app.get('/api/me/instances', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const googleId = req.session!.googleId;
      if (!googleId) {
        res.clearCookie('session');
        res.status(401).json({ error: 'Session invalid' });
        return;
      }

      const user = await getUserByGoogleId(googleId);
      if (!user?.id) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const connections = await getUserConnectedMcps(user.id);

      res.json({
        instances: connections.map(c => ({
          instanceId: c.instanceId,
          instanceName: c.instanceName,
          mcpSlug: c.mcpSlug,
          googleEmail: c.googleEmail,
          connectedAt: c.connectedAt,
        })),
      });
    } catch (err: any) {
      console.error('Error fetching instances:', err);
      res.status(500).json({ error: 'Failed to fetch instances' });
    }
  });

  // PATCH /api/instances/:instanceId - Update instance name
  app.patch('/api/instances/:instanceId', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const instanceId = req.params.instanceId as string;
      const { name } = req.body;

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json({ error: 'Name is required' });
        return;
      }

      const googleId = req.session!.googleId;
      if (!googleId) {
        res.clearCookie('session');
        res.status(401).json({ error: 'Session invalid' });
        return;
      }

      const user = await getUserByGoogleId(googleId);
      if (!user?.id) {
        res.status(401).json({ error: 'User not found' });
        return;
      }

      // Verify user owns this instance
      const connection = await getMcpConnectionByInstanceId(instanceId);
      if (!connection) {
        res.status(404).json({ error: 'Instance not found' });
        return;
      }
      if (connection.userId !== user.id) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      const updated = await updateMcpInstanceName(instanceId, name.trim());
      if (!updated) {
        res.status(404).json({ error: 'Instance not found' });
        return;
      }

      console.error(`User ${user.id} renamed instance ${instanceId} to "${name.trim()}"`);
      res.json({ success: true, instanceId, name: name.trim() });
    } catch (err: any) {
      console.error('Error updating instance:', err);
      res.status(500).json({ error: 'Failed to update instance' });
    }
  });

  // DELETE /api/instances/:instanceId - Delete an instance
  app.delete('/api/instances/:instanceId', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const instanceId = req.params.instanceId as string;

      const googleId = req.session!.googleId;
      if (!googleId) {
        res.clearCookie('session');
        res.status(401).json({ error: 'Session invalid' });
        return;
      }

      const user = await getUserByGoogleId(googleId);
      if (!user?.id) {
        res.status(401).json({ error: 'User not found' });
        return;
      }

      // Verify user owns this instance
      const connection = await getMcpConnectionByInstanceId(instanceId);
      if (!connection) {
        res.status(404).json({ error: 'Instance not found' });
        return;
      }
      if (connection.userId !== user.id) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      const deleted = await disconnectMcpInstance(instanceId);
      if (!deleted) {
        res.status(404).json({ error: 'Instance not found' });
        return;
      }

      console.error(`User ${user.id} deleted instance ${instanceId}`);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Error deleting instance:', err);
      res.status(500).json({ error: 'Failed to delete instance' });
    }
  });

  // Regenerate API key endpoint (protected)
  app.post('/api/regenerate-key', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const googleId = req.session!.googleId;
      if (!googleId) {
        res.clearCookie('session');
        res.status(401).json({ error: 'Session invalid' });
        return;
      }

      const user = await regenerateApiKey(googleId);
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      console.error(`API key regenerated for user: ${user.email} (new key: ${user.apiKey.substring(0, 8)}...)`);
      res.json({ apiKey: user.apiKey });
    } catch (err: any) {
      console.error('Error regenerating API key:', err);
      res.status(500).json({ error: 'Failed to regenerate API key' });
    }
  });

  // Logout endpoint
  app.post('/api/logout', async (req: AuthenticatedRequest, res) => {
    const sessionId = req.signedCookies?.session;
    if (sessionId) {
      await deleteSession(sessionId);
    }
    res.clearCookie('session');
    res.json({ success: true });
  });

  // === Admin ===

  async function requireAdmin(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      requireAuth(req, res, () => resolve());
    });
    if (res.headersSent) return;

    const googleId = req.session?.googleId;
    if (!googleId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const user = await getUserByGoogleId(googleId);
    if (!user || !ADMIN_EMAILS.includes(user.email.toLowerCase())) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    next();
  }

  app.get('/admin', (_req, res) => {
    res.sendFile(path.join(publicDir, 'admin.html'));
  });

  app.get('/api/admin/users', requireAdmin, async (_req: AuthenticatedRequest, res) => {
    try {
      await loadUsers();
      const allUsers = await getAllUsers();
      const usersWithConnections = await Promise.all(
        allUsers.map(async (u) => {
          let connectionCount = 0;
          let connections: { mcpSlug: string; instanceName: string; googleEmail: string | null }[] = [];
          if (u.id) {
            try {
              const mcpConns = await getUserConnectedMcps(u.id);
              connectionCount = mcpConns.length;
              connections = mcpConns.map(c => ({
                mcpSlug: c.mcpSlug,
                instanceName: c.instanceName,
                googleEmail: c.googleEmail,
              }));
            } catch {}
          }
          return {
            id: u.id,
            email: u.email,
            name: u.name,
            authMethod: u.authMethod,
            createdAt: u.createdAt,
            connectionCount,
            connections,
          };
        })
      );
      res.json({ users: usersWithConnections });
    } catch (err: any) {
      console.error('Error fetching admin users:', err);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });

  // === MCP Catalog API (public endpoints) ===

  // GET /api/v1/catalogs - List all active MCPs
  app.get('/api/v1/catalogs', async (_req, res) => {
    try {
      console.error('[/api/v1/catalogs] Fetching catalogs...');
      const catalogs = await listMcpCatalogs();
      console.error(`[/api/v1/catalogs] Found ${catalogs.length} catalogs`);
      res.json({
        catalogs: catalogs.map(c => ({
          slug: c.slug,
          name: c.name,
          description: c.description,
          iconUrl: c.iconUrl,
          mcpUrl: c.mcpUrl,
          provider: c.provider || 'google',
        })),
      });
    } catch (err: any) {
      console.error('[/api/v1/catalogs] Error:', err);
      res.status(500).json({ error: 'Failed to list catalogs' });
    }
  });

  // GET /api/v1/catalogs/:slug - Get single MCP details
  app.get('/api/v1/catalogs/:slug', async (req, res) => {
    try {
      const catalog = await getMcpCatalog(req.params.slug);
      if (!catalog) {
        res.status(404).json({ error: 'Catalog not found' });
        return;
      }
      res.json({
        slug: catalog.slug,
        name: catalog.name,
        description: catalog.description,
        iconUrl: catalog.iconUrl,
        mcpUrl: catalog.mcpUrl,
        provider: catalog.provider || 'google',
      });
    } catch (err: any) {
      console.error('Error getting catalog:', err);
      res.status(500).json({ error: 'Failed to get catalog' });
    }
  });
}

export function createWebApp(docsMcpPort: number, calendarMcpPort: number, sheetsMcpPort: number, gmailMcpPort?: number, slidesMcpPort?: number, driveMcpPort?: number, clickUpMcpPort?: number, slackBotMcpPort?: number, slackUserMcpPort?: number): express.Express {
  const app = express();
  app.set('trust proxy', true);

  // Cookie parser middleware
  app.use(cookieParser(COOKIE_SECRET));

  // Direct health check for Railway (must be before proxy)
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // RFC 9728: OAuth Protected Resource Metadata
  registerOAuthProxy(app, BASE_URL, ALL_SCOPES);

  // Proxy MCP endpoints to internal FastMCP servers (JWT auth enforced before proxy)
  function addMcpProxy(port: number, prefix?: string) {
    const opts: any = {
      target: `http://127.0.0.1:${port}`,
      changeOrigin: true,
      ws: true,
      // Disable proxy timeouts for long-lived SSE streams (default would kill after ~2min)
      proxyTimeout: 0,
      timeout: 0,
      // Prevent buffering of SSE events
      selfHandleResponse: false,
      on: {
        proxyRes: (proxyRes: any, req: any, res: any) => {
          // For SSE streams (GET /mcp or /sse), set headers to prevent intermediate
          // proxies (Cloudflare, Railway, nginx) from buffering or timing out
          if (req.method === 'GET' && (
            req.url?.includes('/mcp') || req.url?.includes('/sse')
          )) {
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
          }
        },
      },
    };
    if (prefix) {
      opts.pathFilter = [`/${prefix}`, `/${prefix}-sse`];
      opts.pathRewrite = { [`^/${prefix}-sse`]: '/sse', [`^/${prefix}`]: '/mcp' };
    } else {
      opts.pathFilter = ['/mcp', '/sse'];
    }
    // Apply JWT auth middleware before proxying to internal MCP servers
    const paths = prefix ? [`/${prefix}`, `/${prefix}-sse`] : ['/mcp', '/sse'];
    app.use(paths, resourceServerMiddleware);
    app.use(createProxyMiddleware(opts));
  }

  addMcpProxy(docsMcpPort);
  addMcpProxy(calendarMcpPort, 'calendar');
  addMcpProxy(sheetsMcpPort, 'sheets');
  if (gmailMcpPort) addMcpProxy(gmailMcpPort, 'gmail');
  if (slidesMcpPort) addMcpProxy(slidesMcpPort, 'slides');
  if (driveMcpPort) {
    addMcpProxy(driveMcpPort, 'drive');
    console.error(`   Drive MCP proxy:  /drive → 127.0.0.1:${driveMcpPort}`);
  }
  if (clickUpMcpPort) {
    addMcpProxy(clickUpMcpPort, 'clickup');
    console.error(`   ClickUp MCP proxy:  /clickup → 127.0.0.1:${clickUpMcpPort}`);
  }
  if (slackBotMcpPort) {
    addMcpProxy(slackBotMcpPort, 'slack-bot');
    console.error(`   Slack Bot MCP proxy: /slack-bot → 127.0.0.1:${slackBotMcpPort}`);
  }
  if (slackUserMcpPort) {
    addMcpProxy(slackUserMcpPort, 'slack');
    console.error(`   Slack MCP proxy:     /slack → 127.0.0.1:${slackUserMcpPort}`);
  }

  // Register all shared routes (auth, dashboard, connect, API, admin, catalogs)
  registerSharedRoutes(app);

  // === REST API for ChatGPT Integration ===

  /**
   * Resolve a Bearer token to a user record.
   * Tries JWT → API key (cheap local lookup) → opaque token (Auth0 /userinfo).
   */
  async function resolveTokenToUser(token: string): Promise<UserRecord | null> {
    // Try JWT
    if (looksLikeJwt(token)) {
      try {
        const payload = await validateJwt(token);
        return await mapJwtToUser(payload);
      } catch { /* not a valid JWT — try next */ }
    }

    // Try API key (cheap local lookup before hitting Auth0)
    await loadUsers();
    const apiKeyUser = await getUserByApiKey(token);
    if (apiKeyUser) return apiKeyUser;

    // Try opaque token (Auth0 /userinfo — last resort, network call)
    try {
      const payload = await validateOpaqueToken(token);
      return await mapJwtToUser(payload);
    } catch { /* not a valid opaque token either */ }

    return null;
  }

  /**
   * Factory for service-specific REST auth middleware.
   * Resolves token → user → finds MCP connection for the service → creates session.
   */
  function createServiceAuth(primarySlug: string, fallbackSubstring: string) {
    return async (req: ApiAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing or invalid Authorization header. Use: Bearer <token>' });
        return;
      }
      const token = authHeader.substring(7);
      if (!token) { res.status(401).json({ error: 'Token is required' }); return; }

      try {
        const user = await resolveTokenToUser(token);
        if (!user) { res.status(401).json({ error: 'Invalid token' }); return; }
        if (!user.id) { res.status(403).json({ error: 'User ID not found.' }); return; }

        // Find service-specific MCP connection for proper OAuth tokens
        let connection = await getMcpConnection(user.id, primarySlug);
        if (!connection) {
          const allConnections = await getUserConnectedMcps(user.id);
          connection = allConnections.find(c => c.mcpSlug.includes(fallbackSubstring)) || null;
        }

        if (connection) {
          if (connection.provider === 'clickup') {
            // ClickUp uses its own session with clickUpAccessToken
            const { createClickUpSession } = await import('../userSession.js');
            req.userSession = createClickUpSession(user, connection);
          } else if (connection.provider === 'slack-bot') {
            // Slack Bot uses its own session with slackBotToken
            const { createSlackBotSession } = await import('../userSession.js');
            req.userSession = createSlackBotSession(user, connection);
          } else if (connection.provider === 'slack') {
            // Slack User uses its own session with slackUserToken + allowedChannels
            const { createSlackUserSession } = await import('../userSession.js');
            req.userSession = createSlackUserSession(user, connection);
          } else {
            const mcp = await getMcpCatalog(connection.mcpSlug);
            const { client_id, client_secret } = mcp?.googleClientId && mcp?.googleClientSecret
              ? { client_id: mcp.googleClientId, client_secret: mcp.googleClientSecret }
              : await loadClientCredentials();
            req.userSession = createUserSessionFromConnection(user, connection, client_id, client_secret);
          }
        } else {
          const { client_id, client_secret } = await loadClientCredentials();
          req.userSession = createUserSession(user, client_id, client_secret);
        }

        req.user = user;
        next();
      } catch (err: any) {
        console.error(`[${primarySlug}] REST API auth error:`, err.message);
        res.status(500).json({ error: 'Authentication failed' });
      }
    };
  }

  const requireApiKey = createServiceAuth('google-docs', 'docs');
  const requireCalendarApiKey = createServiceAuth('google-calendar', 'calendar');
  const requireSheetsApiKey = createServiceAuth('google-sheets', 'sheets');
  const requireDriveApiKey = createServiceAuth('google-drive', 'drive');
  const requireGmailApiKey = createServiceAuth('google-gmail', 'gmail');
  const requireSlidesApiKey = createServiceAuth('google-slides', 'slides');
  const requireClickUpApiKey = createServiceAuth('clickup', 'clickup');

  // JSON body parser already added above for auth routes

  // Serve OpenAPI specs
  for (const spec of ['openapi', 'openapi-calendar', 'openapi-sheets', 'openapi-drive', 'openapi-gmail', 'openapi-slides', 'openapi-clickup']) {
    app.get(`/${spec}.json`, (_req, res) => {
      res.sendFile(path.join(publicDir, `${spec}.json`));
    });
  }

  // POST /api/v1/docs/read - Read a Google Doc
  app.post('/api/v1/docs/read', requireApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { documentId, format = 'text', maxLength, tabId } = req.body;

      if (!documentId) {
        res.status(400).json({ error: 'documentId is required' });
        return;
      }

      const docs = req.userSession!.googleDocs;
      const needsTabsContent = !!tabId;
      const fields = format === 'json' || format === 'markdown'
        ? '*'
        : 'body(content(paragraph(elements(textRun(content)))))';

      const docResponse = await docs.documents.get({
        documentId,
        includeTabsContent: needsTabsContent,
        fields: needsTabsContent ? '*' : fields,
      });

      // Handle tab selection
      let contentSource: any;
      if (tabId) {
        const targetTab = findTabById(docResponse.data, tabId);
        if (!targetTab) {
          res.status(404).json({ error: `Tab with ID "${tabId}" not found` });
          return;
        }
        if (!targetTab.documentTab) {
          res.status(400).json({ error: `Tab "${tabId}" does not have content` });
          return;
        }
        contentSource = { body: targetTab.documentTab.body };
      } else {
        contentSource = docResponse.data;
      }

      // Format response based on requested format
      if (format === 'json') {
        let jsonContent = JSON.stringify(contentSource, null, 2);
        if (maxLength && jsonContent.length > maxLength) {
          jsonContent = jsonContent.substring(0, maxLength);
        }
        res.json({ format: 'json', content: JSON.parse(jsonContent) });
        return;
      }

      // Extract text content
      let textContent = '';
      contentSource.body?.content?.forEach((element: any) => {
        if (element.paragraph?.elements) {
          element.paragraph.elements.forEach((pe: any) => {
            if (pe.textRun?.content) {
              textContent += pe.textRun.content;
            }
          });
        }
        if (element.table?.tableRows) {
          element.table.tableRows.forEach((row: any) => {
            row.tableCells?.forEach((cell: any) => {
              cell.content?.forEach((cellElement: any) => {
                cellElement.paragraph?.elements?.forEach((pe: any) => {
                  if (pe.textRun?.content) {
                    textContent += pe.textRun.content;
                  }
                });
              });
            });
          });
        }
      });

      if (maxLength && textContent.length > maxLength) {
        textContent = textContent.substring(0, maxLength);
      }

      res.json({
        format: 'text',
        content: textContent,
        length: textContent.length,
      });
    } catch (err: any) {
      console.error('Error reading doc:', err);
      if (err.code === 404) {
        res.status(404).json({ error: 'Document not found' });
      } else if (err.code === 403) {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to read document' });
      }
    }
  });

  // GET /api/v1/docs/:documentId/comments - List comments
  app.get('/api/v1/docs/:documentId/comments', requireApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const documentId = req.params.documentId as string;
      const drive = google.drive({ version: 'v3', auth: req.userSession!.oauthClient });

      const response = await drive.comments.list({
        fileId: documentId,
        fields: 'comments(id,content,quotedFileContent,author,createdTime,resolved,replies(id,content,author,createdTime))',
        pageSize: 100,
      });

      const comments = response.data.comments || [];

      res.json({
        documentId,
        count: comments.length,
        comments: comments.map((comment: any) => ({
          id: comment.id,
          content: comment.content,
          quotedText: comment.quotedFileContent?.value || null,
          author: comment.author?.displayName || 'Unknown',
          createdTime: comment.createdTime,
          resolved: comment.resolved || false,
          replies: (comment.replies || []).map((reply: any) => ({
            id: reply.id,
            content: reply.content,
            author: reply.author?.displayName || 'Unknown',
            createdTime: reply.createdTime,
          })),
        })),
      });
    } catch (err: any) {
      console.error('Error listing comments:', err);
      if (err.code === 404) {
        res.status(404).json({ error: 'Document not found' });
      } else if (err.code === 403) {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to list comments' });
      }
    }
  });

  // POST /api/v1/docs/:documentId/comments - Add a comment
  app.post('/api/v1/docs/:documentId/comments', requireApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const documentId = req.params.documentId as string;
      const { startIndex, endIndex, commentText } = req.body;

      if (!commentText) {
        res.status(400).json({ error: 'commentText is required' });
        return;
      }

      if (startIndex === undefined || endIndex === undefined) {
        res.status(400).json({ error: 'startIndex and endIndex are required' });
        return;
      }

      if (endIndex <= startIndex) {
        res.status(400).json({ error: 'endIndex must be greater than startIndex' });
        return;
      }

      // Get the quoted text from the document
      const docs = req.userSession!.googleDocs;
      const doc = await docs.documents.get({ documentId });

      let quotedText = '';
      const content = doc.data.body?.content || [];

      for (const element of content) {
        if (element.paragraph) {
          const elements = element.paragraph.elements || [];
          for (const textElement of elements) {
            if (textElement.textRun) {
              const elementStart = textElement.startIndex || 0;
              const elementEnd = textElement.endIndex || 0;

              if (elementEnd > startIndex && elementStart < endIndex) {
                const text = textElement.textRun.content || '';
                const startOffset = Math.max(0, startIndex - elementStart);
                const endOffset = Math.min(text.length, endIndex - elementStart);
                quotedText += text.substring(startOffset, endOffset);
              }
            }
          }
        }
      }

      // Create the comment using Drive API
      const drive = google.drive({ version: 'v3', auth: req.userSession!.oauthClient });

      const response = await drive.comments.create({
        fileId: documentId,
        fields: 'id,content,quotedFileContent,author,createdTime,resolved',
        requestBody: {
          content: commentText,
          quotedFileContent: {
            value: quotedText,
            mimeType: 'text/html',
          },
        },
      });

      res.status(201).json({
        id: response.data.id,
        content: response.data.content,
        quotedText: response.data.quotedFileContent?.value || null,
        author: response.data.author?.displayName || 'Unknown',
        createdTime: response.data.createdTime,
        resolved: response.data.resolved || false,
      });
    } catch (err: any) {
      console.error('Error adding comment:', err);
      if (err.code === 404) {
        res.status(404).json({ error: 'Document not found' });
      } else if (err.code === 403) {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to add comment' });
      }
    }
  });

  // === Calendar REST API ===

  // GET /api/v1/calendars - List calendars
  app.get('/api/v1/calendars', requireCalendarApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const showHidden = req.query.showHidden === 'true';
      const calendar = req.userSession!.googleCalendar;

      const response = await calendar.calendarList.list({
        showHidden,
      });

      const calendars = response.data.items || [];
      res.json({
        calendars: calendars.map((cal: any) => ({
          id: cal.id,
          summary: cal.summary,
          description: cal.description || null,
          primary: cal.primary || false,
          accessRole: cal.accessRole,
        })),
      });
    } catch (err: any) {
      console.error('Error listing calendars:', err);
      if (err.code === 403) {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to list calendars' });
      }
    }
  });

  // GET /api/v1/calendars/:calendarId/events - List events
  app.get('/api/v1/calendars/:calendarId/events', requireCalendarApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const calendarId = req.params.calendarId as string;
      const calendar = req.userSession!.googleCalendar;

      const now = new Date();
      const thirtyDaysLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const timeMin = (req.query.timeMin as string) || now.toISOString();
      const timeMax = (req.query.timeMax as string) || thirtyDaysLater.toISOString();
      const maxResults = Math.min(parseInt(req.query.maxResults as string) || 50, 2500);
      const query = req.query.query as string | undefined;
      const singleEvents = req.query.singleEvents !== 'false';

      const response = await calendar.events.list({
        calendarId,
        timeMin,
        timeMax,
        maxResults,
        singleEvents,
        orderBy: singleEvents ? 'startTime' : undefined,
        q: query,
      });

      const events = response.data.items || [];
      res.json({
        calendarId,
        count: events.length,
        events: events.map((event: any) => ({
          id: event.id,
          summary: event.summary || null,
          description: event.description || null,
          location: event.location || null,
          start: event.start?.dateTime || event.start?.date || null,
          end: event.end?.dateTime || event.end?.date || null,
          status: event.status,
          htmlLink: event.htmlLink || null,
          creator: event.creator?.email || null,
          organizer: event.organizer?.email || null,
          attendees: (event.attendees || []).map((a: any) => ({
            email: a.email,
            responseStatus: a.responseStatus || 'needsAction',
          })),
        })),
      });
    } catch (err: any) {
      console.error('Error listing events:', err);
      if (err.code === 404) {
        res.status(404).json({ error: 'Calendar not found' });
      } else if (err.code === 403) {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to list events' });
      }
    }
  });

  // GET /api/v1/calendars/:calendarId/events/:eventId - Get event details
  app.get('/api/v1/calendars/:calendarId/events/:eventId', requireCalendarApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { calendarId, eventId } = req.params;
      const calendar = req.userSession!.googleCalendar;

      const response: any = await calendar.events.get({
        calendarId: calendarId as string,
        eventId: eventId as string,
      });

      const event = response.data;
      res.json({
        id: event.id,
        summary: event.summary || null,
        description: event.description || null,
        location: event.location || null,
        start: event.start?.dateTime || event.start?.date || null,
        end: event.end?.dateTime || event.end?.date || null,
        status: event.status,
        htmlLink: event.htmlLink || null,
        creator: event.creator?.email || null,
        organizer: event.organizer?.email || null,
        attendees: (event.attendees || []).map((a: any) => ({
          email: a.email,
          responseStatus: a.responseStatus || 'needsAction',
        })),
        recurrence: event.recurrence || null,
      });
    } catch (err: any) {
      console.error('Error getting event:', err);
      if (err.code === 404) {
        res.status(404).json({ error: 'Event not found' });
      } else if (err.code === 403) {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to get event' });
      }
    }
  });

  // POST /api/v1/calendars/:calendarId/events - Create event
  app.post('/api/v1/calendars/:calendarId/events', requireCalendarApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const calendarId = req.params.calendarId as string;
      const { summary, description, location, startDateTime, endDateTime, timeZone, attendees, sendUpdates = 'none' } = req.body;

      if (!summary) {
        res.status(400).json({ error: 'summary is required' });
        return;
      }
      if (!startDateTime) {
        res.status(400).json({ error: 'startDateTime is required' });
        return;
      }
      if (!endDateTime) {
        res.status(400).json({ error: 'endDateTime is required' });
        return;
      }

      const calendar = req.userSession!.googleCalendar;

      const eventResource: any = {
        summary,
        description,
        location,
        start: { dateTime: startDateTime, timeZone },
        end: { dateTime: endDateTime, timeZone },
      };

      if (attendees && attendees.length > 0) {
        eventResource.attendees = attendees.map((email: string) => ({ email }));
      }

      const response = await calendar.events.insert({
        calendarId,
        requestBody: eventResource,
        sendUpdates,
      });

      const event = response.data;
      res.status(201).json({
        id: event.id,
        summary: event.summary || null,
        description: event.description || null,
        location: event.location || null,
        start: event.start?.dateTime || event.start?.date || null,
        end: event.end?.dateTime || event.end?.date || null,
        status: event.status,
        htmlLink: event.htmlLink || null,
        creator: event.creator?.email || null,
        organizer: event.organizer?.email || null,
        attendees: (event.attendees || []).map((a: any) => ({
          email: a.email,
          responseStatus: a.responseStatus || 'needsAction',
        })),
      });
    } catch (err: any) {
      console.error('Error creating event:', err);
      if (err.code === 403) {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to create event' });
      }
    }
  });

  // PATCH /api/v1/calendars/:calendarId/events/:eventId - Update event
  app.patch('/api/v1/calendars/:calendarId/events/:eventId', requireCalendarApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { calendarId, eventId } = req.params;
      const { summary, description, location, startDateTime, endDateTime, timeZone, sendUpdates = 'none' } = req.body;
      const calendar = req.userSession!.googleCalendar;

      // Fetch existing event to merge fields
      const existingResponse: any = await calendar.events.get({
        calendarId: calendarId as string,
        eventId: eventId as string,
      });
      const existingEvent = existingResponse.data;

      const eventResource: any = {
        summary: summary ?? existingEvent.summary,
        description: description ?? existingEvent.description,
        location: location ?? existingEvent.location,
        start: startDateTime ? { dateTime: startDateTime, timeZone } : existingEvent.start,
        end: endDateTime ? { dateTime: endDateTime, timeZone } : existingEvent.end,
        attendees: existingEvent.attendees,
      };

      const response: any = await calendar.events.update({
        calendarId: calendarId as string,
        eventId: eventId as string,
        requestBody: eventResource,
        sendUpdates: sendUpdates as 'all' | 'externalOnly' | 'none',
      });

      const event = response.data;
      res.json({
        id: event.id,
        summary: event.summary || null,
        description: event.description || null,
        location: event.location || null,
        start: event.start?.dateTime || event.start?.date || null,
        end: event.end?.dateTime || event.end?.date || null,
        status: event.status,
        htmlLink: event.htmlLink || null,
        creator: event.creator?.email || null,
        organizer: event.organizer?.email || null,
        attendees: (event.attendees || []).map((a: any) => ({
          email: a.email,
          responseStatus: a.responseStatus || 'needsAction',
        })),
      });
    } catch (err: any) {
      console.error('Error updating event:', err);
      if (err.code === 404) {
        res.status(404).json({ error: 'Event not found' });
      } else if (err.code === 403) {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to update event' });
      }
    }
  });

  // DELETE /api/v1/calendars/:calendarId/events/:eventId - Delete event
  app.delete('/api/v1/calendars/:calendarId/events/:eventId', requireCalendarApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { calendarId, eventId } = req.params;
      const sendUpdates = (req.query.sendUpdates as string) || 'none';
      const calendar = req.userSession!.googleCalendar;

      await calendar.events.delete({
        calendarId: calendarId as string,
        eventId: eventId as string,
        sendUpdates: sendUpdates as 'all' | 'externalOnly' | 'none',
      });

      res.json({ success: true });
    } catch (err: any) {
      console.error('Error deleting event:', err);
      if (err.code === 404) {
        res.status(404).json({ error: 'Event not found' });
      } else if (err.code === 403) {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to delete event' });
      }
    }
  });

  // === Google Sheets REST API ===

  // GET /api/v1/sheets - List spreadsheets
  app.get('/api/v1/sheets', requireSheetsApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const drive = req.userSession!.googleDrive;
      const maxResults = parseInt(req.query.maxResults as string) || 20;
      const query = req.query.query as string || '';
      const q = query
        ? `mimeType='application/vnd.google-apps.spreadsheet' and name contains '${query.replace(/'/g, "\\'")}'`
        : "mimeType='application/vnd.google-apps.spreadsheet'";
      const result = await drive.files.list({
        q, pageSize: maxResults, orderBy: 'modifiedTime desc',
        fields: 'files(id,name,modifiedTime,owners,webViewLink)',
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      res.json({ spreadsheets: result.data.files || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list spreadsheets' });
    }
  });

  // GET /api/v1/sheets/:spreadsheetId - Get spreadsheet info
  app.get('/api/v1/sheets/:spreadsheetId', requireSheetsApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const sheets = req.userSession!.googleSheets;
      const result = await sheets.spreadsheets.get({
        spreadsheetId: req.params.spreadsheetId as string, includeGridData: false,
      });
      res.json(result.data);
    } catch (err: any) {
      res.status(err.code === 404 ? 404 : 500).json({ error: err.message || 'Failed to get spreadsheet' });
    }
  });

  // POST /api/v1/sheets/:spreadsheetId/read - Read a range
  app.post('/api/v1/sheets/:spreadsheetId/read', requireSheetsApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { range } = req.body;
      if (!range) { res.status(400).json({ error: 'range is required' }); return; }
      const sheets = req.userSession!.googleSheets;
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: req.params.spreadsheetId as string, range,
      });
      res.json({ range: result.data.range, values: result.data.values || [] });
    } catch (err: any) {
      res.status(err.code === 404 ? 404 : 500).json({ error: err.message || 'Failed to read range' });
    }
  });

  // POST /api/v1/sheets/:spreadsheetId/write - Write to a range
  app.post('/api/v1/sheets/:spreadsheetId/write', requireSheetsApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { range, values, valueInputOption = 'USER_ENTERED' } = req.body;
      if (!range || !values) { res.status(400).json({ error: 'range and values are required' }); return; }
      const sheets = req.userSession!.googleSheets;
      const result = await sheets.spreadsheets.values.update({
        spreadsheetId: req.params.spreadsheetId as string, range,
        valueInputOption,
        requestBody: { values },
      });
      res.json({ updatedCells: result.data.updatedCells, updatedRows: result.data.updatedRows, updatedRange: result.data.updatedRange });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to write to range' });
    }
  });

  // POST /api/v1/sheets/:spreadsheetId/append - Append rows
  app.post('/api/v1/sheets/:spreadsheetId/append', requireSheetsApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { range, values, valueInputOption = 'USER_ENTERED' } = req.body;
      if (!range || !values) { res.status(400).json({ error: 'range and values are required' }); return; }
      const sheets = req.userSession!.googleSheets;
      const result = await sheets.spreadsheets.values.append({
        spreadsheetId: req.params.spreadsheetId as string, range,
        valueInputOption, insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      });
      res.json({ updates: result.data.updates });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to append rows' });
    }
  });

  // === Google Drive REST API ===

  // GET /api/v1/drive/files/:fileId - Get file info
  app.get('/api/v1/drive/files/:fileId', requireDriveApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const drive = req.userSession!.googleDrive;
      const result = await drive.files.get({
        fileId: req.params.fileId as string, supportsAllDrives: true,
        fields: 'id,name,mimeType,description,size,createdTime,modifiedTime,owners,shared,parents,webViewLink,driveId',
      });
      res.json(result.data);
    } catch (err: any) {
      res.status(err.code === 404 ? 404 : 500).json({ error: err.message || 'Failed to get file info' });
    }
  });

  // GET /api/v1/drive/folders/:folderId/contents - List folder contents
  app.get('/api/v1/drive/folders/:folderId/contents', requireDriveApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const drive = req.userSession!.googleDrive;
      const maxResults = parseInt(req.query.maxResults as string) || 50;
      const q = `'${req.params.folderId}' in parents and trashed = false`;
      const result = await drive.files.list({
        q, pageSize: maxResults, orderBy: 'folder,name',
        fields: 'files(id,name,mimeType,size,modifiedTime,owners)',
        supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      res.json({ items: result.data.files || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list folder contents' });
    }
  });

  // POST /api/v1/drive/folders - Create folder
  app.post('/api/v1/drive/folders', requireDriveApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { name, parentFolderId } = req.body;
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }
      const drive = req.userSession!.googleDrive;
      const result = await drive.files.create({
        requestBody: {
          name, mimeType: 'application/vnd.google-apps.folder',
          parents: parentFolderId ? [parentFolderId] : undefined,
        },
        supportsAllDrives: true,
        fields: 'id,name,parents,webViewLink',
      });
      res.json(result.data);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to create folder' });
    }
  });

  // POST /api/v1/drive/files/:fileId/copy - Copy a file
  app.post('/api/v1/drive/files/:fileId/copy', requireDriveApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { newName, parentFolderId } = req.body;
      const drive = req.userSession!.googleDrive;
      const result = await drive.files.copy({
        fileId: req.params.fileId as string,
        requestBody: {
          name: newName || undefined,
          parents: parentFolderId ? [parentFolderId] : undefined,
        },
        supportsAllDrives: true,
        fields: 'id,name,webViewLink',
      });
      res.json(result.data);
    } catch (err: any) {
      res.status(err.code === 404 ? 404 : 500).json({ error: err.message || 'Failed to copy file' });
    }
  });

  // DELETE /api/v1/drive/files/:fileId - Delete file
  app.delete('/api/v1/drive/files/:fileId', requireDriveApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const drive = req.userSession!.googleDrive;
      const permanent = req.query.permanent === 'true';
      if (permanent) {
        await drive.files.delete({ fileId: req.params.fileId as string, supportsAllDrives: true });
      } else {
        await drive.files.update({ fileId: req.params.fileId as string, requestBody: { trashed: true }, supportsAllDrives: true });
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(err.code === 404 ? 404 : 500).json({ error: err.message || 'Failed to delete file' });
    }
  });

  // === Google Gmail REST API ===

  // GET /api/v1/gmail/messages - Search emails
  app.get('/api/v1/gmail/messages', requireGmailApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const gmail = req.userSession!.googleGmail;
      const query = req.query.query as string || '';
      const maxResults = parseInt(req.query.maxResults as string) || 10;
      const pageToken = req.query.pageToken as string || undefined;
      const listResult = await gmail.users.messages.list({
        userId: 'me', q: query, maxResults, pageToken,
      });
      const messages = [];
      for (const msg of listResult.data.messages || []) {
        const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id!, format: 'metadata', metadataHeaders: ['Subject', 'From', 'To', 'Date'] });
        const headers = detail.data.payload?.headers || [];
        messages.push({
          id: msg.id, threadId: msg.threadId,
          subject: headers.find(h => h.name === 'Subject')?.value,
          from: headers.find(h => h.name === 'From')?.value,
          to: headers.find(h => h.name === 'To')?.value,
          date: headers.find(h => h.name === 'Date')?.value,
          labelIds: detail.data.labelIds,
          snippet: detail.data.snippet,
        });
      }
      res.json({ messages, nextPageToken: listResult.data.nextPageToken });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to search emails' });
    }
  });

  // GET /api/v1/gmail/messages/:messageId - Read email
  app.get('/api/v1/gmail/messages/:messageId', requireGmailApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const gmail = req.userSession!.googleGmail;
      const format = (req.query.format as string) || 'full';
      const result = await gmail.users.messages.get({
        userId: 'me', id: req.params.messageId as string, format: format as 'full' | 'metadata' | 'minimal',
      });
      res.json(result.data);
    } catch (err: any) {
      res.status(err.code === 404 ? 404 : 500).json({ error: err.message || 'Failed to read email' });
    }
  });

  // POST /api/v1/gmail/messages/send - Send email
  app.post('/api/v1/gmail/messages/send', requireGmailApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { to, subject, body, cc, bcc, isHtml } = req.body;
      if (!to || !subject || !body) { res.status(400).json({ error: 'to, subject, and body are required' }); return; }
      const gmail = req.userSession!.googleGmail;
      const mimeLines = [
        `To: ${to}`, `Subject: ${subject}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        ...(bcc ? [`Bcc: ${bcc}`] : []),
        `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
        '', body,
      ];
      const raw = Buffer.from(mimeLines.join('\r\n')).toString('base64url');
      const result = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
      res.json({ id: result.data.id, threadId: result.data.threadId });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to send email' });
    }
  });

  // POST /api/v1/gmail/drafts - Create draft
  app.post('/api/v1/gmail/drafts', requireGmailApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { to, subject, body, cc, bcc, isHtml } = req.body;
      if (!to || !subject || !body) { res.status(400).json({ error: 'to, subject, and body are required' }); return; }
      const gmail = req.userSession!.googleGmail;
      const mimeLines = [
        `To: ${to}`, `Subject: ${subject}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        ...(bcc ? [`Bcc: ${bcc}`] : []),
        `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
        '', body,
      ];
      const raw = Buffer.from(mimeLines.join('\r\n')).toString('base64url');
      const result = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
      res.json({ id: result.data.id, messageId: result.data.message?.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to create draft' });
    }
  });

  // PATCH /api/v1/gmail/messages/:messageId - Modify labels
  app.patch('/api/v1/gmail/messages/:messageId', requireGmailApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { addLabelIds, removeLabelIds } = req.body;
      const gmail = req.userSession!.googleGmail;
      const result = await gmail.users.messages.modify({
        userId: 'me', id: req.params.messageId as string,
        requestBody: { addLabelIds, removeLabelIds },
      });
      res.json({ id: result.data.id, labelIds: result.data.labelIds });
    } catch (err: any) {
      res.status(err.code === 404 ? 404 : 500).json({ error: err.message || 'Failed to modify email' });
    }
  });

  // DELETE /api/v1/gmail/messages/:messageId - Trash email
  app.delete('/api/v1/gmail/messages/:messageId', requireGmailApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const gmail = req.userSession!.googleGmail;
      await gmail.users.messages.trash({ userId: 'me', id: req.params.messageId as string });
      res.json({ success: true });
    } catch (err: any) {
      res.status(err.code === 404 ? 404 : 500).json({ error: err.message || 'Failed to trash email' });
    }
  });

  // === Google Slides REST API ===

  // POST /api/v1/slides - Create presentation
  app.post('/api/v1/slides', requireSlidesApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { title } = req.body;
      if (!title) { res.status(400).json({ error: 'title is required' }); return; }
      const slides = req.userSession!.googleSlides;
      const result = await slides.presentations.create({ requestBody: { title } });
      res.json({ presentationId: result.data.presentationId, title: result.data.title });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to create presentation' });
    }
  });

  // GET /api/v1/slides/:presentationId - Get presentation
  app.get('/api/v1/slides/:presentationId', requireSlidesApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const slides = req.userSession!.googleSlides;
      const result = await slides.presentations.get({ presentationId: req.params.presentationId as string });
      res.json(result.data);
    } catch (err: any) {
      res.status(err.code === 404 ? 404 : 500).json({ error: err.message || 'Failed to get presentation' });
    }
  });

  // GET /api/v1/slides/:presentationId/pages/:pageObjectId - Get page details
  app.get('/api/v1/slides/:presentationId/pages/:pageObjectId', requireSlidesApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const slides = req.userSession!.googleSlides;
      const result = await slides.presentations.pages.get({
        presentationId: req.params.presentationId as string,
        pageObjectId: req.params.pageObjectId as string,
      });
      res.json(result.data);
    } catch (err: any) {
      res.status(err.code === 404 ? 404 : 500).json({ error: err.message || 'Failed to get page' });
    }
  });

  // POST /api/v1/slides/:presentationId/batchUpdate - Batch update
  app.post('/api/v1/slides/:presentationId/batchUpdate', requireSlidesApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { requests } = req.body;
      if (!requests || !Array.isArray(requests)) { res.status(400).json({ error: 'requests array is required' }); return; }
      const slides = req.userSession!.googleSlides;
      const result = await slides.presentations.batchUpdate({
        presentationId: req.params.presentationId as string,
        requestBody: { requests },
      });
      res.json({ replies: result.data.replies });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to batch update presentation' });
    }
  });

  // === ClickUp REST API ===

  // GET /api/v1/clickup/user - Get authorized user
  app.get('/api/v1/clickup/user', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.getAuthorizedUser();
      res.json(result.user);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get user' });
    }
  });

  // GET /api/v1/clickup/workspaces - List workspaces
  app.get('/api/v1/clickup/workspaces', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.getWorkspaces();
      res.json({ teams: result.teams || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list workspaces' });
    }
  });

  // GET /api/v1/clickup/workspaces/:workspaceId/spaces - List spaces
  app.get('/api/v1/clickup/workspaces/:workspaceId/spaces', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.getSpaces(req.params.workspaceId as string);
      res.json({ spaces: result.spaces || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list spaces' });
    }
  });

  // POST /api/v1/clickup/spaces/:spaceId - Create space
  app.post('/api/v1/clickup/spaces/:spaceId', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.createSpace(req.params.spaceId as string, req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to create space' });
    }
  });

  // GET /api/v1/clickup/spaces/:spaceId/folders - List folders
  app.get('/api/v1/clickup/spaces/:spaceId/folders', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.getFolders(req.params.spaceId as string);
      res.json({ folders: result.folders || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list folders' });
    }
  });

  // POST /api/v1/clickup/spaces/:spaceId/folders - Create folder
  app.post('/api/v1/clickup/spaces/:spaceId/folders', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.createFolder(req.params.spaceId as string, req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to create folder' });
    }
  });

  // GET /api/v1/clickup/folders/:folderId/lists - List lists in folder
  app.get('/api/v1/clickup/folders/:folderId/lists', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.getListsInFolder(req.params.folderId as string);
      res.json({ lists: result.lists || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list lists' });
    }
  });

  // GET /api/v1/clickup/spaces/:spaceId/lists - List lists in space (folderless)
  app.get('/api/v1/clickup/spaces/:spaceId/lists', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.getFolderlessLists(req.params.spaceId as string);
      res.json({ lists: result.lists || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list lists' });
    }
  });

  // POST /api/v1/clickup/folders/:folderId/lists - Create list in folder
  app.post('/api/v1/clickup/folders/:folderId/lists', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.createList(req.params.folderId as string, req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to create list' });
    }
  });

  // PATCH /api/v1/clickup/lists/:listId - Update list
  app.patch('/api/v1/clickup/lists/:listId', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.updateList(req.params.listId as string, req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to update list' });
    }
  });

  // DELETE /api/v1/clickup/lists/:listId - Delete list
  app.delete('/api/v1/clickup/lists/:listId', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      await client.deleteList(req.params.listId as string);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to delete list' });
    }
  });

  // GET /api/v1/clickup/lists/:listId/tasks - List tasks
  app.get('/api/v1/clickup/lists/:listId/tasks', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const params: any = {};
      if (req.query.page) params.page = parseInt(req.query.page as string);
      if (req.query.orderBy) params.order_by = req.query.orderBy;
      if (req.query.statuses) params.statuses = Array.isArray(req.query.statuses) ? req.query.statuses : [req.query.statuses];
      const result = await client.getTasks(req.params.listId as string, params);
      res.json({ tasks: result.tasks || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list tasks' });
    }
  });

  // GET /api/v1/clickup/tasks/:taskId - Get task
  app.get('/api/v1/clickup/tasks/:taskId', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.getTask(req.params.taskId as string);
      res.json(result);
    } catch (err: any) {
      res.status(err.code === 404 ? 404 : 500).json({ error: err.message || 'Failed to get task' });
    }
  });

  // POST /api/v1/clickup/lists/:listId/tasks - Create task
  app.post('/api/v1/clickup/lists/:listId/tasks', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.createTask(req.params.listId as string, req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to create task' });
    }
  });

  // PATCH /api/v1/clickup/tasks/:taskId - Update task
  app.patch('/api/v1/clickup/tasks/:taskId', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.updateTask(req.params.taskId as string, req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to update task' });
    }
  });

  // DELETE /api/v1/clickup/tasks/:taskId - Delete task
  app.delete('/api/v1/clickup/tasks/:taskId', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      await client.deleteTask(req.params.taskId as string);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to delete task' });
    }
  });

  // POST /api/v1/clickup/tasks/:taskId/move - Move task
  app.post('/api/v1/clickup/tasks/:taskId/move', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { listId } = req.body;
      if (!listId) { res.status(400).json({ error: 'listId is required' }); return; }
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.moveTask(req.params.taskId as string, listId);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to move task' });
    }
  });

  // GET /api/v1/clickup/lists/:listId/fields - Get custom fields
  app.get('/api/v1/clickup/lists/:listId/fields', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.getAccessibleCustomFields(req.params.listId as string);
      res.json({ fields: result.fields || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get custom fields' });
    }
  });

  // POST /api/v1/clickup/tasks/:taskId/fields/:fieldId - Set custom field value
  app.post('/api/v1/clickup/tasks/:taskId/fields/:fieldId', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      await client.setCustomFieldValue(req.params.taskId as string, req.params.fieldId as string, req.body.value);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to set custom field' });
    }
  });

  // DELETE /api/v1/clickup/tasks/:taskId/fields/:fieldId - Remove custom field value
  app.delete('/api/v1/clickup/tasks/:taskId/fields/:fieldId', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      await client.removeCustomFieldValue(req.params.taskId as string, req.params.fieldId as string);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to remove custom field' });
    }
  });

  // GET /api/v1/clickup/tasks/:taskId/members - Get task members
  app.get('/api/v1/clickup/tasks/:taskId/members', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.getTaskMembers(req.params.taskId as string);
      res.json({ members: result.members || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get task members' });
    }
  });

  // GET /api/v1/clickup/workspaces/:workspaceId/tasks/search - Search tasks
  app.get('/api/v1/clickup/workspaces/:workspaceId/tasks/search', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const query = req.query.query as string || '';
      const page = req.query.page ? parseInt(req.query.page as string) : undefined;
      const customFields = req.query.custom_fields ? JSON.parse(req.query.custom_fields as string) : undefined;
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.searchTasks(req.params.workspaceId as string, query, page, customFields);
      res.json({ tasks: result.tasks || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to search tasks' });
    }
  });

  // GET /api/v1/clickup/tasks/:taskId/comments - Get comments
  app.get('/api/v1/clickup/tasks/:taskId/comments', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.getTaskComments(req.params.taskId as string);
      res.json({ comments: result.comments || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get comments' });
    }
  });

  // POST /api/v1/clickup/tasks/:taskId/comments - Add comment
  app.post('/api/v1/clickup/tasks/:taskId/comments', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.addTaskComment(req.params.taskId as string, req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to add comment' });
    }
  });

  // GET /api/v1/clickup/workspaces/:workspaceId/docs - List docs
  app.get('/api/v1/clickup/workspaces/:workspaceId/docs', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.listDocs(req.params.workspaceId as string);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list docs' });
    }
  });

  // GET /api/v1/clickup/workspaces/:workspaceId/docs/search - Search docs
  app.get('/api/v1/clickup/workspaces/:workspaceId/docs/search', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const query = req.query.query as string || '';
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.searchDocs(req.params.workspaceId as string, query);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to search docs' });
    }
  });

  // GET /api/v1/clickup/workspaces/:workspaceId/time - Get time entries
  app.get('/api/v1/clickup/workspaces/:workspaceId/time', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const params: any = {};
      if (req.query.start_date) params.start_date = req.query.start_date;
      if (req.query.end_date) params.end_date = req.query.end_date;
      if (req.query.assignee) params.assignee = req.query.assignee;
      const result = await client.getTimeEntries(req.params.workspaceId as string, params);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get time entries' });
    }
  });

  // POST /api/v1/clickup/workspaces/:workspaceId/time/start - Start time entry
  app.post('/api/v1/clickup/workspaces/:workspaceId/time/start', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.startTimeEntry(req.params.workspaceId as string, req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to start time entry' });
    }
  });

  // POST /api/v1/clickup/workspaces/:workspaceId/time/stop - Stop time entry
  app.post('/api/v1/clickup/workspaces/:workspaceId/time/stop', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.stopTimeEntry(req.params.workspaceId as string);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to stop time entry' });
    }
  });

  return app;
}

// Helper function to find a tab by ID in a document
function findTabById(doc: any, tabId: string): any {
  if (!doc.tabs || doc.tabs.length === 0) {
    return null;
  }

  const searchTabs = (tabs: any[]): any => {
    for (const tab of tabs) {
      if (tab.tabProperties?.tabId === tabId) {
        return tab;
      }
      if (tab.childTabs && tab.childTabs.length > 0) {
        const found = searchTabs(tab.childTabs);
        if (found) return found;
      }
    }
    return null;
  };

  return searchTabs(doc.tabs);
}

/**
 * Creates Express app for website-only mode (no MCP proxies).
 * Used in multi-service deployments where MCPs run as separate Railway services.
 * This handles: registration, login, dashboard, OAuth flows, and API endpoints.
 */
export function createWebOnlyApp(): express.Express {
  const app = express();
  app.set('trust proxy', true);

  // Cookie parser middleware
  app.use(cookieParser(COOKIE_SECRET));

  // Direct health check for Railway
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });


  // NOTE: OAuth routes (registerOAuthRoutes) are NOT registered here.
  // In multi-service mode, MCP URLs include apiKey directly (from dashboard).
  // If we advertise OAuth, Claude.ai would use it instead of the apiKey,
  // losing the instanceId and picking wrong Google tokens.
  //
  // No proxy needed: Claude.ai connects directly to MCP services using the
  // full URL from the dashboard (which includes the apiKey). Since MCP services
  // don't advertise OAuth either, the apiKey is used as-is.

  // Register all shared routes (auth, dashboard, connect, API, admin, catalogs)
  registerSharedRoutes(app);

  return app;
}


/**
 * Creates Express app for MCP-only mode (no OAuth).
 * Used in multi-service deployments where each MCP runs as a separate service.
 * Authentication is handled via apiKey in the MCP URL (issued by the dashboard).
 * OAuth is NOT exposed here so Claude.ai uses the apiKey directly instead of
 * attempting a separate OAuth flow.
 */
export function createMcpOnlyApp(internalMcpPort: number): express.Express {
  const app = express();

  // Health check
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // RFC 9728: OAuth Protected Resource Metadata (scoped to this MCP service)
  const mcpSlug = process.env.MCP_SLUG || 'google-docs';
  const mcpBaseUrl = process.env.MCP_BASE_URL || BASE_URL;
  registerOAuthProxy(app, mcpBaseUrl, getScopesForSlug(mcpSlug));

  // Proxy MCP requests to internal FastMCP server (JWT auth enforced before proxy)
  app.use(['/mcp', '/sse'], resourceServerMiddleware);
  const mcpProxy = createProxyMiddleware({
    target: `http://127.0.0.1:${internalMcpPort}`,
    changeOrigin: true,
    ws: true,
    pathFilter: ['/mcp', '/sse'],
    proxyTimeout: 0,
    timeout: 0,
    on: {
      proxyRes: (proxyRes: any, req: any, res: any) => {
        if (req.method === 'GET' && (
          req.url?.includes('/mcp') || req.url?.includes('/sse')
        )) {
          res.setHeader('X-Accel-Buffering', 'no');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
        }
      },
    },
  });
  app.use(mcpProxy);

  return app;
}
