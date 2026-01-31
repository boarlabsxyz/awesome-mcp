// src/auth.ts
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { JWT } from 'google-auth-library'; // ADDED: Import for Service Account client
import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline/promises';
import { fileURLToPath } from 'url';

// --- Calculate paths relative to this script file (ESM way) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRootDir = path.resolve(__dirname, '..');

const TOKEN_PATH = path.join(projectRootDir, 'token.json');
const CREDENTIALS_PATH = path.join(projectRootDir, 'credentials.json');
// --- End of path calculation ---

// --- Helper functions for Railway/cloud deployment ---
// These allow reading credentials from environment variables instead of files

/**
 * Get credentials config from GOOGLE_CREDENTIALS env var or credentials.json file
 * Priority: Environment variable > File
 */
function getCredentialsConfig(): any {
  // Priority 1: Environment variable (for Railway/cloud deployment)
  if (process.env.GOOGLE_CREDENTIALS) {
    try {
      console.error('Loading credentials from GOOGLE_CREDENTIALS env var');
      return JSON.parse(process.env.GOOGLE_CREDENTIALS);
    } catch (e) {
      console.error('Failed to parse GOOGLE_CREDENTIALS env var:', e);
    }
  }

  // Priority 2: Return null to let caller handle file loading
  return null;
}

/**
 * Get stored token from GOOGLE_TOKEN env var or token.json file
 * Priority: Environment variable > File
 */
function getStoredTokenFromEnv(): any | null {
  // Check environment variable first
  if (process.env.GOOGLE_TOKEN) {
    try {
      console.error('Loading token from GOOGLE_TOKEN env var');
      return JSON.parse(process.env.GOOGLE_TOKEN);
    } catch (e) {
      console.error('Failed to parse GOOGLE_TOKEN env var:', e);
    }
  }
  return null;
}

/**
 * Save token - logs to stderr for cloud deployment env var updates
 */
function logTokenForEnvUpdate(token: any): void {
  // In cloud deployment, we can't easily save files
  // Log the token so you can update the env var if needed
  if (process.env.GOOGLE_CREDENTIALS || process.env.GOOGLE_TOKEN) {
    console.error('='.repeat(50));
    console.error('TOKEN REFRESHED - Update GOOGLE_TOKEN env var with:');
    console.error(JSON.stringify(token));
    console.error('='.repeat(50));
  }
}
// --- End of helper functions for Railway/cloud deployment ---

const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive', // Full Drive access for listing, searching, and document discovery
  'https://www.googleapis.com/auth/spreadsheets' // Google Sheets API access
];

// --- NEW FUNCTION: Handles Service Account Authentication ---
// This entire function is new. It is called only when the
// SERVICE_ACCOUNT_PATH environment variable is set.
// Supports domain-wide delegation via GOOGLE_IMPERSONATE_USER env var.
async function authorizeWithServiceAccount(): Promise<JWT> {
  const serviceAccountPath = process.env.SERVICE_ACCOUNT_PATH!; // We know this is set if we are in this function
  const impersonateUser = process.env.GOOGLE_IMPERSONATE_USER; // Optional: email of user to impersonate
  try {
    const keyFileContent = await fs.readFile(serviceAccountPath, 'utf8');
    const serviceAccountKey = JSON.parse(keyFileContent);

    const auth = new JWT({
      email: serviceAccountKey.client_email,
      key: serviceAccountKey.private_key,
      scopes: SCOPES,
      subject: impersonateUser, // Enables domain-wide delegation when set
    });
    await auth.authorize();
    if (impersonateUser) {
      console.error(`Service Account authentication successful, impersonating: ${impersonateUser}`);
    } else {
      console.error('Service Account authentication successful!');
    }
    return auth;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      console.error(`FATAL: Service account key file not found at path: ${serviceAccountPath}`);
      throw new Error(`Service account key file not found. Please check the path in SERVICE_ACCOUNT_PATH.`);
    }
    console.error('FATAL: Error loading or authorizing the service account key:', error.message);
    throw new Error('Failed to authorize using the service account. Ensure the key file is valid and the path is correct.');
  }
}
// --- END OF NEW FUNCTION---

async function loadSavedCredentialsIfExist(): Promise<OAuth2Client | null> {
  try {
    // Try environment variable first (for Railway/cloud deployment)
    let credentials = getStoredTokenFromEnv();

    // Fall back to file if no env var
    if (!credentials) {
      try {
        const content = await fs.readFile(TOKEN_PATH);
        credentials = JSON.parse(content.toString());
        console.error('Loading token from token.json file');
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return null; // No token file, need to authenticate
        }
        throw err;
      }
    }

    const { client_secret, client_id, redirect_uris } = await loadClientSecrets();
    const client = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);
    client.setCredentials(credentials);

    // Set up token refresh handler for cloud deployments
    client.on('tokens', (newTokens) => {
      const updatedToken = { ...credentials, ...newTokens };
      logTokenForEnvUpdate(updatedToken);
      // Also try to save to file for local dev
      fs.writeFile(TOKEN_PATH, JSON.stringify(updatedToken, null, 2))
        .then(() => console.error('Token saved to token.json'))
        .catch(() => console.error('Could not save token to file (expected in cloud deployment)'));
    });

    return client;
  } catch (err) {
    return null;
  }
}

export async function loadClientCredentials() {
  return loadClientSecrets();
}

async function loadClientSecrets() {
  // Try environment variable first (for Railway/cloud deployment)
  let keys = getCredentialsConfig();

  // Fall back to file if no env var
  if (!keys) {
    try {
      const content = await fs.readFile(CREDENTIALS_PATH);
      keys = JSON.parse(content.toString());
      console.error('Loading credentials from credentials.json file');
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new Error('No Google credentials found! Set GOOGLE_CREDENTIALS env var or provide credentials.json');
      }
      throw err;
    }
  }

  const key = keys.installed || keys.web;
  if (!key) throw new Error("Could not find client secrets in credentials.json or GOOGLE_CREDENTIALS env var.");
  return {
      client_id: key.client_id,
      client_secret: key.client_secret,
      redirect_uris: key.redirect_uris || ['http://localhost:3000/'], // Default for web clients
      client_type: keys.web ? 'web' : 'installed'
  };
}

async function saveCredentials(client: OAuth2Client): Promise<void> {
  const { client_secret, client_id } = await loadClientSecrets();
  const payload = JSON.stringify({
    type: 'authorized_user',
    client_id: client_id,
    client_secret: client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  await fs.writeFile(TOKEN_PATH, payload);
  console.error('Token stored to', TOKEN_PATH);
}

async function authenticate(): Promise<OAuth2Client> {
  const { client_secret, client_id, redirect_uris, client_type } = await loadClientSecrets();
  // Use http://localhost for desktop apps (OOB flow was deprecated by Google in 2022)
  const redirectUri = redirect_uris[0] || 'http://localhost';
  console.error(`DEBUG: Using redirect URI: ${redirectUri}`);
  console.error(`DEBUG: Client type: ${client_type}`);
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const authorizeUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES.join(' '),
    prompt: 'select_account',  // Force account selection
  });

  console.error('DEBUG: Generated auth URL:', authorizeUrl);
  console.error('\n=== AUTHORIZATION REQUIRED ===');
  console.error('1. Open this URL in your browser (use incognito for different account):');
  console.error(authorizeUrl);
  console.error('\n2. After granting access, your browser will redirect to a "localhost" page that fails to load.');
  console.error('3. Copy the "code" value from the URL bar. It looks like: http://localhost/?code=4/0XXXXX&scope=...');
  console.error('4. Copy everything between "code=" and "&scope" (or end of URL if no &scope)');
  console.error('==============================\n');
  const code = await rl.question('Paste the authorization code here: ');
  rl.close();

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    if (tokens.refresh_token) { // Save only if we got a refresh token
         await saveCredentials(oAuth2Client);
    } else {
         console.error("Did not receive refresh token. Token might expire.");
    }
    console.error('Authentication successful!');
    return oAuth2Client;
  } catch (err) {
    console.error('Error retrieving access token', err);
    throw new Error('Authentication failed');
  }
}

// --- MODIFIED: The Main Exported Function ---
// This function now acts as a router. It checks for the environment
// variable and decides which authentication method to use.
export async function authorize(): Promise<OAuth2Client | JWT> {
  // Check if the Service Account environment variable is set.
  if (process.env.SERVICE_ACCOUNT_PATH) {
    console.error('Service account path detected. Attempting service account authentication...');
    return authorizeWithServiceAccount();
  } else {
    // If not, execute the original OAuth 2.0 flow exactly as it was.
    console.error('No service account path detected. Falling back to standard OAuth 2.0 flow...');
    let client = await loadSavedCredentialsIfExist();
    if (client) {
      // Optional: Add token refresh logic here if needed, though library often handles it.
      console.error('Using saved credentials.');
      return client;
    }
    console.error('Starting authentication flow...');
    client = await authenticate();
    return client;
  }
}
// --- END OF MODIFIED: The Main Exported Function ---
