// src/migrate.ts
// One-time migration: reads ./data/users.json and inserts into Postgres + Redis.
// Run: npx tsx src/migrate.ts
// Requires DATABASE_URL and REDIS_URL env vars.

import * as fs from 'fs/promises';
import * as path from 'path';
import pg from 'pg';
import { Redis } from 'ioredis';

const { Pool } = pg;

interface StoredUser {
  apiKey: string;
  email: string;
  googleId: string;
  name: string;
  tokens: {
    access_token: string;
    refresh_token: string;
    scope: string;
    token_type: string;
    expiry_date: number;
  };
  createdAt: string;
  updatedAt: string;
}

async function migrate() {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;

  if (!databaseUrl || !redisUrl) {
    console.error('DATABASE_URL and REDIS_URL must be set.');
    process.exit(1);
  }

  const dataDir = process.env.DATA_DIR || './data';
  const usersFile = path.join(dataDir, 'users.json');

  let usersData: Record<string, StoredUser>;
  try {
    const content = await fs.readFile(usersFile, 'utf-8');
    usersData = JSON.parse(content);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      console.error(`No users file found at ${usersFile}, nothing to migrate.`);
      process.exit(0);
    }
    throw err;
  }

  const users = Object.values(usersData);
  console.error(`Found ${users.length} user(s) to migrate.`);

  const pool = new Pool({ connectionString: databaseUrl });
  const redis = new Redis(redisUrl);

  // Ensure table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      api_key    VARCHAR(128) NOT NULL UNIQUE,
      email      VARCHAR(255) NOT NULL,
      google_id  VARCHAR(64)  NOT NULL UNIQUE,
      name       VARCHAR(255) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `);

  let migrated = 0;
  for (const user of users) {
    try {
      await pool.query(
        `INSERT INTO users (api_key, email, google_id, name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (google_id) DO UPDATE SET
           email = EXCLUDED.email,
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [user.apiKey, user.email, user.googleId, user.name, user.createdAt, user.updatedAt]
      );

      await redis.set(`tokens:${user.googleId}`, JSON.stringify(user.tokens));
      migrated++;
      console.error(`  Migrated: ${user.email}`);
    } catch (err) {
      console.error(`  Failed to migrate ${user.email}:`, err);
    }
  }

  console.error(`Migration complete: ${migrated}/${users.length} user(s) migrated.`);

  redis.disconnect();
  await pool.end();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
