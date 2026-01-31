// src/webServer.ts
import express from 'express';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { createProxyMiddleware } from 'http-proxy-middleware';
import crypto from 'crypto';
import { loadUsers, createOrUpdateUser, UserRecord } from './userStore.js';
import { loadClientCredentials } from './auth.js';
import { registerOAuthRoutes, getOAuthState, deleteOAuthState, storeAuthCode } from './oauthServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '..', 'public');

const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';

export function createWebApp(internalMcpPort: number): express.Express {
  const app = express();

  // Direct health check for Railway (must be before proxy)
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // MCP OAuth authorization server endpoints (must be before proxy)
  registerOAuthRoutes(app);

  // Proxy MCP endpoints to internal FastMCP server
  const mcpProxy = createProxyMiddleware({
    target: `http://127.0.0.1:${internalMcpPort}`,
    changeOrigin: true,
    ws: true,
  });
  app.use('/mcp', mcpProxy);
  app.use('/sse', mcpProxy);

  // Serve static files
  app.use(express.static(publicDir));

  // Registration page
  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Start OAuth flow
  app.get('/auth/google', async (_req, res) => {
    try {
      const { client_id, client_secret } = await loadClientCredentials();
      const redirectUri = `${BASE_URL}/auth/callback`;
      const oauthClient = new OAuth2Client(client_id, client_secret, redirectUri);

      const authorizeUrl = oauthClient.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
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
      const { client_id, client_secret } = await loadClientCredentials();
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
      const user = await createOrUpdateUser(
        {
          email: profile.email,
          googleId: profile.id,
          name: profile.name || profile.email,
        },
        {
          access_token: tokens.access_token!,
          refresh_token: tokens.refresh_token!,
          scope: tokens.scope!,
          token_type: tokens.token_type!,
          expiry_date: tokens.expiry_date!,
        }
      );

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

      // Direct registration flow — show success page with API key
      res.redirect(`/success.html?apiKey=${encodeURIComponent(user.apiKey)}`);
    } catch (err: any) {
      console.error('OAuth callback error:', err);
      res.status(500).send('Authentication failed. Please try again.');
    }
  });

  return app;
}
