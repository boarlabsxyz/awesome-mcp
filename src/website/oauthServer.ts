// src/oauthServer.ts — MCP OAuth Authorization Server
// Implements OAuth 2.1 endpoints so Claude.ai can use this as a custom connector.
import crypto from 'crypto';
import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import { isDatabaseAvailable, getRedis } from '../db.js';
import { loadUsers, createOrUpdateUser, getUserByApiKey, getUserByGoogleId } from '../userStore.js';
import { loadClientCredentials } from '../auth.js';
import { getMcpCatalog } from '../mcpCatalogStore.js';
import { getSession } from './sessionStore.js';
import { getMcpConnection } from '../mcpConnectionStore.js';

// Base scopes always needed (for user profile)
const BASE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

// Default scopes when no specific MCP is requested
const DEFAULT_SCOPES = [
  ...BASE_SCOPES,
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

// --- Types ---

interface OAuthAuthCode {
  apiKey: string;
  clientId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  expiresAt: number;
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
    setTimeout(() => memoryAuthCodes.delete(code), 600_000);
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

async function storeState(key: string, data: OAuthState): Promise<void> {
  if (isDatabaseAvailable()) {
    await getRedis().set(`oauth:state:${key}`, JSON.stringify(data), 'EX', 600);
  } else {
    memoryStates.set(key, data);
    setTimeout(() => memoryStates.delete(key), 600_000);
  }
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

// --- Route registration ---

export function registerOAuthRoutes(app: express.Express): void {
  // Normalize BASE_URL: remove trailing slashes to prevent double-slash in redirect URIs
  const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
  console.error(`[OAuth] BASE_URL configured as: ${BASE_URL}`);

  // Debug endpoint: shows OAuth config so you know exactly what redirect URIs to register
  app.get('/debug/oauth-config', async (_req, res) => {
    try {
      const { client_id } = await loadClientCredentials();
      res.json({
        base_url: BASE_URL,
        google_client_id: client_id?.substring(0, 30) + '...',
        redirect_uris_to_register: [
          `${BASE_URL}/auth/callback`,
        ],
        note: 'Add ALL redirect_uris_to_register to your Google Cloud Console > APIs & Services > Credentials > OAuth 2.0 Client > Authorized redirect URIs',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // OAuth Authorization Server Metadata (RFC 8414)
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/authorize`,
      token_endpoint: `${BASE_URL}/token`,
      registration_endpoint: `${BASE_URL}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp'],
    });
  });

  // Dynamic Client Registration (RFC 7591)
  app.post('/register', express.json(), async (req, res) => {
    try {
      const { client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method } = req.body;

      if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
        res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
        return;
      }

      const clientId = crypto.randomUUID();
      const clientSecret = crypto.randomBytes(32).toString('hex');

      const client: OAuthClient = {
        clientId,
        clientSecret,
        redirectUris: redirect_uris,
        clientName: client_name || 'Unknown Client',
      };

      await storeClient(client);
      console.error(`OAuth client registered: ${client.clientName} (${clientId})`);

      res.status(201).json({
        client_id: clientId,
        client_secret: clientSecret,
        client_name: client.clientName,
        redirect_uris,
        grant_types: grant_types || ['authorization_code'],
        response_types: response_types || ['code'],
        token_endpoint_auth_method: token_endpoint_auth_method || 'client_secret_post',
      });
    } catch (err: any) {
      console.error('Client registration error:', err);
      res.status(500).json({ error: 'server_error', error_description: 'Registration failed' });
    }
  });

  // Authorization Endpoint
  app.get('/authorize', async (req, res) => {
    try {
      const responseType = req.query.response_type as string;
      const clientId = req.query.client_id as string;
      const redirectUri = req.query.redirect_uri as string;
      const codeChallenge = req.query.code_challenge as string;
      const codeChallengeMethod = (req.query.code_challenge_method as string) || 'S256';
      const state = req.query.state as string;
      const scope = req.query.scope as string;

      if (responseType !== 'code') {
        res.status(400).json({ error: 'unsupported_response_type' });
        return;
      }

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

      // Try to extract MCP slug from scope parameter
      // Claude sends scope like "google-docs" or "google-calendar"
      let mcpSlug: string | undefined;
      let mcpCatalog: Awaited<ReturnType<typeof getMcpCatalog>> = null;
      let googleScopes = [...DEFAULT_SCOPES];

      console.error(`OAuth: Received scope parameter: "${scope || '(none)'}"`);

      if (scope && scope !== 'mcp') {
        // Try to look up catalog by scope as MCP slug
        const catalog = await getMcpCatalog(scope);
        if (catalog) {
          mcpSlug = scope;
          mcpCatalog = catalog;
          googleScopes = [...BASE_SCOPES, ...catalog.scopes];
          console.error(`OAuth: Using dynamic scopes for MCP "${mcpSlug}": ${googleScopes.join(', ')}`);
        }
      }

      // === Check if user is already logged in and has Google tokens ===
      // This allows skipping redundant Google OAuth when adding connector to Claude.ai
      const sessionId = req.signedCookies?.session;
      console.error(`OAuth /authorize: sessionId=${sessionId ? sessionId.substring(0, 8) + '...' : 'none'}, clientId=${clientId}, redirectUri=${redirectUri}`);

      if (sessionId) {
        const session = await getSession(sessionId);
        console.error(`OAuth /authorize: session found=${!!session}, expired=${session ? session.expiresAt < Date.now() : 'N/A'}`);

        if (session && session.expiresAt > Date.now() && session.googleId) {
          // Get user from session
          const user = await getUserByGoogleId(session.googleId);
          console.error(`OAuth /authorize: looked up user by googleId=${session.googleId}, found=${!!user}`);

          if (user) {
            // Determine which MCP the user is trying to connect
            const targetMcpSlug = mcpSlug || 'google-docs';

            // Check if user has valid Google tokens - either in user record OR in MCP connection
            const hasUserTokens = !!(user.tokens && user.tokens.refresh_token);
            const mcpConnection = user.id ? await getMcpConnection(user.id, targetMcpSlug) : null;
            const hasMcpTokens = !!(mcpConnection && mcpConnection.googleTokens?.refresh_token);

            console.error(`OAuth /authorize: user=${user.email}, hasUserTokens=${hasUserTokens}, hasMcpTokens=${hasMcpTokens}, targetMcp=${targetMcpSlug}`);

            if (hasUserTokens || hasMcpTokens) {
              // User has valid Google tokens - issue auth code directly
              const authCode = crypto.randomBytes(32).toString('hex');
              await storeAuthCode(authCode, {
                apiKey: user.apiKey,
                clientId,
                codeChallenge,
                codeChallengeMethod,
                redirectUri,
                expiresAt: Date.now() + 600_000,
              });

              const tokenSource = hasUserTokens ? 'user tokens' : `MCP "${targetMcpSlug}" connection`;
              console.error(`OAuth: User ${user.email} already has ${tokenSource} - skipping Google OAuth, redirecting to ${redirectUri}`);

              // Redirect back to Claude.ai with auth code
              const callbackUrl = new URL(redirectUri);
              callbackUrl.searchParams.set('code', authCode);
              callbackUrl.searchParams.set('state', state);
              res.redirect(callbackUrl.toString());
              return;
            } else {
              // User is logged in but has no Google tokens - they need to connect an MCP first
              console.error(`OAuth: User ${user.email} logged in but has no Google tokens (refresh_token empty) - showing error`);
              res.status(403).send(`
                <!DOCTYPE html>
                <html>
                <head>
                  <title>MCP Not Connected</title>
                  <style>
                    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
                    h1 { color: #c53030; }
                    a { color: #2563eb; }
                  </style>
                </head>
                <body>
                  <h1>MCP Not Connected</h1>
                  <p>You need to connect the <strong>${targetMcpSlug}</strong> MCP on the website before adding it to Claude.ai.</p>
                  <p><a href="${BASE_URL}/dashboard">Go to Dashboard</a> to connect this MCP first.</p>
                </body>
                </html>
              `);
              return;
            }
          }
        }
      }

      // No valid session - proceed with normal Google OAuth flow
      console.error('OAuth: No valid session found - proceeding with Google OAuth');

      // Generate internal state token to pass through Google OAuth
      const internalState = crypto.randomBytes(32).toString('hex');

      await storeState(internalState, {
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
        state, // Claude.ai's original state, returned in the final redirect
        mcpSlug,
      });

      // Redirect to Google OAuth
      // Use MCP-specific Google credentials if available, otherwise use global credentials
      let googleClientId: string;
      let googleClientSecret: string;
      if (mcpCatalog?.googleClientId && mcpCatalog?.googleClientSecret) {
        googleClientId = mcpCatalog.googleClientId;
        googleClientSecret = mcpCatalog.googleClientSecret;
        console.error(`OAuth: Using MCP-specific Google credentials for "${mcpSlug}"`);
      } else {
        const globalCreds = await loadClientCredentials();
        googleClientId = globalCreds.client_id;
        googleClientSecret = globalCreds.client_secret;
        console.error(`OAuth: Using global Google credentials`);
      }
      const googleRedirectUri = `${BASE_URL}/auth/callback`;
      console.error(`OAuth: Google redirect URI: ${googleRedirectUri}`);
      console.error(`OAuth: Google Client ID: ${googleClientId?.substring(0, 20)}...`);
      const oauthClient = new OAuth2Client(googleClientId, googleClientSecret, googleRedirectUri);

      const authorizeUrl = oauthClient.generateAuthUrl({
        access_type: 'offline',
        scope: googleScopes,
        prompt: 'consent',
        state: internalState,
      });

      res.redirect(authorizeUrl);
    } catch (err: any) {
      console.error('Authorization error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // Token Endpoint
  app.post('/token', express.urlencoded({ extended: false }), async (req, res) => {
    try {
      const { grant_type, code, code_verifier, client_id, redirect_uri } = req.body;

      if (grant_type !== 'authorization_code') {
        res.status(400).json({ error: 'unsupported_grant_type' });
        return;
      }

      if (!code || !code_verifier) {
        res.status(400).json({ error: 'invalid_request', error_description: 'Missing code or code_verifier' });
        return;
      }

      const authCode = await getAuthCode(code);
      if (!authCode) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired or invalid' });
        return;
      }

      // Validate client_id and redirect_uri match
      if (client_id && authCode.clientId !== client_id) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
        return;
      }

      if (redirect_uri && authCode.redirectUri !== redirect_uri) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        return;
      }

      // Verify PKCE
      if (!verifyPKCE(code_verifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }

      // Auth code is single-use
      await deleteAuthCode(code);

      // Return the user's API key as the access token
      res.json({
        access_token: authCode.apiKey,
        token_type: 'Bearer',
        scope: 'mcp',
      });

      console.error(`OAuth token issued for client ${authCode.clientId} (apiKey: ${authCode.apiKey.substring(0, 8)}...)`);
    } catch (err: any) {
      console.error('Token exchange error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });
}

// Exported for use in webServer.ts callback handler
export { storeAuthCode };
