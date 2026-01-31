// src/userSession.ts
import { google, docs_v1, drive_v3, sheets_v4 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { UserRecord, updateTokens } from './userStore.js';

export interface UserSession {
  [key: string]: unknown;
  apiKey: string;
  email: string;
  googleDocs: docs_v1.Docs;
  googleDrive: drive_v3.Drive;
  googleSheets: sheets_v4.Sheets;
  oauthClient: OAuth2Client;
}

// Cache sessions to avoid recreating clients per request
const sessionCache = new Map<string, UserSession>();

export function createUserSession(
  user: UserRecord,
  clientId: string,
  clientSecret: string
): UserSession {
  // Return cached session if available
  const cached = sessionCache.get(user.apiKey);
  if (cached) return cached;

  const oauthClient = new OAuth2Client(clientId, clientSecret);
  oauthClient.setCredentials(user.tokens);

  // Auto-refresh: persist new tokens when they change
  oauthClient.on('tokens', (newTokens) => {
    console.error(`Tokens refreshed for user ${user.email}`);
    updateTokens(user.apiKey, newTokens as any).catch(err => {
      console.error(`Failed to persist refreshed tokens for ${user.email}:`, err);
    });
  });

  const session: UserSession = {
    apiKey: user.apiKey,
    email: user.email,
    googleDocs: google.docs({ version: 'v1', auth: oauthClient }),
    googleDrive: google.drive({ version: 'v3', auth: oauthClient }),
    googleSheets: google.sheets({ version: 'v4', auth: oauthClient }),
    oauthClient,
  };

  sessionCache.set(user.apiKey, session);
  return session;
}

export function clearSessionCache(apiKey: string): void {
  sessionCache.delete(apiKey);
}
