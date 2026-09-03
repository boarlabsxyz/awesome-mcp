// Direct Google API client for e2e setup/teardown — independent of the MCP.
//
// Write tests need to create scratch resources (docs, sheets, slides, Drive
// files, calendar events, Gmail drafts) before invoking the MCP tool, and clean
// them up after. Going through the MCP for setup couples the test to the very
// thing it's testing, so we hit Google directly.
//
// ONE OAuth client backs all six Google services (google-docs, google-drive,
// google-sheets, google-slides, google-gmail, google-calendar) — same refresh
// token, same env vars, just extra googleapis namespaces. Non-Google services
// have their own clients: setup/clickupClient.ts, setup/slackClient.ts.
//
// Mirrors the OAuth client pattern in src/userSession.ts:42-50 — same library
// (google-auth-library + googleapis), same token-refresh listener shape. The
// e2e harness reads the refresh token + OAuth client id/secret from env vars
// populated by GHA secrets.

import { OAuth2Client } from 'google-auth-library';
import {
  google,
  type calendar_v3,
  type docs_v1,
  type drive_v3,
  type gmail_v1,
  type sheets_v4,
  type slides_v1,
} from 'googleapis';

export interface GoogleClients {
  docs: docs_v1.Docs;
  drive: drive_v3.Drive;
  sheets: sheets_v4.Sheets;
  slides: slides_v1.Slides;
  gmail: gmail_v1.Gmail;
  calendar: calendar_v3.Calendar;
  oauthClient: OAuth2Client;
}

let cached: GoogleClients | undefined;

export function getWriteAccountClients(): GoogleClients {
  if (cached) return cached;

  const refreshToken = required('E2E_WRITE_GOOGLE_REFRESH_TOKEN');
  const clientId = required('E2E_GOOGLE_CLIENT_ID');
  const clientSecret = required('E2E_GOOGLE_CLIENT_SECRET');

  const oauthClient = new OAuth2Client(clientId, clientSecret);
  oauthClient.setCredentials({ refresh_token: refreshToken });

  // Token refreshes happen automatically inside googleapis. We log so a
  // refresh that happens DURING a test shows up in the forensics bundle's
  // run log if anyone goes looking.
  oauthClient.on('tokens', (tokens) => {
    if (tokens.access_token) {
      console.error('[e2e] write-account access token refreshed');
    }
  });

  cached = {
    docs: google.docs({ version: 'v1', auth: oauthClient }),
    drive: google.drive({ version: 'v3', auth: oauthClient }),
    sheets: google.sheets({ version: 'v4', auth: oauthClient }),
    slides: google.slides({ version: 'v1', auth: oauthClient }),
    gmail: google.gmail({ version: 'v1', auth: oauthClient }),
    calendar: google.calendar({ version: 'v3', auth: oauthClient }),
    oauthClient,
  };
  return cached;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. See e2e/fixtures/write-google.md for the setup procedure.`,
    );
  }
  return value;
}
