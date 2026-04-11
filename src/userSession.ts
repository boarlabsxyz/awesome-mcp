// src/userSession.ts
import { google, docs_v1, drive_v3, sheets_v4, calendar_v3, gmail_v1, slides_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { UserRecord, updateTokens } from './userStore.js';
import { McpConnection, GoogleTokens, updateMcpInstanceTokens, clearMcpInstanceTokensCache } from './mcpConnectionStore.js';

export interface UserSession {
  [key: string]: unknown;
  userId?: number;
  apiKey: string;
  email: string;
  mcpSlug?: string;
  googleDocs: docs_v1.Docs;
  googleDrive: drive_v3.Drive;
  googleSheets: sheets_v4.Sheets;
  googleCalendar: calendar_v3.Calendar;
  googleGmail: gmail_v1.Gmail;
  googleSlides: slides_v1.Slides;
  oauthClient: OAuth2Client;
  clickUpAccessToken?: string;
}

// Cache sessions to avoid recreating clients per request
const sessionCache = new Map<string, UserSession>();

// Cache for per-MCP sessions (key: `${apiKey}:${mcpSlug}`)
const mcpSessionCache = new Map<string, UserSession>();

export function createUserSession(
  user: UserRecord,
  clientId: string,
  clientSecret: string
): UserSession {
  // Return cached session if available
  const cached = sessionCache.get(user.apiKey);
  if (cached) return cached;

  const oauthClient = new OAuth2Client(clientId, clientSecret);
  if (user.tokens) {
    oauthClient.setCredentials(user.tokens);
  }

  // Auto-refresh: persist new tokens when they change
  oauthClient.on('tokens', (newTokens) => {
    console.error(`Tokens refreshed for user ${user.email}`);
    updateTokens(user.apiKey, newTokens as any).catch(err => {
      console.error(`Failed to persist refreshed tokens for ${user.email}:`, err);
    });
  });

  const session: UserSession = {
    userId: user.id,
    apiKey: user.apiKey,
    email: user.email,
    googleDocs: google.docs({ version: 'v1', auth: oauthClient }),
    googleDrive: google.drive({ version: 'v3', auth: oauthClient }),
    googleSheets: google.sheets({ version: 'v4', auth: oauthClient }),
    googleCalendar: google.calendar({ version: 'v3', auth: oauthClient }),
    googleGmail: google.gmail({ version: 'v1', auth: oauthClient }),
    googleSlides: google.slides({ version: 'v1', auth: oauthClient }),
    oauthClient,
  };

  sessionCache.set(user.apiKey, session);
  return session;
}

/**
 * Create a user session using per-MCP OAuth tokens.
 * This is used when a user has connected a specific MCP and we need to use
 * that MCP's Google credentials and the user's tokens for that MCP.
 */
export function createUserSessionFromConnection(
  user: UserRecord,
  connection: McpConnection,
  clientId: string,
  clientSecret: string
): UserSession {
  // Cache by instanceId to support multiple instances of the same MCP type
  const cacheKey = `${user.apiKey}:${connection.instanceId}`;

  // Return cached session if available
  const cached = mcpSessionCache.get(cacheKey);
  if (cached) return cached;

  const oauthClient = new OAuth2Client(clientId, clientSecret);
  oauthClient.setCredentials(connection.googleTokens);

  console.error(`[Session] Creating session for ${user.email} on MCP ${connection.mcpSlug} (instance: ${connection.instanceId})`);
  console.error(`[Session] Client ID: ${clientId?.substring(0, 20)}...`);
  console.error(`[Session] Has refresh_token: ${!!connection.googleTokens?.refresh_token}`);

  // Auto-refresh: persist new tokens when they change
  oauthClient.on('tokens', (newTokens) => {
    console.error(`Tokens refreshed for user ${user.email} on instance ${connection.instanceId}`);
    updateMcpInstanceTokens(connection.instanceId, newTokens as Partial<GoogleTokens>).catch(err => {
      console.error(`Failed to persist refreshed tokens for ${user.email} on instance ${connection.instanceId}:`, err);
    });
    // Clear cache so new tokens are picked up
    clearMcpInstanceTokensCache(connection.instanceId).catch(() => {});
  });

  const session: UserSession = {
    userId: user.id,
    apiKey: user.apiKey,
    email: user.email,
    mcpSlug: connection.mcpSlug,
    googleDocs: google.docs({ version: 'v1', auth: oauthClient }),
    googleDrive: google.drive({ version: 'v3', auth: oauthClient }),
    googleSheets: google.sheets({ version: 'v4', auth: oauthClient }),
    googleCalendar: google.calendar({ version: 'v3', auth: oauthClient }),
    googleGmail: google.gmail({ version: 'v1', auth: oauthClient }),
    googleSlides: google.slides({ version: 'v1', auth: oauthClient }),
    oauthClient,
  };

  mcpSessionCache.set(cacheKey, session);
  return session;
}

/**
 * Create a user session for ClickUp connections.
 * ClickUp uses a long-lived access token, no OAuth2Client needed.
 */
export function createClickUpSession(
  user: UserRecord,
  connection: McpConnection,
): UserSession {
  const accessToken = (connection.providerTokens as any)?.access_token;
  if (!accessToken) {
    throw new Error(`ClickUp access token missing for connection ${connection.instanceId}. Please reconnect.`);
  }

  const cacheKey = `${user.apiKey}:${connection.instanceId}`;
  const cached = mcpSessionCache.get(cacheKey);
  if (cached) return cached;

  const session: UserSession = {
    userId: user.id,
    apiKey: user.apiKey,
    email: user.email,
    mcpSlug: connection.mcpSlug,
    clickUpAccessToken: accessToken,
    // Null placeholders for Google clients (ClickUp MCP won't use them)
    googleDocs: null as any,
    googleDrive: null as any,
    googleSheets: null as any,
    googleCalendar: null as any,
    googleGmail: null as any,
    googleSlides: null as any,
    oauthClient: null as any,
  };

  mcpSessionCache.set(cacheKey, session);
  return session;
}

export function clearSessionCache(apiKey: string): void {
  sessionCache.delete(apiKey);
  // Also clear any MCP-specific sessions for this user
  for (const key of mcpSessionCache.keys()) {
    if (key.startsWith(`${apiKey}:`)) {
      mcpSessionCache.delete(key);
    }
  }
}

export function clearMcpSessionCache(apiKey: string, mcpSlugOrInstanceId: string): void {
  mcpSessionCache.delete(`${apiKey}:${mcpSlugOrInstanceId}`);
}
