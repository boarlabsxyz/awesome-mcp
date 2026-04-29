// src/mcpCatalogStore.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { isDatabaseAvailable, getPool } from './db.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const CATALOG_FILE = path.join(DATA_DIR, 'mcp-catalog.json');

export interface McpCatalogEntry {
  id: number;
  slug: string;
  name: string;
  description: string;
  iconUrl: string | null;
  mcpUrl: string;
  scopes: string[];
  googleClientId: string | null;
  googleClientSecret: string | null;
  oauthScopes: string[];
  isLocal: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  provider?: string;                 // 'google' | 'clickup'
  oauthAuthorizationUrl?: string;    // e.g. 'https://app.clickup.com/api'
  oauthTokenUrl?: string;            // e.g. 'https://api.clickup.com/api/v2/oauth/token'
}

// ---------- File-based storage (fallback) ----------

let catalog: McpCatalogEntry[] = [];
let loaded = false;
let writeLock: Promise<void> = Promise.resolve();
let nextId = 1;

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function fileLoadCatalog(): Promise<void> {
  if (loaded) return;
  await ensureDataDir();
  try {
    const content = await fs.readFile(CATALOG_FILE, 'utf-8');
    catalog = JSON.parse(content);
    nextId = catalog.length > 0 ? Math.max(...catalog.map(e => e.id)) + 1 : 1;
    loaded = true;
    console.error(`Loaded ${catalog.length} MCP catalog entries from ${CATALOG_FILE}`);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      catalog = [];
      loaded = true;
      console.error('No existing MCP catalog file, starting fresh.');
    } else {
      throw err;
    }
  }
}

async function saveCatalog(): Promise<void> {
  writeLock = writeLock.then(async () => {
    await ensureDataDir();
    await fs.writeFile(CATALOG_FILE, JSON.stringify(catalog, null, 2));
  });
  await writeLock;
}

async function fileListMcpCatalogs(): Promise<McpCatalogEntry[]> {
  await fileLoadCatalog();
  return catalog.filter(e => e.isActive);
}

async function fileGetMcpCatalog(slug: string): Promise<McpCatalogEntry | null> {
  await fileLoadCatalog();
  return catalog.find(e => e.slug === slug && e.isActive) || null;
}

async function fileCreateMcpCatalog(
  entry: Omit<McpCatalogEntry, 'id' | 'createdAt' | 'updatedAt'>
): Promise<McpCatalogEntry> {
  await fileLoadCatalog();

  // Check if slug already exists
  const existing = catalog.find(e => e.slug === entry.slug);
  if (existing) {
    // Update existing entry
    existing.name = entry.name;
    existing.description = entry.description;
    existing.iconUrl = entry.iconUrl;
    existing.mcpUrl = entry.mcpUrl;
    existing.scopes = entry.scopes;
    existing.googleClientId = entry.googleClientId || existing.googleClientId;
    existing.googleClientSecret = entry.googleClientSecret || existing.googleClientSecret;
    existing.oauthScopes = entry.oauthScopes || existing.oauthScopes;
    existing.isLocal = entry.isLocal;
    existing.isActive = entry.isActive;
    if (entry.provider !== undefined) existing.provider = entry.provider;
    if (entry.oauthAuthorizationUrl !== undefined) existing.oauthAuthorizationUrl = entry.oauthAuthorizationUrl;
    if (entry.oauthTokenUrl !== undefined) existing.oauthTokenUrl = entry.oauthTokenUrl;
    existing.updatedAt = new Date().toISOString();
    await saveCatalog();
    return existing;
  }

  const newEntry: McpCatalogEntry = {
    id: nextId++,
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    iconUrl: entry.iconUrl,
    mcpUrl: entry.mcpUrl,
    scopes: entry.scopes,
    googleClientId: entry.googleClientId || null,
    googleClientSecret: entry.googleClientSecret || null,
    oauthScopes: entry.oauthScopes || [],
    isLocal: entry.isLocal,
    isActive: entry.isActive,
    provider: entry.provider,
    oauthAuthorizationUrl: entry.oauthAuthorizationUrl,
    oauthTokenUrl: entry.oauthTokenUrl,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  catalog.push(newEntry);
  await saveCatalog();
  return newEntry;
}

// ---------- Database-backed storage ----------

async function dbListMcpCatalogs(): Promise<McpCatalogEntry[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, slug, name, description, icon_url, mcp_url, scopes, google_client_id, google_client_secret, oauth_scopes, is_local, is_active, created_at, updated_at, provider, oauth_authorization_url, oauth_token_url
     FROM mcp_catalog
     WHERE is_active = true
     ORDER BY name`
  );
  return rows.map(mapRowToEntry);
}

async function dbGetMcpCatalog(slug: string): Promise<McpCatalogEntry | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, slug, name, description, icon_url, mcp_url, scopes, google_client_id, google_client_secret, oauth_scopes, is_local, is_active, created_at, updated_at, provider, oauth_authorization_url, oauth_token_url
     FROM mcp_catalog
     WHERE slug = $1 AND is_active = true`,
    [slug]
  );
  if (rows.length === 0) return null;
  return mapRowToEntry(rows[0]);
}

async function dbCreateMcpCatalog(
  entry: Omit<McpCatalogEntry, 'id' | 'createdAt' | 'updatedAt'>
): Promise<McpCatalogEntry> {
  const pool = getPool();
  const now = new Date();
  const scopesJson = JSON.stringify(entry.scopes);
  const oauthScopesJson = JSON.stringify(entry.oauthScopes || []);

  const { rows } = await pool.query(
    `INSERT INTO mcp_catalog (slug, name, description, icon_url, mcp_url, scopes, google_client_id, google_client_secret, oauth_scopes, is_local, is_active, created_at, updated_at, provider, oauth_authorization_url, oauth_token_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13, $14, $15)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       icon_url = EXCLUDED.icon_url,
       mcp_url = EXCLUDED.mcp_url,
       scopes = EXCLUDED.scopes,
       google_client_id = COALESCE(EXCLUDED.google_client_id, mcp_catalog.google_client_id),
       google_client_secret = COALESCE(EXCLUDED.google_client_secret, mcp_catalog.google_client_secret),
       oauth_scopes = COALESCE(EXCLUDED.oauth_scopes, mcp_catalog.oauth_scopes),
       is_local = EXCLUDED.is_local,
       is_active = EXCLUDED.is_active,
       updated_at = EXCLUDED.updated_at,
       provider = COALESCE(EXCLUDED.provider, mcp_catalog.provider),
       oauth_authorization_url = COALESCE(EXCLUDED.oauth_authorization_url, mcp_catalog.oauth_authorization_url),
       oauth_token_url = COALESCE(EXCLUDED.oauth_token_url, mcp_catalog.oauth_token_url)
     RETURNING id, slug, name, description, icon_url, mcp_url, scopes, google_client_id, google_client_secret, oauth_scopes, is_local, is_active, created_at, updated_at, provider, oauth_authorization_url, oauth_token_url`,
    [entry.slug, entry.name, entry.description, entry.iconUrl, entry.mcpUrl, scopesJson, entry.googleClientId || null, entry.googleClientSecret || null, oauthScopesJson, entry.isLocal, entry.isActive, now, entry.provider || 'google', entry.oauthAuthorizationUrl || null, entry.oauthTokenUrl || null]
  );

  return mapRowToEntry(rows[0]);
}

function mapRowToEntry(row: any): McpCatalogEntry {
  let scopes: string[] = [];
  if (row.scopes) {
    try {
      scopes = typeof row.scopes === 'string' ? JSON.parse(row.scopes) : row.scopes;
    } catch {
      scopes = [];
    }
  }
  let oauthScopes: string[] = [];
  if (row.oauth_scopes) {
    try {
      oauthScopes = typeof row.oauth_scopes === 'string' ? JSON.parse(row.oauth_scopes) : row.oauth_scopes;
    } catch {
      oauthScopes = [];
    }
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || '',
    iconUrl: row.icon_url,
    mcpUrl: row.mcp_url,
    scopes,
    googleClientId: row.google_client_id || null,
    googleClientSecret: row.google_client_secret || null,
    oauthScopes,
    isLocal: row.is_local,
    isActive: row.is_active,
    provider: row.provider || 'google',
    oauthAuthorizationUrl: row.oauth_authorization_url || undefined,
    oauthTokenUrl: row.oauth_token_url || undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

// ---------- Public API ----------

export async function listMcpCatalogs(): Promise<McpCatalogEntry[]> {
  if (isDatabaseAvailable()) {
    return dbListMcpCatalogs();
  }
  return fileListMcpCatalogs();
}

export async function getMcpCatalog(slug: string): Promise<McpCatalogEntry | null> {
  if (isDatabaseAvailable()) {
    return dbGetMcpCatalog(slug);
  }
  return fileGetMcpCatalog(slug);
}

export async function createMcpCatalog(
  entry: Omit<McpCatalogEntry, 'id' | 'createdAt' | 'updatedAt'>
): Promise<McpCatalogEntry> {
  if (isDatabaseAvailable()) {
    return dbCreateMcpCatalog(entry);
  }
  return fileCreateMcpCatalog(entry);
}

export async function seedDefaultCatalogs(): Promise<void> {
  console.error('Seeding default MCP catalog entries...');

  // For multi-service deployments, MCP URLs can be set via environment variables
  // e.g., GOOGLE_DOCS_MCP_URL=https://google-docs-mcp-production.up.railway.app/mcp
  // If not set, falls back to relative paths (for single-service MCP_MODE=all deployments)
  const normalizeUrl = (url: string | undefined, defaultPath: string): string => {
    if (!url) return defaultPath;
    // Add https:// if missing protocol
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('/')) {
      return 'https://' + url;
    }
    return url;
  };

  const googleDocsMcpUrl = normalizeUrl(process.env.GOOGLE_DOCS_MCP_URL, '/mcp');
  const googleCalendarMcpUrl = normalizeUrl(process.env.GOOGLE_CALENDAR_MCP_URL, '/calendar');
  const googleSheetsMcpUrl = normalizeUrl(process.env.GOOGLE_SHEETS_MCP_URL, '/sheets');

  // Per-MCP Google credentials allow each MCP to use its own Google Cloud project.
  // If set, these are stored in the catalog so all services (website, MCP, REST API)
  // use the same OAuth client for token operations.
  const googleDocsClientId = process.env.GOOGLE_DOCS_CLIENT_ID || null;
  const googleDocsClientSecret = process.env.GOOGLE_DOCS_CLIENT_SECRET || null;
  const googleCalendarClientId = process.env.GOOGLE_CALENDAR_CLIENT_ID || null;
  const googleCalendarClientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || null;
  const googleSheetsClientId = process.env.GOOGLE_SHEETS_CLIENT_ID || null;
  const googleSheetsClientSecret = process.env.GOOGLE_SHEETS_CLIENT_SECRET || null;
  const googleGmailClientId = process.env.GOOGLE_GMAIL_CLIENT_ID || null;
  const googleGmailClientSecret = process.env.GOOGLE_GMAIL_CLIENT_SECRET || null;

  const googleGmailMcpUrl = normalizeUrl(process.env.GOOGLE_GMAIL_MCP_URL, '/gmail');
  const googleSlidesClientId = process.env.GOOGLE_SLIDES_CLIENT_ID || null;
  const googleSlidesClientSecret = process.env.GOOGLE_SLIDES_CLIENT_SECRET || null;
  const googleSlidesMcpUrl = normalizeUrl(process.env.GOOGLE_SLIDES_MCP_URL, '/slides');
  const googleDriveClientId = process.env.GOOGLE_DRIVE_CLIENT_ID || null;
  const googleDriveClientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET || null;
  const googleDriveMcpUrl = normalizeUrl(process.env.GOOGLE_DRIVE_MCP_URL, '/drive');

  console.error(`MCP URLs: google-docs=${googleDocsMcpUrl}, google-calendar=${googleCalendarMcpUrl}, google-sheets=${googleSheetsMcpUrl}, google-gmail=${googleGmailMcpUrl}, google-slides=${googleSlidesMcpUrl}`);
  console.error(`MCP credentials: google-docs=${googleDocsClientId ? 'env' : 'global'}, google-calendar=${googleCalendarClientId ? 'env' : 'global'}, google-sheets=${googleSheetsClientId ? 'env' : 'global'}, google-gmail=${googleGmailClientId ? 'env' : 'global'}, google-slides=${googleSlidesClientId ? 'env' : 'global'}`);

  await createMcpCatalog({
    slug: 'google-docs',
    name: 'Google Docs MCP',
    description: 'Read, write, and manage Google Docs',
    iconUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/66/Google_Docs_2020_Logo.svg/960px-Google_Docs_2020_Logo.svg.png',
    mcpUrl: googleDocsMcpUrl,
    scopes: [
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/drive',
    ],
    googleClientId: googleDocsClientId,
    googleClientSecret: googleDocsClientSecret,
    oauthScopes: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/drive',
    ],
    isLocal: process.env.GOOGLE_DOCS_MCP_URL ? false : true,
    isActive: true,
  });

  await createMcpCatalog({
    slug: 'google-calendar',
    name: 'Google Calendar MCP',
    description: 'Manage Google Calendar events and schedules',
    iconUrl: null,
    mcpUrl: googleCalendarMcpUrl,
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    googleClientId: googleCalendarClientId,
    googleClientSecret: googleCalendarClientSecret,
    oauthScopes: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    isLocal: process.env.GOOGLE_CALENDAR_MCP_URL ? false : true,
    isActive: true,
  });

  await createMcpCatalog({
    slug: 'google-sheets',
    name: 'Google Sheets MCP',
    description: 'Read, write, and manage Google Spreadsheets',
    iconUrl: 'https://www.torontomu.ca/content/dam/google/teach-with-google-apps/sign-up-sheets/sign-up-sheets-1.png',
    mcpUrl: googleSheetsMcpUrl,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
    googleClientId: googleSheetsClientId,
    googleClientSecret: googleSheetsClientSecret,
    oauthScopes: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
    isLocal: process.env.GOOGLE_SHEETS_MCP_URL ? false : true,
    isActive: true,
  });

  await createMcpCatalog({
    slug: 'google-gmail',
    name: 'Gmail MCP',
    description: 'Send, read, search, and manage Gmail messages and labels',
    iconUrl: 'https://images.icon-icons.com/2642/PNG/512/google_mail_gmail_logo_icon_159346.png',
    mcpUrl: googleGmailMcpUrl,
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify',
    ],
    googleClientId: googleGmailClientId,
    googleClientSecret: googleGmailClientSecret,
    oauthScopes: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/gmail.modify',
    ],
    isLocal: process.env.GOOGLE_GMAIL_MCP_URL ? false : true,
    isActive: true,
  });

  await createMcpCatalog({
    slug: 'google-slides',
    name: 'Google Slides MCP',
    description: 'Create, read, and manage Google Slides presentations',
    iconUrl: 'https://play-lh.googleusercontent.com/DG-zbXPr8LItYD8F2nD4aR_SK_jpkipLBK77YWY-F0cdJt67VFgCHZtRtjsakzTw3EM=w240-h480-rw',
    mcpUrl: googleSlidesMcpUrl,
    scopes: [
      'https://www.googleapis.com/auth/presentations',
      'https://www.googleapis.com/auth/drive',
    ],
    googleClientId: googleSlidesClientId,
    googleClientSecret: googleSlidesClientSecret,
    oauthScopes: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/presentations',
      'https://www.googleapis.com/auth/drive',
    ],
    isLocal: process.env.GOOGLE_SLIDES_MCP_URL ? false : true,
    isActive: true,
  });

  await createMcpCatalog({
    slug: 'google-drive',
    name: 'Google Drive MCP',
    description: 'Browse, search, share, and manage files in Google Drive',
    iconUrl: 'https://www.computerhope.com/issues/pictures/google-drive-logo.png',
    mcpUrl: googleDriveMcpUrl,
    scopes: [
      'https://www.googleapis.com/auth/drive',
    ],
    googleClientId: googleDriveClientId,
    googleClientSecret: googleDriveClientSecret,
    oauthScopes: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/drive',
    ],
    isLocal: process.env.GOOGLE_DRIVE_MCP_URL ? false : true,
    isActive: true,
  });

  // ClickUp MCP (non-Google provider)
  const clickUpClientId = process.env.CLICKUP_CLIENT_ID || null;
  const clickUpClientSecret = process.env.CLICKUP_CLIENT_SECRET || null;
  const clickUpMcpUrl = normalizeUrl(process.env.CLICKUP_MCP_URL, '/clickup');

  await createMcpCatalog({
    slug: 'clickup',
    name: 'ClickUp MCP',
    description: 'Manage tasks, lists, docs, and time tracking in ClickUp',
    iconUrl: 'https://s3-eu-west-1.amazonaws.com/tpd/logos/596dc4c10000ff0005a6e68f/0x0.png',
    mcpUrl: clickUpMcpUrl,
    provider: 'clickup',
    scopes: [],
    googleClientId: clickUpClientId,
    googleClientSecret: clickUpClientSecret,
    oauthAuthorizationUrl: 'https://app.clickup.com/api',
    oauthTokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
    oauthScopes: [],
    isLocal: !process.env.CLICKUP_MCP_URL,
    isActive: true,
  });

  // Slack Bot MCP (bot-token provider — no OAuth, user pastes xoxb- token)
  const slackBotMcpUrl = normalizeUrl(process.env.SLACK_BOT_MCP_URL, '/slack-bot');

  await createMcpCatalog({
    slug: 'slack-bot',
    name: 'Slack Bot MCP',
    description: 'Read channels and post messages in Slack workspaces via bot token',
    iconUrl: 'https://a.slack-edge.com/80588/marketing/img/icons/icon_slack_hash_colored.png',
    mcpUrl: slackBotMcpUrl,
    provider: 'slack-bot',
    scopes: [],
    googleClientId: null,
    googleClientSecret: null,
    oauthScopes: [],
    isLocal: !process.env.SLACK_BOT_MCP_URL,
    isActive: true,
  });

  // Slack User MCP (OAuth-based with channel allowlist)
  const slackClientId = process.env.SLACK_CLIENT_ID || null;
  const slackClientSecret = process.env.SLACK_CLIENT_SECRET || null;
  const slackUserMcpUrl = normalizeUrl(process.env.SLACK_USER_MCP_URL, '/slack');

  await createMcpCatalog({
    slug: 'slack',
    name: 'Slack MCP',
    description: 'Read and write Slack channels with per-channel access control',
    iconUrl: 'https://a.slack-edge.com/80588/marketing/img/icons/icon_slack_hash_colored.png',
    mcpUrl: slackUserMcpUrl,
    provider: 'slack',
    scopes: [],
    googleClientId: slackClientId,
    googleClientSecret: slackClientSecret,
    oauthAuthorizationUrl: 'https://slack.com/oauth/v2/authorize',
    oauthTokenUrl: 'https://slack.com/api/oauth.v2.access',
    oauthScopes: ['channels:history', 'channels:read', 'groups:history', 'groups:read', 'im:history', 'im:read', 'mpim:history', 'mpim:read', 'chat:write', 'users:read', 'team:read'],
    isLocal: !process.env.SLACK_USER_MCP_URL,
    isActive: true,
  });

  console.error('Default MCP catalog entries seeded.');
}
