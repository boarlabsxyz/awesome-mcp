// src/userStore.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { isDatabaseAvailable, getPool, getRedis, initDatabase } from './db.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const USERS_FILE = path.join(DATA_DIR, 'users.json');

export interface UserProfile {
  apiKey: string;
  email: string;
  googleId: string;
  name: string;
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
  tokens: UserTokens;
}

// ---------- File-based storage (fallback) ----------

// In-memory store keyed by apiKey
let users: Record<string, UserRecord> = {};
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
    apiKey,
    email: profile.email,
    googleId: profile.googleId,
    name: profile.name,
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
  user.tokens = { ...user.tokens, ...tokens };
  user.updatedAt = new Date().toISOString();
  await saveUsers();
}

// ---------- Database-backed storage ----------

async function dbGetUserByApiKey(apiKey: string): Promise<UserRecord | undefined> {
  const pool = getPool();
  const redis = getRedis();

  const { rows } = await pool.query(
    'SELECT api_key, email, google_id, name, created_at, updated_at FROM users WHERE api_key = $1',
    [apiKey]
  );
  if (rows.length === 0) return undefined;

  const row = rows[0];
  const tokensJson = await redis.get(`tokens:${row.google_id}`);
  if (!tokensJson) return undefined;

  return {
    apiKey: row.api_key,
    email: row.email,
    googleId: row.google_id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    tokens: JSON.parse(tokensJson),
  };
}

async function dbGetUserByGoogleId(googleId: string): Promise<UserRecord | undefined> {
  const pool = getPool();
  const redis = getRedis();

  const { rows } = await pool.query(
    'SELECT api_key, email, google_id, name, created_at, updated_at FROM users WHERE google_id = $1',
    [googleId]
  );
  if (rows.length === 0) return undefined;

  const row = rows[0];
  const tokensJson = await redis.get(`tokens:${row.google_id}`);
  if (!tokensJson) return undefined;

  return {
    apiKey: row.api_key,
    email: row.email,
    googleId: row.google_id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    tokens: JSON.parse(tokensJson),
  };
}

async function dbCreateOrUpdateUser(
  profile: { email: string; googleId: string; name: string },
  tokens: UserTokens
): Promise<UserRecord> {
  const pool = getPool();
  const redis = getRedis();

  const now = new Date();

  // Check if user exists to preserve their apiKey
  const existing = await dbGetUserByGoogleId(profile.googleId);
  const apiKey = existing?.apiKey ?? generateApiKey();

  const { rows } = await pool.query(
    `INSERT INTO users (api_key, email, google_id, name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (google_id) DO UPDATE SET
       email = EXCLUDED.email,
       name = EXCLUDED.name,
       updated_at = EXCLUDED.updated_at
     RETURNING api_key, email, google_id, name, created_at, updated_at`,
    [apiKey, profile.email, profile.googleId, profile.name, now]
  );

  const row = rows[0];

  // Store tokens in Redis
  await redis.set(`tokens:${profile.googleId}`, JSON.stringify(tokens));

  return {
    apiKey: row.api_key,
    email: row.email,
    googleId: row.google_id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    tokens,
  };
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
