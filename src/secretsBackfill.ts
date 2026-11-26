// Boot-time pass that brings stored credentials in line with
// TOKEN_ENCRYPTION_KEYS (src/util/secretBox.ts), run by initDatabase before the
// stores are used:
//
// - fills or corrects users.api_key_hash for every row (lookups go by the hash);
// - with encryption on, seals every plaintext credential and re-seals every
//   value sealed with a key that is no longer first in the list (rotation).
//
// Every row update is a compare-and-set on the value it read, so a replica
// writing the row meanwhile (a token refresh) wins and nothing it wrote is
// lost; that row is simply picked up on the next boot. Idempotent, and cheap
// once done: rows already in the target form are skipped without a write.
//
// Turning encryption off again is not a migration this does: with the keys
// removed, sealed values cannot be read at all. Keep the keys.

import type pg from 'pg';
import type { Redis } from 'ioredis';
import {
  activeKeyId,
  isEncryptionEnabled,
  isSealed,
  lookupHash,
  openJson,
  openString,
  sealJson,
  sealString,
  sealedJsonKeyId,
  sealedKeyId,
} from './util/secretBox.js';

type Queryable = Pick<pg.Pool, 'query'>;

export interface BackfillReport {
  table: string;
  updated: number;
  skippedConcurrent: number;
  failed: number;
}

/** True when a sealed or plaintext string should be rewritten under the active key. */
function stringNeedsSeal(value: string | null | undefined): boolean {
  if (!value || !isEncryptionEnabled()) return false;
  return !isSealed(value) || sealedKeyId(value) !== activeKeyId();
}

function jsonNeedsSeal(value: unknown): boolean {
  if (value === null || value === undefined || !isEncryptionEnabled()) return false;
  return sealedJsonKeyId(value) !== activeKeyId();
}

async function backfillUsers(db: Queryable): Promise<BackfillReport> {
  const report: BackfillReport = { table: 'users', updated: 0, skippedConcurrent: 0, failed: 0 };
  const { rows } = await db.query('SELECT id, api_key, api_key_hash FROM users');
  for (const row of rows) {
    try {
      const apiKey = openString(row.api_key);
      // Recomputed, not just checked for presence: a replica on older code
      // that regenerates a key rewrites api_key but leaves the hash, which
      // would otherwise keep matching the revoked key.
      if (row.api_key_hash === lookupHash(apiKey) && !stringNeedsSeal(row.api_key)) continue;
      const result = await db.query(
        'UPDATE users SET api_key = $1, api_key_hash = $2 WHERE id = $3 AND api_key = $4',
        [sealString(apiKey), lookupHash(apiKey), row.id, row.api_key],
      );
      if (result.rowCount) report.updated++;
      else report.skippedConcurrent++;
    } catch (err: any) {
      report.failed++;
      console.error(`[secrets-backfill] users id=${row.id}: ${err?.message || err}`);
    }
  }
  return report;
}

async function backfillConnections(db: Queryable): Promise<BackfillReport> {
  const report: BackfillReport = { table: 'mcp_connections', updated: 0, skippedConcurrent: 0, failed: 0 };
  if (!isEncryptionEnabled()) return report;
  const { rows } = await db.query('SELECT id, google_tokens, provider_tokens FROM mcp_connections');
  for (const row of rows) {
    if (!jsonNeedsSeal(row.google_tokens) && !jsonNeedsSeal(row.provider_tokens)) continue;
    try {
      const google = row.google_tokens === null ? null : JSON.stringify(sealJson(openJson(row.google_tokens)));
      const provider = row.provider_tokens === null ? null : JSON.stringify(sealJson(openJson(row.provider_tokens)));
      const result = await db.query(
        `UPDATE mcp_connections SET google_tokens = COALESCE($1::jsonb, google_tokens), provider_tokens = $2::jsonb
          WHERE id = $3
            AND google_tokens IS NOT DISTINCT FROM $4::jsonb
            AND provider_tokens IS NOT DISTINCT FROM $5::jsonb`,
        [google, provider, row.id, JSON.stringify(row.google_tokens), row.provider_tokens === null ? null : JSON.stringify(row.provider_tokens)],
      );
      if (result.rowCount) report.updated++;
      else report.skippedConcurrent++;
    } catch (err: any) {
      report.failed++;
      console.error(`[secrets-backfill] mcp_connections id=${row.id}: ${err?.message || err}`);
    }
  }
  return report;
}

async function backfillStringColumn(db: Queryable, table: string, column: string): Promise<BackfillReport> {
  const report: BackfillReport = { table: `${table}.${column}`, updated: 0, skippedConcurrent: 0, failed: 0 };
  if (!isEncryptionEnabled()) return report;
  const { rows } = await db.query(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`);
  for (const row of rows) {
    if (!stringNeedsSeal(row.value)) continue;
    try {
      const result = await db.query(
        `UPDATE ${table} SET ${column} = $1 WHERE id = $2 AND ${column} = $3`,
        [sealString(openString(row.value)), row.id, row.value],
      );
      if (result.rowCount) report.updated++;
      else report.skippedConcurrent++;
    } catch (err: any) {
      report.failed++;
      console.error(`[secrets-backfill] ${table} id=${row.id}: ${err?.message || err}`);
    }
  }
  return report;
}

/**
 * Redis holds credentials under two key families:
 * - `mcp_tokens:instance:*` only caches mcp_connections.google_tokens, so a
 *   value not in the target form is deleted and refilled from Postgres;
 * - `tokens:<googleId>` is the ONLY copy of a user's sign-in Google tokens, so
 *   it is re-sealed, under WATCH so a concurrent write wins.
 */
async function backfillRedis(redis: Redis): Promise<BackfillReport> {
  const report: BackfillReport = { table: 'redis', updated: 0, skippedConcurrent: 0, failed: 0 };
  if (!isEncryptionEnabled()) return report;
  for (const pattern of ['mcp_tokens:instance:*', 'tokens:*']) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      for (const key of keys) {
        try {
          if (pattern.startsWith('mcp_tokens')) {
            const value = await redis.get(key);
            if (value !== null && stringNeedsSeal(value)) {
              await redis.del(key);
              report.updated++;
            }
            continue;
          }
          // WATCH before GET: a write between the read and the SET aborts it.
          await redis.watch(key);
          const value = await redis.get(key);
          if (value === null || !stringNeedsSeal(value)) {
            await redis.unwatch();
            continue;
          }
          const result = await redis.multi().set(key, sealString(openString(value))).exec();
          if (result) report.updated++;
          else report.skippedConcurrent++;
        } catch (err: any) {
          await redis.unwatch().catch(() => {});
          report.failed++;
          console.error(`[secrets-backfill] redis ${key.split(':')[0]}:…: ${err?.message || err}`);
        }
      }
    } while (cursor !== '0');
  }
  return report;
}

/**
 * Run every backfill. Never throws for a single bad row (it is logged and
 * counted); a row that cannot be opened (its key is missing from
 * TOKEN_ENCRYPTION_KEYS) also fails at every read, so the log says which.
 */
export async function backfillStoredSecrets(db: Queryable, redis?: Redis): Promise<BackfillReport[]> {
  if (!isEncryptionEnabled()) {
    console.error(process.env.TOKEN_ENCRYPTION_KEYS
      ? '[secrets-backfill] TOKEN_ENCRYPTION_KEYS is set but TOKEN_ENCRYPTION_SEAL is not "true": sealed values are opened, nothing new is sealed (rollout step 2).'
      : '[secrets-backfill] TOKEN_ENCRYPTION_KEYS is not set: tokens and client secrets are stored in PLAINTEXT. See src/util/secretBox.ts for the rollout.');
  }
  const reports = [
    await backfillUsers(db),
    await backfillConnections(db),
    await backfillStringColumn(db, 'mcp_catalog', 'google_client_secret'),
    await backfillStringColumn(db, 'clickup_webhook_subscriptions', 'shared_secret'),
    ...(redis ? [await backfillRedis(redis)] : []),
  ];
  for (const r of reports) {
    if (r.updated || r.skippedConcurrent || r.failed) {
      console.error(`[secrets-backfill] ${r.table}: ${r.updated} updated, ${r.skippedConcurrent} changed meanwhile (next boot), ${r.failed} failed`);
    }
  }
  return reports;
}
