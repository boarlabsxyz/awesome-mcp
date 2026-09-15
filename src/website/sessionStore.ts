// src/sessionStore.ts
import * as crypto from 'crypto';
import { isDatabaseAvailable, getRedis } from '../db.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days in seconds

export interface Session {
  /**
   * The account this session belongs to (users.id).
   *
   * Sessions used to be keyed by `googleId` alone, which made every
   * session-backed route Google-only by construction: an email+password
   * account has no Google identity, so the `getUserByGoogleId` lookup behind
   * each of them was a guaranteed miss. `userId` is now the identity; see
   * `resolveSessionUser` in webServer.ts.
   *
   * Optional because sessions minted before this change are still in Redis
   * with only a googleId, and they keep working until they expire.
   */
  userId?: number;
  googleId?: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Who a session is for. A bare string is the legacy googleId form, kept so
 * existing callers (and tests) read unchanged.
 */
export type SessionIdentity = string | { userId?: number; googleId?: string };

function toIdentity(identity: SessionIdentity): { userId?: number; googleId?: string } {
  return typeof identity === 'string' ? { googleId: identity } : identity;
}

// ---------- In-memory storage (fallback) ----------

const sessions: Map<string, Session> = new Map();

function memoryCreateSession(identity: SessionIdentity): string {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(sessionId, {
    ...toIdentity(identity),
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  return sessionId;
}

function memoryGetSession(sessionId: string): Session | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function memoryDeleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}

// ---------- Redis-backed storage ----------

async function redisCreateSession(identity: SessionIdentity): Promise<string> {
  const redis = getRedis();
  const sessionId = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const session: Session = {
    ...toIdentity(identity),
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  await redis.setex(`session:${sessionId}`, SESSION_TTL_SECONDS, JSON.stringify(session));
  return sessionId;
}

async function redisGetSession(sessionId: string): Promise<Session | null> {
  const redis = getRedis();
  const data = await redis.get(`session:${sessionId}`);
  if (!data) return null;
  const session: Session = JSON.parse(data);
  if (session.expiresAt < Date.now()) {
    await redis.del(`session:${sessionId}`);
    return null;
  }
  return session;
}

async function redisDeleteSession(sessionId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`session:${sessionId}`);
}

// ---------- Public API ----------

export async function createSession(identity: SessionIdentity): Promise<string> {
  if (isDatabaseAvailable()) {
    return redisCreateSession(identity);
  }
  return memoryCreateSession(identity);
}

export async function getSession(sessionId: string): Promise<Session | null> {
  if (isDatabaseAvailable()) {
    return redisGetSession(sessionId);
  }
  return memoryGetSession(sessionId);
}

export async function deleteSession(sessionId: string): Promise<void> {
  if (isDatabaseAvailable()) {
    return redisDeleteSession(sessionId);
  }
  return memoryDeleteSession(sessionId);
}
