// src/db.ts
import { Redis } from 'ioredis';
import pg from 'pg';

const { Pool } = pg;

let redis: Redis | null = null;
let pool: pg.Pool | null = null;
let dbAvailable = false;

const CREATE_USERS_TABLE = `
CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  api_key    VARCHAR(128) NOT NULL UNIQUE,
  email      VARCHAR(255) NOT NULL,
  google_id  VARCHAR(64)  NOT NULL UNIQUE,
  name       VARCHAR(255) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
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
