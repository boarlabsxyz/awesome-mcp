// src/mcpConnectionStore.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { nanoid } from 'nanoid';
import { isDatabaseAvailable, getPool, getRedis } from './db.js';

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

export type ProviderTokens = GoogleTokens | ClickUpTokens | SlackUserTokens;

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
    connections = JSON.parse(content);
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
    await fs.writeFile(CONNECTIONS_FILE, JSON.stringify(connections, null, 2));
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

function mapDbRowToConnection(row: any): McpConnection {
  const googleTokens = typeof row.google_tokens === 'string'
    ? JSON.parse(row.google_tokens)
    : row.google_tokens;
  let providerTokens: ProviderTokens | undefined;
  if (row.provider_tokens) {
    providerTokens = typeof row.provider_tokens === 'string'
      ? JSON.parse(row.provider_tokens)
      : row.provider_tokens;
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
        [JSON.stringify(tokens), googleEmail, existing[0].id]
      );
      const row = rows[0];

      await redis.set(
        `mcp_tokens:instance:${row.instance_id}`,
        JSON.stringify(tokens),
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
    [userId, mcpSlug, instanceId, finalInstanceName, googleEmail || null, JSON.stringify(tokens)]
  );

  const row = rows[0];

  // Cache tokens in Redis for fast lookup by instanceId
  await redis.set(
    `mcp_tokens:instance:${row.instance_id}`,
    JSON.stringify(tokens),
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
    [JSON.stringify(mergedTokens), userId, mcpSlug]
  );

  // Update cache by instanceId
  if (connection.instanceId) {
    await redis.set(
      `mcp_tokens:instance:${connection.instanceId}`,
      JSON.stringify(mergedTokens),
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
    conn.googleTokens = JSON.parse(cached);
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
    JSON.stringify(conn.googleTokens),
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
    [userId, mcpSlug, instanceId, instanceName, googleEmail, JSON.stringify(tokens), provider || 'google', providerTokens ? JSON.stringify(providerTokens) : null, providerEmail || null]
  );

  const row = rows[0];

  // Cache tokens in Redis
  await redis.set(
    `mcp_tokens:instance:${instanceId}`,
    JSON.stringify(tokens),
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
    [JSON.stringify(mergedTokens), instanceId]
  );

  // Update cache
  await redis.set(
    `mcp_tokens:instance:${instanceId}`,
    JSON.stringify(mergedTokens),
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
  if (isDatabaseAvailable()) {
    return dbCreateMcpInstance(userId, mcpSlug, instanceName, tokens, googleEmail, provider, providerTokens, providerEmail);
  }
  return fileCreateMcpInstance(userId, mcpSlug, instanceName, tokens, googleEmail, provider, providerTokens, providerEmail);
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

export async function updateMcpInstanceProviderTokens(
  instanceId: string,
  providerTokens: ProviderTokens
): Promise<void> {
  if (isDatabaseAvailable()) {
    const pool = getPool();
    await pool.query(
      `UPDATE mcp_connections SET provider_tokens = $1::jsonb, updated_at = NOW() WHERE instance_id = $2`,
      [JSON.stringify(providerTokens), instanceId]
    );
  } else {
    // File-based: find and update by instanceId
    await fileLoadConnections();
    const connection = connections.find(c => c.instanceId === instanceId);
    if (connection) {
      connection.providerTokens = providerTokens;
      connection.updatedAt = new Date().toISOString();
      await saveConnections();
    }
  }
}

export async function clearMcpInstanceTokensCache(instanceId: string): Promise<void> {
  if (isDatabaseAvailable()) {
    const redis = getRedis();
    await redis.del(`mcp_tokens:instance:${instanceId}`);
  }
}
