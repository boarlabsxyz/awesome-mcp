// Short-lived bearer tokens for the REST data plane (`/api/v1/*`).
//
// Minted by the `mintRestBearerForCurl` MCP tool. Verified by `resolveTokenToUser`
// in webServer.ts so every existing endpoint accepts these tokens too.
//
// Storage mirrors sessionStore.ts: Redis-backed when DATABASE_URL is set,
// in-memory Map otherwise.

import * as crypto from 'node:crypto';
import { isDatabaseAvailable, getRedis } from '../db.js';

export const REST_TOKEN_TTL_SECONDS = 5 * 60;
const REST_TOKEN_TTL_MS = REST_TOKEN_TTL_SECONDS * 1000;
const REDIS_KEY_PREFIX = 'oauth:rest_token:';

export interface RestTokenRecord {
  userId: number;
  /**
   * The MCP instance whose session minted the bearer. With two connections to
   * one service (two Google accounts on Sheets), the REST plane serves this
   * one rather than whichever connection a slug lookup finds first.
   */
  instanceId?: string;
  createdAt: number;
  expiresAt: number;
}

export interface MintedRestToken {
  token: string;
  expiresAt: number;
  ttlSeconds: number;
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

// ---------- In-memory storage (fallback) ----------

const memoryStore = new Map<string, RestTokenRecord>();

// Lookup only cleans the specific key it touches, so tokens minted but never
// looked up would leak forever. Sweep expired entries periodically on mint
// — deterministic, no timer lifecycle to manage.
const SWEEP_EVERY_MINTS = 64;
let mintsSinceLastSweep = 0;

function memorySweep(): void {
  const now = Date.now();
  for (const [token, rec] of memoryStore) {
    if (rec.expiresAt <= now) memoryStore.delete(token);
  }
}

function memoryMint(userId: number, instanceId?: string): MintedRestToken {
  if (++mintsSinceLastSweep >= SWEEP_EVERY_MINTS) {
    mintsSinceLastSweep = 0;
    memorySweep();
  }
  const token = generateToken();
  const now = Date.now();
  memoryStore.set(token, {
    userId,
    ...(instanceId ? { instanceId } : {}),
    createdAt: now,
    expiresAt: now + REST_TOKEN_TTL_MS,
  });
  return { token, expiresAt: now + REST_TOKEN_TTL_MS, ttlSeconds: REST_TOKEN_TTL_SECONDS };
}

function memoryLookup(token: string): RestTokenRecord | null {
  const rec = memoryStore.get(token);
  if (!rec) return null;
  if (rec.expiresAt < Date.now()) {
    memoryStore.delete(token);
    return null;
  }
  return rec;
}

function memoryRevoke(token: string): void {
  memoryStore.delete(token);
}

// ---------- Redis-backed storage ----------

async function redisMint(userId: number, instanceId?: string): Promise<MintedRestToken> {
  const redis = getRedis();
  const token = generateToken();
  const now = Date.now();
  const rec: RestTokenRecord = {
    userId,
    ...(instanceId ? { instanceId } : {}),
    createdAt: now,
    expiresAt: now + REST_TOKEN_TTL_MS,
  };
  await redis.setex(`${REDIS_KEY_PREFIX}${token}`, REST_TOKEN_TTL_SECONDS, JSON.stringify(rec));
  return { token, expiresAt: rec.expiresAt, ttlSeconds: REST_TOKEN_TTL_SECONDS };
}

async function redisLookup(token: string): Promise<RestTokenRecord | null> {
  const redis = getRedis();
  const data = await redis.get(`${REDIS_KEY_PREFIX}${token}`);
  if (!data) return null;
  try {
    const rec: RestTokenRecord = JSON.parse(data);
    if (rec.expiresAt < Date.now()) {
      await redis.del(`${REDIS_KEY_PREFIX}${token}`);
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

async function redisRevoke(token: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`${REDIS_KEY_PREFIX}${token}`);
}

// ---------- Public API ----------

export async function mintRestToken(userId: number, instanceId?: string): Promise<MintedRestToken> {
  if (isDatabaseAvailable()) return redisMint(userId, instanceId);
  return memoryMint(userId, instanceId);
}

/** The full record behind a bearer: who minted it and from which MCP instance. */
export async function lookupRestTokenRecord(token: string): Promise<RestTokenRecord | null> {
  if (!token || typeof token !== 'string') return null;
  if (isDatabaseAvailable()) return redisLookup(token);
  return memoryLookup(token);
}

export async function lookupRestToken(token: string): Promise<number | null> {
  return (await lookupRestTokenRecord(token))?.userId ?? null;
}

export async function revokeRestToken(token: string): Promise<void> {
  if (isDatabaseAvailable()) return redisRevoke(token);
  return memoryRevoke(token);
}
