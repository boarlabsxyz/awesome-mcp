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

// Auth0 subject identifier for JWT-based authentication
const ALTER_USERS_ADD_AUTH0_SUB = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth0_sub VARCHAR(255) UNIQUE;
`;

// Provider support: add provider, oauth URLs to mcp_catalog
const ALTER_MCP_CATALOG_ADD_PROVIDER_COLUMNS = `
ALTER TABLE mcp_catalog
  ADD COLUMN IF NOT EXISTS provider VARCHAR(50) DEFAULT 'google',
  ADD COLUMN IF NOT EXISTS oauth_authorization_url VARCHAR(2048),
  ADD COLUMN IF NOT EXISTS oauth_token_url VARCHAR(2048);
`;

// ClickUp task-event webhook subscriptions.
// One row per (user, workspace) — per-user scoping keeps a departing user's
// creator-binding failure to their own digest rather than everyone's. The
// shared_secret is stored as-is: it's issued per-webhook by ClickUp and is
// only ever used HMAC-side for verifying inbound POSTs; we don't send it back
// out to the caller.
const CREATE_CLICKUP_WEBHOOK_SUBSCRIPTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS clickup_webhook_subscriptions (
  id                   SERIAL PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id         VARCHAR(100) NOT NULL,
  clickup_webhook_id   VARCHAR(100) NOT NULL,
  shared_secret        VARCHAR(255) NOT NULL,
  events               JSONB NOT NULL,
  status               VARCHAR(20) NOT NULL DEFAULT 'active',
  fail_count           INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, workspace_id),
  UNIQUE(clickup_webhook_id)
);
`;

// Normalized task-event store. One row per history_item (a single ClickUp
// webhook POST can carry several: e.g. moving a task also fires a status
// change). from_val / to_val are stringified for querying; raw_payload keeps
// the full history_item for anything the routine needs later.
const CREATE_CLICKUP_TASK_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS clickup_task_events (
  id                BIGSERIAL PRIMARY KEY,
  subscription_id   INTEGER NOT NULL REFERENCES clickup_webhook_subscriptions(id) ON DELETE CASCADE,
  workspace_id      VARCHAR(100) NOT NULL,
  task_id           VARCHAR(100) NOT NULL,
  event_type        VARCHAR(50) NOT NULL,
  field             VARCHAR(50),
  from_val          TEXT,
  to_val            TEXT,
  actor_id          VARCHAR(100),
  actor_username    VARCHAR(255),
  occurred_at       BIGINT NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_payload       JSONB NOT NULL
);
`;

const CREATE_CLICKUP_EVENTS_WORKSPACE_TASK_INDEX = `
CREATE INDEX IF NOT EXISTS idx_clickup_events_ws_task_time
  ON clickup_task_events(workspace_id, task_id, occurred_at DESC);
`;

const CREATE_CLICKUP_EVENTS_SUBSCRIPTION_INDEX = `
CREATE INDEX IF NOT EXISTS idx_clickup_events_sub_time
  ON clickup_task_events(subscription_id, occurred_at DESC);
`;

// Slack channel-event subscriptions.
//
// Unlike ClickUp there is no remote object to mirror: Slack event subscriptions
// are declared once on the app, and every workspace event arrives at one
// Request URL. A row here is purely a local interest filter — "this user wants
// these event types from this channel" — which is why there is no
// slack_webhook_id and no per-row shared_secret (verification uses the
// app-level SLACK_SIGNING_SECRET). N users can watch the same channel, so
// ingestion looks rows up by (team, channel) and fans out.
const CREATE_SLACK_EVENT_SUBSCRIPTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS slack_event_subscriptions (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id        VARCHAR(100) NOT NULL,
  channel_id     VARCHAR(100) NOT NULL,
  events         JSONB NOT NULL,
  match_pattern  TEXT,
  status         VARCHAR(20) NOT NULL DEFAULT 'active',
  fail_count     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, team_id, channel_id)
);
`;

// Captured Slack events, one row per (subscription, event).
//
// UNIQUE(subscription_id, event_id) is load-bearing in a way the ClickUp
// equivalent isn't: Slack retries any delivery it doesn't get a prompt 2xx for
// (flagging the retry in X-Slack-Retry-Num), so without a dedup key a single
// slow response duplicates every event in the window. Slack's own `event_id`
// is the natural key — ClickUp never provided one.
const CREATE_SLACK_CHANNEL_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS slack_channel_events (
  id               BIGSERIAL PRIMARY KEY,
  subscription_id  INTEGER NOT NULL REFERENCES slack_event_subscriptions(id) ON DELETE CASCADE,
  team_id          VARCHAR(100) NOT NULL,
  channel_id       VARCHAR(100) NOT NULL,
  event_id         VARCHAR(100) NOT NULL,
  event_type       VARCHAR(50) NOT NULL,
  message_ts       VARCHAR(50),
  thread_ts        VARCHAR(50),
  actor_id         VARCHAR(100),
  text             TEXT,
  occurred_at      BIGINT NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_payload      JSONB NOT NULL,
  UNIQUE(subscription_id, event_id)
);
`;

const CREATE_SLACK_EVENTS_CHANNEL_INDEX = `
CREATE INDEX IF NOT EXISTS idx_slack_events_team_channel_time
  ON slack_channel_events(team_id, channel_id, occurred_at DESC);
`;

const CREATE_SLACK_EVENTS_SUBSCRIPTION_INDEX = `
CREATE INDEX IF NOT EXISTS idx_slack_events_sub_time
  ON slack_channel_events(subscription_id, occurred_at DESC);
`;

// Lookup path for ingestion: one POST arrives per event and must find every
// subscription interested in that (team, channel).
const CREATE_SLACK_SUBSCRIPTIONS_CHANNEL_INDEX = `
CREATE INDEX IF NOT EXISTS idx_slack_subs_team_channel
  ON slack_event_subscriptions(team_id, channel_id);
`;

// Re-hosted images for ClickUp Docs. ClickUp Doc pages render markdown, so an
// image is embedded as ![alt](url) pointing at our own public serve route
// (/images/clickup-doc/:id). Bytes live here; see src/clickup/docImageStore.ts.
const CREATE_CLICKUP_DOC_IMAGES_TABLE = `
CREATE TABLE IF NOT EXISTS clickup_doc_images (
  id          TEXT PRIMARY KEY,
  bytes       BYTEA NOT NULL,
  mime        TEXT NOT NULL,
  byte_size   INTEGER NOT NULL,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

// Content-addressed image blob store (WebP, sha256-keyed). The DDL lives here
// with the other migrations, but all DML is confined to src/images/imageBlobStore.ts
// (the swap-to-R2 seam). STORAGE EXTERNAL disables TOAST compression: WebP is
// already compressed, so column compression would just waste CPU on every write.
const CREATE_IMAGE_BLOBS_TABLE = `
CREATE TABLE IF NOT EXISTS image_blobs (
  key          TEXT PRIMARY KEY,
  data         BYTEA NOT NULL,
  content_type TEXT NOT NULL,
  bytes        INT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const ALTER_IMAGE_BLOBS_STORAGE_EXTERNAL = `
ALTER TABLE image_blobs ALTER COLUMN data SET STORAGE EXTERNAL;
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

    // Auth0 subject identifier for JWT-based auth
    await pool.query(ALTER_USERS_ADD_AUTH0_SUB);
    console.error('Users auth0_sub column ensured.');

    // Provider support: add provider columns to mcp_connections
    await pool.query(ALTER_MCP_CONNECTIONS_ADD_PROVIDER_COLUMNS);
    console.error('MCP connections provider columns ensured.');

    // Provider support: add provider columns to mcp_catalog
    await pool.query(ALTER_MCP_CATALOG_ADD_PROVIDER_COLUMNS);
    console.error('MCP catalog provider columns ensured.');

    // ClickUp webhook subscriptions + task event store (PR1: schema + ingestion)
    await pool.query(CREATE_CLICKUP_WEBHOOK_SUBSCRIPTIONS_TABLE);
    console.error('ClickUp webhook subscriptions table ensured.');
    await pool.query(CREATE_CLICKUP_TASK_EVENTS_TABLE);
    console.error('ClickUp task events table ensured.');
    await pool.query(CREATE_CLICKUP_EVENTS_WORKSPACE_TASK_INDEX);
    await pool.query(CREATE_CLICKUP_EVENTS_SUBSCRIPTION_INDEX);
    console.error('ClickUp task events indexes ensured.');
    // Slack channel-event subscriptions + event store
    await pool.query(CREATE_SLACK_EVENT_SUBSCRIPTIONS_TABLE);
    console.error('Slack event subscriptions table ensured.');
    await pool.query(CREATE_SLACK_CHANNEL_EVENTS_TABLE);
    console.error('Slack channel events table ensured.');
    await pool.query(CREATE_SLACK_EVENTS_CHANNEL_INDEX);
    await pool.query(CREATE_SLACK_EVENTS_SUBSCRIPTION_INDEX);
    await pool.query(CREATE_SLACK_SUBSCRIPTIONS_CHANNEL_INDEX);
    console.error('Slack channel events indexes ensured.');
    await pool.query(CREATE_CLICKUP_DOC_IMAGES_TABLE);
    console.error('ClickUp doc images table ensured.');
    await pool.query(CREATE_IMAGE_BLOBS_TABLE);
    await pool.query(ALTER_IMAGE_BLOBS_STORAGE_EXTERNAL);
    console.error('Image blobs table ensured.');

    dbAvailable = true;

    // Kick off the retention scheduler now that dbAvailable=true. Dynamic
    // import to avoid a boot-time cycle with the clickup module.
    try {
      const { startTaskEventRetentionScheduler } = await import('./clickup/taskEventStore.js');
      startTaskEventRetentionScheduler();
    } catch (err: any) {
      console.error('[db] failed to start ClickUp event retention scheduler:', err?.message || err);
    }
    try {
      const { startSlackEventRetentionScheduler } = await import('./slack/eventStore.js');
      startSlackEventRetentionScheduler();
    } catch (err: any) {
      console.error('[db] failed to start Slack event retention scheduler:', err?.message || err);
    }
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
