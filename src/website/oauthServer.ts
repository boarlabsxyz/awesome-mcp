// src/website/oauthServer.ts — storage and token logic for the MCP OAuth 2.1
// authorization server. The routes live in registerOAuthProxy (webServer.ts),
// which authenticates the person through Auth0 and then issues OUR tokens:
// an authorization code here, then short-lived access and rotating refresh
// tokens from oauthTokenStore.ts.
import crypto from 'crypto';
import { isDatabaseAvailable, getRedis } from '../db.js';
import { getUserByApiKey } from '../userStore.js';
import { issueTokenPair, rotateRefreshToken, type IssuedTokens } from './oauthTokenStore.js';

// --- Types ---

interface OAuthAuthCode {
  userId: number;
  /**
   * Codes stored before short-lived tokens shipped carried the API key
   * instead. They live 10 minutes, so this only bridges one deploy.
   */
  apiKey?: string;
  clientId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  expiresAt: number;
  scope?: string;
}

interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  clientName: string;
}

interface OAuthState {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string; // original state from Claude.ai
  mcpSlug?: string; // optional MCP slug for dynamic scopes
  requestedScope?: string; // scope requested by MCP client (echoed back in token response)
}

// --- In-memory fallback stores ---

const memoryAuthCodes = new Map<string, OAuthAuthCode>();
const memoryClients = new Map<string, OAuthClient>();
const memoryStates = new Map<string, OAuthState>();

// --- Storage helpers ---

async function storeAuthCode(code: string, data: OAuthAuthCode): Promise<void> {
  if (isDatabaseAvailable()) {
    await getRedis().set(`oauth:code:${code}`, JSON.stringify(data), 'EX', 600);
  } else {
    memoryAuthCodes.set(code, data);
    // unref: a pending cleanup must not keep the process (or a test run) alive.
    setTimeout(() => memoryAuthCodes.delete(code), 600_000).unref();
  }
}

async function getAuthCode(code: string): Promise<OAuthAuthCode | null> {
  if (isDatabaseAvailable()) {
    const raw = await getRedis().get(`oauth:code:${code}`);
    return raw ? JSON.parse(raw) : null;
  }
  const data = memoryAuthCodes.get(code);
  if (data && data.expiresAt < Date.now()) {
    memoryAuthCodes.delete(code);
    return null;
  }
  return data ?? null;
}

async function deleteAuthCode(code: string): Promise<void> {
  if (isDatabaseAvailable()) {
    await getRedis().del(`oauth:code:${code}`);
  } else {
    memoryAuthCodes.delete(code);
  }
}

async function storeClient(client: OAuthClient): Promise<void> {
  if (isDatabaseAvailable()) {
    await getRedis().set(`oauth:client:${client.clientId}`, JSON.stringify(client));
  } else {
    memoryClients.set(client.clientId, client);
  }
}

async function getClient(clientId: string): Promise<OAuthClient | null> {
  if (isDatabaseAvailable()) {
    const raw = await getRedis().get(`oauth:client:${clientId}`);
    return raw ? JSON.parse(raw) : null;
  }
  return memoryClients.get(clientId) ?? null;
}

export async function getOAuthState(key: string): Promise<OAuthState | null> {
  if (isDatabaseAvailable()) {
    const raw = await getRedis().get(`oauth:state:${key}`);
    return raw ? JSON.parse(raw) : null;
  }
  return memoryStates.get(key) ?? null;
}

export async function deleteOAuthState(key: string): Promise<void> {
  if (isDatabaseAvailable()) {
    await getRedis().del(`oauth:state:${key}`);
  } else {
    memoryStates.delete(key);
  }
}

// --- PKCE ---

function verifyPKCE(codeVerifier: string, codeChallenge: string, method: string): boolean {
  if (method === 'S256') {
    const hash = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return hash === codeChallenge;
  }
  if (method === 'plain') {
    return codeVerifier === codeChallenge;
  }
  return false;
}

// --- Token endpoint logic ---

type GrantError = { ok: false; status: number; error: string; errorDescription?: string };

/**
 * Validate and spend an authorization code: grant_type, code, PKCE, client_id
 * and redirect_uri. Returns the user it was issued for.
 */
export async function exchangeAuthCode(params: {
  grant_type: string;
  code: string;
  code_verifier: string;
  client_id?: string;
  redirect_uri?: string;
}): Promise<{ ok: true; userId: number; scope: string; clientId: string } | GrantError> {
  const { grant_type, code, code_verifier, client_id, redirect_uri } = params;

  if (grant_type !== 'authorization_code') {
    return { ok: false, status: 400, error: 'unsupported_grant_type' };
  }
  if (!code || !code_verifier) {
    return { ok: false, status: 400, error: 'invalid_request', errorDescription: 'Missing code or code_verifier' };
  }

  const authCode = await getAuthCode(code);
  if (!authCode) {
    return { ok: false, status: 400, error: 'invalid_grant', errorDescription: 'Authorization code expired or invalid' };
  }
  if (client_id && authCode.clientId !== client_id) {
    return { ok: false, status: 400, error: 'invalid_grant', errorDescription: 'client_id mismatch' };
  }
  if (redirect_uri && authCode.redirectUri !== redirect_uri) {
    return { ok: false, status: 400, error: 'invalid_grant', errorDescription: 'redirect_uri mismatch' };
  }
  if (!verifyPKCE(code_verifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
    return { ok: false, status: 400, error: 'invalid_grant', errorDescription: 'PKCE verification failed' };
  }

  await deleteAuthCode(code);

  let userId = authCode.userId;
  if (!userId && authCode.apiKey) {
    userId = (await getUserByApiKey(authCode.apiKey))?.id as number;
  }
  if (!userId) {
    return { ok: false, status: 400, error: 'invalid_grant', errorDescription: 'The account behind this code no longer exists' };
  }
  return { ok: true, userId, scope: authCode.scope || 'mcp', clientId: authCode.clientId };
}

/** The JSON body of a successful token response (RFC 6749 §5.1). */
function tokenResponse(tokens: IssuedTokens) {
  return {
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: tokens.scope,
  };
}

function errorBody(err: GrantError): Record<string, string> {
  const body: Record<string, string> = { error: err.error };
  if (err.errorDescription) body.error_description = err.errorDescription;
  return body;
}

/**
 * POST /oauth/token, both grants. Issues short-lived access tokens and
 * rotating refresh tokens (oauthTokenStore.ts), never the user's permanent
 * API key, which would never expire, could make every REST write, and could
 * not be revoked for one client without breaking all the others.
 */
export async function handleTokenRequest(body: Record<string, unknown> | undefined): Promise<{
  status: number;
  body: Record<string, unknown>;
  clientId?: string;
}> {
  const params = (body ?? {}) as Record<string, string>;

  if (params.grant_type === 'refresh_token') {
    if (!params.refresh_token) {
      return { status: 400, body: { error: 'invalid_request', error_description: 'Missing refresh_token' } };
    }
    const result = await rotateRefreshToken(params.refresh_token, params.client_id || undefined);
    if (!result.ok) {
      const description = {
        invalid: 'Refresh token expired, revoked or unknown',
        reused: 'Refresh token was already used; this authorization has been revoked. Authorize again.',
        client_mismatch: 'Refresh token was issued to another client',
      }[result.reason];
      return { status: 400, body: { error: 'invalid_grant', error_description: description } };
    }
    return { status: 200, body: tokenResponse(result.tokens), clientId: result.clientId };
  }

  const exchanged = await exchangeAuthCode(params as any);
  if (!exchanged.ok) return { status: exchanged.status, body: errorBody(exchanged) };

  const client = await getClient(exchanged.clientId).catch(() => null);
  const tokens = await issueTokenPair({
    userId: exchanged.userId,
    clientId: exchanged.clientId,
    clientName: client?.clientName ?? null,
    scope: exchanged.scope,
  });
  return { status: 200, body: tokenResponse(tokens), clientId: exchanged.clientId };
}

export { storeAuthCode, storeClient, getClient };
