// src/userStore.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { isDatabaseAvailable, getPool, getRedis, initDatabase } from './db.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const USERS_FILE = path.join(DATA_DIR, 'users.json');

export interface UserProfile {
  id?: number;
  apiKey: string;
  email: string;
  googleId: string | null;
  auth0Sub?: string;
  name: string;
  authMethod: 'google' | 'password';
  createdAt: string;
  updatedAt: string;
}

export interface UserTokens {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
}

export interface UserRecord extends UserProfile {
  tokens?: UserTokens;
}

// ---------- File-based storage (fallback) ----------

// In-memory store keyed by apiKey
let users: Record<string, UserRecord> = {};
let nextFileUserId = 1;
let loaded = false;

// Simple mutex to prevent concurrent writes
let writeLock: Promise<void> = Promise.resolve();

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function fileLoadUsers(): Promise<void> {
  if (loaded) return;
  await ensureDataDir();
  try {
    const content = await fs.readFile(USERS_FILE, 'utf-8');
    users = JSON.parse(content);
    // Restore auto-increment counter from existing user IDs
    const maxId = Math.max(0, ...Object.values(users).map(u => u.id ?? 0));
    nextFileUserId = maxId + 1;
    loaded = true;
    console.error(`Loaded ${Object.keys(users).length} user(s) from ${USERS_FILE}`);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      users = {};
      loaded = true;
      console.error('No existing users file, starting fresh.');
    } else {
      throw err;
    }
  }
}

async function saveUsers(): Promise<void> {
  writeLock = writeLock.then(async () => {
    await ensureDataDir();
    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
  });
  await writeLock;
}

function fileGetUserByApiKey(apiKey: string): UserRecord | undefined {
  return users[apiKey];
}

function fileGetUserByGoogleId(googleId: string): UserRecord | undefined {
  return Object.values(users).find(u => u.googleId === googleId);
}

function fileGetUserByEmail(email: string): UserRecord | undefined {
  return Object.values(users).find(u => u.email === email);
}

async function fileCreateOrUpdateUser(
  profile: { email: string; googleId: string; name: string },
  tokens: UserTokens
): Promise<UserRecord> {
  await fileLoadUsers();
  const existing = fileGetUserByGoogleId(profile.googleId);
  if (existing) {
    existing.email = profile.email;
    existing.name = profile.name;
    existing.tokens = tokens;
    existing.updatedAt = new Date().toISOString();
    await saveUsers();
    return existing;
  }
  const apiKey = generateApiKey();
  const user: UserRecord = {
    id: nextFileUserId++,
    apiKey,
    email: profile.email,
    googleId: profile.googleId,
    name: profile.name,
    authMethod: 'google',
    tokens,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  users[apiKey] = user;
  await saveUsers();
  return user;
}

async function fileUpdateTokens(apiKey: string, tokens: Partial<UserTokens>): Promise<void> {
  const user = users[apiKey];
  if (!user) return;
  if (!user.tokens) {
    user.tokens = tokens as UserTokens;
  } else {
    user.tokens = { ...user.tokens, ...tokens };
  }
  user.updatedAt = new Date().toISOString();
  await saveUsers();
}

// ---------- Database-backed storage ----------

const DB_USER_COLUMNS = 'id, api_key, email, google_id, auth0_sub, name, auth_method, created_at, updated_at';

/** Load tokens from Redis for a given google_id (returns undefined if none). */
async function loadTokensFromRedis(googleId: string | null): Promise<UserTokens | undefined> {
  if (!googleId) return undefined;
  const redis = getRedis();
  const tokensJson = await redis.get(`tokens:${googleId}`);
  return tokensJson ? JSON.parse(tokensJson) : undefined;
}

/** Map a database row to a UserRecord. */
function rowToUserRecord(row: any, tokens?: UserTokens): UserRecord {
  return {
    id: row.id,
    apiKey: row.api_key,
    email: row.email,
    googleId: row.google_id,
    auth0Sub: row.auth0_sub,
    name: row.name,
    authMethod: row.auth_method || 'google',
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    tokens,
  };
}

/** Query a single user by a WHERE clause and map to UserRecord. */
async function dbGetUserBy(whereClause: string, params: any[]): Promise<UserRecord | undefined> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT ${DB_USER_COLUMNS} FROM users WHERE ${whereClause}`,
    params
  );
  if (rows.length === 0) return undefined;
  const row = rows[0];
  const tokens = await loadTokensFromRedis(row.google_id);
  return rowToUserRecord(row, tokens);
}

async function dbGetUserByApiKey(apiKey: string): Promise<UserRecord | undefined> {
  return dbGetUserBy('api_key = $1', [apiKey]);
}

async function dbGetUserByGoogleId(googleId: string): Promise<UserRecord | undefined> {
  return dbGetUserBy('google_id = $1', [googleId]);
}

async function dbGetUserByEmail(email: string): Promise<UserRecord | undefined> {
  return dbGetUserBy('email = $1', [email]);
}

async function dbGetUserById(id: number): Promise<UserRecord | undefined> {
  return dbGetUserBy('id = $1', [id]);
}

async function dbCreateOrUpdateUser(
  profile: { email: string; googleId: string; name: string },
  tokens: UserTokens
): Promise<UserRecord> {
  const pool = getPool();
  const redis = getRedis();

  const now = new Date();

  // Check if user exists by googleId first, then by email (for password->google migration)
  let existing = await dbGetUserByGoogleId(profile.googleId);
  if (!existing) {
    // Check if user exists with same email (password auth user linking Google)
    const emailUser = await dbGetUserByEmail(profile.email);
    if (emailUser) {
      existing = emailUser;
    }
  }
  const apiKey = existing?.apiKey ?? generateApiKey();

  // Use upsert on email to handle both cases:
  // 1. New user (insert)
  // 2. Existing user by googleId (update via google_id conflict)
  // 3. Existing user by email only (update via email conflict - links Google account)
  const { rows } = await pool.query(
    `INSERT INTO users (api_key, email, google_id, name, auth_method, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'google', $5, $5)
     ON CONFLICT (email) DO UPDATE SET
       google_id = EXCLUDED.google_id,
       name = EXCLUDED.name,
       auth_method = 'google',
       updated_at = EXCLUDED.updated_at
     RETURNING id, api_key, email, google_id, name, auth_method, created_at, updated_at`,
    [apiKey, profile.email, profile.googleId, profile.name, now]
  );

  const row = rows[0];

  // Store tokens in Redis
  await redis.set(`tokens:${profile.googleId}`, JSON.stringify(tokens));

  return rowToUserRecord(row, tokens);
}

async function dbUpdateTokens(apiKey: string, tokens: Partial<UserTokens>): Promise<void> {
  const pool = getPool();
  const redis = getRedis();

  const { rows } = await pool.query(
    'SELECT google_id FROM users WHERE api_key = $1',
    [apiKey]
  );
  if (rows.length === 0) return;

  const googleId = rows[0].google_id;

  // Merge with existing tokens
  const existingJson = await redis.get(`tokens:${googleId}`);
  const existing: UserTokens = existingJson ? JSON.parse(existingJson) : {} as UserTokens;
  const merged = { ...existing, ...tokens };

  await redis.set(`tokens:${googleId}`, JSON.stringify(merged));
  await pool.query('UPDATE users SET updated_at = NOW() WHERE api_key = $1', [apiKey]);
}

// ---------- Get All Users ----------

function fileGetAllUsers(): UserProfile[] {
  return Object.values(users).map(({ tokens, ...profile }) => profile);
}

async function dbGetAllUsers(): Promise<UserProfile[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id, api_key, email, google_id, name, auth_method, created_at, updated_at FROM users ORDER BY created_at DESC'
  );
  return rows.map((row: any) => ({
    ...rowToUserRecord(row),
  }));
}

// ---------- Public API ----------

export function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

export async function loadUsers(): Promise<void> {
  if (isDatabaseAvailable()) {
    // DB mode: initDatabase() already ran, nothing to load into memory
    return;
  }
  await fileLoadUsers();
}

export async function getAllUsers(): Promise<UserProfile[]> {
  if (isDatabaseAvailable()) {
    return dbGetAllUsers();
  }
  await fileLoadUsers();
  return fileGetAllUsers();
}

export async function getUserByApiKey(apiKey: string): Promise<UserRecord | undefined> {
  if (isDatabaseAvailable()) {
    return dbGetUserByApiKey(apiKey);
  }
  return fileGetUserByApiKey(apiKey);
}

export async function getUserByGoogleId(googleId: string): Promise<UserRecord | undefined> {
  if (isDatabaseAvailable()) {
    return dbGetUserByGoogleId(googleId);
  }
  return fileGetUserByGoogleId(googleId);
}

export async function getUserByEmail(email: string): Promise<UserRecord | undefined> {
  if (isDatabaseAvailable()) {
    return dbGetUserByEmail(email);
  }
  return fileGetUserByEmail(email);
}

export async function getUserById(id: number): Promise<UserRecord | undefined> {
  if (isDatabaseAvailable()) {
    return dbGetUserById(id);
  }
  await fileLoadUsers();
  return Object.values(users).find(u => u.id === id);
}

export async function createOrUpdateUser(
  profile: { email: string; googleId: string; name: string },
  tokens: UserTokens
): Promise<UserRecord> {
  if (isDatabaseAvailable()) {
    return dbCreateOrUpdateUser(profile, tokens);
  }
  return fileCreateOrUpdateUser(profile, tokens);
}

export async function updateTokens(apiKey: string, tokens: Partial<UserTokens>): Promise<void> {
  if (isDatabaseAvailable()) {
    return dbUpdateTokens(apiKey, tokens);
  }
  return fileUpdateTokens(apiKey, tokens);
}

// ---------- Auth0 Subject Mapping ----------

async function dbGetUserByAuth0Sub(sub: string): Promise<UserRecord | undefined> {
  return dbGetUserBy('auth0_sub = $1', [sub]);
}

function fileGetUserByAuth0Sub(sub: string): UserRecord | undefined {
  return Object.values(users).find(u => u.auth0Sub === sub);
}

export async function getUserByAuth0Sub(sub: string): Promise<UserRecord | undefined> {
  if (isDatabaseAvailable()) {
    return dbGetUserByAuth0Sub(sub);
  }
  await fileLoadUsers();
  return fileGetUserByAuth0Sub(sub);
}

async function dbSetAuth0Sub(userId: number, sub: string): Promise<void> {
  const pool = getPool();
  await pool.query('UPDATE users SET auth0_sub = $1, updated_at = NOW() WHERE id = $2', [sub, userId]);
}

async function fileSetAuth0Sub(userId: number, sub: string): Promise<void> {
  const user = Object.values(users).find(u => u.id === userId);
  if (user) {
    user.auth0Sub = sub;
    user.updatedAt = new Date().toISOString();
    await saveUsers();
  }
}

export async function setAuth0Sub(userId: number, sub: string): Promise<void> {
  if (isDatabaseAvailable()) {
    return dbSetAuth0Sub(userId, sub);
  }
  return fileSetAuth0Sub(userId, sub);
}

// ---------- Create User (minimal, for JWT-based auth) ----------

async function dbCreateUser(profile: { email: string; name: string; auth0Sub?: string }): Promise<UserRecord> {
  const pool = getPool();
  const apiKey = generateApiKey();
  const { rows } = await pool.query(
    `INSERT INTO users (api_key, email, google_id, auth0_sub, name, auth_method, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $4, 'google', NOW(), NOW())
     RETURNING id, api_key, email, google_id, auth0_sub, name, auth_method, created_at, updated_at`,
    [apiKey, profile.email, profile.auth0Sub || null, profile.name]
  );
  return rowToUserRecord(rows[0]);
}

async function fileCreateUser(profile: { email: string; name: string; auth0Sub?: string }): Promise<UserRecord> {
  await fileLoadUsers();
  const apiKey = generateApiKey();
  const user: UserRecord = {
    id: nextFileUserId++,
    apiKey,
    email: profile.email,
    googleId: null,
    auth0Sub: profile.auth0Sub,
    name: profile.name,
    authMethod: 'google',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  users[apiKey] = user;
  await saveUsers();
  return user;
}

export async function createUser(profile: { email: string; name: string; auth0Sub?: string }): Promise<UserRecord> {
  if (isDatabaseAvailable()) {
    return dbCreateUser(profile);
  }
  return fileCreateUser(profile);
}

// ---------- Regenerate API Key ----------

async function fileRegenerateApiKey(googleId: string): Promise<UserRecord | null> {
  await fileLoadUsers();
  const existing = fileGetUserByGoogleId(googleId);
  if (!existing) return null;

  // Remove old entry
  delete users[existing.apiKey];

  // Generate new key and update user
  const newApiKey = generateApiKey();
  existing.apiKey = newApiKey;
  existing.updatedAt = new Date().toISOString();

  // Store under new key
  users[newApiKey] = existing;
  await saveUsers();

  return existing;
}

async function dbRegenerateApiKey(googleId: string): Promise<UserRecord | null> {
  const pool = getPool();
  const redis = getRedis();

  // Check if user exists
  const { rows: existingRows } = await pool.query(
    'SELECT google_id FROM users WHERE google_id = $1',
    [googleId]
  );
  if (existingRows.length === 0) return null;

  // Generate new key and update
  const newApiKey = generateApiKey();
  const { rows } = await pool.query(
    `UPDATE users SET api_key = $1, updated_at = NOW()
     WHERE google_id = $2
     RETURNING id, api_key, email, google_id, name, auth_method, created_at, updated_at`,
    [newApiKey, googleId]
  );

  const row = rows[0];
  const tokens = await loadTokensFromRedis(googleId);
  if (!tokens) return null;

  return rowToUserRecord(row, tokens);
}

export async function regenerateApiKey(googleId: string): Promise<UserRecord | null> {
  if (isDatabaseAvailable()) {
    return dbRegenerateApiKey(googleId);
  }
  return fileRegenerateApiKey(googleId);
}
