// src/sessionStore.ts
import * as crypto from 'crypto';
import { isDatabaseAvailable, getRedis } from './db.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days in seconds

export interface Session {
  googleId: string;
  createdAt: number;
  expiresAt: number;
}

// ---------- In-memory storage (fallback) ----------

const sessions: Map<string, Session> = new Map();

function memoryCreateSession(googleId: string): string {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(sessionId, {
    googleId,
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

async function redisCreateSession(googleId: string): Promise<string> {
  const redis = getRedis();
  const sessionId = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const session: Session = {
    googleId,
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

export async function createSession(googleId: string): Promise<string> {
  if (isDatabaseAvailable()) {
    return redisCreateSession(googleId);
  }
  return memoryCreateSession(googleId);
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
