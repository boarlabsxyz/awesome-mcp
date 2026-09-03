// src/webServer.ts
import express, { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { resourceServerMiddleware, createResourceServerMiddleware } from '../auth/resourceServerMiddleware.js';
import { ALL_SCOPES, getScopesForSlug } from '../auth/scopeMap.js';
import { validateJwt, validateOpaqueToken, hasScope } from '../auth/jwtValidator.js';
import { mapJwtToUser } from '../auth/userMapping.js';
import { looksLikeJwt } from '../auth/resourceServerMiddleware.js';
import { buildMeetConferenceData, hasExistingConference } from '../google-calendar/conferenceFormatter.js';

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

  // --- OAuth routes: intercept client OAuth flow, authenticate via Auth0, issue our own tokens ---

  /** Guard that checks AUTH0_DOMAIN is configured, returns issuer or sends 503. */
  function requireIssuer(res: express.Response): string | null {
    const issuer = auth0Issuer();
    if (!issuer) { res.status(503).json({ error: 'AUTH0_DOMAIN not configured' }); return null; }
    return issuer;
  }

  // In-memory state store for OAuth proxy flow (maps our state → client's original params)
  const proxyOAuthStates = new Map<string, {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    state: string;
    scope: string;
  }>();

  // Dynamic Client Registration (RFC 7591)
  app.post('/oauth/register', express.json(), async (req, res) => {
    try {
      const { client_name, redirect_uris } = req.body;
      if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
        res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
        return;
      }
      const clientId = crypto.randomUUID();
      const clientSecret = crypto.randomBytes(32).toString('hex');
      await storeClient({ clientId, clientSecret, redirectUris: redirect_uris, clientName: client_name || 'MCP Client' });
      console.error(`[oauth-proxy] Client registered: ${client_name || 'Unknown'} (${clientId})`);
      res.status(201).json({
        client_id: clientId,
        client_secret: clientSecret,
        client_name: client_name || 'MCP Client',
        redirect_uris,
        token_endpoint_auth_method: 'none',
      });
    } catch (err: any) {
      console.error('[oauth-proxy] Registration failed:', err.message);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // Authorization endpoint — intercept client's redirect_uri, authenticate via Auth0
  app.get('/oauth/authorize', async (req, res) => {
    const issuer = requireIssuer(res);
    if (!issuer) return;

    const clientId = req.query.client_id as string;
    const redirectUri = req.query.redirect_uri as string;
    const codeChallenge = req.query.code_challenge as string;
    const codeChallengeMethod = (req.query.code_challenge_method as string) || 'S256';
    const state = req.query.state as string;
    const scope = req.query.scope as string || 'mcp';

    if (!clientId || !redirectUri || !codeChallenge || !state) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Missing required parameters' });
      return;
    }

    // Validate client
    const client = await getClient(clientId);
    if (!client) {
      res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
      return;
    }
    if (!client.redirectUris.includes(redirectUri)) {
      res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri not registered' });
      return;
    }

    // Store client's original params; replace redirect_uri with our own callback
    const internalState = crypto.randomBytes(32).toString('hex');
    proxyOAuthStates.set(internalState, {
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      state,
      scope,
    });
    // Clean up after 10 minutes
    setTimeout(() => proxyOAuthStates.delete(internalState), 600_000);

    // Build Auth0 authorize URL with OUR callback
    const auth0ClientId = process.env.AUTH0_CLIENT_ID || '';
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: auth0ClientId,
      redirect_uri: `${resource}/oauth/callback`,
      state: internalState,
      scope: 'openid email profile',
      prompt: 'login',
    });

    console.error(`[oauth-proxy] /authorize: redirecting to Auth0, internalState=${internalState.substring(0, 8)}...`);
    res.redirect(`${issuer}/authorize?${params.toString()}`);
  });

  // OAuth callback — Auth0 redirects here after user authenticates
  app.get('/oauth/callback', async (req, res) => {
    const issuer = requireIssuer(res);
    if (!issuer) return;

    const code = req.query.code as string;
    const internalState = req.query.state as string;

    if (!code || !internalState) {
      res.status(400).send('Missing code or state from Auth0');
      return;
    }

    const savedState = proxyOAuthStates.get(internalState);
    if (!savedState) {
      res.status(400).send('OAuth state expired or invalid. Please try again.');
      return;
    }
    proxyOAuthStates.delete(internalState);

    try {
      // Exchange Auth0 code for tokens
      const auth0ClientId = process.env.AUTH0_CLIENT_ID || '';
      const auth0ClientSecret = process.env.AUTH0_CLIENT_SECRET || '';
      const tokenRes = await fetch(`${issuer}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: auth0ClientId,
          client_secret: auth0ClientSecret,
          code,
          redirect_uri: `${resource}/oauth/callback`,
        }),
      });

      if (!tokenRes.ok) {
        const errData = await tokenRes.text();
        console.error('[oauth-proxy] Auth0 token exchange failed:', errData);
        res.status(502).send('Authentication failed. Please try again.');
        return;
      }

      const tokenData = await tokenRes.json() as { access_token: string };

      // Use Auth0 /userinfo to identify the user
      const userinfoRes = await fetch(`${issuer}/userinfo`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      if (!userinfoRes.ok) {
        console.error('[oauth-proxy] Auth0 /userinfo failed');
        res.status(502).send('Failed to identify user. Please try again.');
        return;
      }

      const userinfo = await userinfoRes.json() as { email?: string; sub?: string; name?: string };
      if (!userinfo.email) {
        res.status(400).send('Could not determine user email from Auth0.');
        return;
      }

      // Find user in our database by email
      await loadUsers();
      const allUsers = await getAllUsers();
      const user = allUsers.find(u => u.email === userinfo.email);

      if (!user) {
        res.status(403).send(`
          <!DOCTYPE html>
          <html><head><title>Account Not Found</title>
          <style>body { font-family: system-ui, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; } h1 { color: #c53030; } a { color: #2563eb; }</style>
          </head><body>
          <h1>Account Not Found</h1>
          <p>No account found for <strong>${userinfo.email}</strong>. Please register on the <a href="${resource}/dashboard">dashboard</a> first.</p>
          </body></html>
        `);
        return;
      }

      // Issue our own authorization code
      const authCode = crypto.randomBytes(32).toString('hex');
      await storeAuthCode(authCode, {
        apiKey: user.apiKey,
        clientId: savedState.clientId,
        codeChallenge: savedState.codeChallenge,
        codeChallengeMethod: savedState.codeChallengeMethod,
        redirectUri: savedState.redirectUri,
        expiresAt: Date.now() + 600_000,
        scope: savedState.scope,
      });

      // Redirect back to the client (ChatGPT) with our auth code
      const callbackUrl = new URL(savedState.redirectUri);
      callbackUrl.searchParams.set('code', authCode);
      callbackUrl.searchParams.set('state', savedState.state);

      console.error(`[oauth-proxy] Issuing auth code for ${user.email}, redirecting to ${callbackUrl.origin}`);
      res.redirect(callbackUrl.toString());
    } catch (err: any) {
      console.error('[oauth-proxy] Callback error:', err);
      res.status(500).send('Authentication failed. Please try again.');
    }
  });

  // Token endpoint — exchange our auth code for user's apiKey
  app.post('/oauth/token', express.urlencoded({ extended: false }), express.json(), async (req, res) => {
    try {
      const result = await exchangeAuthCode(req.body);
      if (!result.ok) {
        const body: Record<string, string> = { error: result.error };
        if (result.errorDescription) body.error_description = result.errorDescription;
        res.status(result.status).json(body);
        return;
      }
      res.json({ access_token: result.apiKey, token_type: 'Bearer', scope: result.scope });
      console.error(`[oauth-proxy] Token issued for client ${result.clientId}`);
    } catch (err: any) {
      console.error('[oauth-proxy] Token exchange error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });
}
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import { loadUsers, createOrUpdateUser, getUserByGoogleId, getUserByApiKey, getUserById, getUserByEmail, createPasswordUser, getPasswordHashByEmail, regenerateApiKeyByUserId, getAllUsers, UserRecord, DuplicateEmailError } from '../userStore.js';
import { normalizeEmail, isValidEmail, validatePassword, hashPassword, verifyPassword } from '../auth/password.js';
import { loadClientCredentials } from '../auth.js';
import { getOAuthState, deleteOAuthState, storeAuthCode, storeClient, getClient, exchangeAuthCode } from './oauthServer.js';
import { createSession, getSession, deleteSession, Session } from './sessionStore.js';
import { consumeLoginAttempt, resetLoginAttempts, RateLimitVerdict, LOGIN_RATE_LIMIT } from './loginRateLimit.js';
import { lookupRestToken } from './restTokenStore.js';
import { mapSlackErrorToHttpStatus } from './slackErrorMapper.js';
import { negotiateFormat, respondNegotiated } from './restContent.js';
import { sendUpstreamError } from './restUpstreamError.js';
import { qstr, qint, qarr } from '../util/queryParams.js';
import { stripTrailingSlashes } from '../util/url.js';
import { selectTabContent, extractDocBodyText, truncateJsonByLength } from './docContent.js';
import { clearSessionCache, createUserSession, createUserSessionFromConnection, UserSession } from '../userSession.js';
import { listMcpCatalogs, getMcpCatalog } from '../mcpCatalogStore.js';
import { exchangeOutlineOauthCode, buildOutlineInstanceName } from '../outline/oauthCallback.js';
import { exchangeHubSpotOauthCode, buildHubSpotOauthInstanceName, HUBSPOT_TOKEN_URL } from '../hubspot/oauthCallback.js';
import { validateOutlineToken, buildOutlineInstanceName as buildOutlineInstanceNameFromToken } from '../outline/connectToken.js';
import { validatePeopleForceToken } from '../peopleforce/connectToken.js';
import { validateHubSpotToken } from '../hubspot/connectToken.js';
import { checkConnectionHealth, type ConnectionHealth } from './connectionHealth.js';
import { buildSimpleInstanceName, type ValidateResult } from '../util/pasteTokenValidation.js';
import {
  listSpreadsheetFiles,
  LIST_SPREADSHEETS_SCOPE,
  type SpreadsheetOrderBy,
} from '../google-sheets/listHandlers.js';
import { describeDriveError } from '../google-drive/driveErrors.js';
import {
  connectMcp,
  getMcpConnection,
  getUserConnectedMcps,
  disconnectMcp,
  createMcpInstance,
  getMcpConnectionByInstanceId,
  updateMcpInstanceName,
  updateMcpInstanceTokens,
  updateMcpInstanceProviderTokens,
  updateMcpInstanceGoogleEmail,
  disconnectMcpInstance
} from '../mcpConnectionStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Capitalize each word in a string. */
function titleCase(str: string): string {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}
const publicDir = path.resolve(__dirname, '..', 'public');

// Base scopes for registration/login (only profile info, no MCP permissions)
const BASE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

/**
 * Effective OAuth scopes shown on /integrations and used by the Google
 * connect flow when an MCP has no explicit oauthScopes. Mirrors the
 * fallback at /connect/:mcpSlug. Exported for testability.
 */
export function computeEffectiveScopes(
  provider: string,
  oauthScopes: string[] | undefined | null,
  mcpScopes: string[] | undefined | null
): string[] {
  const declared = oauthScopes || [];
  if (provider === 'google' && declared.length === 0) {
    return [...BASE_SCOPES, ...(mcpScopes || [])];
  }
  return declared;
}

const BASE_URL = stripTrailingSlashes(process.env.BASE_URL || 'http://localhost:8080');
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-secret-change-me';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

/** How long a pending "finish this after you log in" intent stays valid. */
const POST_LOGIN_REDIRECT_MAX_AGE = 10 * 60 * 1000; // 10 minutes
const POST_LOGIN_REDIRECT_COOKIE = 'post_login_redirect';

// Health probes hit a third party, so results are cached briefly — a dashboard
// render, a second tab and an F5 should not re-probe every provider. Short
// enough that a credential dying mid-session surfaces quickly; the cache is
// dropped outright on any credential replacement so a successful reconnect
// hides the button at once rather than after the TTL.
const CONNECTION_HEALTH_TTL_SECONDS = 300;

async function readConnectionHealthCache(instanceId: string): Promise<ConnectionHealth | null> {
  try {
    const { isDatabaseAvailable, getRedis } = await import('../db.js');
    if (!isDatabaseAvailable()) return null;
    const raw = await getRedis().get(`conn_health:${instanceId}`);
    return raw ? JSON.parse(raw) as ConnectionHealth : null;
  } catch {
    return null; // A cache miss is always safe; a cache error must not 500.
  }
}

async function writeConnectionHealthCache(instanceId: string, health: ConnectionHealth): Promise<void> {
  try {
    const { isDatabaseAvailable, getRedis } = await import('../db.js');
    if (!isDatabaseAvailable()) return;
    await getRedis().set(
      `conn_health:${instanceId}`, JSON.stringify(health), 'EX', CONNECTION_HEALTH_TTL_SECONDS,
    );
  } catch { /* best-effort */ }
}

/**
 * Forget what we knew about a connection's health.
 *
 * Called wherever a credential is replaced. Without it, reconnecting would
 * leave the Reconnect button up for the remainder of the TTL, which reads
 * exactly like the reconnect having failed.
 */
export async function clearConnectionHealthCache(instanceId: string): Promise<void> {
  try {
    const { isDatabaseAvailable, getRedis } = await import('../db.js');
    if (!isDatabaseAvailable()) return;
    await getRedis().del(`conn_health:${instanceId}`);
  } catch { /* best-effort */ }
}

/**
 * Validate a post-login return path.
 *
 * This value is reflected into res.redirect() after a session is established,
 * so it is an open-redirect sink and is treated as untrusted even though we
 * set it ourselves — a signed cookie proves integrity, not that the contents
 * are still a path we want to send a freshly-authenticated user to.
 *
 * Rejects anything that isn't a same-origin absolute path: "//evil.test" is a
 * protocol-relative URL that browsers follow off-site, and a backslash is
 * normalised to a forward slash by some clients, so "/\evil.test" is the same
 * trick. The prefix allowlist is the real guard — only the flows that actually
 * need resuming are resumable.
 */
export function sanitizePostLoginRedirect(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.includes('\\')) return null;
  const path = value.split('?')[0];
  const allowed = path === '/dashboard' || path.startsWith('/connect/');
  return allowed ? value : null;
}
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
  // ClickUp and Slack tokens are long-lived (no refresh needed, no expiry).
  // Outline is intentionally NOT here: OAuth-connected Outline tokens expire
  // (~1h) and carry a refresh token, so they are computed from the passed
  // tokens below (paste-token Outline connections have neither field and so
  // still resolve to non-expiring).
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
/**
 * Keys that must survive a re-consent when the new exchange omits them.
 *
 * Every one of these has burned someone:
 *  - refresh_token: Outline rotates its refresh token and HubSpot can omit it;
 *    overwriting with undefined leaves a connection that works for an hour and
 *    then dies. Same failure mergeReconnectTokens exists to prevent for Google.
 *  - accessRules: Slack's per-channel allowlist lives inside providerTokens.
 *    Dropping it on reconnect would silently WIDEN access, which is the one
 *    direction a reconnect must never move.
 *  - baseUrl: Outline's instance URL. It is derived from env at exchange time,
 *    so a deploy that lost the env var would otherwise blank it on the next
 *    reconnect and point the connector at the default tenant.
 *
 * The merge only fills in values the fresh exchange left EMPTY. That is why the
 * Slack branch keeps its own reconnect path instead of routing through here: it
 * builds providerTokens with a freshly-defaulted accessRules object, which is
 * non-empty, so the merge would happily keep those defaults and reset the
 * user's channel allowlist. Any future provider that pre-seeds a default for
 * one of these keys has the same trap — omit the key on the reconnect path and
 * let the stored value win.
 */
const PRESERVED_ON_RECONNECT = ['refresh_token', 'accessRules', 'baseUrl'] as const;

/**
 * Non-Google sibling of mergeReconnectTokens: carry forward anything the fresh
 * exchange did not supply, so re-consenting can only ever add information.
 */
export function mergeProviderReconnectTokens<T extends Record<string, any>>(
  newTokens: T,
  existingTokens: Record<string, any> | null | undefined,
): T & Partial<Record<typeof PRESERVED_ON_RECONNECT[number], any>> {
  // The return type is T *plus* the preserved keys: the merge can reinstate a
  // key the fresh exchange never had (a Slack allowlist on a token payload
  // that is only { access_token }), so claiming plain T would be a lie.
  if (!existingTokens) return { ...newTokens };
  const merged: Record<string, any> = { ...newTokens };
  for (const key of PRESERVED_ON_RECONNECT) {
    const incoming = merged[key];
    const isEmpty = incoming === undefined || incoming === null || incoming === '';
    if (isEmpty && existingTokens[key] !== undefined && existingTokens[key] !== null) {
      merged[key] = existingTokens[key];
    }
  }
  return merged as T & Partial<Record<typeof PRESERVED_ON_RECONNECT[number], any>>;
}

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
 * Mount the ClickUp task-event webhook ingestion endpoint on any Express app.
 *
 * Called from every app factory (createWebApp, createWebOnlyApp,
 * createMcpOnlyApp) so subscribeToTaskEvents can safely construct
 * `${BASE_URL}/webhooks/clickup/inbound` regardless of which pod BASE_URL
 * points at. Before this helper existed, MCP-only pods (createMcpOnlyApp)
 * had no /webhooks route and returned Express's default 404 for every
 * delivery — the exact production symptom that motivated PR5.
 *
 * Design notes:
 * - Registered with express.raw() so we consume the exact bytes ClickUp
 *   signed. Must be registered BEFORE any global express.json() on the
 *   same app; each caller is responsible for that ordering.
 * - Auth is signature-only. The URL is public because ClickUp POSTs to it.
 *   Trust is anchored in the X-Signature header vs the shared_secret we
 *   stored at subscribe time.
 * - Emits one structured JSON log line per delivery, greppable via
 *   [clickup-ingest]. Never logs the shared_secret itself (see
 *   IngestionLogContext).
 * - Outer catch returns 500 on infra crashes (import failure, DB down)
 *   so ClickUp counts them — the previous 200-swallow hid a 30-delivery
 *   failure behind a green counter.
 */
export function registerClickUpWebhookIngest(app: express.Express): void {
  app.post(
    '/webhooks/clickup/inbound',
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req, res) => {
      try {
        const store = await import('../clickup/taskEventStore.js');
        const { handleClickUpWebhookIngest } = await import('../clickup/webhookHelpers.js');
        const rawBody: Buffer = req.body instanceof Buffer ? req.body : Buffer.from(req.body as any);
        const result = await handleClickUpWebhookIngest(
          rawBody,
          req.headers['x-signature'] as string | undefined,
          store,
        );
        console.error(`[clickup-ingest] ${JSON.stringify({
          status: result.status,
          ...result.logContext,
        })}`);
        res.status(result.status).json(result.body);
      } catch (err: any) {
        console.error(`[clickup-ingest] handler crash: ${err?.message || err}`);
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );
}

/**
 * Mount the Slack Events API ingestion endpoint on any Express app.
 *
 * Same transport shape as registerClickUpWebhookIngest, and mounted at the same
 * places for the same reason — an MCP-only pod without this route 404s every
 * delivery, and Slack disables a Request URL that keeps failing. Slack's blast
 * radius is worse than ClickUp's: one Request URL serves the whole workspace,
 * so a disabled URL takes out every subscriber in every channel, not one user's
 * digest.
 *
 * Design notes:
 * - express.raw() so we see the exact bytes Slack signed. MUST be registered
 *   before any global express.json() on the same app.
 * - Auth is signature-only; the URL is public because Slack POSTs to it. Trust
 *   comes from the v0 HMAC against SLACK_SIGNING_SECRET, plus the ±5-minute
 *   replay window enforced in verifySlackSignature.
 * - The url_verification handshake is answered by the same handler, after the
 *   signature check, so saving the Request URL in Slack works with no special
 *   casing here.
 * - One structured JSON log line per delivery, greppable via [slack-ingest].
 *   Never includes message text — see the eventHelpers module header.
 */
export function registerSlackEventsIngest(app: express.Express): void {
  app.post(
    '/webhooks/slack/inbound',
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req, res) => {
      try {
        const store = await import('../slack/eventStore.js');
        const { handleSlackEventIngest } = await import('../slack/eventHelpers.js');
        const rawBody: Buffer = req.body instanceof Buffer ? req.body : Buffer.from(req.body as any);
        const result = await handleSlackEventIngest(
          rawBody,
          {
            signature: req.headers['x-slack-signature'] as string | undefined,
            timestamp: req.headers['x-slack-request-timestamp'] as string | undefined,
            retryNum: req.headers['x-slack-retry-num'] as string | undefined,
          },
          store,
          process.env.SLACK_SIGNING_SECRET,
        );
        console.error(`[slack-ingest] ${JSON.stringify({
          status: result.status,
          ...result.logContext,
        })}`);
        res.status(result.status).json(result.body);
      } catch (err: any) {
        console.error(`[slack-ingest] handler crash: ${err?.message || err}`);
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );
}

/**
 * Serves re-hosted ClickUp Doc images. The insertImageIntoPage /
 * uploadClickUpDocImage tools store image bytes in Postgres and embed a
 * markdown link pointing here; ClickUp's renderer fetches this URL, so the
 * route is intentionally public (unauthenticated). Ids are unguessable UUIDs.
 * Registered on every pod that can receive public traffic, mirroring
 * registerClickUpWebhookIngest.
 */
export function registerClickUpDocImageRoutes(app: express.Express): void {
  app.get('/images/clickup-doc/:id', async (req, res) => {
    try {
      // Dynamic import to avoid a boot-time cycle with the db/clickup modules.
      const { getDocImage } = await import('../clickup/docImageStore.js');
      const img = await getDocImage(req.params.id);
      if (!img) {
        res.status(404).send('Not found');
        return;
      }
      res
        .type(img.mime)
        // nosniff: don't let a browser re-interpret stored bytes as HTML/SVG
        // (defense-in-depth against XSS; ingest already rejects SVG).
        .set('X-Content-Type-Options', 'nosniff')
        .set('Cache-Control', 'public, max-age=31536000, immutable')
        .send(img.bytes);
    } catch (err: any) {
      console.error(`[clickup-doc-image] serve error: ${err?.message || err}`);
      res.status(500).send('Internal error');
    }
  });
}

// Constant-time bearer comparison (avoids leaking the token via timing).
function bearerMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Bearer auth for the upload endpoint. Runs BEFORE express.raw so an
// unauthenticated request is rejected without buffering its (up to 20MB) body.
// Fail closed: no configured token means no valid upload is possible.
function authorizeImageUpload(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.IMAGE_UPLOAD_TOKEN;
  const header = String(req.headers['authorization'] || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!expected || !provided || !bearerMatches(provided, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

/**
 * Content-addressed image blob host (see src/images/imageBlobStore.ts).
 *   POST /images/upload  — bearer-auth'd raw-binary upload → 201 { url, key, ... }
 *   GET  /images/:key    — public, immutable, ETag/304 (keys are content hashes,
 *                          so bytes at a URL never change; read must be anonymous
 *                          because ClickUp's image proxy can't authenticate).
 * Mounted on a sub-router so the raw-body-size 413 is handled in scope.
 */
export function registerImageBlobRoutes(app: express.Express): void {
  const router = express.Router();

  router.post(
    '/upload',
    // Auth first, so unauthorized requests are rejected before the body is read.
    authorizeImageUpload,
    // Input-side DoS guard: reject oversized bodies BEFORE sharp decodes them.
    // This is the real memory protection (see imageBlobStore for why the 2 MB
    // output cap is storage hygiene, not security). Do not remove it.
    express.raw({ type: '*/*', limit: '20mb' }),
    async (req, res) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(415).json({ error: 'Empty or non-binary request body.' });
        return;
      }

      try {
        const { store, STORED_CONTENT_TYPE } = await import('../images/imageBlobStore.js');
        const result = await store(body, String(req.headers['content-type'] || ''));
        res.status(201).json({ ...result, contentType: STORED_CONTENT_TYPE });
      } catch (err: any) {
        if (err?.httpStatus === 415) { res.status(415).json({ error: err.message }); return; }
        if (err?.httpStatus === 413) { res.status(413).json({ error: err.message }); return; }
        console.error(`[image-upload] error: ${err?.message || err}`);
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  router.get('/:key', async (req, res) => {
    try {
      const { fetch: fetchBlob } = await import('../images/imageBlobStore.js');
      const found = await fetchBlob(req.params.key);
      if (!found) { res.status(404).send('Not found'); return; }

      // Content-hash key ⇒ the bytes can never change, so it doubles as a strong
      // ETag and the response is immutable-cacheable forever.
      const etag = JSON.stringify(req.params.key); // quoted per RFC 7232
      const inm = req.headers['if-none-match'];
      if (inm && (inm === etag || inm === req.params.key)) {
        res.status(304).set('ETag', etag).end();
        return;
      }

      res
        .status(200)
        .type(found.contentType)
        .set('X-Content-Type-Options', 'nosniff')
        .set('Cache-Control', 'public, max-age=31536000, immutable')
        .set('ETag', etag)
        .send(found.buffer);
    } catch (err: any) {
      console.error(`[image-serve] error: ${err?.message || err}`);
      res.status(500).send('Internal error');
    }
  });

  // Map express.raw's oversize error to a clean 413 (the input DoS guard).
  router.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      res.status(413).json({ error: 'Request body too large (max 20MB).' });
      return;
    }
    next(err);
  });

  app.use('/images', router);
}

/**
 * Resolve the account behind a dashboard session.
 *
 * Every session-backed route used to do this inline as
 * `getUserByGoogleId(req.session.googleId)`, which made the whole dashboard
 * Google-only by construction: an email+password account has google_id NULL,
 * so the lookup missed and the route answered 401 on a valid session.
 *
 * `userId` is the identity now. The googleId fallback is for sessions minted
 * before that change — they are still live in Redis for up to their 7-day
 * TTL and must keep working rather than logging everyone out on deploy.
 */
async function resolveSessionUser(session: Session | undefined): Promise<UserRecord | undefined> {
  if (!session) return undefined;
  if (typeof session.userId === 'number') {
    return getUserById(session.userId);
  }
  if (session.googleId) {
    return getUserByGoogleId(session.googleId);
  }
  return undefined;
}

/**
 * Best available client address for rate-limiting purposes.
 *
 * Deliberately not `req.ip`. The app sets `trust proxy: true`, which makes
 * Express believe the whole X-Forwarded-For chain, and a client controls
 * everything it sends — so `req.ip` is whatever the caller claims. Each proxy
 * *appends* the peer it actually saw, so the RIGHTMOST entry is the one
 * written by the hop closest to us and is the only part a client cannot
 * forge; anything injected lands to its left.
 *
 * This is exactly as trustworthy as "there is one proxy in front of us",
 * which is true on Railway. It is a local hardening, not a fix for the
 * repo-wide `trust proxy: true` — that setting deserves its own change, since
 * narrowing it affects every consumer of req.ip.
 */
function rateLimitClientAddress(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const chain = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (chain) {
    const hops = chain.split(',');
    const nearest = hops[hops.length - 1]?.trim();
    if (nearest) return nearest;
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Buckets a credential attempt counts against, each with its own ceiling.
 *
 * Per-IP and per-email so neither dimension alone is a bypass: one address
 * spraying many emails and many addresses hammering one email both accumulate.
 *
 * The global bucket exists because the other two are caller-influenced — the
 * email is chosen outright and the address is only as trustworthy as the
 * proxy assumption above — so an attacker who can rotate both would otherwise
 * mint unlimited fresh buckets and spend ~190ms of bcrypt CPU per request
 * forever. It is the only ceiling here that an attacker cannot route around.
 */
function attemptKeys(req: Request, email: string): Array<{ key: string; limit: number }> {
  return [
    { key: `ip:${rateLimitClientAddress(req)}`, limit: LOGIN_RATE_LIMIT.MAX_ATTEMPTS },
    { key: `email:${email}`, limit: LOGIN_RATE_LIMIT.MAX_ATTEMPTS },
    { key: 'global:credentials', limit: LOGIN_RATE_LIMIT.GLOBAL_MAX_ATTEMPTS },
  ];
}

/** Consume one attempt on every bucket; returns a verdict for the caller. */
async function guardAttempt(req: Request, email: string): Promise<RateLimitVerdict> {
  const verdicts = await Promise.all(
    attemptKeys(req, email).map(({ key, limit }) => consumeLoginAttempt(key, limit)),
  );
  const blocked = verdicts.find(v => !v.allowed);
  return blocked ?? { allowed: true, retryAfter: 0 };
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

  // Login page — offers Google OAuth and email+password side by side.
  // This used to redirect straight to /auth/google, which is no longer a
  // correct default now that an account can exist without a Google identity.
  app.get('/login', (_req, res) => {
    res.sendFile(path.join(publicDir, 'login.html'));
  });

  // Dashboard - always serve the page (JS handles auth via /api/me)
  app.get('/dashboard', (_req, res) => {
    res.sendFile(path.join(publicDir, 'dashboard.html'));
  });

  // Public changelog / release notes
  app.get('/updates', (_req, res) => {
    res.sendFile(path.join(publicDir, 'updates.html'));
  });

  // Public integrations directory
  app.get('/integrations', (_req, res) => {
    res.sendFile(path.join(publicDir, 'integrations.html'));
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
            scope: oauthState.requestedScope || 'mcp',
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

      // Direct registration flow — create session and redirect to dashboard.
      // googleId rides along so a session minted here still resolves if the
      // user row is ever looked up the old way.
      const sessionId = await createSession({ userId: user.id, googleId: profile.id });
      res.cookie('session', sessionId, {
        signed: true,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: SESSION_MAX_AGE,
      });

      // Resume whatever the user was trying to do before we bounced them to
      // log in. Sanitized rather than trusted: this lands in res.redirect(),
      // and a signed cookie only proves we wrote it, not that it is still a
      // path worth sending a freshly-authenticated user to.
      const parked = sanitizePostLoginRedirect(req.signedCookies?.[POST_LOGIN_REDIRECT_COOKIE]);
      if (req.signedCookies?.[POST_LOGIN_REDIRECT_COOKIE]) {
        res.clearCookie(POST_LOGIN_REDIRECT_COOKIE);
      }
      res.redirect(parked || '/dashboard');
    } catch (err: any) {
      console.error('OAuth callback error:', err);
      res.status(500).send('Authentication failed. Please try again.');
    }
  });

  // === Email + password authentication ===

  const AUTH_COOKIE_OPTIONS = {
    signed: true as const,
    httpOnly: true as const,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: SESSION_MAX_AGE,
  };

  /**
   * Finish a successful sign-in: mint the session cookie and hand back the
   * post-login destination the user was parked at, if any.
   */
  async function completeSignIn(req: Request, res: Response, user: UserRecord): Promise<string> {
    const sessionId = await createSession({ userId: user.id, googleId: user.googleId ?? undefined });
    res.cookie('session', sessionId, AUTH_COOKIE_OPTIONS);

    const parked = sanitizePostLoginRedirect(req.signedCookies?.[POST_LOGIN_REDIRECT_COOKIE]);
    if (req.signedCookies?.[POST_LOGIN_REDIRECT_COOKIE]) {
      res.clearCookie(POST_LOGIN_REDIRECT_COOKIE);
    }
    return parked || '/dashboard';
  }

  app.post('/api/auth/register', express.json(), async (req: Request, res: Response) => {
    try {
      const email = normalizeEmail(String(req.body?.email ?? ''));
      const password = String(req.body?.password ?? '');

      if (!isValidEmail(email)) {
        res.status(400).json({ error: 'Enter a valid email address.' });
        return;
      }
      const policyError = validatePassword(password);
      if (policyError) {
        res.status(400).json({ error: policyError });
        return;
      }

      const gate = await guardAttempt(req, email);
      if (!gate.allowed) {
        res.set('Retry-After', String(gate.retryAfter));
        res.status(429).json({ error: 'Too many attempts. Try again later.' });
        return;
      }

      await loadUsers();
      if (await getUserByEmail(email)) {
        // Deliberately explicit rather than a generic error. Registration is
        // already an existence oracle — any wording that let a real duplicate
        // through would be worse than the disclosure, because the user would
        // be stuck with no way to tell "taken" from "broken".
        res.status(409).json({
          error: 'An account with that email already exists. Sign in instead.',
        });
        return;
      }

      const user = await createPasswordUser({
        // Sign-up collects no display name — the account is identified by its
        // email, and asking for a name at the door buys nothing the address
        // does not already give us. A `name` in the request body is ignored
        // rather than trusted, so it cannot be used to spoof a display name.
        email,
        name: email,
        passwordHash: await hashPassword(password),
      });

      // Email only — no API-key prefix. A key fragment in logs is a fragment
      // of a live credential, and it buys nothing an account id doesn't.
      console.error(`User registered via password: ${user.email}`);
      await Promise.all(attemptKeys(req, email).map(({ key }) => resetLoginAttempts(key)));

      const redirectTo = await completeSignIn(req, res, user);
      res.status(201).json({ email: user.email, name: user.name, redirectTo });
    } catch (err: any) {
      // Two concurrent registrations can both clear the pre-check above; the
      // store's uniqueness rule decides, and the loser gets the same 409 it
      // would have got had it arrived a moment later.
      if (err instanceof DuplicateEmailError) {
        res.status(409).json({
          error: 'An account with that email already exists. Sign in instead.',
        });
        return;
      }
      console.error('Registration error:', err);
      res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
  });

  app.post('/api/auth/login', express.json(), async (req: Request, res: Response) => {
    try {
      const email = normalizeEmail(String(req.body?.email ?? ''));
      const password = String(req.body?.password ?? '');

      if (!email || !password) {
        res.status(400).json({ error: 'Email and password are required.' });
        return;
      }

      const gate = await guardAttempt(req, email);
      if (!gate.allowed) {
        res.set('Retry-After', String(gate.retryAfter));
        res.status(429).json({ error: 'Too many attempts. Try again later.' });
        return;
      }

      await loadUsers();
      const storedHash = await getPasswordHashByEmail(email);

      // Run the compare unconditionally — including when there is no account
      // and when the account is Google-only (hash null). verifyPassword burns
      // the same bcrypt cost either way, so response time does not reveal
      // which emails are registered. See auth/password.ts.
      const passwordOk = await verifyPassword(password, storedHash);
      const user = passwordOk ? await getUserByEmail(email) : undefined;

      if (!passwordOk || !user?.id) {
        res.status(401).json({ error: 'Incorrect email or password.' });
        return;
      }

      await Promise.all(attemptKeys(req, email).map(({ key }) => resetLoginAttempts(key)));
      clearSessionCache(user.apiKey);

      console.error(`User signed in via password: ${user.email}`);
      const redirectTo = await completeSignIn(req, res, user);
      res.json({ email: user.email, name: user.name, redirectTo });
    } catch (err: any) {
      console.error('Login error:', err);
      res.status(500).json({ error: 'Sign-in failed. Please try again.' });
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
    console.error(`[requireAuth] session found=${!!session}, userId=${session?.userId ?? 'none'}, googleId=${session?.googleId || 'none'}`);
    if (!session || session.expiresAt < Date.now()) {
      console.error(`[requireAuth] Session expired or not found`);
      res.clearCookie('session');
      res.status(401).json({ error: 'Session expired' });
      return;
    }
    req.session = session;
    next();
  }

  // === ClickUp task-event webhook ingestion (public, HMAC-verified) ===
  // Mounted here (before the global express.json()) so we can consume the raw
  // body. See registerClickUpWebhookIngest for the full design note.
  registerClickUpWebhookIngest(app);

  // === Slack Events API ingestion (public, signature-verified) ===
  // Same raw-body ordering requirement as the ClickUp route above.
  registerSlackEventsIngest(app);

  // Public serve route for re-hosted ClickUp Doc images (unauthenticated).
  registerClickUpDocImageRoutes(app);

  // Content-addressed image blob host (upload + immutable serve). Registered
  // before the global express.json() so the raw-binary upload body is consumed
  // by its own express.raw() rather than a JSON parser.
  registerImageBlobRoutes(app);

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

    // Park the whole intent — path AND query — then send the user to log in.
    //
    // This used to hand-rebuild the return URL from `mcpSlug` + `name`, which
    // silently dropped `?reconnect=<instanceId>`: the one parameter that tells
    // the callback to refresh an existing instance instead of treating the
    // consent as a brand-new connection. A user whose session had lapsed
    // therefore came back from Google without it, fell into the callback's
    // "already connected" branch, and watched their stale token survive
    // untouched — the intermittent half of "reconnect sometimes doesn't work",
    // and provider-agnostic, so Gmail was affected exactly like the rest.
    //
    // It also pointed at `/?redirect=…`, and `/` unconditionally redirects to
    // /dashboard without ever reading that parameter, so the return-to-intent
    // was dead on arrival regardless. A signed, short-lived cookie consumed by
    // /auth/callback replaces it; going straight to /auth/google also drops a
    // pointless hop.
    const parkIntentAndLogin = () => {
      res.cookie(POST_LOGIN_REDIRECT_COOKIE, req.originalUrl, {
        signed: true,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: POST_LOGIN_REDIRECT_MAX_AGE,
      });
      // /login, not /auth/google: with two sign-in methods, hard-redirecting
      // to Google would deny the page to every email+password account.
      res.redirect('/login');
    };

    if (!sessionId) {
      parkIntentAndLogin();
      return;
    }
    const session = await getSession(sessionId);
    if (!session || session.expiresAt < Date.now()) {
      res.clearCookie('session');
      parkIntentAndLogin();
      return;
    }

    const connectingUser = await resolveSessionUser(session);
    if (!connectingUser?.id) {
      res.clearCookie('session');
      parkIntentAndLogin();
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
        // userId is what the callback resolves on. googleId used to be the
        // only identity here, which meant an email+password user could start
        // a connect flow and get "User not found" on the way back — after
        // consenting at the provider.
        userId: connectingUser.id,
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
          // Generic OAuth 2.0 authorization_code providers (e.g. Outline, ClickUp).
          // response_type=code is REQUIRED by spec-compliant servers — Outline's
          // OAuth server (@node-oauth/oauth2-server) rejects the request without
          // it; ClickUp defaults to code and tolerates the explicit value. scope
          // is only appended when the catalog declares scopes (ClickUp uses
          // app-level scopes → none, so it is omitted for ClickUp).
          let authorizeUrl = `${mcp.oauthAuthorizationUrl}?client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=${encodeURIComponent(state)}`;
          const scopeList = (mcp.oauthScopes || []).join(' ');
          if (scopeList) {
            authorizeUrl += `&scope=${encodeURIComponent(scopeList)}`;
          }
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

      // Get user from the state we stored when the flow started. Prefer
      // userId; fall back to googleId for flows started before that field
      // existed and still inside their 10-minute state TTL.
      const user = await resolveSessionUser({
        userId: stateData.userId,
        googleId: stateData.googleId,
        createdAt: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
      });
      if (!user?.id) {
        res.status(401).send('User not found. Please log in again.');
        return;
      }

      let connection;
      const provider = stateData.provider || mcp.provider || 'google';

      /**
       * Apply a re-consent to the instance the user clicked Reconnect on.
       *
       * Every non-Google branch below used to skip straight to its
       * "already connected?" check, which matches on the regenerated instance
       * name — and that name is derived from the workspace/portal, so on a
       * reconnect it ALWAYS matches. The result was a guaranteed no-op:
       * the user re-consented, got redirected to `already_exists`, and the
       * stale token was never replaced. That is the "it says ClickUp (S&F) is
       * already connected when I try to reconnect" dead end. Only the Slack and
       * Google branches ever handled it.
       *
       * Returns null when it has already answered the request.
       */
      const applyProviderReconnect = async <T extends Parameters<typeof updateMcpInstanceProviderTokens>[1]>(
        freshTokens: T,
        label: string,
      ): Promise<any | null> => {
        const existing = await getMcpConnectionByInstanceId(stateData.reconnectInstanceId);
        if (!existing || existing.userId !== user.id || existing.mcpSlug !== mcpSlug) {
          res.status(404).send('Instance not found or access denied.');
          return null;
        }
        const merged = mergeProviderReconnectTokens(freshTokens, existing.providerTokens as any);
        await updateMcpInstanceProviderTokens(existing.instanceId, merged);
        // Credentials changed, so any cached health verdict is stale — drop it
        // or the Reconnect button lingers for the rest of the TTL and reads as
        // "reconnecting did nothing".
        await clearConnectionHealthCache(existing.instanceId);
        console.error(`User ${user.id} reconnected ${label} MCP: ${existing.instanceId}`);
        return { ...existing, providerTokens: merged };
      };

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
        const providerTokens = {
          access_token: slackUserToken,
          accessRules: {
            allowedOrgs: [tokenData.team?.id].filter(Boolean) as string[],
            blacklistUsers: [] as string[],
            whitelistChannels: [] as string[],
            blacklistChannels: [] as string[],
            allowPublicOnly: false,
          },
        };
        const providerEmail = null;
        const emptyGoogleTokens = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };
        // Auto-generate instance name: Service Name (team name)
        const serviceName = mcp.name.replace(' MCP', '').trim();
        const teamLabel = tokenData.team?.name || 'workspace';
        const instanceName = stateData.instanceName || `${serviceName} (${teamLabel})`;

        // Check if this is a reconnect (update existing instance tokens)
        if (stateData.reconnectInstanceId) {
          const existing = await getMcpConnectionByInstanceId(stateData.reconnectInstanceId);
          if (!existing || existing.userId !== user.id || existing.mcpSlug !== mcpSlug) {
            res.status(404).send('Instance not found or access denied.');
            return;
          }
          // Preserve existing accessRules on reconnect — only update the token
          const existingRules = (existing.providerTokens as any)?.accessRules;
          if (existingRules) {
            providerTokens.accessRules = existingRules;
          }
          await updateMcpInstanceProviderTokens(existing.instanceId, providerTokens);
          // Credentials changed, so any cached health verdict is stale — drop it
          // or the Reconnect button lingers for the rest of the TTL and reads as
          // "reconnecting did nothing".
          await clearConnectionHealthCache(existing.instanceId);
          connection = existing;
          console.error(`User ${user.id} reconnected Slack User MCP: ${connection.instanceId}`);
        } else {
          // Check if user already has this Slack MCP for the same team — reconnect instead
          const slackConnections = await getUserConnectedMcps(user.id);
          const existingSlack = slackConnections.find(c => c.mcpSlug === mcpSlug && c.instanceName === instanceName);

          if (existingSlack) {
            console.error(`User ${user.id} already has ${mcpSlug} for ${instanceName}: ${existingSlack.instanceId}`);
            res.redirect(`/dashboard?already_exists=` + encodeURIComponent(existingSlack.instanceName));
            return;
          } else {
            connection = await createMcpInstance(
              user.id, mcpSlug, instanceName, emptyGoogleTokens, null,
              'slack', providerTokens, providerEmail
            );
            console.error(`User ${user.id} connected Slack User MCP: ${connection.instanceId}`);
          }
        }

        // Redirect to dashboard — channelSetup only for new connections
        const slackSuccessParam = stateData.reconnectInstanceId ? 'reconnected' : 'channelSetup';
        res.redirect(`/dashboard?${slackSuccessParam}=${encodeURIComponent(connection.instanceId)}`);
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

        // Fetch ClickUp workspace names for instance naming
        let clickUpWorkspaceNames: string[] = [];
        try {
          const teamController = new AbortController();
          const teamTimeout = setTimeout(() => teamController.abort(), 10_000);
          const teamResponse = await fetch('https://api.clickup.com/api/v2/team', {
            headers: { 'Authorization': `Bearer ${clickUpAccessToken}` },
            signal: teamController.signal,
          });
          clearTimeout(teamTimeout);
          if (teamResponse.ok) {
            const teamData = await teamResponse.json() as { teams?: Array<{ name: string }> };
            clickUpWorkspaceNames = (teamData.teams || []).map(t => t.name);
            console.error(`[MCP Connect] ClickUp workspaces: ${clickUpWorkspaceNames.join(', ')}`);
          }
        } catch (teamErr) {
          console.error('[MCP Connect] Could not fetch ClickUp teams:', teamErr);
        }

        const providerTokens = { access_token: clickUpAccessToken };
        // Use empty GoogleTokens placeholder (ClickUp doesn't use them)
        const emptyGoogleTokens = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };

        // Auto-generate instance name: Service Name (workspace or email)
        const clickUpServiceName = mcp.name.replace(' MCP', '').trim();
        let clickUpInstanceName: string;
        if (stateData.instanceName) {
          clickUpInstanceName = stateData.instanceName;
        } else if (clickUpWorkspaceNames.length > 0) {
          clickUpInstanceName = `${clickUpServiceName} (${clickUpWorkspaceNames.join(', ')})`;
        } else {
          clickUpInstanceName = providerEmail ? `${clickUpServiceName} (${providerEmail})` : clickUpServiceName;
        }

        if (stateData.reconnectInstanceId) {
          const reconnected = await applyProviderReconnect(providerTokens, 'ClickUp');
          if (!reconnected) return;
          res.redirect(`/dashboard?reconnected=${encodeURIComponent(reconnected.instanceName || mcpSlug)}`);
          return;
        }

        // Check if user already has this mcpSlug + same ClickUp account — reconnect instead
        const clickUpConnections = await getUserConnectedMcps(user.id);
        // Match by instance name (contains workspace name) to allow same email across different workspaces
        const existingClickUp = clickUpConnections.find(c => c.mcpSlug === mcpSlug && c.instanceName === clickUpInstanceName);

        if (existingClickUp) {
          console.error(`User ${user.id} already has ${mcpSlug} for ${providerEmail}: ${existingClickUp.instanceId}`);
          res.redirect(`/dashboard?already_exists=` + encodeURIComponent(existingClickUp.instanceName));
          return;
        } else {
          connection = await createMcpInstance(
            user.id, mcpSlug, clickUpInstanceName, emptyGoogleTokens, null,
            'clickup', providerTokens, providerEmail
          );
          console.error(`User ${user.id} connected ClickUp MCP: ${connection.instanceId}`);
        }
      } else if (provider === 'outline') {
        // Outline OAuth 2.0 authorization_code exchange, plus a best-effort
        // /api/auth.info fetch for email + team name. See src/outline/oauthCallback.ts.
        const outlineBaseUrl = process.env.OUTLINE_BASE_URL || 'https://wiki-dev.gluzdov.com';
        const exchange = await exchangeOutlineOauthCode({
          tokenUrl: mcp.oauthTokenUrl || `${outlineBaseUrl}/oauth/token`,
          code,
          clientId: client_id,
          clientSecret: client_secret,
          redirectUri,
          baseUrl: outlineBaseUrl,
        });
        if (!exchange.ok) {
          console.error(`[MCP Connect] ${exchange.logMessage}`);
          res.status(exchange.status).send(exchange.userMessage);
          return;
        }
        console.error(`[MCP Connect] Outline user email: ${exchange.email}, team: ${exchange.teamName}`);

        // Persist baseUrl alongside the token so tool calls can locate the
        // right Outline instance regardless of which env var is set on the MCP
        // service later (matches the paste-token flow's shape). Outline OAuth
        // access tokens expire (~1h default) and rotate their refresh token on
        // each use, so we store refresh_token + expiry_date to drive the
        // tool-call-time refresh in createOutlineSession/withOutlineClient.
        const outlineProviderTokens = {
          access_token: exchange.accessToken,
          refresh_token: exchange.refreshToken ?? undefined,
          expiry_date: exchange.expiresIn ? Date.now() + exchange.expiresIn * 1000 : undefined,
          baseUrl: outlineBaseUrl,
        };
        const emptyGoogleTokensForOutline = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };
        const outlineInstanceName = buildOutlineInstanceName({
          serviceName: mcp.name.replace(' MCP', '').trim(),
          providedInstanceName: stateData.instanceName,
          teamName: exchange.teamName,
          email: exchange.email,
        });

        if (stateData.reconnectInstanceId) {
          const reconnected = await applyProviderReconnect(outlineProviderTokens, 'Outline');
          if (!reconnected) return;
          res.redirect(`/dashboard?reconnected=${encodeURIComponent(reconnected.instanceName || mcpSlug)}`);
          return;
        }

        const outlineConnections = await getUserConnectedMcps(user.id);
        const existingOutline = outlineConnections.find(c => c.mcpSlug === mcpSlug && c.instanceName === outlineInstanceName);

        if (existingOutline) {
          console.error(`User ${user.id} already has ${mcpSlug} for ${exchange.email}: ${existingOutline.instanceId}`);
          res.redirect(`/dashboard?already_exists=` + encodeURIComponent(existingOutline.instanceName));
          return;
        }
        connection = await createMcpInstance(
          user.id, mcpSlug, outlineInstanceName, emptyGoogleTokensForOutline, null,
          'outline', outlineProviderTokens, exchange.email
        );
        console.error(`User ${user.id} connected Outline MCP: ${connection.instanceId}`);
      } else if (provider === 'hubspot') {
        // HubSpot OAuth 2.0 authorization_code exchange (see src/hubspot/oauthCallback.ts).
        const exchange = await exchangeHubSpotOauthCode({
          tokenUrl: mcp.oauthTokenUrl || HUBSPOT_TOKEN_URL,
          code,
          clientId: client_id,
          clientSecret: client_secret,
          redirectUri,
        });
        if (!exchange.ok) {
          console.error(`[MCP Connect] ${exchange.logMessage}`);
          res.status(exchange.status).send(exchange.userMessage);
          return;
        }
        console.error(`[MCP Connect] HubSpot portal: ${exchange.hubDomain}, user: ${exchange.email}`);

        // HubSpot access tokens expire (~30 min); store refresh_token + expiry_date
        // to drive the tool-call-time refresh in createHubSpotSession/withHubSpotClient.
        const hubspotProviderTokens = {
          access_token: exchange.accessToken,
          refresh_token: exchange.refreshToken ?? undefined,
          expiry_date: exchange.expiresIn ? Date.now() + exchange.expiresIn * 1000 : undefined,
        };
        const emptyGoogleTokensForHubSpot = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };
        const hubspotInstanceName = buildHubSpotOauthInstanceName({
          serviceName: mcp.name.replace(' MCP', '').trim(),
          providedInstanceName: stateData.instanceName,
          hubDomain: exchange.hubDomain,
          email: exchange.email,
        });

        if (stateData.reconnectInstanceId) {
          const reconnected = await applyProviderReconnect(hubspotProviderTokens, 'HubSpot');
          if (!reconnected) return;
          res.redirect(`/dashboard?reconnected=${encodeURIComponent(reconnected.instanceName || mcpSlug)}`);
          return;
        }

        const hubspotConnections = await getUserConnectedMcps(user.id);
        const existingHubSpot = hubspotConnections.find(c => c.mcpSlug === mcpSlug && c.instanceName === hubspotInstanceName);
        if (existingHubSpot) {
          console.error(`User ${user.id} already has ${mcpSlug} for ${exchange.hubDomain}: ${existingHubSpot.instanceId}`);
          res.redirect(`/dashboard?already_exists=` + encodeURIComponent(existingHubSpot.instanceName));
          return;
        }
        connection = await createMcpInstance(
          user.id, mcpSlug, hubspotInstanceName, emptyGoogleTokensForHubSpot, null,
          'hubspot', hubspotProviderTokens, exchange.email
        );
        console.error(`User ${user.id} connected HubSpot MCP: ${connection.instanceId}`);
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
          // Credentials changed, so any cached health verdict is stale — drop it
          // or the Reconnect button lingers for the rest of the TTL and reads as
          // "reconnecting did nothing".
          await clearConnectionHealthCache(existing.instanceId);
          // Persist google email if it changed
          if (googleEmail && googleEmail !== existing.googleEmail) {
            await updateMcpInstanceGoogleEmail(existing.instanceId, googleEmail);
          }
          connection = { ...existing, googleTokens, googleEmail: googleEmail || existing.googleEmail };
          console.error(`User ${user.id} reconnected MCP instance: ${existing.instanceId} (${existing.instanceName})`);
        } else if (stateData.instanceName || googleEmail) {
          // Check if user already has this mcpSlug + same account — reconnect instead of creating duplicate
          const userConnections = await getUserConnectedMcps(user.id);
          const existingForAccount = googleEmail
            ? userConnections.find(c => c.mcpSlug === mcpSlug && c.googleEmail === googleEmail)
            : null;

          if (existingForAccount) {
            // Already connected — redirect with warning
            console.error(`User ${user.id} already has ${mcpSlug} for ${googleEmail}: ${existingForAccount.instanceId}`);
            res.redirect(`/dashboard?already_exists=` + encodeURIComponent(existingForAccount.instanceName));
            return;
          } else {
            // Auto-generate instance name: Service Name (email)
            const googleServiceName = mcp.name.replace(' MCP', '').trim();
            const autoName = stateData.instanceName || (googleEmail ? `${googleServiceName} (${googleEmail})` : googleServiceName);
            connection = await createMcpInstance(
              user.id,
              mcpSlug,
              autoName,
              googleTokens,
              googleEmail
            );
            console.error(`User ${user.id} created MCP instance: ${connection.instanceId} (${autoName})`);
          }
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
      const { mcpSlug, token, instanceName, instanceId } = req.body as {
        mcpSlug?: string; token?: string; instanceName?: string; instanceId?: string;
      };
      if (!mcpSlug || !token) {
        res.status(400).json({ error: 'mcpSlug and token are required' });
        return;
      }

      const mcp = await getMcpCatalog(mcpSlug);
      if (!mcp) {
        res.status(404).json({ error: `MCP "${mcpSlug}" not found in catalog` });
        return;
      }

      const user = await resolveSessionUser((req as any).session);
      if (!user?.id) { res.status(401).json({ error: 'Not authenticated' }); return; }
      const userId = user.id;

      /**
       * Store a validated paste-token credential — updating the named instance
       * when the caller is re-authenticating, creating one otherwise.
       *
       * Paste-token providers (slack-bot, peopleforce, hubspot-by-token, and
       * Outline in paste mode) previously had no way to replace a rotated
       * credential: every path here called createMcpInstance unconditionally,
       * so re-pasting produced a DUPLICATE connection and left the dead one in
       * place. Delete-and-re-add was the only real option, and it is not
       * equivalent — the MCP URL embeds instanceId, so recreating hands the
       * user a different URL and they have to re-add the connector in Claude.
       * OAuth providers got this via /connect/:slug?reconnect=…; this is the
       * paste-token counterpart.
       *
       * The stored name and email are deliberately left alone on re-auth. This
       * rotates the credential of an account already connected; pasting a token
       * for a DIFFERENT account is a new connection, not a repair, and silently
       * relabelling the user's instance would hide that.
       */
      const persistPasteConnection = async (opts: {
        provider: string;
        serviceLogName: string;
        name: string;
        providerTokens: Record<string, any>;
        providerEmail: string | null;
      }): Promise<void> => {
        if (instanceId) {
          const existing = await getMcpConnectionByInstanceId(instanceId);
          if (!existing || existing.userId !== userId || existing.mcpSlug !== mcpSlug) {
            res.status(404).json({ error: 'Instance not found or access denied.' });
            return;
          }
          // A straight replace, not a merge: unlike the OAuth reconnect path
          // there is nothing partial to preserve, because the paste flow
          // produces every field it stores (access_token, plus baseUrl for
          // Outline). No refresh tokens and no access rules live here.
          await updateMcpInstanceProviderTokens(existing.instanceId, opts.providerTokens as any);

          // Drop the cached session, or the replaced credential changes nothing
          // that matters: buildMcpSession memoises by `${apiKey}:${instanceId}`
          // in a plain Map with no TTL, so a session built from the token the
          // user just replaced would otherwise be served for the life of the
          // process — defeating the entire point of re-entering it. Same reason
          // the access-rules endpoint clears it after writing.
          const { clearMcpSessionCache } = await import('../userSession.js');
          clearMcpSessionCache(user.apiKey, existing.instanceId);
          await clearConnectionHealthCache(existing.instanceId);

          console.error(`User ${userId} re-authenticated ${opts.serviceLogName} MCP: ${existing.instanceId}`);
          res.json({
            success: true,
            instanceId: existing.instanceId,
            instanceName: existing.instanceName,
            reauthenticated: true,
          });
          return;
        }
        const emptyGoogleTokens = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };
        const connection = await createMcpInstance(
          userId, mcpSlug, opts.name, emptyGoogleTokens, null,
          opts.provider, opts.providerTokens as any, opts.providerEmail,
        );
        console.error(`User ${userId} connected ${opts.serviceLogName} MCP: ${connection.instanceId}`);
        res.json({ success: true, instanceId: connection.instanceId, instanceName: connection.instanceName });
      };

      // Shared paste-token connect flow for simple bearer/API-key providers:
      // validate the pasted credential, then store just { access_token }. Each
      // provider differs only in its validate() call, provider slug, and log label.
      const connectPasteToken = async (
        provider: string,
        serviceLogName: string,
        validate: () => Promise<ValidateResult>,
      ): Promise<void> => {
        const result = await validate();
        if (!result.ok) {
          console.error(`[connect-token] ${result.logMessage}`);
          res.status(result.status).json({ error: result.userMessage });
          return;
        }
        await persistPasteConnection({
          provider,
          serviceLogName,
          name: buildSimpleInstanceName({
            serviceName: mcp.name.replace(' MCP', '').trim(),
            providedInstanceName: instanceName,
          }),
          providerTokens: { access_token: token },
          providerEmail: null,
        });
      };

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

          const botServiceName = mcp.name.replace(' MCP', '').trim();
          await persistPasteConnection({
            provider: 'slack-bot',
            serviceLogName: 'Slack Bot',
            name: instanceName || `${botServiceName} (${data.team || 'workspace'})`,
            providerTokens: { access_token: token },
            providerEmail: null, // Slack bot tokens have no associated email
          });
        } catch (err: any) {
          clearTimeout(timeout);
          console.error('[connect-token] Slack token validation failed:', err);
          res.status(502).json({ error: 'Failed to validate Slack token. Check the token and try again.' });
        }
        return;
      }

      if (mcpSlug === 'outline') {
        // Outline paste-token flow: the request body carries { token, baseUrl,
        // instanceName? }. We validate the pair by calling <baseUrl>/api/auth.info,
        // then store baseUrl alongside the access_token so tool calls hit the
        // right instance.
        const { baseUrl } = req.body as { baseUrl?: string };
        const validate = await validateOutlineToken({ baseUrl: baseUrl ?? '', token });
        if (!validate.ok) {
          console.error(`[connect-token] ${validate.logMessage}`);
          res.status(validate.status).json({ error: validate.userMessage });
          return;
        }

        const providerEmail = validate.email;
        await persistPasteConnection({
          provider: 'outline',
          serviceLogName: `Outline (${validate.baseUrl})`,
          name: buildOutlineInstanceNameFromToken({
            serviceName: mcp.name.replace(' MCP', '').trim(),
            providedInstanceName: instanceName,
            teamName: validate.teamName,
            email: providerEmail,
          }),
          // baseUrl rides along: a re-auth can legitimately move an instance to
          // a different Outline host, and it is re-validated above either way.
          providerTokens: { access_token: token, baseUrl: validate.baseUrl },
          providerEmail,
        });
        return;
      }

      if (mcpSlug === 'peopleforce') {
        // Validate against the public API's /employees endpoint, then store the
        // access_token. PeopleForce uses a fixed base URL for most tenants; the
        // per-service PEOPLEFORCE_BASE_URL env var covers the rest.
        await connectPasteToken('peopleforce', 'PeopleForce', () => validatePeopleForceToken({ token }));
        return;
      }

      if (mcpSlug === 'hubspot') {
        // Validate the private-app access token against the public CRM API
        // (/crm/v3/objects/companies?limit=1), then store the access_token.
        // HubSpot uses a fixed base URL for most tenants; HUBSPOT_BASE_URL covers the rest.
        await connectPasteToken('hubspot', 'HubSpot', () => validateHubSpotToken({ token }));
        return;
      }

      res.status(400).json({ error: `Direct token connection not supported for "${mcpSlug}"` });
    } catch (err) {
      console.error('[connect-token] error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/instances/:instanceId/access-rules - Get current access rules + org info
  app.get('/api/instances/:instanceId/access-rules', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const instanceId = req.params.instanceId as string;
      const user = await resolveSessionUser((req as any).session);
      if (!user?.id) { res.status(401).json({ error: 'Not authenticated' }); return; }

      const connection = await getMcpConnectionByInstanceId(instanceId);
      if (!connection || connection.userId !== user.id || connection.provider !== 'slack') {
        res.status(404).json({ error: 'Slack connection not found' });
        return;
      }

      const accessToken = (connection.providerTokens as any)?.access_token;
      if (!accessToken) { res.status(400).json({ error: 'No Slack token found' }); return; }

      const { SlackClient } = await import('../slack/apiHelpers.js');
      const client = new SlackClient(accessToken);

      // Get current workspace info
      let currentOrg = { id: '', name: 'Unknown' };
      try {
        const { team } = await client.teamInfo();
        currentOrg = { id: team.id, name: team.name };
      } catch { /* skip */ }

      // Discover connected orgs from shared channels
      const connectedOrgs: Array<{ id: string; name: string }> = [];
      const seenOrgIds = new Set<string>([currentOrg.id]);

      // Find shared channels first
      const sharedChannelIds: string[] = [];
      let cursor: string | undefined;
      do {
        const result = await client.conversationsListAll(cursor, 'public_channel,private_channel');
        for (const ch of result.channels) {
          if (ch.is_ext_shared || ch.is_org_shared) {
            sharedChannelIds.push(ch.id);
          }
        }
        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      // Get shared_team_ids from conversations.info (limited to first 10 shared channels, sequential to avoid rate limits)
      for (const chId of sharedChannelIds.slice(0, 10)) {
        try {
          const { channel: info } = await client.conversationsInfo(chId);
          if (info.shared_team_ids) {
            for (const tid of info.shared_team_ids) {
              if (!seenOrgIds.has(tid)) {
                seenOrgIds.add(tid);
                connectedOrgs.push({ id: tid, name: tid });
              }
            }
          }
        } catch { /* skip — rate limit or other error */ }
      }

      // Resolve org names: try team.info for each external org, fall back to user names
      for (const org of connectedOrgs) {
        if (org.name === org.id) {
          try {
            const { team } = await client.teamInfo(org.id);
            org.name = team.name;
          } catch {
            // team.info failed for external org — keep ID as fallback
          }
        }
      }

      // Migrate old format
      const { migrateSlackTokens } = await import('../mcpConnectionStore.js');
      const tokens = migrateSlackTokens(connection.providerTokens);

      // Get blacklisted user names for display (sequential to avoid rate limits)
      const blacklistUserDetails: Array<{ id: string; name: string }> = [];
      if (tokens.accessRules?.blacklistUsers?.length) {
        for (const uid of tokens.accessRules.blacklistUsers.slice(0, 50)) {
          try {
            const { user: u } = await client.usersInfo(uid);
            blacklistUserDetails.push({ id: uid, name: u.profile?.display_name || u.real_name || u.name });
          } catch {
            blacklistUserDetails.push({ id: uid, name: uid });
          }
        }
      }

      res.json({
        currentRules: tokens.accessRules,
        currentOrg,
        connectedOrgs,
        blacklistUserDetails,
      });
    } catch (err) {
      console.error('[access-rules] error:', err);
      res.status(500).json({ error: 'Failed to load access rules' });
    }
  });

  // POST /api/instances/:instanceId/access-rules - Save access rules
  app.post('/api/instances/:instanceId/access-rules', requireAuth, express.json(), async (req: AuthenticatedRequest, res) => {
    try {
      const instanceId = req.params.instanceId as string;
      const { accessRules } = req.body as { accessRules?: any };
      if (!accessRules) {
        res.status(400).json({ error: 'accessRules object is required' });
        return;
      }

      // Validate glob patterns
      const allPatterns = [...(accessRules.whitelistChannels || []), ...(accessRules.blacklistChannels || [])];
      for (const pattern of allPatterns) {
        if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 100) {
          res.status(400).json({ error: `Invalid pattern: "${pattern}". Must be 1-100 characters.` });
          return;
        }
        if (/[^a-zA-Z0-9\-_*?]/.test(pattern)) {
          res.status(400).json({ error: `Invalid pattern: "${pattern}". Only alphanumeric, hyphens, underscores, *, ? allowed.` });
          return;
        }
      }

      const user = await resolveSessionUser((req as any).session);
      if (!user?.id) { res.status(401).json({ error: 'Not authenticated' }); return; }

      const connection = await getMcpConnectionByInstanceId(instanceId);
      if (!connection || connection.userId !== user.id || connection.provider !== 'slack') {
        res.status(404).json({ error: 'Slack connection not found' });
        return;
      }

      const { updateMcpInstanceProviderTokens } = await import('../mcpConnectionStore.js');
      const updatedTokens = {
        ...(connection.providerTokens as any),
        accessRules: {
          allowedOrgs: accessRules.allowedOrgs || [],
          blacklistUsers: accessRules.blacklistUsers || [],
          whitelistChannels: accessRules.whitelistChannels || [],
          blacklistChannels: accessRules.blacklistChannels || [],
          allowPublicOnly: !!accessRules.allowPublicOnly,
        },
      };
      await updateMcpInstanceProviderTokens(instanceId, updatedTokens);

      // Clear session cache so new rules take effect
      const { clearMcpSessionCache } = await import('../userSession.js');
      clearMcpSessionCache(user.apiKey, instanceId);

      console.error(`User ${user.id} updated Slack access rules for ${instanceId}: ${updatedTokens.accessRules.whitelistChannels.length} whitelist, ${updatedTokens.accessRules.blacklistChannels.length} blacklist, ${updatedTokens.accessRules.blacklistUsers.length} blocked users, ${updatedTokens.accessRules.allowedOrgs.length} orgs`);
      res.json({ success: true });
    } catch (err) {
      console.error('[access-rules] error:', err);
      res.status(500).json({ error: 'Failed to save access rules' });
    }
  });

  // GET /api/instances/:instanceId/users/search - Search workspace users for blacklist
  const userListCache = new Map<string, { members: any[]; expiresAt: number }>();

  app.get('/api/instances/:instanceId/users/search', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const instanceId = req.params.instanceId as string;
      const query = ((req.query.q as string) || '').toLowerCase().trim();
      if (!query) { res.json({ users: [] }); return; }

      const user = await resolveSessionUser((req as any).session);
      if (!user?.id) { res.status(401).json({ error: 'Not authenticated' }); return; }

      const connection = await getMcpConnectionByInstanceId(instanceId);
      if (!connection || connection.userId !== user.id || connection.provider !== 'slack') {
        res.status(404).json({ error: 'Slack connection not found' });
        return;
      }

      const accessToken = (connection.providerTokens as any)?.access_token;
      if (!accessToken) { res.status(400).json({ error: 'No Slack token found' }); return; }

      // Cache full user list per instance (5 min TTL)
      let allMembers: any[];
      const cached = userListCache.get(instanceId);
      if (cached && cached.expiresAt > Date.now()) {
        allMembers = cached.members;
      } else {
        const { SlackClient } = await import('../slack/apiHelpers.js');
        const client = new SlackClient(accessToken);
        allMembers = [];
        const seenIds = new Set<string>();

        // 1. Workspace members from users.list
        try {
          let cursor: string | undefined;
          do {
            const result = await client.usersList(cursor);
            for (const m of result.members) {
              if (m.deleted || m.is_bot) continue;
              seenIds.add(m.id);
              allMembers.push({
                id: m.id,
                name: m.name,
                real_name: m.real_name,
                team_id: m.team_id,
                avatar: m.profile?.image_48 || null,
                display_name: m.profile?.display_name || '',
              });
            }
            cursor = result.response_metadata?.next_cursor || undefined;
          } while (cursor);
        } catch (listErr) {
          console.error('[users/search] users.list failed:', (listErr as any)?.message);
        }

        // 2. External users from DM conversations (non-fatal — may lack im:read scope)
        try {
          let dmCursor: string | undefined;
          const externalUserIds: string[] = [];
          do {
            const dmResult = await client.conversationsList(dmCursor, 'im');
            for (const ch of dmResult.channels) {
              if (ch.user && !seenIds.has(ch.user)) {
                externalUserIds.push(ch.user);
                seenIds.add(ch.user);
              }
            }
            dmCursor = dmResult.response_metadata?.next_cursor || undefined;
          } while (dmCursor);

          // Resolve external user details
          await Promise.all(externalUserIds.slice(0, 50).map(async (uid) => {
            try {
              const { user: u } = await client.usersInfo(uid);
              if (u.is_bot || (u as any).is_app_user) return;
              allMembers.push({
                id: u.id,
                name: u.name,
                real_name: u.real_name,
                team_id: u.team_id || '',
                avatar: u.profile?.image_48 || null,
                display_name: u.profile?.display_name || '',
              });
            } catch { /* skip */ }
          }));
        } catch (dmErr) {
          console.error('[users/search] DM user discovery failed (may need im:read scope):', (dmErr as any)?.message);
        }

        // 3. Members from group DMs (mpim) — surfaces users you interact with in group chats
        try {
          let mpimCursor: string | undefined;
          const mpimMemberIds: string[] = [];
          do {
            const mpimResult = await client.conversationsList(mpimCursor, 'mpim');
            for (const ch of mpimResult.channels) {
              try {
                const { members } = await client.conversationsMembers(ch.id);
                for (const uid of members) {
                  if (!seenIds.has(uid)) {
                    mpimMemberIds.push(uid);
                    seenIds.add(uid);
                  }
                }
              } catch { /* skip */ }
            }
            mpimCursor = mpimResult.response_metadata?.next_cursor || undefined;
          } while (mpimCursor);

          await Promise.all(mpimMemberIds.slice(0, 50).map(async (uid) => {
            try {
              const { user: u } = await client.usersInfo(uid);
              if (u.is_bot || (u as any).is_app_user) return;
              allMembers.push({
                id: u.id,
                name: u.name,
                real_name: u.real_name,
                team_id: u.team_id || '',
                avatar: u.profile?.image_48 || null,
                display_name: u.profile?.display_name || '',
              });
            } catch { /* skip */ }
          }));
        } catch (mpimErr) {
          console.error('[users/search] Group DM member discovery failed:', (mpimErr as any)?.message);
        }

        userListCache.set(instanceId, { members: allMembers, expiresAt: Date.now() + 5 * 60 * 1000 });
      }

      // Filter by query
      const matches = allMembers
        .filter(m =>
          (m.name || '').toLowerCase().includes(query) ||
          (m.real_name || '').toLowerCase().includes(query) ||
          (m.display_name || '').toLowerCase().includes(query)
        )
        .slice(0, 20);

      res.json({ users: matches });
    } catch (err) {
      console.error('[users/search] error:', err);
      res.status(500).json({ error: 'Failed to search users' });
    }
  });

  // POST /api/disconnect/:mcpSlug - Disconnect an MCP
  app.post('/api/disconnect/:mcpSlug', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const mcpSlug = req.params.mcpSlug as string;

      // Get user from session
      const user = await resolveSessionUser(req.session);
      if (!user?.id) {
        res.clearCookie('session');
        res.status(401).json({ error: 'Session invalid' });
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
      const user = await resolveSessionUser(req.session);
      if (!user) {
        console.error('/api/me: session resolved to no account, clearing session');
        res.clearCookie('session');
        res.status(401).json({ error: 'Session invalid, please sign in again' });
        return;
      }

      // Get user's MCP connections
      const connections = user.id ? await getUserConnectedMcps(user.id) : [];

      // Auto-migrate old instance names that still contain " MCP"
      for (const c of connections) {
        if (c.instanceName && c.instanceName.includes(' MCP')) {
          const serviceName = c.instanceName.replace(' MCP', '').trim();
          const identifier = c.googleEmail || c.providerEmail;
          const newName = identifier ? `${serviceName} (${identifier})` : serviceName;
          if (newName !== c.instanceName) {
            await updateMcpInstanceName(c.instanceId, newName);
            c.instanceName = newName;
          }
        }
      }

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
          // Outline stores its real (possibly expiring) OAuth token in
          // providerTokens, not googleTokens — feed the right object so the
          // dashboard reflects OAuth expiry/refresh state.
          tokenStatus: computeTokenStatus(
            c.provider === 'outline'
              ? (c.providerTokens as { refresh_token?: string; expiry_date?: number } | undefined)
              : c.googleTokens,
            c.provider,
          ),
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
      const user = await resolveSessionUser(req.session);
      if (!user?.id) {
        res.clearCookie('session');
        res.status(401).json({ error: 'Session invalid' });
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

  /**
   * Does this connection's credential still work?
   *
   * The dashboard asks per row and offers Reconnect only on 'reauth'. It is a
   * separate call rather than a field on /api/me on purpose: this makes a live
   * request to the provider, and folding it into the page load would make the
   * whole dashboard wait on the slowest third party.
   *
   * Cached briefly so re-rendering, a second tab, or an F5 does not re-probe
   * every provider. The cache is dropped whenever credentials are replaced, so
   * a successful reconnect hides the button immediately instead of leaving it
   * up for the rest of the TTL — which is the whole complaint this answers.
   */
  app.get('/api/me/connections/:instanceId/health', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await resolveSessionUser(req.session);
      if (!user?.id) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const instanceId = String(req.params.instanceId);
      const connection = await getMcpConnectionByInstanceId(instanceId);
      if (!connection || connection.userId !== user.id) {
        res.status(404).json({ error: 'Instance not found' });
        return;
      }

      const cached = await readConnectionHealthCache(instanceId);
      if (cached) {
        res.json({ ...cached, cached: true });
        return;
      }

      const mcp = await getMcpCatalog(connection.mcpSlug);
      let clientId: string | null = mcp?.googleClientId || null;
      let clientSecret: string | null = mcp?.googleClientSecret || null;
      if ((connection.provider || 'google') === 'google' && (!clientId || !clientSecret)) {
        try {
          const global = await loadClientCredentials();
          clientId = clientId || global.client_id;
          clientSecret = clientSecret || global.client_secret;
        } catch {
          // Leave them null; the probe reports 'unknown' rather than guessing.
        }
      }

      const health = await checkConnectionHealth(connection, { clientId, clientSecret });
      await writeConnectionHealthCache(instanceId, health);
      res.json({ ...health, cached: false });
    } catch (err: any) {
      console.error('[connection-health] error:', err);
      // Never a 500 into the dashboard's per-row fetch: an error here must read
      // as "could not tell", not as a broken connection.
      res.json({ state: 'unknown', reason: 'Health check failed.' });
    }
  });

  // API endpoint to get user's MCP instances (new multi-instance API)
  app.get('/api/me/instances', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await resolveSessionUser(req.session);
      if (!user?.id) {
        res.clearCookie('session');
        res.status(401).json({ error: 'Session invalid' });
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

      const user = await resolveSessionUser(req.session);
      if (!user?.id) {
        res.clearCookie('session');
        res.status(401).json({ error: 'Session invalid' });
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

      const user = await resolveSessionUser(req.session);
      if (!user?.id) {
        res.clearCookie('session');
        res.status(401).json({ error: 'Session invalid' });
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
      const current = await resolveSessionUser(req.session);
      if (!current?.id) {
        res.clearCookie('session');
        res.status(401).json({ error: 'Session invalid' });
        return;
      }

      // Rotate by user id, not google_id: that column is NULL for
      // email+password accounts, so the googleId-keyed rotation matched zero
      // rows and reported "user not found" on a perfectly valid account.
      const user = await regenerateApiKeyByUserId(current.id);
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

    const user = await resolveSessionUser(req.session);
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (!ADMIN_EMAILS.includes(user.email.toLowerCase())) {
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

  // === Internal API (GitHub Actions → app server) ===

  function requireInternalApiKey(req: Request, res: Response, next: NextFunction) {
    const internalKey = process.env.INTERNAL_API_KEY;
    if (!internalKey) { res.status(503).json({ error: 'Internal API not configured' }); return; }
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${internalKey}`) {
      res.status(401).json({ error: 'Invalid internal API key' });
      return;
    }
    next();
  }

  // Send release notification emails to all users via an admin's Gmail connection
  // Pass { test: true } in the body to send only to test addresses instead of all users
  app.post('/api/internal/release-notify', requireInternalApiKey, async (req: Request, res: Response) => {
    const { subject, body, test } = req.body;
    if (!subject || !body) {
      res.status(400).json({ error: 'subject and body are required' });
      return;
    }
    try {
      // Find an admin user with a Gmail connection to send from
      const allUsers = await getAllUsers();
      const adminUser = allUsers.find(u => ADMIN_EMAILS.includes(u.email.toLowerCase()));
      if (!adminUser || !adminUser.id) {
        res.status(503).json({ error: 'No admin user found for sending emails' });
        return;
      }

      const adminConnections = await getUserConnectedMcps(adminUser.id);
      const gmailConnection = adminConnections.find(c => c.mcpSlug === 'google-gmail');
      if (!gmailConnection) {
        res.status(503).json({ error: 'Admin user has no Gmail connection' });
        return;
      }

      const { client_id, client_secret } = await loadClientCredentials();
      const session = createUserSessionFromConnection(adminUser as UserRecord, gmailConnection, client_id, client_secret);

      const TEST_EMAILS = ['evgen@boarlabs.xyz', 'eugeneovchinnikov2006@gmail.com'];

      // When test mode is enabled, send only to test addresses
      const recipients = test
        ? TEST_EMAILS
        : allUsers.map(u => u.email).filter(Boolean);

      if (recipients.length === 0) {
        res.json({ sent: 0, failed: 0, message: 'No recipients found' });
        return;
      }

      // Send in BCC batches of 50
      const BATCH_SIZE = 50;
      let sent = 0;
      let failed = 0;

      for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
        const batch = recipients.slice(i, i + BATCH_SIZE);
        try {
          const { createRawEmail } = await import('../google-gmail/apiHelpers.js');
          const raw = createRawEmail(adminUser.email, subject, body, {
            bcc: batch.join(', '),
            isHtml: true,
          });
          await session.googleGmail.users.messages.send({ userId: 'me', requestBody: { raw } });
          sent += batch.length;
        } catch (err: any) {
          console.error(`[release-notify] Failed to send batch ${i}:`, err.message);
          failed += batch.length;
        }
      }

      res.json({ sent, failed });
    } catch (err: any) {
      console.error('[release-notify] Error:', err);
      res.status(500).json({ error: 'Failed to send release notifications' });
    }
  });

  // === MCP Catalog API (public endpoints) ===

  // Sample prompts per integration, surfaced on the /integrations directory.
  // Kept here (not in the DB) so they can be edited without a migration.
  const SAMPLE_PROMPTS: Record<string, string[]> = {
    'google-docs': [
      'Summarize the doc at https://docs.google.com/document/d/…',
      'Append a "Next steps" section to my planning doc',
      'Find every "TODO" in this doc and turn them into a checklist',
    ],
    'google-sheets': [
      'Read the "Q3 forecast" sheet and chart revenue by region',
      'Append a new row with today\'s standup notes',
      'Clear the scratchpad range A1:D50',
    ],
    'google-calendar': [
      'What\'s on my calendar tomorrow?',
      'Schedule a 30-min sync with the team for Thursday afternoon',
      'Move my 4pm meeting to Friday',
    ],
    'google-gmail': [
      'Summarize unread mail from this week',
      'Draft a reply to the latest message from finance@',
      'Search for invoices from Stripe and label them "Receipts"',
    ],
    'google-slides': [
      'Add a title slide to the kickoff deck',
      'Replace "OLD_LOGO" with our new logo in every slide',
      'Read the speaker notes from slide 5',
    ],
    'google-drive': [
      'Find the latest version of the pricing memo',
      'Move all PDFs from /Inbox to /Archive',
      'Share this folder with alex@ as commenter',
    ],
    'clickup': [
      'Create a task in the "Backlog" list with today\'s sync notes',
      'What\'s assigned to me and due this week?',
      'Comment on CU-86c9mr5kd with the latest status',
    ],
    'slack': [
      'Summarize what I missed in #eng-platform today',
      'Send a release note to #announcements',
      'Find the thread where we agreed on the API shape',
    ],
    'slack-bot': [
      'Post the daily standup template to #standup',
      'List the last 20 messages from #incidents',
      'Pin the runbook link in #oncall',
    ],
    'outline': [
      'Find the onboarding doc in the Engineering collection',
      'Create a doc summarizing today\'s incident in the Runbooks collection',
      'Search the wiki for our deployment checklist',
    ],
    'peopleforce': [
      'Who\'s out on leave next week?',
      'List everyone in the Engineering department',
      'Show me the skills on Jane Doe\'s profile',
    ],
    'hubspot': [
      'Find the Acme Corp company and summarize its recent activity',
      'Update the lifecycle stage for contact jane@acme.com',
      'List open tickets modified this week',
    ],
  };

  // GET /api/v1/catalogs - List all active MCPs
  app.get('/api/v1/catalogs', async (_req, res) => {
    try {
      console.error('[/api/v1/catalogs] Fetching catalogs...');
      const catalogs = await listMcpCatalogs();
      console.error(`[/api/v1/catalogs] Found ${catalogs.length} catalogs`);
      res.json({
        catalogs: catalogs.map(c => {
          const provider = c.provider || 'google';
          return {
            slug: c.slug,
            name: c.name,
            description: c.description,
            iconUrl: c.iconUrl,
            mcpUrl: c.mcpUrl,
            provider,
            scopes: computeEffectiveScopes(provider, c.oauthScopes, c.scopes),
            // Non-empty only when this connector has an OAuth authorize endpoint
            // configured (e.g. Outline once OUTLINE_CLIENT_ID/SECRET/BASE_URL are
            // set). The dashboard uses it to offer the OAuth "Connect" flow
            // instead of the paste-token form for otherwise token-based providers.
            oauthAuthorizationUrl: c.oauthAuthorizationUrl || null,
            samplePrompts: SAMPLE_PROMPTS[c.slug] || [],
          };
        }),
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

  registerRestApiRoutes(app);

  return app;
}

function registerRestApiRoutes(app: express.Express): void {
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

    // Try short-lived REST token (5-min, minted by mintRestBearerForCurl MCP tool)
    try {
      const restUserId = await lookupRestToken(token);
      if (restUserId !== null) {
        await loadUsers();
        const restUser = await getUserById(restUserId);
        if (restUser) return restUser;
      }
    } catch { /* fall through */ }

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
          } else if (connection.provider === 'outline') {
            // Outline uses its own session with outlineAccessToken
            const { createOutlineSession } = await import('../userSession.js');
            req.userSession = createOutlineSession(user, connection);
          } else if (connection.provider === 'peopleforce') {
            // PeopleForce uses its own session with peopleForceAccessToken.
            // Without this branch the connection falls through to the Google
            // OAuth path below and yields a session with no provider token —
            // auth would pass and the handler would throw at call time.
            const { createPeopleForceSession } = await import('../userSession.js');
            req.userSession = createPeopleForceSession(user, connection);
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
  const requireSlackApiKey = createServiceAuth('slack-bot', 'slack');
  const requirePeopleForceApiKey = createServiceAuth('peopleforce', 'peopleforce');

  // JSON body parser already added above for auth routes

  // Serve OpenAPI specs.
  // `openapi.json` is the combined REST data-plane spec (built by
  // scripts/buildRootOpenapi.mjs). `openapi-docs.json` and the per-service
  // siblings remain available for ChatGPT Custom Actions backward compat.
  for (const spec of ['openapi', 'openapi-docs', 'openapi-calendar', 'openapi-sheets', 'openapi-drive', 'openapi-gmail', 'openapi-slides', 'openapi-clickup']) {
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

  // GET /api/v1/docs/recent - Recent Google Docs (most-recently-modified).
  // Registered BEFORE /api/v1/docs/:documentId so Express picks this static
  // path first instead of treating "recent" as a documentId.
  app.get('/api/v1/docs/recent', requireApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const drive = req.userSession!.googleDrive;
      const maxResults = qint(req.query.maxResults, 20, { max: 200 });
      const response = await drive.files.list({
        q: "mimeType='application/vnd.google-apps.document' and trashed=false",
        pageSize: maxResults,
        orderBy: 'modifiedTime desc',
        fields: 'files(id,name,modifiedTime,createdTime,webViewLink,owners(displayName,emailAddress))',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      res.json({ files: response.data.files || [] });
    } catch (err) {
      sendUpstreamError(res, err, { fallback: 'Failed to list recent docs' });
    }
  });

  // GET /api/v1/docs/:documentId - Read a Google Doc with content negotiation.
  // Accept: application/json (default) or ?format=json → raw upstream Docs API JSON.
  // Accept: text/plain or ?format=text → extracted plain text body.
  // Optional query: ?tabId=, ?maxLength=.
  // Sibling of the legacy POST /api/v1/docs/read (which stays unchanged for
  // ChatGPT Custom Actions backward compat).
  // Doc-content fields used when only the body text is requested. Avoids
  // pulling all the formatting metadata when the caller asked for text.
  const DOC_TEXT_FIELDS =
    'body(content(paragraph(elements(textRun(content))),table(tableRows(tableCells(content(paragraph(elements(textRun(content))))))))),title';

  app.get('/api/v1/docs/:documentId', requireApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const documentId = req.params.documentId as string;
      const tabId = qstr(req.query.tabId) || undefined;
      const maxLength = Math.max(qint(req.query.maxLength, 0), 0);
      const wantText = negotiateFormat(req) === 'text';

      const docs = req.userSession!.googleDocs;
      const docResponse = await docs.documents.get({
        documentId,
        includeTabsContent: !!tabId,
        fields: wantText && !tabId ? DOC_TEXT_FIELDS : '*',
      });

      const selection = tabId
        ? selectTabContent(docResponse.data as any, tabId)
        : { kind: 'ok' as const, content: docResponse.data };
      if (selection.kind === 'notFound') {
        res.status(404).json({ error: selection.message });
        return;
      }
      if (selection.kind === 'badRequest') {
        res.status(400).json({ error: selection.message });
        return;
      }

      if (wantText) {
        let text = extractDocBodyText(selection.content as any);
        if (maxLength > 0 && text.length > maxLength) text = text.substring(0, maxLength);
        res.type('text/plain; charset=utf-8').send(text);
        return;
      }

      const result = truncateJsonByLength(selection.content, maxLength);
      if (result.truncated) {
        res.json({
          truncated: true,
          originalLength: result.originalLength,
          truncatedJson: result.truncatedJson,
        });
        return;
      }
      res.json(result.payload);
    } catch (err) {
      console.error('Error reading doc:', err);
      sendUpstreamError(res, err, { notFound: 'Document not found', fallback: 'Failed to read document' });
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

  // GET /api/v1/docs/:documentId/comments/:commentId - Get one comment + replies
  // Same field mask and response shape as the list sibling above, so a caller
  // can jq a single comment without special-casing the payload.
  app.get('/api/v1/docs/:documentId/comments/:commentId', requireApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const documentId = req.params.documentId as string;
      const drive = google.drive({ version: 'v3', auth: req.userSession!.oauthClient });

      const response = await drive.comments.get({
        fileId: documentId,
        commentId: req.params.commentId as string,
        fields: 'id,content,quotedFileContent,author,createdTime,resolved,replies(id,content,author,createdTime)',
      });

      const comment = response.data as any;
      res.json({
        documentId,
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
      });
    } catch (err) {
      console.error('Error getting comment:', err);
      sendUpstreamError(res, err, { notFound: 'Comment not found', fallback: 'Failed to get comment' });
    }
  });

  // GET /api/v1/docs/:documentId/structure - Structure summary of a Google Doc.
  // Optional query: ?detailed=true (element-by-element listing), ?tabId=.
  // Reuses GDocsHelpers.parseDocStructure so this matches the inspectDocStructure
  // MCP tool exactly rather than reimplementing the traversal.
  app.get('/api/v1/docs/:documentId/structure', requireApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const documentId = req.params.documentId as string;
      const detailed = req.query.detailed === 'true';
      const tabId = qstr(req.query.tabId) || undefined;

      const docs = req.userSession!.googleDocs;
      const docResponse = await docs.documents.get({ documentId, includeTabsContent: true });
      if (!docResponse.data) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      const { parseDocStructure } = await import('../google-docs/apiHelpers.js');
      res.json(parseDocStructure(docResponse.data, detailed, tabId));
    } catch (err) {
      console.error('Error inspecting doc structure:', err);
      sendUpstreamError(res, err, { notFound: 'Document not found', fallback: 'Failed to inspect document structure' });
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
      const { summary, description, location, startDateTime, endDateTime, timeZone, attendees, addGoogleMeet = false, sendUpdates = 'none' } = req.body;

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

      if (addGoogleMeet) {
        eventResource.conferenceData = buildMeetConferenceData();
      }

      const response = await calendar.events.insert({
        calendarId,
        requestBody: eventResource,
        sendUpdates,
        conferenceDataVersion: addGoogleMeet ? 1 : undefined,
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
        hangoutLink: event.hangoutLink || null,
        conferenceData: event.conferenceData || null,
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
      const { summary, description, location, startDateTime, endDateTime, timeZone, addGoogleMeet = false, sendUpdates = 'none' } = req.body;
      const calendar = req.userSession!.googleCalendar;

      // Fetch existing event to merge fields
      const existingResponse: any = await calendar.events.get({
        calendarId: calendarId as string,
        eventId: eventId as string,
      });
      const existingEvent = existingResponse.data;

      const wantsNewMeet = addGoogleMeet && !hasExistingConference(existingEvent);
      const eventResource: any = {
        summary: summary ?? existingEvent.summary,
        description: description ?? existingEvent.description,
        location: location ?? existingEvent.location,
        start: startDateTime ? { dateTime: startDateTime, timeZone } : existingEvent.start,
        end: endDateTime ? { dateTime: endDateTime, timeZone } : existingEvent.end,
        attendees: existingEvent.attendees,
        conferenceData: wantsNewMeet ? buildMeetConferenceData() : existingEvent.conferenceData,
      };

      const response: any = await calendar.events.update({
        calendarId: calendarId as string,
        eventId: eventId as string,
        requestBody: eventResource,
        sendUpdates: sendUpdates as 'all' | 'externalOnly' | 'none',
        conferenceDataVersion: wantsNewMeet ? 1 : undefined,
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
        hangoutLink: event.hangoutLink || null,
        conferenceData: event.conferenceData || null,
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
      // Shared with the listGoogleSheets MCP tool — see
      // src/google-sheets/listHandlers.ts. Do not inline a Drive query here.
      const files = await listSpreadsheetFiles(drive, {
        query: (req.query.query as string) || undefined,
        maxResults: parseInt(req.query.maxResults as string) || 20,
        orderBy: (req.query.orderBy as SpreadsheetOrderBy) || undefined,
        searchContent: req.query.searchContent === 'true',
        corpora: (req.query.corpora as any) || undefined,
        driveId: (req.query.driveId as string) || undefined,
      });
      res.json({ spreadsheets: files });
    } catch (err: any) {
      // 502, never Google's own status. On this endpoint 401/403 mean the
      // caller's REST bearer was rejected by requireSheetsApiKey; reusing them
      // for an upstream Google failure would tell a client to re-mint its
      // bearer when the real fix is re-authorizing the Google connection.
      // 502 says "your request was fine, the upstream wasn't" — and the
      // message carries Google's actual reason.
      res.status(502).json({
        error: describeDriveError(err, 'list spreadsheets', LIST_SPREADSHEETS_SCOPE),
      });
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
  // JSON by default (raw Gmail API payload). Accept: text/plain returns the
  // same markdown rendering the readEmail MCP tool emits. The `?format=`
  // query selects the upstream Gmail detail level (full | metadata | minimal
  // | raw); any non-Gmail value (e.g. a REST-negotiation `json`/`text`)
  // falls back to `full`. For text rendering we always force `full` so the
  // body is available.
  app.get('/api/v1/gmail/messages/:messageId', requireGmailApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const gmail = req.userSession!.googleGmail;
      const wantText = negotiateFormat(req) === 'text';
      type GmailDetail = 'full' | 'metadata' | 'minimal' | 'raw';
      const isGmailDetail = (v: string): v is GmailDetail =>
        v === 'full' || v === 'metadata' || v === 'minimal' || v === 'raw';
      const rawFormat = (req.query.format ?? '').toString();
      const gmailFormat: GmailDetail = wantText || !isGmailDetail(rawFormat) ? 'full' : rawFormat;
      const result = await gmail.users.messages.get({
        userId: 'me', id: req.params.messageId as string, format: gmailFormat,
      });
      if (wantText) {
        const { renderEmail } = await import('../google-gmail/apiHelpers.js');
        res.type('text/plain; charset=utf-8').send(renderEmail(result.data));
        return;
      }
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
  // JSON by default; Accept: text/plain (or ?format=text) returns the same
  // markdown rendering the listTasks MCP tool emits.
  app.get('/api/v1/clickup/lists/:listId/tasks', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const {
        ClickUpClient,
        collectTasksInCloseWindow,
        formatCloseWindowCapMessage,
        parseCloseWindow,
      } = await import('../clickup/apiHelpers.js');
      const { formatTaskList } = await import('../clickup/formatHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const params: any = {};
      if (req.query.page) params.page = parseInt(req.query.page as string);
      if (req.query.orderBy) params.order_by = req.query.orderBy;
      if (req.query.statuses) params.statuses = Array.isArray(req.query.statuses) ? req.query.statuses : [req.query.statuses];

      const win = parseCloseWindow(req.query.closedAfter as string | undefined, req.query.closedBefore as string | undefined);
      if (win.error) { res.status(400).json({ error: win.error }); return; }

      let tasks: any[];
      if (win.from !== undefined || win.to !== undefined) {
        const listId = req.params.listId as string;
        const winParams = { ...params, include_closed: true };
        delete winParams.page;
        const collected = await collectTasksInCloseWindow(
          async (page) => (await client.getTasks(listId, { ...winParams, page })).tasks || [],
          win.from,
          win.to,
        );
        if (collected.hitCap) { res.status(400).json({ error: formatCloseWindowCapMessage(collected.pagesScanned) }); return; }
        tasks = collected.tasks;
      } else {
        const result = await client.getTasks(req.params.listId as string, params);
        tasks = result.tasks || [];
      }

      if (negotiateFormat(req) === 'text') {
        res.type('text/plain; charset=utf-8').send(formatTaskList(tasks));
        return;
      }
      res.json({ tasks });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list tasks' });
    }
  });

  // GET /api/v1/clickup/tasks/:taskId - Get task
  // JSON by default; Accept: text/plain returns the markdown rendering.
  app.get('/api/v1/clickup/tasks/:taskId', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const { formatTask } = await import('../clickup/formatHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.getTask(req.params.taskId as string);
      if (negotiateFormat(req) === 'text') {
        res.type('text/plain; charset=utf-8').send(formatTask(result));
        return;
      }
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
      const {
        ClickUpClient,
        collectTasksInCloseWindow,
        formatCloseWindowCapMessage,
        parseCloseWindow,
      } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);

      const win = parseCloseWindow(req.query.closedAfter as string | undefined, req.query.closedBefore as string | undefined);
      if (win.error) { res.status(400).json({ error: win.error }); return; }

      if (win.from !== undefined || win.to !== undefined) {
        const workspaceId = req.params.workspaceId as string;
        // Bypass client.searchTasks's client-side name filter during pagination so
        // the loop's "page < 100 → stop" heuristic sees raw ClickUp page sizes.
        const collected = await collectTasksInCloseWindow(
          async (p) => (await client.searchTasks(workspaceId, '', p, customFields, true)).tasks || [],
          win.from,
          win.to,
        );
        if (collected.hitCap) { res.status(400).json({ error: formatCloseWindowCapMessage(collected.pagesScanned) }); return; }
        const q = query.toLowerCase();
        const filtered = query ? collected.tasks.filter((t: any) => t.name?.toLowerCase().includes(q)) : collected.tasks;
        res.json({ tasks: filtered });
        return;
      }

      const result = await client.searchTasks(req.params.workspaceId as string, query, page, customFields);
      res.json({ tasks: result.tasks || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to search tasks' });
    }
  });

  // GET /api/v1/clickup/workspaces/:workspaceId/tasks/filter - Filtered team tasks
  // Thin wrapper over ClickUp's server-side filter endpoint. Query params mirror
  // the filterTeamTasks MCP tool 1:1, with camelCase names matching the tool's
  // Zod schema. Date params accept ISO or Unix ms strings and are normalized via
  // parseTimestampInput. Repeat a query param (assignees=a&assignees=b) to pass
  // an array. custom_fields is a JSON-encoded string.
  app.get('/api/v1/clickup/workspaces/:workspaceId/tasks/filter', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient, parseTimestampInput } = await import('../clickup/apiHelpers.js');
      const { formatTaskList } = await import('../clickup/formatHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);

      const toArr = (v: any): string[] | undefined => {
        if (v === undefined) return undefined;
        return Array.isArray(v) ? (v as string[]) : [v as string];
      };
      const parseTs = (v: any, field: string): number | undefined => {
        if (v === undefined) return undefined;
        const ts = parseTimestampInput(v as string);
        if (Number.isNaN(ts)) throw new Error(`Invalid ${field}: ${v}`);
        return ts;
      };

      let params: any;
      try {
        params = {
          page: req.query.page !== undefined ? parseInt(req.query.page as string) : undefined,
          order_by: req.query.orderBy as string | undefined,
          reverse: req.query.reverse === 'true',
          subtasks: req.query.subtasks === 'true',
          include_closed: req.query.includeClosed === 'true',
          assignees: toArr(req.query.assignees),
          statuses: toArr(req.query.statuses),
          tags: toArr(req.query.tags),
          space_ids: toArr(req.query.spaceIds),
          project_ids: toArr(req.query.projectIds),
          list_ids: toArr(req.query.listIds),
          date_created_gt: parseTs(req.query.dateCreatedGt, 'dateCreatedGt'),
          date_created_lt: parseTs(req.query.dateCreatedLt, 'dateCreatedLt'),
          date_updated_gt: parseTs(req.query.dateUpdatedGt, 'dateUpdatedGt'),
          date_updated_lt: parseTs(req.query.dateUpdatedLt, 'dateUpdatedLt'),
          due_date_gt: parseTs(req.query.dueDateGt, 'dueDateGt'),
          due_date_lt: parseTs(req.query.dueDateLt, 'dueDateLt'),
          custom_fields: req.query.custom_fields ? JSON.parse(req.query.custom_fields as string) : undefined,
        };
      } catch (e: any) {
        res.status(400).json({ error: e.message });
        return;
      }

      const result = await client.filterTeamTasks(req.params.workspaceId as string, params);
      const tasks = result.tasks || [];
      if (negotiateFormat(req) === 'text') {
        res.type('text/plain; charset=utf-8').send(formatTaskList(tasks));
        return;
      }
      res.json({ tasks });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to filter tasks' });
    }
  });

  // GET /api/v1/clickup/workspaces/:workspaceId/events - Task-event history from the store
  // Mirrors the getTaskEventHistory MCP tool 1:1. Query params: since/until
  // (ISO or Unix ms), eventTypes (repeatable), toStatus, taskId, limit.
  // If no subscription exists for (user, workspace), returns 200 with
  // { kind: 'no-subscription', warning, events: [] } — not 404 — so the
  // caller can fall back to filterTeamTasks without inspecting a status code.
  app.get('/api/v1/clickup/workspaces/:workspaceId/events', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const userId = req.userSession?.userId;
      if (!userId) { res.status(401).json({ error: 'Missing user context' }); return; }

      const { parseTimestampInput } = await import('../clickup/apiHelpers.js');
      const { queryTaskEventsFlow } = await import('../clickup/webhookHelpers.js');
      const store = await import('../clickup/taskEventStore.js');

      const toArr = (v: any): string[] | undefined => {
        if (v === undefined) return undefined;
        return Array.isArray(v) ? (v as string[]) : [v as string];
      };
      const parseTs = (v: any, field: string): number | undefined => {
        if (v === undefined) return undefined;
        const ts = parseTimestampInput(v as string);
        if (Number.isNaN(ts)) throw new Error(`Invalid ${field}: ${v}`);
        return ts;
      };

      let since: number | undefined, until: number | undefined;
      try {
        since = parseTs(req.query.since, 'since');
        until = parseTs(req.query.until, 'until');
      } catch (e: any) {
        res.status(400).json({ error: e.message });
        return;
      }

      const result = await queryTaskEventsFlow(
        { findSubscription: store.findSubscription, queryTaskEvents: store.queryTaskEvents },
        {
          userId,
          workspaceId: req.params.workspaceId as string,
          since, until,
          eventTypes: toArr(req.query.eventTypes),
          toStatus: req.query.toStatus as string | undefined,
          taskId: req.query.taskId as string | undefined,
          limit: req.query.limit !== undefined ? parseInt(req.query.limit as string) : undefined,
        },
      );
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to query task events' });
    }
  });

  // GET /api/v1/clickup/subscriptions - List task-event subscriptions owned by
  // the caller. Optional ?workspaceId to narrow.
  app.get('/api/v1/clickup/subscriptions', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const userId = req.userSession?.userId;
      if (!userId) { res.status(401).json({ error: 'Missing user context' }); return; }
      const { listSubscriptionsForUser } = await import('../clickup/taskEventStore.js');
      const subs = await listSubscriptionsForUser(userId, req.query.workspaceId as string | undefined);
      // Redact shared_secret before returning — it's for HMAC verification
      // server-side only and must never leave the process.
      const safe = subs.map(({ sharedSecret: _s, ...rest }) => rest);
      res.json({ subscriptions: safe });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list subscriptions' });
    }
  });

  // GET /api/v1/clickup/workspaces/:workspaceId/subscription/debug -
  // Structured diagnostic report cross-referencing local subscription vs
  // ClickUp's own view vs the event store. Mirrors debugTaskEventSubscription
  // MCP tool 1:1. Returns 200 with the report even when things are broken —
  // this is a diagnostic tool, not a health check.
  app.get('/api/v1/clickup/workspaces/:workspaceId/subscription/debug', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const userId = req.userSession?.userId;
      if (!userId) { res.status(401).json({ error: 'Missing user context' }); return; }
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const { debugTaskEventSubscriptionFlow } = await import('../clickup/webhookHelpers.js');
      const store = await import('../clickup/taskEventStore.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);

      const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '');
      const expectedEndpoint = baseUrl ? `${baseUrl}/webhooks/clickup/inbound` : '';

      const report = await debugTaskEventSubscriptionFlow(
        {
          findSubscription: store.findSubscription,
          listWebhooks: (workspaceId) => client.listWebhooks(workspaceId),
          countTaskEventsForSubscription: store.countTaskEventsForSubscription,
          queryTaskEvents: store.queryTaskEvents,
        },
        { userId, workspaceId: req.params.workspaceId as string, expectedEndpoint },
      );
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to build debug report' });
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

  // GET /api/v1/clickup/workspaces/:workspaceId/docs - List one page of docs
  app.get('/api/v1/clickup/workspaces/:workspaceId/docs', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient, docsFromEnvelope, cursorFromEnvelope } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.listDocs(req.params.workspaceId as string, {
        limit: qint(req.query.limit, 100, { min: 10, max: 100 }),
        cursor: qstr(req.query.cursor) || undefined,
      });
      res.json({ docs: docsFromEnvelope(result), nextCursor: cursorFromEnvelope(result) || null });
    } catch (err) {
      sendUpstreamError(res, err, { fallback: 'Failed to list docs' });
    }
  });

  // GET /api/v1/clickup/workspaces/:workspaceId/docs/search - Search docs by
  // name across the whole workspace. Matching, paging and sorting all live in
  // ClickUpClient.searchAllDocs so this stays identical to the MCP tool — the
  // two used to carry separate copies of a one-page substring filter.
  app.get('/api/v1/clickup/workspaces/:workspaceId/docs/search', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const creatorRaw = qstr(req.query.creator);
      const scan = await client.searchAllDocs(req.params.workspaceId as string, {
        query: qstr(req.query.query) || undefined,
        creator: creatorRaw ? Number(creatorRaw) : undefined,
        parentId: qstr(req.query.parentId) || undefined,
        parentType: qstr(req.query.parentType) || undefined,
      });
      // totalScanned/hitCap/rateLimited ride along so a caller can tell an
      // empty result apart from an incomplete scan.
      res.json(scan);
    } catch (err) {
      sendUpstreamError(res, err, { fallback: 'Failed to search docs' });
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

  // POST /api/v1/images - Re-host an image and get a public URL to embed in a
  // ClickUp Doc (the REST/API-key sibling of the uploadClickUpDocImage MCP tool).
  // Two body shapes, both converging on the shared image store():
  //   - raw binary bytes (Content-Type: image/png, image/jpeg, image/gif,
  //     image/bmp, image/webp) — the bytes are stored directly; OR
  //   - JSON { "imageUrl": "https://..." } — the URL is fetched and re-hosted.
  // express.raw parses everything EXCEPT application/json (which the global JSON
  // parser already handled), so a raw upload isn't blocked by the 100kb JSON cap.
  app.post(
    '/api/v1/images',
    requireClickUpApiKey,
    express.raw({ type: (req) => !(req.headers['content-type'] || '').includes('application/json'), limit: '20mb' }),
    async (req: ApiAuthenticatedRequest, res) => {
      try {
        const { store, STORED_CONTENT_TYPE, getImagePublicBaseUrl } = await import('../images/imageBlobStore.js');
        getImagePublicBaseUrl(); // fail fast if the image host isn't configured

        let result;
        const body = req.body;
        const imageUrl = (body && typeof body === 'object' && !Buffer.isBuffer(body)) ? body.imageUrl : undefined;
        if (Buffer.isBuffer(body) && body.length > 0) {
          result = await store(body, String(req.headers['content-type'] || ''));
        } else if (typeof imageUrl === 'string' && imageUrl.length > 0) {
          const { fetchImageBytes } = await import('../clickup/docImageStore.js');
          result = await store(await fetchImageBytes(imageUrl), '');
        } else {
          res.status(400).json({ error: 'Provide the image as a raw binary body (Content-Type: image/png, image/jpeg, image/gif, image/bmp, or image/webp) or JSON { "imageUrl": "https://..." }.' });
          return;
        }
        res.status(201).json({ ...result, contentType: STORED_CONTENT_TYPE });
      } catch (err: any) {
        if (err?.httpStatus === 415) { res.status(415).json({ error: err.message }); return; }
        if (err?.httpStatus === 413) { res.status(413).json({ error: err.message }); return; }
        // fetchImageBytes throws UserError for bad/blocked/oversized URLs → 400.
        if (err?.name === 'UserError') { res.status(400).json({ error: err.message }); return; }
        console.error(`[api-images] ${err?.message || err}`);
        res.status(500).json({ error: err?.message || 'Failed to store image' });
      }
    },
  );

  // === REST Data Plane: extended GET endpoints ===
  // These are passthrough siblings of read-only MCP tools that return bulk
  // data. Catalogued in src/restCatalog.ts and discoverable via the
  // listRestEndpoints MCP tool. Bearer is either the permanent apiKey or a
  // 5-minute token from the mintRestBearerForCurl MCP tool.

  // sendUpstreamError lives in ./restUpstreamError.js so it's unit-testable
  // in isolation and so each route's catch can stay a one-liner.

  // GET /api/v1/docs - List Google Docs (?q= triggers search)
  app.get('/api/v1/docs', requireApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const drive = req.userSession!.googleDrive;
      const q = qstr(req.query.q);
      const maxResults = qint(req.query.maxResults, 50, { max: 1000 });
      const orderBy = qstr(req.query.orderBy, 'modifiedTime');
      let queryString = "mimeType='application/vnd.google-apps.document' and trashed=false";
      if (q) {
        // Escape backslashes then single quotes so the value is safe to drop
        // into a Drive query string literal. Use string-arg replaceAll to
        // avoid the regex-escape gymnastics.
        const escaped = q.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
        queryString += ` and (name contains '${escaped}' or fullText contains '${escaped}')`;
      }
      const response = await drive.files.list({
        q: queryString,
        pageSize: maxResults,
        orderBy: orderBy === 'name' ? 'name' : orderBy,
        fields: 'nextPageToken,files(id,name,modifiedTime,createdTime,size,webViewLink,owners(displayName,emailAddress),driveId)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      res.json({ files: response.data.files || [], nextPageToken: response.data.nextPageToken });
    } catch (err) {
      sendUpstreamError(res, err, { fallback: 'Failed to list docs' });
    }
  });

  // GET /api/v1/docs/:documentId/tabs - List tabs in a Google Doc
  app.get('/api/v1/docs/:documentId/tabs', requireApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const docs = req.userSession!.googleDocs;
      const includeContent = req.query.includeContent === 'true';
      const docResponse = await docs.documents.get({
        documentId: req.params.documentId as string,
        includeTabsContent: true,
        fields: includeContent ? 'title,tabs' : 'title,tabs(tabProperties,childTabs)',
      });
      // Flatten the tab tree.
      const flatten = (tabs: any[] = [], level = 0, out: any[] = []): any[] => {
        for (const tab of tabs) {
          out.push({
            tabId: tab.tabProperties?.tabId,
            title: tab.tabProperties?.title || null,
            index: tab.tabProperties?.index ?? null,
            level,
          });
          if (tab.childTabs?.length) flatten(tab.childTabs, level + 1, out);
        }
        return out;
      };
      const allTabs = flatten(docResponse.data.tabs as any[] || []);
      res.json({
        documentId: req.params.documentId,
        title: docResponse.data.title || null,
        tabCount: allTabs.length,
        tabs: allTabs,
      });
    } catch (err) {
      sendUpstreamError(res, err, { notFound: 'Document not found', fallback: 'Failed to list tabs' });
    }
  });

  // GET /api/v1/drive/shared-drives - List shared drives
  app.get('/api/v1/drive/shared-drives', requireDriveApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const drive = req.userSession!.googleDrive;
      const maxResults = qint(req.query.maxResults, 50, { max: 100 });
      const q = qstr(req.query.q);
      const response = await drive.drives.list({
        pageSize: maxResults,
        q: q ? `name contains '${q.replace(/'/g, "\\'")}'` : undefined,
        fields: 'nextPageToken,drives(id,name,createdTime,capabilities)',
      });
      res.json({ drives: response.data.drives || [], nextPageToken: response.data.nextPageToken });
    } catch (err) {
      sendUpstreamError(res, err, { fallback: 'Failed to list shared drives' });
    }
  });

  // GET /api/v1/drive/folders/:folderId - Get folder metadata
  app.get('/api/v1/drive/folders/:folderId', requireDriveApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const drive = req.userSession!.googleDrive;
      const response = await drive.files.get({
        fileId: req.params.folderId as string,
        supportsAllDrives: true,
        fields: 'id,name,description,createdTime,modifiedTime,webViewLink,owners(displayName,emailAddress),lastModifyingUser(displayName),shared,parents,driveId,mimeType',
      });
      if (response.data.mimeType !== 'application/vnd.google-apps.folder') {
        res.status(400).json({ error: 'The specified ID does not belong to a folder.' });
        return;
      }
      res.json(response.data);
    } catch (err) {
      sendUpstreamError(res, err, { notFound: 'Folder not found', fallback: 'Failed to get folder info' });
    }
  });

  // GET /api/v1/drive/files/:fileId/permissions - List permissions on a file
  app.get('/api/v1/drive/files/:fileId/permissions', requireDriveApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const drive = req.userSession!.googleDrive;
      const response = await drive.permissions.list({
        fileId: req.params.fileId as string,
        supportsAllDrives: true,
        fields: 'permissions(id,type,role,emailAddress,displayName,domain,allowFileDiscovery,deleted)',
      });
      res.json({ fileId: req.params.fileId, permissions: response.data.permissions || [] });
    } catch (err) {
      sendUpstreamError(res, err, { notFound: 'File not found', fallback: 'Failed to list permissions' });
    }
  });

  // GET /api/v1/drive/files/:fileId/public - Check public accessibility
  app.get('/api/v1/drive/files/:fileId/public', requireDriveApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const drive = req.userSession!.googleDrive;
      const [meta, perms] = await Promise.all([
        drive.files.get({
          fileId: req.params.fileId as string,
          supportsAllDrives: true,
          fields: 'id,name,shared,webViewLink',
        }),
        drive.permissions.list({
          fileId: req.params.fileId as string,
          supportsAllDrives: true,
          fields: 'permissions(type,role,domain,allowFileDiscovery)',
        }),
      ]);
      const list = perms.data.permissions || [];
      const anyone = list.find(p => p.type === 'anyone');
      const domain = list.find(p => p.type === 'domain');
      res.json({
        fileId: meta.data.id,
        name: meta.data.name,
        shared: !!meta.data.shared,
        webViewLink: meta.data.webViewLink,
        publiclyAccessible: !!anyone,
        anyoneAccess: anyone ? { role: anyone.role, discoverable: !!anyone.allowFileDiscovery } : null,
        domainAccess: domain ? { domain: domain.domain, role: domain.role } : null,
      });
    } catch (err) {
      sendUpstreamError(res, err, { notFound: 'File not found', fallback: 'Failed to check public access' });
    }
  });

  // GET /api/v1/gmail/labels - List Gmail labels
  app.get('/api/v1/gmail/labels', requireGmailApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const gmail = req.userSession!.googleGmail;
      const response = await gmail.users.labels.list({ userId: 'me' });
      res.json({ labels: response.data.labels || [] });
    } catch (err) {
      sendUpstreamError(res, err, { fallback: 'Failed to list labels' });
    }
  });

  // GET /api/v1/slides/:presentationId/pages/:pageObjectId/thumbnail - Slide thumbnail URL
  app.get('/api/v1/slides/:presentationId/pages/:pageObjectId/thumbnail', requireSlidesApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const slides = req.userSession!.googleSlides;
      const thumbnailSize = qstr(req.query.size, 'MEDIUM').toUpperCase();
      const response = await slides.presentations.pages.getThumbnail({
        presentationId: req.params.presentationId as string,
        pageObjectId: req.params.pageObjectId as string,
        'thumbnailProperties.mimeType': 'PNG',
        'thumbnailProperties.thumbnailSize': thumbnailSize,
      });
      res.json({
        presentationId: req.params.presentationId,
        pageObjectId: req.params.pageObjectId,
        contentUrl: response.data.contentUrl,
        width: response.data.width,
        height: response.data.height,
      });
    } catch (err) {
      sendUpstreamError(res, err, { notFound: 'Page or presentation not found', fallback: 'Failed to get thumbnail' });
    }
  });

  // GET /api/v1/slides/:presentationId/comments - List comments on a presentation
  app.get('/api/v1/slides/:presentationId/comments', requireSlidesApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const drive = req.userSession!.googleDrive;
      const response = await drive.comments.list({
        fileId: req.params.presentationId as string,
        fields: 'comments(id,content,quotedFileContent,author,createdTime,resolved,replies(id,content,author,createdTime))',
        pageSize: 100,
      });
      res.json({
        presentationId: req.params.presentationId,
        comments: response.data.comments || [],
      });
    } catch (err) {
      sendUpstreamError(res, err, { notFound: 'Presentation not found', fallback: 'Failed to list comments' });
    }
  });

  // GET /api/v1/sheets/:spreadsheetId/ranges - Read a range (GET sibling of POST .../read)
  app.get('/api/v1/sheets/:spreadsheetId/ranges', requireSheetsApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const range = qstr(req.query.range);
      if (!range) {
        res.status(400).json({ error: 'Query param `range` is required (e.g. range=Sheet1!A1:D10)' });
        return;
      }
      const sheets = req.userSession!.googleSheets;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: req.params.spreadsheetId as string,
        range,
      });
      const values = response.data.values || [];
      if (negotiateFormat(req) === 'text') {
        if (values.length === 0) {
          res.type('text/plain; charset=utf-8').send(`Range ${range} is empty or does not exist.`);
          return;
        }
        let body = `**Spreadsheet Range:** ${range}\n\n`;
        values.forEach((row: any[], index: number) => {
          body += `Row ${index + 1}: ${JSON.stringify(row)}\n`;
        });
        res.type('text/plain; charset=utf-8').send(body);
        return;
      }
      res.json({
        spreadsheetId: req.params.spreadsheetId,
        range: response.data.range,
        majorDimension: response.data.majorDimension,
        values,
      });
    } catch (err) {
      sendUpstreamError(res, err, { notFound: 'Spreadsheet not found', fallback: 'Failed to read range' });
    }
  });

  // GET /api/v1/sheets/:spreadsheetId/rows/:rowNumber - Read a single row
  app.get('/api/v1/sheets/:spreadsheetId/rows/:rowNumber', requireSheetsApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const rowNumber = Number.parseInt(req.params.rowNumber as string, 10);
      if (!Number.isInteger(rowNumber) || rowNumber < 1) {
        res.status(400).json({ error: 'rowNumber must be a positive 1-based integer' });
        return;
      }
      const sheetName = qstr(req.query.sheet);
      const sheets = req.userSession!.googleSheets;
      const range = sheetName ? `${sheetName}!${rowNumber}:${rowNumber}` : `${rowNumber}:${rowNumber}`;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: req.params.spreadsheetId as string,
        range,
      });
      const values = response.data.values?.[0] || [];
      // If ?withHeaders=true, also fetch row 1 and pair them.
      let asObject: Record<string, any> | undefined;
      if (req.query.withHeaders === 'true') {
        const headersRange = sheetName ? `${sheetName}!1:1` : '1:1';
        const headersResp = await sheets.spreadsheets.values.get({
          spreadsheetId: req.params.spreadsheetId as string,
          range: headersRange,
        });
        const headers = (headersResp.data.values?.[0] || []).map(String);
        asObject = {};
        headers.forEach((h, i) => { asObject![h] = values[i] ?? null; });
      }
      res.json({
        spreadsheetId: req.params.spreadsheetId,
        rowNumber,
        sheet: sheetName || null,
        values,
        ...(asObject ? { asObject } : {}),
      });
    } catch (err) {
      sendUpstreamError(res, err, { notFound: 'Spreadsheet not found', fallback: 'Failed to read row' });
    }
  });

  // GET /api/v1/sheets/:spreadsheetId/search - Find a row by column value
  app.get('/api/v1/sheets/:spreadsheetId/search', requireSheetsApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const col = qstr(req.query.col);
      const val = qstr(req.query.val);
      const sheetName = qstr(req.query.sheet);
      if (!col || !val) {
        res.status(400).json({ error: 'Query params `col` and `val` are required (e.g. col=A&val=foo)' });
        return;
      }
      // Restrict `col` to A1-style column letters so it cannot expand the
      // range (e.g. "A:Z") or inject sheet references like "A!Sheet2".
      if (!/^[A-Z]+$/i.test(col)) {
        res.status(400).json({ error: 'Query param `col` must be A1 column letters (e.g. A, B, AA).' });
        return;
      }
      const sheets = req.userSession!.googleSheets;
      // Cap the search window so an unbounded column read can't be triggered
      // by a sparse value at row ~1M. Callers that need a different window
      // can supply ?startRow= / ?maxRows= explicitly.
      const MAX_ROWS = 10000;
      const startRow = qint(req.query.startRow, 1, { min: 1 });
      const maxRows = qint(req.query.maxRows, MAX_ROWS, { min: 1, max: MAX_ROWS });
      const endRow = startRow + maxRows - 1;
      const colRange = `${col}${startRow}:${col}${endRow}`;
      const range = sheetName ? `${sheetName}!${colRange}` : colRange;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: req.params.spreadsheetId as string,
        range,
      });
      const rows = response.data.values || [];
      let rowNumber: number | null = null;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i][0] !== undefined && String(rows[i][0]) === val) {
          rowNumber = startRow + i;
          break;
        }
      }
      res.json({
        spreadsheetId: req.params.spreadsheetId,
        column: col,
        searchValue: val,
        sheet: sheetName || null,
        startRow,
        maxRows,
        rowNumber,
        found: rowNumber !== null,
      });
    } catch (err) {
      sendUpstreamError(res, err, { notFound: 'Spreadsheet not found', fallback: 'Failed to search' });
    }
  });

  // GET /api/v1/clickup/docs/:docId - Get a ClickUp doc with its pages
  app.get('/api/v1/clickup/docs/:docId', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const workspaceId = qstr(req.query.workspaceId);
      if (!workspaceId) {
        res.status(400).json({ error: 'Query param `workspaceId` is required' });
        return;
      }
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      // Let getDocPages rejections propagate to the outer catch so a real
      // failure is reported as 4xx/5xx, not masked as "no pages".
      const [doc, pages] = await Promise.all([
        client.getDoc(workspaceId, req.params.docId as string),
        client.getDocPages(workspaceId, req.params.docId as string),
      ]);
      res.json({ doc, pages });
    } catch (err) {
      sendUpstreamError(res, err, { notFound: 'Doc not found', fallback: 'Failed to get doc' });
    }
  });

  // GET /api/v1/clickup/docs/:docId/pages/:pageId - Get a page within a ClickUp doc
  app.get('/api/v1/clickup/docs/:docId/pages/:pageId', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const workspaceId = qstr(req.query.workspaceId);
      if (!workspaceId) {
        res.status(400).json({ error: 'Query param `workspaceId` is required' });
        return;
      }
      const contentFormat = qstr(req.query.contentFormat, 'text/md');
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const page = await client.getPage(workspaceId, req.params.docId as string, req.params.pageId as string, contentFormat);
      res.json(page);
    } catch (err) {
      sendUpstreamError(res, err, { notFound: 'Page not found', fallback: 'Failed to get page' });
    }
  });

  // Slack REST endpoints — require a slack-bot connection.
  // slack-user (xoxp) connections have access-rules enforcement that we can't
  // safely apply at the REST layer yet, so callers with only a slack-user
  // connection get a clear error from createServiceAuth's connection lookup.

  // GET /api/v1/slack/channels - List Slack channels and DMs
  app.get('/api/v1/slack/channels', requireSlackApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      if (!req.userSession?.slackBotToken) {
        res.status(403).json({ error: 'Slack-bot connection required for REST. Connect via the dashboard.' });
        return;
      }
      const { SlackClient } = await import('../slack/apiHelpers.js');
      const client = new SlackClient(req.userSession.slackBotToken);
      const cursor = qstr(req.query.cursor) || undefined;
      const types = qstr(req.query.types) || undefined;
      const result = await client.conversationsList(cursor, types);
      res.json({ channels: result.channels, nextCursor: result.response_metadata?.next_cursor || null });
    } catch (err: any) {
      res.status(mapSlackErrorToHttpStatus(err)).json({ error: err.message || 'Failed to list channels' });
    }
  });

  // GET /api/v1/slack/channels/:channelId/messages - Read recent messages
  app.get('/api/v1/slack/channels/:channelId/messages', requireSlackApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      if (!req.userSession?.slackBotToken) {
        res.status(403).json({ error: 'Slack-bot connection required for REST.' });
        return;
      }
      const { SlackClient } = await import('../slack/apiHelpers.js');
      const client = new SlackClient(req.userSession.slackBotToken);
      const limit = qint(req.query.limit, 50, { max: 200 });
      const result = await client.conversationsHistory(req.params.channelId as string, {
        limit,
        oldest: qstr(req.query.oldest) || undefined,
        latest: qstr(req.query.latest) || undefined,
        cursor: qstr(req.query.cursor) || undefined,
      });
      res.json({
        channelId: req.params.channelId,
        messages: result.messages,
        hasMore: !!result.has_more,
        nextCursor: result.response_metadata?.next_cursor || null,
      });
    } catch (err: any) {
      res.status(mapSlackErrorToHttpStatus(err)).json({ error: err.message || 'Failed to read history' });
    }
  });

  // GET /api/v1/slack/channels/:channelId/threads/:threadTs - Read thread replies
  app.get('/api/v1/slack/channels/:channelId/threads/:threadTs', requireSlackApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      if (!req.userSession?.slackBotToken) {
        res.status(403).json({ error: 'Slack-bot connection required for REST.' });
        return;
      }
      const { SlackClient } = await import('../slack/apiHelpers.js');
      const client = new SlackClient(req.userSession.slackBotToken);
      const limit = qint(req.query.limit, 50, { max: 200 });
      const result = await client.conversationsReplies(
        req.params.channelId as string,
        req.params.threadTs as string,
        { limit, cursor: qstr(req.query.cursor) || undefined },
      );
      res.json({
        channelId: req.params.channelId,
        threadTs: req.params.threadTs,
        messages: result.messages,
        hasMore: !!result.has_more,
        nextCursor: result.response_metadata?.next_cursor || null,
      });
    } catch (err: any) {
      res.status(mapSlackErrorToHttpStatus(err)).json({ error: err.message || 'Failed to read thread' });
    }
  });

  // GET /api/v1/slack/users - List workspace users
  app.get('/api/v1/slack/users', requireSlackApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      if (!req.userSession?.slackBotToken) {
        res.status(403).json({ error: 'Slack-bot connection required for REST.' });
        return;
      }
      const { SlackClient } = await import('../slack/apiHelpers.js');
      const client = new SlackClient(req.userSession.slackBotToken);
      const limit = qint(req.query.limit, 200, { max: 1000 });
      const result = await client.usersList(qstr(req.query.cursor) || undefined, limit);
      res.json({ members: result.members, nextCursor: result.response_metadata?.next_cursor || null });
    } catch (err: any) {
      res.status(mapSlackErrorToHttpStatus(err)).json({ error: err.message || 'Failed to list users' });
    }
  });


  // === PeopleForce ===
  // Every PeopleForce route resolves its token through this guard first.
  // createServiceAuth falls back to a plain Google session when the user has no
  // PeopleForce connection, so auth can pass with no provider token at all —
  // without the check we would build a client with an undefined bearer and
  // surface a confusing upstream 401 instead of "connect PeopleForce".
  // peopleForceBaseUrl is deliberately NOT required: it is optional, and
  // PeopleForceClient falls back to the default tenant base when it is absent.
  function peopleForceToken(req: ApiAuthenticatedRequest, res: Response): string | null {
    const token = req.userSession?.peopleForceAccessToken;
    if (!token) {
      res.status(403).json({ error: 'PeopleForce connection required for REST. Connect via the dashboard.' });
      return null;
    }
    return token;
  }

  // Bulk HRIS reads: the employee directory is ~260 records at 50/page, so a
  // full headcount pull through the LLM context is exactly what this plane
  // avoids. All four support ?format=text to get the same markdown the MCP
  // tools render (see respondNegotiated) so the two surfaces can't drift.

  // GET /api/v1/peopleforce/employees - List employees
  // NOTE: omitting ?status returns ACTIVE employees only, not everyone —
  // PeopleForce has no "all". A full headcount is status=active + status=inactive.
  app.get('/api/v1/peopleforce/employees', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { PeopleForceClient, formatEmployeeList, EMPLOYEE_STATUS_VALUES } = await import('../peopleforce/apiHelpers.js');
      const status = qstr(req.query.status) || undefined;
      // Validate against the allowlist rather than passing through: PeopleForce
      // silently ignores an unknown status and returns the byte-identical
      // default directory, so a typo would fail open with plausible wrong data.
      if (status && !(EMPLOYEE_STATUS_VALUES as readonly string[]).includes(status)) {
        res.status(400).json({ error: `status must be one of: ${EMPLOYEE_STATUS_VALUES.join(', ')}` });
        return;
      }
      const token = peopleForceToken(req, res);
      if (!token) return;
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.listEmployees({
        page: qint(req.query.page, 1, { min: 1 }),
        status: status as any,
      });
      respondNegotiated(req, res, result, () => formatEmployeeList(result.data ?? [], result.metadata?.pagination));
    } catch (err: any) {
      console.error('Error listing PeopleForce employees:', err);
      sendUpstreamError(res, err, { notFound: 'Employees not found', fallback: 'Failed to list employees' });
    }
  });

  // GET /api/v1/peopleforce/employees/:employeeId - Get a single employee
  app.get('/api/v1/peopleforce/employees/:employeeId', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { PeopleForceClient, formatEmployee } = await import('../peopleforce/apiHelpers.js');
      const token = peopleForceToken(req, res);
      if (!token) return;
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.getEmployee(req.params.employeeId as string);
      if (!result?.data) {
        res.status(404).json({ error: 'Employee not found' });
        return;
      }
      respondNegotiated(req, res, result, () => formatEmployee(result.data));
    } catch (err: any) {
      console.error('Error fetching PeopleForce employee:', err);
      sendUpstreamError(res, err, { notFound: 'Employee not found', fallback: 'Failed to fetch employee' });
    }
  });

  // GET /api/v1/peopleforce/departments - List departments
  app.get('/api/v1/peopleforce/departments', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { PeopleForceClient, formatDepartmentList } = await import('../peopleforce/apiHelpers.js');
      const token = peopleForceToken(req, res);
      if (!token) return;
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.listDepartments({ page: qint(req.query.page, 1, { min: 1 }) });
      respondNegotiated(req, res, result, () => formatDepartmentList(result.data ?? [], result.metadata?.pagination));
    } catch (err: any) {
      console.error('Error listing PeopleForce departments:', err);
      sendUpstreamError(res, err, { notFound: 'Departments not found', fallback: 'Failed to list departments' });
    }
  });

  // GET /api/v1/peopleforce/leave-requests - List leave requests
  // ?state filters by lifecycle state. PeopleForce has no server-side filter by
  // employee or date range — page through and filter with jq.
  app.get('/api/v1/peopleforce/leave-requests', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { PeopleForceClient, formatLeaveRequestList } = await import('../peopleforce/apiHelpers.js');
      const token = peopleForceToken(req, res);
      if (!token) return;
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.listLeaveRequests({
        page: qint(req.query.page, 1, { min: 1 }),
        state: qstr(req.query.state) || undefined,
      });
      respondNegotiated(req, res, result, () => formatLeaveRequestList(result.data ?? [], result.metadata?.pagination));
    } catch (err: any) {
      console.error('Error listing PeopleForce leave requests:', err);
      sendUpstreamError(res, err, { notFound: 'Leave requests not found', fallback: 'Failed to list leave requests' });
    }
  });

  // GET /api/v1/peopleforce/leave-requests/:leaveRequestId - Get one leave request
  app.get('/api/v1/peopleforce/leave-requests/:leaveRequestId', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { PeopleForceClient, formatLeaveRequestList } = await import('../peopleforce/apiHelpers.js');
      const token = peopleForceToken(req, res);
      if (!token) return;
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.getLeaveRequest(req.params.leaveRequestId as string);
      if (!result?.data) {
        res.status(404).json({ error: 'Leave request not found' });
        return;
      }
      respondNegotiated(req, res, result, () => formatLeaveRequestList([result.data]));
    } catch (err: any) {
      console.error('Error fetching PeopleForce leave request:', err);
      sendUpstreamError(res, err, { notFound: 'Leave request not found', fallback: 'Failed to fetch leave request' });
    }
  });

  // --- Reference / lookup lists ---
  // Every one of these is the same shape: one `page` param, one client call,
  // one formatter. They're registered from a table rather than fifteen
  // copy-pasted handlers so a change to the error/negotiation contract lands
  // in one place — the same reason the MCP side has addPaginatedListTool.
  const PF_LOOKUP_ROUTES: ReadonlyArray<{
    path: string;
    fetch: (client: any, page: number) => Promise<any>;
    format: (helpers: any, result: any) => string;
    notFound: string;
    fallback: string;
  }> = [
    {
      path: '/api/v1/peopleforce/leave-types',
      fetch: (c, page) => c.listLeaveTypes({ page }),
      format: (h, r) => h.formatLeaveTypeList(r.data ?? [], r.metadata?.pagination),
      notFound: 'Leave types not found',
      fallback: 'Failed to list leave types',
    },
    {
      path: '/api/v1/peopleforce/positions',
      fetch: (c, page) => c.listPositions({ page }),
      format: (h, r) => h.formatNamedList('Positions', r.data ?? [], r.metadata?.pagination),
      notFound: 'Positions not found',
      fallback: 'Failed to list positions',
    },
    {
      path: '/api/v1/peopleforce/divisions',
      fetch: (c, page) => c.listDivisions({ page }),
      format: (h, r) => h.formatNamedList('Divisions', r.data ?? [], r.metadata?.pagination),
      notFound: 'Divisions not found',
      fallback: 'Failed to list divisions',
    },
    {
      path: '/api/v1/peopleforce/locations',
      fetch: (c, page) => c.listLocations({ page }),
      format: (h, r) => h.formatLocationList(r.data ?? [], r.metadata?.pagination),
      notFound: 'Locations not found',
      fallback: 'Failed to list locations',
    },
    {
      path: '/api/v1/peopleforce/employment-types',
      fetch: (c, page) => c.listEmploymentTypes({ page }),
      format: (h, r) => h.formatNamedList('Employment Types', r.data ?? [], r.metadata?.pagination),
      notFound: 'Employment types not found',
      fallback: 'Failed to list employment types',
    },
    {
      path: '/api/v1/peopleforce/job-levels',
      fetch: (c, page) => c.listJobLevels({ page }),
      format: (h, r) => h.formatNamedList('Job Levels', r.data ?? [], r.metadata?.pagination),
      notFound: 'Job levels not found',
      fallback: 'Failed to list job levels',
    },
    {
      path: '/api/v1/peopleforce/skills',
      fetch: (c, page) => c.listSkills({ page }),
      format: (h, r) => h.formatNamedList('Skills', r.data ?? [], r.metadata?.pagination),
      notFound: 'Skills not found',
      fallback: 'Failed to list skills',
    },
    {
      path: '/api/v1/peopleforce/competencies',
      fetch: (c, page) => c.listCompetencies({ page }),
      format: (h, r) => h.formatNamedList('Competencies', r.data ?? [], r.metadata?.pagination),
      notFound: 'Competencies not found',
      fallback: 'Failed to list competencies',
    },
    {
      path: '/api/v1/peopleforce/tasks',
      fetch: (c, page) => c.listTasks({ page }),
      format: (h, r) => h.formatTaskList(r.data ?? [], r.metadata?.pagination),
      notFound: 'Tasks not found',
      fallback: 'Failed to list tasks',
    },
    {
      path: '/api/v1/peopleforce/objectives',
      fetch: (c, page) => c.listObjectives({ page }),
      format: (h, r) => h.formatObjectiveList(r.data ?? [], r.metadata?.pagination),
      notFound: 'Objectives not found',
      fallback: 'Failed to list objectives',
    },
    {
      path: '/api/v1/peopleforce/kpis',
      fetch: (c, page) => c.listKeyPerformanceIndicators({ page }),
      format: (h, r) => h.formatKpiList(r.data ?? [], r.metadata?.pagination),
      notFound: 'KPIs not found',
      fallback: 'Failed to list KPIs',
    },
    {
      path: '/api/v1/peopleforce/employee-tables',
      fetch: (c, page) => c.listEmployeeTables({ page }),
      format: (h, r) => h.formatEmployeeTableList(r.data ?? [], r.metadata?.pagination),
      notFound: 'Employee tables not found',
      fallback: 'Failed to list employee tables',
    },
    {
      path: '/api/v1/peopleforce/knowledge-base/categories',
      fetch: (c, page) => c.listKnowledgeBaseCategories({ page }),
      format: (h, r) => h.formatKnowledgeCategoryList(r.data ?? [], r.metadata?.pagination),
      notFound: 'Knowledge base categories not found',
      fallback: 'Failed to list knowledge base categories',
    },
    {
      path: '/api/v1/peopleforce/recruitment/pipelines',
      fetch: (c, page) => c.listRecruitmentPipelines({ page }),
      format: (h, r) => h.formatPipelineList(r.data ?? [], r.metadata?.pagination),
      notFound: 'Recruitment pipelines not found',
      fallback: 'Failed to list recruitment pipelines',
    },
    {
      path: '/api/v1/peopleforce/recruitment/candidate-movements',
      fetch: (c, page) => c.listCandidateMovements({ page }),
      format: (h, r) => h.formatMovementList(r.data ?? [], r.metadata?.pagination),
      notFound: 'Candidate movements not found',
      fallback: 'Failed to list candidate movements',
    },
    {
      path: '/api/v1/peopleforce/recruitment/disqualify-reasons',
      fetch: (c, page) => c.listDisqualifyReasons({ page }),
      format: (h, r) => h.formatNamedList('Disqualify Reasons', r.data ?? [], r.metadata?.pagination),
      notFound: 'Disqualify reasons not found',
      fallback: 'Failed to list disqualify reasons',
    },
    {
      path: '/api/v1/peopleforce/recruitment/sources',
      fetch: (c, page) => c.listRecruitmentSources({ page }),
      format: (h, r) => h.formatNamedList('Recruitment Sources', r.data ?? [], r.metadata?.pagination),
      notFound: 'Recruitment sources not found',
      fallback: 'Failed to list recruitment sources',
    },
  ];

  for (const route of PF_LOOKUP_ROUTES) {
    app.get(route.path, requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
      try {
        const helpers = await import('../peopleforce/apiHelpers.js');
        const token = peopleForceToken(req, res);
        if (!token) return;
        const client = new helpers.PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
        const result = await route.fetch(client, qint(req.query.page, 1, { min: 1 }));
        respondNegotiated(req, res, result, () => route.format(helpers, result));
      } catch (err: any) {
        console.error(`Error on PeopleForce ${route.path}:`, err);
        sendUpstreamError(res, err, { notFound: route.notFound, fallback: route.fallback });
      }
    });
  }

  // --- Employee-nested reads ---
  // These endpoints don't paginate upstream — they always return the full list.
  const PF_EMPLOYEE_ROUTES: ReadonlyArray<{
    path: string;
    fetch: (client: any, employeeId: string) => Promise<any>;
    format: (helpers: any, result: any) => string;
    notFound: string;
    fallback: string;
  }> = [
    {
      path: '/api/v1/peopleforce/employees/:employeeId/leave-balances',
      fetch: (c, id) => c.listEmployeeLeaveBalances(id),
      format: (h, r) => h.formatLeaveBalances(r.data ?? []),
      notFound: 'Leave balances not found',
      fallback: 'Failed to list leave balances',
    },
    {
      path: '/api/v1/peopleforce/employees/:employeeId/skills',
      fetch: (c, id) => c.listEmployeeSkills(id),
      format: (h, r) => h.formatEmployeeSkills(r.data ?? []),
      notFound: 'Employee skills not found',
      fallback: 'Failed to list employee skills',
    },
    {
      path: '/api/v1/peopleforce/employees/:employeeId/documents',
      fetch: (c, id) => c.listEmployeeDocuments(id),
      format: (h, r) => h.formatUnknownItemList('Employee Documents', r.data ?? []),
      notFound: 'Employee documents not found',
      fallback: 'Failed to list employee documents',
    },
    {
      path: '/api/v1/peopleforce/employees/:employeeId/notes',
      fetch: (c, id) => c.listEmployeeNotes(id),
      format: (h, r) => h.formatUnknownItemList('Employee Notes', r.data ?? []),
      notFound: 'Employee notes not found',
      fallback: 'Failed to list employee notes',
    },
    {
      path: '/api/v1/peopleforce/employees/:employeeId/emergency-contacts',
      fetch: (c, id) => c.listEmployeeEmergencyContacts(id),
      format: (h, r) => h.formatUnknownItemList('Emergency Contacts', r.data ?? []),
      notFound: 'Emergency contacts not found',
      fallback: 'Failed to list emergency contacts',
    },
  ];

  for (const route of PF_EMPLOYEE_ROUTES) {
    app.get(route.path, requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
      try {
        const helpers = await import('../peopleforce/apiHelpers.js');
        const token = peopleForceToken(req, res);
        if (!token) return;
        const client = new helpers.PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
        const result = await route.fetch(client, req.params.employeeId as string);
        respondNegotiated(req, res, result, () => route.format(helpers, result));
      } catch (err: any) {
        console.error(`Error on PeopleForce ${route.path}:`, err);
        sendUpstreamError(res, err, { notFound: route.notFound, fallback: route.fallback });
      }
    });
  }

  // GET /api/v1/peopleforce/employees/:employeeId/tables/:tableInternalName
  // tableInternalName is a system slug from /employee-tables, not the display
  // name. The row payload is wrapped in { data: {...} } and unwrapped by the
  // client — without that every table would read as empty.
  app.get('/api/v1/peopleforce/employees/:employeeId/tables/:tableInternalName', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { PeopleForceClient, formatEmployeeTable } = await import('../peopleforce/apiHelpers.js');
      const token = peopleForceToken(req, res);
      if (!token) return;
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.getEmployeeTable(req.params.employeeId as string, req.params.tableInternalName as string);
      if (!result || typeof result !== 'object') {
        res.status(404).json({ error: 'Employee table not found' });
        return;
      }
      respondNegotiated(req, res, result, () => formatEmployeeTable(result));
    } catch (err: any) {
      console.error('Error fetching PeopleForce employee table:', err);
      sendUpstreamError(res, err, { notFound: 'Employee table not found', fallback: 'Failed to fetch employee table' });
    }
  });

  // --- Knowledge base ---
  // GET /api/v1/peopleforce/knowledge-base/articles?categoryId=... - List articles
  // Registered before the :articleId route below purely for readability; the two
  // differ in path depth so ordering is not load-bearing here.
  app.get('/api/v1/peopleforce/knowledge-base/articles', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { PeopleForceClient, formatKnowledgeArticleList } = await import('../peopleforce/apiHelpers.js');
      // Upstream only exposes articles nested under a category — there is no
      // workspace-wide article list to fall back to.
      const categoryId = qstr(req.query.categoryId);
      if (!categoryId) {
        res.status(400).json({ error: 'categoryId query parameter is required' });
        return;
      }
      const token = peopleForceToken(req, res);
      if (!token) return;
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.listKnowledgeBaseArticles({ categoryId, page: qint(req.query.page, 1, { min: 1 }) });
      respondNegotiated(req, res, result, () => formatKnowledgeArticleList(result.data ?? [], result.metadata?.pagination));
    } catch (err: any) {
      console.error('Error listing PeopleForce knowledge base articles:', err);
      sendUpstreamError(res, err, { notFound: 'Knowledge base category not found', fallback: 'Failed to list knowledge base articles' });
    }
  });

  // GET /api/v1/peopleforce/knowledge-base/articles/:articleId - Get one article
  app.get('/api/v1/peopleforce/knowledge-base/articles/:articleId', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { PeopleForceClient, formatKnowledgeArticle } = await import('../peopleforce/apiHelpers.js');
      const token = peopleForceToken(req, res);
      if (!token) return;
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.getKnowledgeBaseArticle(req.params.articleId as string);
      if (!result?.data) {
        res.status(404).json({ error: 'Knowledge base article not found' });
        return;
      }
      respondNegotiated(req, res, result, () => formatKnowledgeArticle(result.data));
    } catch (err: any) {
      console.error('Error fetching PeopleForce knowledge base article:', err);
      sendUpstreamError(res, err, { notFound: 'Knowledge base article not found', fallback: 'Failed to fetch knowledge base article' });
    }
  });

  // --- Recruitment: vacancies ---
  // GET /api/v1/peopleforce/recruitment/vacancies - List vacancies
  // ?status and ?tagIds are repeatable (?status=a&status=b) or comma-separated.
  app.get('/api/v1/peopleforce/recruitment/vacancies', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { PeopleForceClient, formatVacancyList } = await import('../peopleforce/apiHelpers.js');
      const token = peopleForceToken(req, res);
      if (!token) return;
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.listVacancies({
        page: qint(req.query.page, 1, { min: 1 }),
        status: qarr(req.query.status),
        tagIds: qarr(req.query.tagIds),
      });
      respondNegotiated(req, res, result, () => formatVacancyList(result.data ?? [], result.metadata?.pagination));
    } catch (err: any) {
      console.error('Error listing PeopleForce vacancies:', err);
      sendUpstreamError(res, err, { notFound: 'Vacancies not found', fallback: 'Failed to list vacancies' });
    }
  });

  // GET /api/v1/peopleforce/recruitment/vacancies/:vacancyId - Get one vacancy
  app.get('/api/v1/peopleforce/recruitment/vacancies/:vacancyId', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { PeopleForceClient, formatVacancy } = await import('../peopleforce/apiHelpers.js');
      const token = peopleForceToken(req, res);
      if (!token) return;
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.getVacancy(req.params.vacancyId as string);
      if (!result?.data) {
        res.status(404).json({ error: 'Vacancy not found' });
        return;
      }
      respondNegotiated(req, res, result, () => formatVacancy(result.data));
    } catch (err: any) {
      console.error('Error fetching PeopleForce vacancy:', err);
      sendUpstreamError(res, err, { notFound: 'Vacancy not found', fallback: 'Failed to fetch vacancy' });
    }
  });

  // GET /api/v1/peopleforce/recruitment/vacancies/:vacancyId/applications - Pipeline excerpt
  app.get('/api/v1/peopleforce/recruitment/vacancies/:vacancyId/applications', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { PeopleForceClient, formatApplicationList } = await import('../peopleforce/apiHelpers.js');
      const token = peopleForceToken(req, res);
      if (!token) return;
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.listVacancyApplications({
        vacancyId: req.params.vacancyId as string,
        page: qint(req.query.page, 1, { min: 1 }),
      });
      respondNegotiated(req, res, result, () => formatApplicationList(result.data ?? [], result.metadata?.pagination));
    } catch (err: any) {
      console.error('Error listing PeopleForce vacancy applications:', err);
      sendUpstreamError(res, err, { notFound: 'Vacancy not found', fallback: 'Failed to list vacancy applications' });
    }
  });

  // GET /api/v1/peopleforce/recruitment/vacancies/:vacancyId/applications/:applicationId
  app.get('/api/v1/peopleforce/recruitment/vacancies/:vacancyId/applications/:applicationId', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { PeopleForceClient, formatApplicationList } = await import('../peopleforce/apiHelpers.js');
      const token = peopleForceToken(req, res);
      if (!token) return;
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.getVacancyApplication({
        vacancyId: req.params.vacancyId as string,
        applicationId: req.params.applicationId as string,
      });
      if (!result?.data) {
        res.status(404).json({ error: 'Vacancy application not found' });
        return;
      }
      respondNegotiated(req, res, result, () => formatApplicationList([result.data]));
    } catch (err: any) {
      console.error('Error fetching PeopleForce vacancy application:', err);
      sendUpstreamError(res, err, { notFound: 'Vacancy application not found', fallback: 'Failed to fetch vacancy application' });
    }
  });

  // GET /api/v1/peopleforce/recruitment/published-vacancies/:vacancyId - Careers-site JD
  // Some tenants gate the Careers API behind a separate career-site token; on a
  // not-authorized error, fall back to getVacancy's internal description.
  app.get('/api/v1/peopleforce/recruitment/published-vacancies/:vacancyId', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { PeopleForceClient, formatPublishedVacancy } = await import('../peopleforce/apiHelpers.js');
      const token = peopleForceToken(req, res);
      if (!token) return;
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.getPublishedVacancy(req.params.vacancyId as string);
      respondNegotiated(req, res, result, () => formatPublishedVacancy(result));
    } catch (err: any) {
      console.error('Error fetching PeopleForce published job description:', err);
      sendUpstreamError(res, err, { notFound: 'Published vacancy not found', fallback: 'Failed to fetch published job description' });
    }
  });

  // --- Recruitment: candidates ---
  // GET /api/v1/peopleforce/recruitment/candidates - List candidates
  // ?vacancyIds and ?skills are repeatable or comma-separated.
  app.get('/api/v1/peopleforce/recruitment/candidates', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { PeopleForceClient, formatCandidateList } = await import('../peopleforce/apiHelpers.js');
      const token = peopleForceToken(req, res);
      if (!token) return;
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.listCandidates({
        page: qint(req.query.page, 1, { min: 1 }),
        vacancyIds: qarr(req.query.vacancyIds),
        pipelineStageId: qstr(req.query.pipelineStageId) || undefined,
        skills: qarr(req.query.skills),
        email: qstr(req.query.email) || undefined,
        createdAtGte: qstr(req.query.createdAtGte) || undefined,
        createdAtLte: qstr(req.query.createdAtLte) || undefined,
        updatedAtGte: qstr(req.query.updatedAtGte) || undefined,
        updatedAtLte: qstr(req.query.updatedAtLte) || undefined,
      });
      respondNegotiated(req, res, result, () => formatCandidateList(result.data ?? [], result.metadata?.pagination));
    } catch (err: any) {
      console.error('Error listing PeopleForce candidates:', err);
      sendUpstreamError(res, err, { notFound: 'Candidates not found', fallback: 'Failed to list candidates' });
    }
  });

  // GET /api/v1/peopleforce/recruitment/candidates/:candidateId - Get one candidate
  app.get('/api/v1/peopleforce/recruitment/candidates/:candidateId', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { PeopleForceClient, formatCandidate } = await import('../peopleforce/apiHelpers.js');
      const token = peopleForceToken(req, res);
      if (!token) return;
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.getCandidate(req.params.candidateId as string);
      if (!result?.data) {
        res.status(404).json({ error: 'Candidate not found' });
        return;
      }
      respondNegotiated(req, res, result, () => formatCandidate(result.data));
    } catch (err: any) {
      console.error('Error fetching PeopleForce candidate:', err);
      sendUpstreamError(res, err, { notFound: 'Candidate not found', fallback: 'Failed to fetch candidate' });
    }
  });

  // GET /api/v1/peopleforce/recruitment/candidates/:candidateId/dossier
  // Best-effort bundle (profile + notes + experience + education, plus the
  // application when ?vacancyId is given). Parts that fail are reported inside
  // the payload rather than failing the request.
  app.get('/api/v1/peopleforce/recruitment/candidates/:candidateId/dossier', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { PeopleForceClient, formatCandidateDossier } = await import('../peopleforce/apiHelpers.js');
      const token = peopleForceToken(req, res);
      if (!token) return;
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.getCandidateDossier({
        candidateId: req.params.candidateId as string,
        vacancyId: qstr(req.query.vacancyId) || undefined,
      });
      respondNegotiated(req, res, result, () => formatCandidateDossier(result));
    } catch (err: any) {
      console.error('Error building PeopleForce candidate dossier:', err);
      sendUpstreamError(res, err, { notFound: 'Candidate not found', fallback: 'Failed to build candidate dossier' });
    }
  });

  // --- Candidate-nested reads (no upstream pagination) ---
  const PF_CANDIDATE_ROUTES: ReadonlyArray<{
    path: string;
    fetch: (client: any, candidateId: string) => Promise<any>;
    format: (helpers: any, result: any) => string;
    notFound: string;
    fallback: string;
  }> = [
    {
      path: '/api/v1/peopleforce/recruitment/candidates/:candidateId/notes',
      fetch: (c, id) => c.listCandidateNotes(id),
      format: (h, r) => h.formatCandidateNotes(r.data ?? []),
      notFound: 'Candidate notes not found',
      fallback: 'Failed to list candidate notes',
    },
    {
      path: '/api/v1/peopleforce/recruitment/candidates/:candidateId/experiences',
      fetch: (c, id) => c.listCandidateExperiences(id),
      format: (h, r) => h.formatCandidateExperiences(r.data ?? []),
      notFound: 'Candidate experiences not found',
      fallback: 'Failed to list candidate experiences',
    },
    {
      path: '/api/v1/peopleforce/recruitment/candidates/:candidateId/educations',
      fetch: (c, id) => c.listCandidateEducations(id),
      format: (h, r) => h.formatCandidateEducations(r.data ?? []),
      notFound: 'Candidate educations not found',
      fallback: 'Failed to list candidate educations',
    },
  ];

  for (const route of PF_CANDIDATE_ROUTES) {
    app.get(route.path, requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
      try {
        const helpers = await import('../peopleforce/apiHelpers.js');
        const token = peopleForceToken(req, res);
        if (!token) return;
        const client = new helpers.PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
        const result = await route.fetch(client, req.params.candidateId as string);
        respondNegotiated(req, res, result, () => route.format(helpers, result));
      } catch (err: any) {
        console.error(`Error on PeopleForce ${route.path}:`, err);
        sendUpstreamError(res, err, { notFound: route.notFound, fallback: route.fallback });
      }
    });
  }


  // --- PeopleForce writes ---
  // Bodies are validated with the MCP tools' own Zod schemas rather than
  // hand-rolled `if (!field)` checks: REST bypasses FastMCP's Zod layer, and
  // reusing the schema is the only thing keeping the two surfaces in step.
  // Path params are merged over the body so a URL and a mismatched body key
  // can't disagree about which record is being written.
  //
  // Note these widen what the permanent dashboard API key can do — it reaches
  // the same createServiceAuth gate as the reads.

  // POST /api/v1/peopleforce/leave-requests - Create a leave request
  app.post('/api/v1/peopleforce/leave-requests', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const token = peopleForceToken(req, res);
      if (!token) return;
      const { createLeaveRequestSchema } = await import('../peopleforce/server.js');
      const parsed = createLeaveRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request body', issues: parsed.error.flatten() });
        return;
      }
      const { PeopleForceClient } = await import('../peopleforce/apiHelpers.js');
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      const result = await client.createLeaveRequest(parsed.data);
      if (!result?.data) {
        res.status(502).json({ error: 'PeopleForce accepted the request but returned no leave request' });
        return;
      }
      res.status(201).json(result);
    } catch (err: any) {
      console.error('Error creating PeopleForce leave request:', err);
      sendUpstreamError(res, err, { notFound: 'Employee or leave type not found', fallback: 'Failed to create leave request' });
    }
  });

  // POST /api/v1/peopleforce/recruitment/candidates/:candidateId/notes - Add a note
  app.post('/api/v1/peopleforce/recruitment/candidates/:candidateId/notes', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const token = peopleForceToken(req, res);
      if (!token) return;
      const { addCandidateNoteSchema } = await import('../peopleforce/server.js');
      const parsed = addCandidateNoteSchema.safeParse({ ...req.body, candidateId: req.params.candidateId });
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request body', issues: parsed.error.flatten() });
        return;
      }
      const { PeopleForceClient, formatCandidateNotes } = await import('../peopleforce/apiHelpers.js');
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      await client.addCandidateNote(parsed.data);
      // The add call returns no usable body, so re-read: a caller chaining curls
      // needs the created note's id, and a bare {ok:true} would force them to
      // issue the follow-up GET themselves.
      const notes = await client.listCandidateNotes(parsed.data.candidateId);
      respondNegotiated(req, res.status(201), notes, () => formatCandidateNotes(notes.data ?? []));
    } catch (err: any) {
      console.error('Error adding PeopleForce candidate note:', err);
      sendUpstreamError(res, err, { notFound: 'Candidate not found', fallback: 'Failed to add candidate note' });
    }
  });

  // POST /api/v1/peopleforce/recruitment/vacancies/:vacancyId/applications/:applicationId/move
  app.post('/api/v1/peopleforce/recruitment/vacancies/:vacancyId/applications/:applicationId/move', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const token = peopleForceToken(req, res);
      if (!token) return;
      const { moveVacancyApplicationSchema } = await import('../peopleforce/server.js');
      const parsed = moveVacancyApplicationSchema.safeParse({
        ...req.body,
        vacancyId: req.params.vacancyId,
        applicationId: req.params.applicationId,
      });
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request body', issues: parsed.error.flatten() });
        return;
      }
      const { PeopleForceClient } = await import('../peopleforce/apiHelpers.js');
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      await client.moveVacancyApplication(parsed.data);
      // Re-read so the response is the application as it now stands, not the
      // move payload echoed back.
      const result = await client.getVacancyApplication({
        vacancyId: parsed.data.vacancyId,
        applicationId: parsed.data.applicationId,
      });
      res.json(result);
    } catch (err: any) {
      console.error('Error moving PeopleForce vacancy application:', err);
      sendUpstreamError(res, err, { notFound: 'Vacancy, application or pipeline stage not found', fallback: 'Failed to move vacancy application' });
    }
  });

  // POST /api/v1/peopleforce/recruitment/vacancies/:vacancyId/applications/:applicationId/disqualify
  // Consequential and not idempotent — repeating it re-disqualifies. There is no
  // confirmation affordance behind a curl, hence the explicit catalog note.
  app.post('/api/v1/peopleforce/recruitment/vacancies/:vacancyId/applications/:applicationId/disqualify', requirePeopleForceApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const token = peopleForceToken(req, res);
      if (!token) return;
      const { disqualifyVacancyApplicationSchema } = await import('../peopleforce/server.js');
      const parsed = disqualifyVacancyApplicationSchema.safeParse({
        ...req.body,
        vacancyId: req.params.vacancyId,
        applicationId: req.params.applicationId,
      });
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request body', issues: parsed.error.flatten() });
        return;
      }
      const { PeopleForceClient } = await import('../peopleforce/apiHelpers.js');
      const client = new PeopleForceClient(token, req.userSession!.peopleForceBaseUrl);
      await client.disqualifyVacancyApplication(parsed.data);
      const result = await client.getVacancyApplication({
        vacancyId: parsed.data.vacancyId,
        applicationId: parsed.data.applicationId,
      });
      res.json(result);
    } catch (err: any) {
      console.error('Error disqualifying PeopleForce vacancy application:', err);
      sendUpstreamError(res, err, { notFound: 'Vacancy, application or disqualify reason not found', fallback: 'Failed to disqualify vacancy application' });
    }
  });

  // GET /api/v1/drive/files/:fileId/download - Stream file content
  // Google native types are exported (?exportMime= to override the default).
  // Other types are downloaded as-is via alt=media. Content-Type and a
  // best-effort Content-Disposition header are set from upstream metadata.
  app.get('/api/v1/drive/files/:fileId/download', requireDriveApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const drive = req.userSession!.googleDrive;
      const fileId = req.params.fileId as string;
      const meta = await drive.files.get({
        fileId,
        supportsAllDrives: true,
        fields: 'id,name,mimeType,size',
      });
      const sourceMime = meta.data.mimeType || 'application/octet-stream';
      const name = meta.data.name || 'download';
      // Default export targets for Google native types when caller doesn't override.
      const DEFAULT_EXPORTS: Record<string, string> = {
        'application/vnd.google-apps.document': 'application/pdf',
        'application/vnd.google-apps.spreadsheet': 'text/csv',
        'application/vnd.google-apps.presentation': 'application/pdf',
        'application/vnd.google-apps.drawing': 'image/png',
      };
      const isNative = sourceMime.startsWith('application/vnd.google-apps.');
      const exportMime = qstr(req.query.exportMime) || (isNative ? DEFAULT_EXPORTS[sourceMime] : undefined);

      // Stream the upstream response straight to the client so multi-MB/GB
      // files don't get buffered in memory. Pipeline awaits completion and
      // surfaces errors to the catch below.
      let upstream: NodeJS.ReadableStream;
      let outMime: string;
      let knownSize: number | undefined;
      if (isNative) {
        if (!exportMime) {
          res.status(400).json({ error: `No default export format for ${sourceMime}. Pass ?exportMime=...` });
          return;
        }
        const resp = await drive.files.export(
          { fileId, mimeType: exportMime },
          { responseType: 'stream' },
        );
        upstream = resp.data as NodeJS.ReadableStream;
        outMime = exportMime;
        // Google Docs exports are generated on demand; no reliable upfront size.
      } else {
        const resp = await drive.files.get(
          { fileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'stream' },
        );
        upstream = resp.data as NodeJS.ReadableStream;
        outMime = sourceMime;
        const size = Number(meta.data.size);
        if (Number.isFinite(size) && size > 0) knownSize = size;
      }
      const safeName = name.replaceAll(/[^\w.-]+/g, '_');
      res.setHeader('Content-Type', outMime);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      if (knownSize !== undefined) res.setHeader('Content-Length', String(knownSize));
      const { pipeline } = await import('node:stream/promises');
      await pipeline(upstream, res);
    } catch (err: any) {
      if (res.headersSent) {
        // Mid-stream failure: response already committed; destroy the socket
        // so the client sees a truncated transfer instead of a hang.
        res.destroy(err);
        return;
      }
      if (err.code === 404) res.status(404).json({ error: 'File not found' });
      else if (err.code === 403) res.status(403).json({ error: 'Permission denied' });
      else res.status(500).json({ error: err.message || 'Failed to download file' });
    }
  });

  // GET /api/v1/gmail/messages/:messageId/attachments/:attachmentId
  // Returns Gmail's base64url-encoded attachment payload plus size. Callers
  // decode the body locally (the message's part headers carry the mime type).
  app.get('/api/v1/gmail/messages/:messageId/attachments/:attachmentId', requireGmailApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const gmail = req.userSession!.googleGmail;
      const resp = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: req.params.messageId as string,
        id: req.params.attachmentId as string,
      });
      res.json({
        messageId: req.params.messageId,
        attachmentId: req.params.attachmentId,
        size: resp.data.size ?? 0,
        // base64url, exactly as Gmail returns it
        data: resp.data.data ?? '',
      });
    } catch (err) {
      sendUpstreamError(res, err, { notFound: 'Attachment or message not found', fallback: 'Failed to fetch attachment' });
    }
  });

  // GET /api/v1/clickup/workspaces/:workspaceId/members
  // ClickUp's API exposes members inside the team payload from getWorkspaces,
  // so we fetch all teams and slice the matching one. Returns members[].
  app.get('/api/v1/clickup/workspaces/:workspaceId/members', requireClickUpApiKey, async (req: ApiAuthenticatedRequest, res) => {
    try {
      const { ClickUpClient } = await import('../clickup/apiHelpers.js');
      const client = new ClickUpClient(req.userSession!.clickUpAccessToken!);
      const result = await client.getWorkspaces();
      const team = (result.teams || []).find((t: any) => String(t.id) === req.params.workspaceId);
      if (!team) {
        res.status(404).json({ error: 'Workspace not found or not accessible to this user' });
        return;
      }
      res.json({ workspaceId: team.id, members: team.members || [] });
    } catch (err) {
      sendUpstreamError(res, err, { notFound: 'Workspace not found', fallback: 'Failed to list workspace members' });
    }
  });
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
  // REST data plane (/api/v1/*). Same routes the all-in-one createWebApp
  // mounts — kept reachable in MCP_MODE=web (multi-service Railway split)
  // where the website pod runs this factory instead of createWebApp.
  registerRestApiRoutes(app);

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

  // ClickUp task-event webhook ingestion. Mounted here so an MCP-only pod
  // whose BASE_URL was used at subscribeToTaskEvents time (very common in
  // multi-service Railway deploys where each MCP has its own domain) can
  // still receive deliveries — previously this returned Express's default
  // 404 and ClickUp fail_count climbed to 30 while nothing landed. Must be
  // registered BEFORE any express.json() on this app.
  registerClickUpWebhookIngest(app);

  // Slack Events API ingestion. Mounted here for the same reason as the ClickUp
  // route above: the Slack app's Request URL may point at this pod's domain.
  registerSlackEventsIngest(app);

  // Public serve route for re-hosted ClickUp Doc images (unauthenticated).
  registerClickUpDocImageRoutes(app);

  // Content-addressed image blob host (upload + immutable serve).
  registerImageBlobRoutes(app);

  // RFC 9728: OAuth Protected Resource Metadata (scoped to this MCP service)
  const mcpSlug = process.env.MCP_SLUG || 'google-docs';
  const mcpBaseUrl = process.env.MCP_BASE_URL || BASE_URL;
  registerOAuthProxy(app, mcpBaseUrl, getScopesForSlug(mcpSlug));

  // Proxy MCP requests to internal FastMCP server
  // Auth middleware: try JWT/Auth0 first, fall back to apiKey lookup (issued by our OAuth proxy)
  const mcpScopeForSlug = getScopesForSlug(mcpSlug)[0] || null;
  const jwtMiddleware = createResourceServerMiddleware({
    validateJwt,
    validateOpaqueToken,
    hasScope,
    getRequiredScope: () => mcpScopeForSlug,
    mapJwtToUser,
  });

  // RFC 9728 §5.1 / MCP authorization: a 401 from the MCP endpoint MUST carry
  // this header. It is how a client discovers *which* authorization server to
  // use, and it is what turns an expired token into a re-authorization prompt.
  // Without it a client has nothing to act on and surfaces the 401 as an opaque
  // transport failure instead — which reads to the user as "reconnecting did
  // not help". Built from mcpBaseUrl, not BASE_URL: each MCP runs on its own
  // subdomain (gmail.awesome-mcp.xyz), and pointing at the main site's metadata
  // would send the client to the wrong resource.
  const mcpWwwAuth = `Bearer resource_metadata="${mcpBaseUrl}/.well-known/oauth-protected-resource"`;

  const mcpOnlyMiddleware = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Try JWT/Auth0 auth first
    const origEnd = res.end;
    let jwtFailed = false;
    const fakeRes = Object.create(res);
    fakeRes.status = (code: number) => {
      if (code === 401) jwtFailed = true;
      return fakeRes;
    };
    fakeRes.setHeader = () => fakeRes;
    fakeRes.json = () => fakeRes;
    fakeRes.end = () => {};

    await jwtMiddleware(req, fakeRes as any, () => { jwtFailed = false; });
    if (!jwtFailed) {
      next();
      return;
    }

    // JWT/Auth0 failed — try apiKey from Bearer header (issued by our OAuth /token endpoint)
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).setHeader('WWW-Authenticate', mcpWwwAuth).json({
        error: 'unauthorized',
        message: 'Missing Authorization header.',
      });
      return;
    }

    const token = authHeader.slice(7);
    try {
      await loadUsers();
      // Support compound token format: "apiKey.instanceId"
      let apiKey = token;
      const dotIndex = token.lastIndexOf('.');
      if (dotIndex > 0) {
        const possibleUser = await getUserByApiKey(token.substring(0, dotIndex));
        if (possibleUser) apiKey = token.substring(0, dotIndex);
      }
      const user = await getUserByApiKey(apiKey);
      if (!user || !user.id) {
        res.status(401).setHeader('WWW-Authenticate', mcpWwwAuth).json({
          error: 'invalid_token',
          message: 'Invalid API key.',
        });
        return;
      }
      // Set trusted headers so FastMCP can identify the user
      req.headers['x-mcp-user-id'] = String(user.id);
      if (user.email) req.headers['x-mcp-user-email'] = user.email;
      console.error(`[mcp-only-auth] API key auth for user ${user.email}`);
      next();
    } catch (err: any) {
      console.error('[mcp-only-auth] API key lookup failed:', err.message);
      res.status(401).setHeader('WWW-Authenticate', mcpWwwAuth).json({
        error: 'invalid_token',
        message: 'Authentication failed.',
      });
    }
  };

  // REST data plane (/api/v1/*). Same routes createWebApp / createWebOnlyApp
  // mount — kept reachable in MCP_MODE=mcp (per-service Railway subdomains
  // like google-calendar.awesome-mcp.xyz) so bearers minted by the shared
  // mintRestBearerForCurl tool actually work on the subdomain they were
  // minted from. Registered BEFORE the /mcp proxy so the /api/v1/* prefix
  // is matched against the concrete routes rather than falling through.
  registerRestApiRoutes(app);

  app.use(['/mcp', '/sse'], mcpOnlyMiddleware);
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
