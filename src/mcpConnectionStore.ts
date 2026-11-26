// src/mcpConnectionStore.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { nanoid } from 'nanoid';
import { isDatabaseAvailable, getPool, getRedis } from './db.js';
import { sealJson, openJson, sealString, openString } from './util/secretBox.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const CONNECTIONS_FILE = path.join(DATA_DIR, 'mcp-connections.json');

export interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
}

export interface ClickUpTokens {
  access_token: string;
}

export interface SlackAccessRules {
  allowedOrgs: string[];        // Team IDs permitted (current org auto-included)
  blacklistUsers: string[];     // User IDs to block (DMs with these users forbidden)
  whitelistChannels: string[];  // Glob patterns for allowed channel names (e.g. "*", "eng-*")
  blacklistChannels: string[];  // Glob patterns for blocked channel names (e.g. "secret-*")
  allowPublicOnly: boolean;     // If true, only public channels pass
}

export interface SlackUserTokens {
  access_token: string;
  accessRules?: SlackAccessRules;
  allowedChannels?: string[];   // Legacy, kept for migration
}

/** Migrate old SlackUserTokens (allowedChannels) to new accessRules format. */
export function migrateSlackTokens(tokens: any): SlackUserTokens {
  if (tokens.accessRules) return tokens;
  return {
    access_token: tokens.access_token,
    accessRules: {
      allowedOrgs: [],
      blacklistUsers: [],
      whitelistChannels: [],
      blacklistChannels: [],
      allowPublicOnly: false,
    },
    allowedChannels: tokens.allowedChannels || [],
  };
}

export interface OutlineTokens {
  access_token: string;
  /** OAuth authorization_code flow only. Absent for pasted personal API keys. */
  refresh_token?: string;
  /** Access-token expiry as ms-epoch. Absent = non-expiring (personal API key). */
  expiry_date?: number;
  /** Per-connection Outline base URL (e.g. https://wiki.example.com). */
  baseUrl?: string;
}

export type ProviderTokens = GoogleTokens | ClickUpTokens | SlackUserTokens | OutlineTokens;

export interface McpConnection {
  id: number;
  userId: number;
  mcpSlug: string;
  instanceId: string;      // URL-safe unique identifier for this instance
  instanceName: string;    // User-friendly display name
  googleEmail: string | null; // Connected Google account email
  googleTokens: GoogleTokens;
  connectedAt: string;
  updatedAt: string;
  provider?: string;              // 'google' | 'clickup', defaults to 'google'
  providerTokens?: ProviderTokens;
  providerEmail?: string | null;
}

// ---------- File-based storage (fallback) ----------

interface FileConnection {
  id: number;
  userId: number;
  mcpSlug: string;
  instanceId: string;
  instanceName: string;
  googleEmail: string | null;
  googleTokens: GoogleTokens;
  connectedAt: string;
  updatedAt: string;
  provider?: string;
  providerTokens?: ProviderTokens;
  providerEmail?: string | null;
}

let connections: FileConnection[] = [];
let loaded = false;
let writeLock: Promise<void> = Promise.resolve();
let nextId = 1;

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function fileLoadConnections(): Promise<void> {
  if (loaded) return;
  await ensureDataDir();
  try {
    const content = await fs.readFile(CONNECTIONS_FILE, 'utf-8');
    connections = (JSON.parse(content) as FileConnection[]).map(c => ({
      ...c,
      googleTokens: c.googleTokens ? openJson(c.googleTokens) : c.googleTokens,
      providerTokens: c.providerTokens ? openJson(c.providerTokens) : c.providerTokens,
    }));
    nextId = connections.length > 0 ? Math.max(...connections.map(c => c.id)) + 1 : 1;
    loaded = true;
    console.error(`Loaded ${connections.length} MCP connection(s) from ${CONNECTIONS_FILE}`);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      connections = [];
      loaded = true;
      console.error('No existing MCP connections file, starting fresh.');
    } else {
      throw err;
    }
  }
}

async function saveConnections(): Promise<void> {
  writeLock = writeLock.then(async () => {
    await ensureDataDir();
    // Sealed on disk like in Postgres; the in-memory list stays plaintext.
    const onDisk = connections.map(c => ({
      ...c,
      googleTokens: sealJson(c.googleTokens),
      providerTokens: c.providerTokens ? sealJson(c.providerTokens) : c.providerTokens,
    }));
    await fs.writeFile(CONNECTIONS_FILE, JSON.stringify(onDisk, null, 2));
  });
  await writeLock;
}

async function fileConnectMcp(
  userId: number,
  mcpSlug: string,
  tokens: GoogleTokens,
  instanceName?: string,
  googleEmail?: string | null
): Promise<McpConnection> {
  await fileLoadConnections();

  // For backward compatibility: find existing connection by userId + mcpSlug (single-instance behavior)
  // New instances will have unique instanceIds
  const existingIndex = connections.findIndex(
    c => c.userId === userId && c.mcpSlug === mcpSlug && !instanceName
  );

  const now = new Date().toISOString();

  if (existingIndex >= 0) {
    // Update existing connection
    connections[existingIndex].googleTokens = tokens;
    connections[existingIndex].updatedAt = now;
    if (googleEmail !== undefined) {
      connections[existingIndex].googleEmail = googleEmail;
    }
    await saveConnections();
    return connections[existingIndex];
  }

  // Create new connection with unique instanceId
  const instanceId = nanoid(10);
  const connection: FileConnection = {
    id: nextId++,
    userId,
    mcpSlug,
    instanceId,
    instanceName: instanceName || mcpSlug,
    googleEmail: googleEmail || null,
    googleTokens: tokens,
    connectedAt: now,
    updatedAt: now,
  };
  connections.push(connection);
  await saveConnections();
  return connection;
}

async function fileGetMcpConnection(
  userId: number,
  mcpSlug: string
): Promise<McpConnection | null> {
  await fileLoadConnections();
  return connections.find(c => c.userId === userId && c.mcpSlug === mcpSlug) || null;
}

async function fileGetUserConnectedMcps(userId: number): Promise<McpConnection[]> {
  await fileLoadConnections();
  return connections.filter(c => c.userId === userId);
}

async function fileDisconnectMcp(userId: number, mcpSlug: string): Promise<boolean> {
  await fileLoadConnections();
  const index = connections.findIndex(c => c.userId === userId && c.mcpSlug === mcpSlug);
  if (index < 0) return false;
  connections.splice(index, 1);
  await saveConnections();
  return true;
}

async function fileUpdateMcpTokens(
  userId: number,
  mcpSlug: string,
  tokens: Partial<GoogleTokens>
): Promise<void> {
  await fileLoadConnections();
  const connection = connections.find(c => c.userId === userId && c.mcpSlug === mcpSlug);
  if (!connection) return;
  connection.googleTokens = { ...connection.googleTokens, ...tokens };
  connection.updatedAt = new Date().toISOString();
  await saveConnections();
}

async function fileGetMcpConnectionByInstanceId(
  instanceId: string
): Promise<McpConnection | null> {
  await fileLoadConnections();
  return connections.find(c => c.instanceId === instanceId) || null;
}

async function fileCreateMcpInstance(
  userId: number,
  mcpSlug: string,
  instanceName: string,
  tokens: GoogleTokens,
  googleEmail: string | null,
  provider?: string,
  providerTokens?: ProviderTokens,
  providerEmail?: string | null
): Promise<McpConnection> {
  await fileLoadConnections();

  const now = new Date().toISOString();
  const instanceId = nanoid(10);

  const connection: FileConnection = {
    id: nextId++,
    userId,
    mcpSlug,
    instanceId,
    instanceName,
    googleEmail,
    googleTokens: tokens,
    connectedAt: now,
    updatedAt: now,
    provider,
    providerTokens,
    providerEmail,
  };
  connections.push(connection);
  await saveConnections();
  return connection;
}

async function fileUpdateMcpInstanceName(
  instanceId: string,
  newName: string
): Promise<boolean> {
  await fileLoadConnections();
  const connection = connections.find(c => c.instanceId === instanceId);
  if (!connection) return false;
  connection.instanceName = newName;
  connection.updatedAt = new Date().toISOString();
  await saveConnections();
  return true;
}

async function fileUpdateMcpInstanceGoogleEmail(
  instanceId: string,
  googleEmail: string
): Promise<boolean> {
  await fileLoadConnections();
  const connection = connections.find(c => c.instanceId === instanceId);
  if (!connection) return false;
  connection.googleEmail = googleEmail;
  connection.updatedAt = new Date().toISOString();
  await saveConnections();
  return true;
}

async function fileDisconnectMcpInstance(instanceId: string): Promise<boolean> {
  await fileLoadConnections();
  const index = connections.findIndex(c => c.instanceId === instanceId);
  if (index < 0) return false;
  connections.splice(index, 1);
  await saveConnections();
  return true;
}

// ---------- Database-backed storage ----------

// Credentials are sealed at rest (src/util/secretBox.ts) whenever
// TOKEN_ENCRYPTION_KEYS is set: every write below goes through these, every
// read through mapDbRowToConnection or openCachedTokens. Plaintext rows from
// before encryption still read; initDatabase seals them (sealExistingSecrets).

/** The JSON text for a google_tokens / provider_tokens parameter. */
function tokensParam(tokens: unknown): string {
  return JSON.stringify(sealJson(tokens));
}

/** The Redis cache value for an instance's Google tokens. */
function cachedTokensValue(tokens: unknown): string {
  return sealString(JSON.stringify(tokens));
}

function openCachedTokens(cached: string): GoogleTokens {
  return JSON.parse(openString(cached));
}

function mapDbRowToConnection(row: any): McpConnection {
  const googleTokens = row.google_tokens ? openJson(row.google_tokens) : row.google_tokens;
  let providerTokens: ProviderTokens | undefined;
  if (row.provider_tokens) {
    providerTokens = openJson<ProviderTokens>(row.provider_tokens);
  }
  return {
    id: row.id,
    userId: row.user_id,
    mcpSlug: row.mcp_slug,
    instanceId: row.instance_id || `${row.mcp_slug}-${row.id}`,
    instanceName: row.instance_name || row.mcp_slug,
    googleEmail: row.google_email,
    googleTokens: googleTokens || {},
    connectedAt: row.connected_at instanceof Date ? row.connected_at.toISOString() : row.connected_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    provider: row.provider || 'google',
    providerTokens,
    providerEmail: row.provider_email || null,
  };
}

async function dbConnectMcp(
  userId: number,
  mcpSlug: string,
  tokens: GoogleTokens,
  instanceName?: string,
  googleEmail?: string | null
): Promise<McpConnection> {
  const pool = getPool();
  const redis = getRedis();

  // For backward compatibility when no instanceName provided, check if legacy instance exists
  if (!instanceName) {
    // Check for existing legacy instance
    const { rows: existing } = await pool.query(
      `SELECT id, instance_id FROM mcp_connections
       WHERE user_id = $1 AND mcp_slug = $2 AND instance_id LIKE '%-legacy'
       LIMIT 1`,
      [userId, mcpSlug]
    );

    if (existing.length > 0) {
      // Update existing legacy instance
      const { rows } = await pool.query(
        `UPDATE mcp_connections
         SET google_tokens = $1, google_email = COALESCE($2, google_email), updated_at = NOW()
         WHERE id = $3
         RETURNING id, user_id, mcp_slug, instance_id, instance_name, google_email, google_tokens, connected_at, updated_at`,
        [tokensParam(tokens), googleEmail, existing[0].id]
      );
      const row = rows[0];

      await redis.set(
        `mcp_tokens:instance:${row.instance_id}`,
        cachedTokensValue(tokens),
        'EX',
        3600
      );

      return mapDbRowToConnection(row);
    }
  }

  // Create new instance (either with provided name or as new legacy instance)
  const instanceId = instanceName ? nanoid(10) : `${mcpSlug}-legacy`;
  const finalInstanceName = instanceName || mcpSlug;

  const { rows } = await pool.query(
    `INSERT INTO mcp_connections (user_id, mcp_slug, instance_id, instance_name, google_email, google_tokens, connected_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     RETURNING id, user_id, mcp_slug, instance_id, instance_name, google_email, google_tokens, connected_at, updated_at`,
    [userId, mcpSlug, instanceId, finalInstanceName, googleEmail || null, tokensParam(tokens)]
  );

  const row = rows[0];

  // Cache tokens in Redis for fast lookup by instanceId
  await redis.set(
    `mcp_tokens:instance:${row.instance_id}`,
    cachedTokensValue(tokens),
    'EX',
    3600 // 1 hour cache
  );

  return mapDbRowToConnection(row);
}

async function dbGetMcpConnection(
  userId: number,
  mcpSlug: string
): Promise<McpConnection | null> {
  const pool = getPool();

  // Fall back to database - get first connection for this mcp_slug (legacy behavior)
  const { rows } = await pool.query(
    `SELECT id, user_id, mcp_slug, instance_id, instance_name, google_email, google_tokens, connected_at, updated_at, provider, provider_tokens, provider_email
     FROM mcp_connections
     WHERE user_id = $1 AND mcp_slug = $2
     ORDER BY connected_at ASC
     LIMIT 1`,
    [userId, mcpSlug]
  );

  if (rows.length === 0) return null;
  return mapDbRowToConnection(rows[0]);
}

async function dbGetUserConnectedMcps(userId: number): Promise<McpConnection[]> {
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT id, user_id, mcp_slug, instance_id, instance_name, google_email, google_tokens, connected_at, updated_at, provider, provider_tokens, provider_email
     FROM mcp_connections
     WHERE user_id = $1
     ORDER BY connected_at DESC`,
    [userId]
  );

  return rows.map(mapDbRowToConnection);
}

async function dbDisconnectMcp(userId: number, mcpSlug: string): Promise<boolean> {
  const pool = getPool();
  const redis = getRedis();

  const { rowCount } = await pool.query(
    `DELETE FROM mcp_connections WHERE user_id = $1 AND mcp_slug = $2`,
    [userId, mcpSlug]
  );

  // Clear cache
  await redis.del(`mcp_tokens:${userId}:${mcpSlug}`);

  return (rowCount ?? 0) > 0;
}

async function dbUpdateMcpTokens(
  userId: number,
  mcpSlug: string,
  tokens: Partial<GoogleTokens>
): Promise<void> {
  const pool = getPool();
  const redis = getRedis();

  // Get current tokens
  const connection = await dbGetMcpConnection(userId, mcpSlug);
  if (!connection) return;

  const mergedTokens = { ...connection.googleTokens, ...tokens };

  await pool.query(
    `UPDATE mcp_connections
     SET google_tokens = $1, updated_at = NOW()
     WHERE user_id = $2 AND mcp_slug = $3`,
    [tokensParam(mergedTokens), userId, mcpSlug]
  );

  // Update cache by instanceId
  if (connection.instanceId) {
    await redis.set(
      `mcp_tokens:instance:${connection.instanceId}`,
      cachedTokensValue(mergedTokens),
      'EX',
      3600
    );
  }
}

async function dbGetMcpConnectionByInstanceId(
  instanceId: string
): Promise<McpConnection | null> {
  const pool = getPool();
  const redis = getRedis();

  // Try Redis cache first
  const cached = await redis.get(`mcp_tokens:instance:${instanceId}`);
  if (cached) {
    const { rows } = await pool.query(
      `SELECT id, user_id, mcp_slug, instance_id, instance_name, google_email, connected_at, updated_at, provider, provider_tokens, provider_email
       FROM mcp_connections
       WHERE instance_id = $1`,
      [instanceId]
    );
    if (rows.length === 0) {
      await redis.del(`mcp_tokens:instance:${instanceId}`);
      return null;
    }
    const row = rows[0];
    const conn = mapDbRowToConnection(row);
    conn.googleTokens = openCachedTokens(cached);
    return conn;
  }

  // Fall back to database
  const { rows } = await pool.query(
    `SELECT id, user_id, mcp_slug, instance_id, instance_name, google_email, google_tokens, connected_at, updated_at, provider, provider_tokens, provider_email
     FROM mcp_connections
     WHERE instance_id = $1`,
    [instanceId]
  );

  if (rows.length === 0) return null;

  const conn = mapDbRowToConnection(rows[0]);

  // Cache for future lookups
  await redis.set(
    `mcp_tokens:instance:${instanceId}`,
    cachedTokensValue(conn.googleTokens),
    'EX',
    3600
  );

  return conn;
}

async function dbCreateMcpInstance(
  userId: number,
  mcpSlug: string,
  instanceName: string,
  tokens: GoogleTokens,
  googleEmail: string | null,
  provider?: string,
  providerTokens?: ProviderTokens,
  providerEmail?: string | null
): Promise<McpConnection> {
  const pool = getPool();
  const redis = getRedis();

  const instanceId = nanoid(10);

  const { rows } = await pool.query(
    `INSERT INTO mcp_connections (user_id, mcp_slug, instance_id, instance_name, google_email, google_tokens, connected_at, updated_at, provider, provider_tokens, provider_email)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), $7, $8, $9)
     RETURNING id, user_id, mcp_slug, instance_id, instance_name, google_email, google_tokens, connected_at, updated_at, provider, provider_tokens, provider_email`,
    [userId, mcpSlug, instanceId, instanceName, googleEmail, tokensParam(tokens), provider || 'google', providerTokens ? tokensParam(providerTokens) : null, providerEmail || null]
  );

  const row = rows[0];

  // Cache tokens in Redis
  await redis.set(
    `mcp_tokens:instance:${instanceId}`,
    cachedTokensValue(tokens),
    'EX',
    3600
  );

  return mapDbRowToConnection(row);
}

async function dbUpdateMcpInstanceName(
  instanceId: string,
  newName: string
): Promise<boolean> {
  const pool = getPool();

  const { rowCount } = await pool.query(
    `UPDATE mcp_connections
     SET instance_name = $1, updated_at = NOW()
     WHERE instance_id = $2`,
    [newName, instanceId]
  );

  return (rowCount ?? 0) > 0;
}

async function dbUpdateMcpInstanceGoogleEmail(
  instanceId: string,
  googleEmail: string
): Promise<boolean> {
  const pool = getPool();

  const { rowCount } = await pool.query(
    `UPDATE mcp_connections
     SET google_email = $1, updated_at = NOW()
     WHERE instance_id = $2`,
    [googleEmail, instanceId]
  );

  return (rowCount ?? 0) > 0;
}

async function dbDisconnectMcpInstance(instanceId: string): Promise<boolean> {
  const pool = getPool();
  const redis = getRedis();

  const { rowCount } = await pool.query(
    `DELETE FROM mcp_connections WHERE instance_id = $1`,
    [instanceId]
  );

  // Clear cache
  await redis.del(`mcp_tokens:instance:${instanceId}`);

  return (rowCount ?? 0) > 0;
}

async function dbUpdateMcpInstanceTokens(
  instanceId: string,
  tokens: Partial<GoogleTokens>
): Promise<void> {
  const pool = getPool();
  const redis = getRedis();

  // Get current connection
  const connection = await dbGetMcpConnectionByInstanceId(instanceId);
  if (!connection) return;

  const mergedTokens = { ...connection.googleTokens, ...tokens };

  await pool.query(
    `UPDATE mcp_connections
     SET google_tokens = $1, updated_at = NOW()
     WHERE instance_id = $2`,
    [tokensParam(mergedTokens), instanceId]
  );

  // Update cache
  await redis.set(
    `mcp_tokens:instance:${instanceId}`,
    cachedTokensValue(mergedTokens),
    'EX',
    3600
  );
}

// ---------- Public API ----------

export async function connectMcp(
  userId: number,
  mcpSlug: string,
  tokens: GoogleTokens,
  instanceName?: string,
  googleEmail?: string | null
): Promise<McpConnection> {
  if (isDatabaseAvailable()) {
    return dbConnectMcp(userId, mcpSlug, tokens, instanceName, googleEmail);
  }
  return fileConnectMcp(userId, mcpSlug, tokens, instanceName, googleEmail);
}

export async function getMcpConnection(
  userId: number,
  mcpSlug: string
): Promise<McpConnection | null> {
  if (isDatabaseAvailable()) {
    return dbGetMcpConnection(userId, mcpSlug);
  }
  return fileGetMcpConnection(userId, mcpSlug);
}

export async function getUserConnectedMcps(userId: number): Promise<McpConnection[]> {
  if (isDatabaseAvailable()) {
    return dbGetUserConnectedMcps(userId);
  }
  return fileGetUserConnectedMcps(userId);
}

export async function disconnectMcp(userId: number, mcpSlug: string): Promise<boolean> {
  if (isDatabaseAvailable()) {
    return dbDisconnectMcp(userId, mcpSlug);
  }
  return fileDisconnectMcp(userId, mcpSlug);
}

export async function updateMcpTokens(
  userId: number,
  mcpSlug: string,
  tokens: Partial<GoogleTokens>
): Promise<void> {
  if (isDatabaseAvailable()) {
    return dbUpdateMcpTokens(userId, mcpSlug, tokens);
  }
  return fileUpdateMcpTokens(userId, mcpSlug, tokens);
}

// Clear cached tokens (useful after token refresh)
export async function clearMcpTokensCache(userId: number, mcpSlug: string): Promise<void> {
  if (isDatabaseAvailable()) {
    const redis = getRedis();
    await redis.del(`mcp_tokens:${userId}:${mcpSlug}`);
  }
}

// === New Instance-based functions ===

export async function getMcpConnectionByInstanceId(
  instanceId: string
): Promise<McpConnection | null> {
  if (isDatabaseAvailable()) {
    return dbGetMcpConnectionByInstanceId(instanceId);
  }
  return fileGetMcpConnectionByInstanceId(instanceId);
}

export async function createMcpInstance(
  userId: number,
  mcpSlug: string,
  instanceName: string,
  tokens: GoogleTokens,
  googleEmail: string | null,
  provider?: string,
  providerTokens?: ProviderTokens,
  providerEmail?: string | null
): Promise<McpConnection> {
  // Ensure unique instance name per user
  const existing = await getUserConnectedMcps(userId);
  const existingNames = new Set(existing.map(c => c.instanceName));
  let uniqueName = instanceName;
  if (existingNames.has(uniqueName)) {
    let counter = 2;
    while (existingNames.has(`${instanceName} ${counter}`)) {
      counter++;
    }
    uniqueName = `${instanceName} ${counter}`;
  }

  if (isDatabaseAvailable()) {
    return dbCreateMcpInstance(userId, mcpSlug, uniqueName, tokens, googleEmail, provider, providerTokens, providerEmail);
  }
  return fileCreateMcpInstance(userId, mcpSlug, uniqueName, tokens, googleEmail, provider, providerTokens, providerEmail);
}

export async function updateMcpInstanceName(
  instanceId: string,
  newName: string
): Promise<boolean> {
  if (isDatabaseAvailable()) {
    return dbUpdateMcpInstanceName(instanceId, newName);
  }
  return fileUpdateMcpInstanceName(instanceId, newName);
}

export async function updateMcpInstanceGoogleEmail(
  instanceId: string,
  googleEmail: string
): Promise<boolean> {
  if (isDatabaseAvailable()) {
    return dbUpdateMcpInstanceGoogleEmail(instanceId, googleEmail);
  }
  return fileUpdateMcpInstanceGoogleEmail(instanceId, googleEmail);
}

export async function disconnectMcpInstance(instanceId: string): Promise<boolean> {
  if (isDatabaseAvailable()) {
    return dbDisconnectMcpInstance(instanceId);
  }
  return fileDisconnectMcpInstance(instanceId);
}

export async function updateMcpInstanceTokens(
  instanceId: string,
  tokens: Partial<GoogleTokens>
): Promise<void> {
  if (isDatabaseAvailable()) {
    return dbUpdateMcpInstanceTokens(instanceId, tokens);
  }
  // File-based: find and update by instanceId
  const connection = await fileGetMcpConnectionByInstanceId(instanceId);
  if (connection) {
    await fileUpdateMcpTokens(connection.userId, connection.mcpSlug, tokens);
  }
}

/** keepIfAbsent semantics: the kept keys the row holds (non-null), overlaid by `fresh`. */
function mergeKeepingAbsent(
  current: Record<string, unknown>,
  fresh: Record<string, unknown>,
  keep: readonly string[],
): Record<string, unknown> {
  const carried: Record<string, unknown> = {};
  for (const key of keep) {
    if (current[key] !== undefined && current[key] !== null) carried[key] = current[key];
  }
  return { ...carried, ...fresh };
}

/**
 * patch semantics: null when an expected key no longer holds its value
 * (null = absent), else `current` with `changes` set and `removed` deleted.
 */
function applyProviderTokensPatch(
  current: Record<string, unknown>,
  changes: Record<string, unknown>,
  removed: readonly string[],
  expected: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (expected && Object.entries(expected).some(([key, value]) => stableJson(current[key] ?? null) !== stableJson(value))) {
    return null;
  }
  const next: Record<string, unknown> = { ...current, ...changes };
  for (const key of removed) delete next[key];
  return next;
}

/**
 * Read-modify-write of one row's provider_tokens under a row lock.
 *
 * These merges used to run inside the UPDATE, on jsonb keys. A sealed column
 * is one opaque value, so the merge now happens here, in a transaction that
 * holds the row (`SELECT ... FOR UPDATE`) from the read to the write: two
 * writers owning different keys (a token refresh, a settings save) still
 * cannot undo each other, which is what the in-SQL merge guaranteed. `merge`
 * returns null to write nothing. Resolves false when the row is gone or
 * nothing was written.
 */
async function withLockedProviderTokens(
  instanceId: string,
  merge: (current: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT provider_tokens FROM mcp_connections WHERE instance_id = $1 FOR UPDATE',
      [instanceId],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const current = (rows[0].provider_tokens ? openJson(rows[0].provider_tokens) : {}) as Record<string, unknown>;
    const next = merge(current ?? {});
    if (next === null) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      'UPDATE mcp_connections SET provider_tokens = $1, updated_at = NOW() WHERE instance_id = $2',
      // Round-trip through JSON so the stored value matches what the old
      // jsonb merge stored (undefined dropped, Dates as strings).
      [tokensParam(JSON.parse(JSON.stringify(next))), instanceId],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Replaces provider_tokens whole.
 *
 * `keepIfAbsent` names keys to carry over from the row AS IT IS AT WRITE TIME
 * whenever `providerTokens` leaves them empty (undefined, null or ''). The
 * carry happens under the row lock, not from an earlier read, so a reconnect
 * cannot drop a setting saved while it ran.
 */
export async function updateMcpInstanceProviderTokens(
  instanceId: string,
  providerTokens: ProviderTokens,
  opts: { keepIfAbsent?: readonly string[] } = {}
): Promise<void> {
  const keep = opts.keepIfAbsent ?? [];
  const fresh: Record<string, unknown> = { ...providerTokens };
  for (const key of keep) {
    if (fresh[key] === undefined || fresh[key] === null || fresh[key] === '') delete fresh[key];
  }
  if (isDatabaseAvailable()) {
    await withLockedProviderTokens(instanceId, current => mergeKeepingAbsent(current, fresh, keep));
  } else {
    // File-based: find and update by instanceId
    await fileLoadConnections();
    const connection = connections.find(c => c.instanceId === instanceId);
    if (connection) {
      const current = (connection.providerTokens ?? {}) as Record<string, unknown>;
      connection.providerTokens = mergeKeepingAbsent(current, fresh, keep) as unknown as ProviderTokens;
      connection.updatedAt = new Date().toISOString();
      await saveConnections();
    }
  }
}

/**
 * Sets the given provider_tokens keys and deletes those given as undefined,
 * leaving every other key as the row has it at write time. Done under a row
 * lock, so two writers that own different keys (a token refresh, a settings
 * save) cannot undo each other the way read, spread and replace can.
 *
 * `expect` makes it a compare-and-set, for a writer that merged into what it
 * read: the write happens only while each named key still holds that value
 * (undefined = absent). Resolves false when nothing was written — the row is
 * gone, or an expected key changed — so the caller can re-read and retry, or
 * report the connection missing, instead of claiming a save that never landed.
 */
export async function patchMcpInstanceProviderTokens(
  instanceId: string,
  changes: Record<string, unknown>,
  opts: { expect?: Record<string, unknown> } = {}
): Promise<boolean> {
  const removed = Object.keys(changes).filter(key => changes[key] === undefined);
  // JSON null stands for "absent", so an expected undefined matches a missing key.
  const expected = opts.expect
    ? Object.fromEntries(Object.entries(opts.expect).map(([key, value]) => [key, value ?? null]))
    : null;
  if (isDatabaseAvailable()) {
    return withLockedProviderTokens(instanceId, current => applyProviderTokensPatch(current, changes, removed, expected));
  }
  await fileLoadConnections();
  const connection = connections.find(c => c.instanceId === instanceId);
  if (!connection) return false;
  const next = applyProviderTokensPatch((connection.providerTokens ?? {}) as Record<string, unknown>, changes, removed, expected);
  if (next === null) return false;
  connection.providerTokens = next as unknown as ProviderTokens;
  connection.updatedAt = new Date().toISOString();
  await saveConnections();
  return true;
}

/** JSON with sorted object keys, so equal values compare equal like jsonb's `=`. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function clearMcpInstanceTokensCache(instanceId: string): Promise<void> {
  if (isDatabaseAvailable()) {
    const redis = getRedis();
    await redis.del(`mcp_tokens:instance:${instanceId}`);
  }
}
