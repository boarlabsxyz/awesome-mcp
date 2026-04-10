// src/db.ts
import { Redis } from 'ioredis';
import pg from 'pg';

const { Pool } = pg;

let redis: Redis | null = null;
let pool: pg.Pool | null = null;
let dbAvailable = false;

const CREATE_USERS_TABLE = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  api_key       VARCHAR(128) NOT NULL UNIQUE,
  email         VARCHAR(255) NOT NULL UNIQUE,
  google_id     VARCHAR(64)  UNIQUE,
  name          VARCHAR(255) NOT NULL DEFAULT '',
  password_hash VARCHAR(255),
  auth_method   VARCHAR(20)  NOT NULL DEFAULT 'google',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
`;

const CREATE_MCP_CONNECTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS mcp_connections (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mcp_slug      VARCHAR(100) NOT NULL,
  google_tokens JSONB NOT NULL,
  connected_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, mcp_slug)
);
`;

const CREATE_MCP_CATALOG_TABLE = `
CREATE TABLE IF NOT EXISTS mcp_catalog (
  id                   SERIAL PRIMARY KEY,
  slug                 VARCHAR(100) NOT NULL UNIQUE,
  name                 VARCHAR(255) NOT NULL,
  description          TEXT,
  icon_url             VARCHAR(2048),
  mcp_url              VARCHAR(2048) NOT NULL,
  scopes               TEXT DEFAULT '[]',
  google_client_id     VARCHAR(255),
  google_client_secret VARCHAR(255),
  oauth_scopes         TEXT DEFAULT '[]',
  is_local             BOOLEAN DEFAULT true,
  is_active            BOOLEAN DEFAULT true,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);
`;

const ALTER_MCP_CATALOG_ADD_SCOPES = `
ALTER TABLE mcp_catalog ADD COLUMN IF NOT EXISTS scopes TEXT DEFAULT '[]';
`;

const ALTER_USERS_ADD_PASSWORD_COLUMNS = `
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255),
  ADD COLUMN IF NOT EXISTS auth_method VARCHAR(20) DEFAULT 'google';
`;

const ALTER_USERS_MAKE_GOOGLE_ID_NULLABLE = `
ALTER TABLE users ALTER COLUMN google_id DROP NOT NULL;
`;

const ALTER_USERS_MAKE_EMAIL_UNIQUE = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_email_key'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
  END IF;
END $$;
`;

const ALTER_MCP_CATALOG_ADD_GOOGLE_CREDENTIALS = `
ALTER TABLE mcp_catalog
  ADD COLUMN IF NOT EXISTS google_client_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS google_client_secret VARCHAR(255),
  ADD COLUMN IF NOT EXISTS oauth_scopes TEXT DEFAULT '[]';
`;

// Multi-instance support: add instance_id, instance_name, google_email columns
const ALTER_MCP_CONNECTIONS_ADD_INSTANCE_COLUMNS = `
ALTER TABLE mcp_connections
  ADD COLUMN IF NOT EXISTS instance_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS instance_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS google_email VARCHAR(255);
`;

// Migrate existing data to have instance_id and instance_name
const MIGRATE_MCP_CONNECTIONS_INSTANCE_DATA = `
UPDATE mcp_connections
SET instance_id = mcp_slug || '-' || id::text,
    instance_name = mcp_slug
WHERE instance_id IS NULL;
`;

// Create index for instance_id lookups
const CREATE_MCP_CONNECTIONS_INSTANCE_INDEX = `
CREATE INDEX IF NOT EXISTS idx_mcp_connections_instance ON mcp_connections(instance_id);
`;

// Drop old unique constraint and add new one for multi-instance support
const DROP_OLD_MCP_CONNECTIONS_CONSTRAINT = `
DO $$
BEGIN
  -- Drop the old unique constraint if it exists
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mcp_connections_user_id_mcp_slug_key'
  ) THEN
    ALTER TABLE mcp_connections DROP CONSTRAINT mcp_connections_user_id_mcp_slug_key;
  END IF;
END $$;
`;

// Provider support: add provider, provider_tokens, provider_email to mcp_connections
const ALTER_MCP_CONNECTIONS_ADD_PROVIDER_COLUMNS = `
ALTER TABLE mcp_connections
  ADD COLUMN IF NOT EXISTS provider VARCHAR(50) DEFAULT 'google',
  ADD COLUMN IF NOT EXISTS provider_tokens JSONB,
  ADD COLUMN IF NOT EXISTS provider_email VARCHAR(255);
`;

// Provider support: add provider, oauth URLs to mcp_catalog
const ALTER_MCP_CATALOG_ADD_PROVIDER_COLUMNS = `
ALTER TABLE mcp_catalog
  ADD COLUMN IF NOT EXISTS provider VARCHAR(50) DEFAULT 'google',
  ADD COLUMN IF NOT EXISTS oauth_authorization_url VARCHAR(2048),
  ADD COLUMN IF NOT EXISTS oauth_token_url VARCHAR(2048);
`;

// Add unique constraint on instance_id (each instance must be unique)
const ADD_INSTANCE_ID_UNIQUE_CONSTRAINT = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mcp_connections_instance_id_key'
  ) THEN
    -- First ensure all instance_ids are unique
    UPDATE mcp_connections SET instance_id = instance_id || '-' || id::text
    WHERE instance_id IN (
      SELECT instance_id FROM mcp_connections GROUP BY instance_id HAVING COUNT(*) > 1
    );
    -- Then add the constraint
    ALTER TABLE mcp_connections ADD CONSTRAINT mcp_connections_instance_id_key UNIQUE (instance_id);
  END IF;
END $$;
`;

export async function initDatabase(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  const databaseUrl = process.env.DATABASE_URL;

  if (!redisUrl || !databaseUrl) {
    console.error('DATABASE_URL or REDIS_URL not set — using file-based storage.');
    dbAvailable = false;
    return;
  }

  try {
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query('SELECT 1');
    console.error('PostgreSQL connected.');

    redis = new Redis(redisUrl);
    await redis.ping();
    console.error('Redis connected.');

    await pool.query(CREATE_USERS_TABLE);
    console.error('Users table ensured.');

    // Run migrations for users table
    await pool.query(ALTER_USERS_ADD_PASSWORD_COLUMNS);
    console.error('Users password columns ensured.');

    // Make google_id nullable for password-based users
    try {
      await pool.query(ALTER_USERS_MAKE_GOOGLE_ID_NULLABLE);
      console.error('Users google_id made nullable.');
    } catch (err: any) {
      // Ignore if already nullable
      if (!err.message.includes('already')) {
        console.error('Note: google_id column update:', err.message);
      }
    }

    // Make email unique
    await pool.query(ALTER_USERS_MAKE_EMAIL_UNIQUE);
    console.error('Users email unique constraint ensured.');

    await pool.query(CREATE_MCP_CONNECTIONS_TABLE);
    console.error('MCP connections table ensured.');

    await pool.query(CREATE_MCP_CATALOG_TABLE);
    console.error('MCP catalog table ensured.');

    // Add scopes column for existing installations
    await pool.query(ALTER_MCP_CATALOG_ADD_SCOPES);
    console.error('MCP catalog scopes column ensured.');

    // Add Google credentials columns to MCP catalog
    await pool.query(ALTER_MCP_CATALOG_ADD_GOOGLE_CREDENTIALS);
    console.error('MCP catalog Google credentials columns ensured.');

    // Multi-instance support: add new columns
    await pool.query(ALTER_MCP_CONNECTIONS_ADD_INSTANCE_COLUMNS);
    console.error('MCP connections instance columns ensured.');

    // Migrate existing connections to have instance_id/instance_name
    await pool.query(MIGRATE_MCP_CONNECTIONS_INSTANCE_DATA);
    console.error('MCP connections instance data migrated.');

    // Create index for instance_id lookups
    await pool.query(CREATE_MCP_CONNECTIONS_INSTANCE_INDEX);
    console.error('MCP connections instance index ensured.');

    // Drop old unique constraint (user_id, mcp_slug) to allow multiple instances
    await pool.query(DROP_OLD_MCP_CONNECTIONS_CONSTRAINT);
    console.error('Old MCP connections constraint dropped (if existed).');

    // Add unique constraint on instance_id
    await pool.query(ADD_INSTANCE_ID_UNIQUE_CONSTRAINT);
    console.error('MCP connections instance_id unique constraint ensured.');

    // Provider support: add provider columns to mcp_connections
    await pool.query(ALTER_MCP_CONNECTIONS_ADD_PROVIDER_COLUMNS);
    console.error('MCP connections provider columns ensured.');

    // Provider support: add provider columns to mcp_catalog
    await pool.query(ALTER_MCP_CATALOG_ADD_PROVIDER_COLUMNS);
    console.error('MCP catalog provider columns ensured.');

    dbAvailable = true;
  } catch (err) {
    console.error('Failed to connect to database(s), falling back to file storage:', err);
    await cleanupPartial();
    dbAvailable = false;
  }
}

async function cleanupPartial(): Promise<void> {
  if (redis) {
    try { redis.disconnect(); } catch {}
    redis = null;
  }
  if (pool) {
    try { await pool.end(); } catch {}
    pool = null;
  }
}

export async function closeDatabase(): Promise<void> {
  if (redis) {
    redis.disconnect();
    redis = null;
    console.error('Redis disconnected.');
  }
  if (pool) {
    await pool.end();
    pool = null;
    console.error('PostgreSQL disconnected.');
  }
  dbAvailable = false;
}

export function getRedis(): Redis {
  if (!redis) throw new Error('Redis not initialized');
  return redis;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error('PostgreSQL pool not initialized');
  return pool;
}

export function isDatabaseAvailable(): boolean {
  return dbAvailable;
}
