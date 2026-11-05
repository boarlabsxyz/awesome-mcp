// Per-user sandbox state in Redis: which sandbox is the user's, the one-run-
// at-a-time lock, and the daily quota counters. Redis, not process memory, so
// every replica of the Sandbox MCP sees the same sandbox, lock and spend.
import * as crypto from 'node:crypto';
import { UserError } from 'fastmcp';
import { getRedis, isDatabaseAvailable } from '../db.js';

/** The slice of ioredis this module uses (a fake implements it in tests). */
export interface Kv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: 'PX', ms: number, nx?: 'NX'): Promise<'OK' | null>;
  del(key: string): Promise<number>;
  incrby(key: string, by: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/** The shared Redis client, or null when this service has none. */
export function sandboxKv(): Kv | null {
  return isDatabaseAvailable() ? (getRedis() as unknown as Kv) : null;
}

const sandboxKey = (userId: number) => `sandbox:user:${userId}`;
const lockKey = (userId: number) => `sandbox:lock:${userId}`;
const quotaKey = (userId: number, day: string, what: 'runs' | 'secs') => `sandbox:quota:${userId}:${day}:${what}`;

/**
 * How long the user→sandbox mapping is kept. The vendor's own timeout decides
 * when the sandbox dies; a mapping that outlives it is harmless (connect finds
 * nothing and a fresh one is made), so this only has to outlast the longest
 * sandbox life (24 h on E2B Pro).
 */
const MAPPING_TTL_MS = 25 * 3600_000;

export async function getSandboxId(kv: Kv, userId: number): Promise<string | null> {
  return kv.get(sandboxKey(userId));
}

export async function setSandboxId(kv: Kv, userId: number, id: string): Promise<void> {
  await kv.set(sandboxKey(userId), id, 'PX', MAPPING_TTL_MS);
}

export async function clearSandboxId(kv: Kv, userId: number): Promise<void> {
  await kv.del(sandboxKey(userId));
}

/**
 * Runs fn holding the user's sandbox lock, or refuses at once if another call
 * holds it — a queue would strand the caller's socket behind a 5-minute run.
 * Every call that touches the sandbox takes it, so creating a sandbox is
 * serialized too: two overlapping calls cannot start two. The TTL frees a
 * lock whose holder died.
 */
export async function withSandboxLock<T>(kv: Kv, userId: number, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const token = crypto.randomBytes(12).toString('hex');
  const got = await kv.set(lockKey(userId), token, 'PX', ttlMs, 'NX');
  if (got !== 'OK') {
    throw new UserError('Your sandbox is busy with another call (a run may still be in progress). Wait for it to finish, then try again.');
  }
  try {
    return await fn();
  } finally {
    // Release only our own lock: if it expired and another call took it, it is theirs.
    if ((await kv.get(lockKey(userId)).catch(() => null)) === token) await kv.del(lockKey(userId)).catch(() => 0);
  }
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Limits, read per call so an env change needs only a restart. */
export function sandboxLimits() {
  return {
    maxRunsPerDay: envInt('SANDBOX_MAX_RUNS_PER_DAY', 200),
    maxSecondsPerDay: envInt('SANDBOX_MAX_SECONDS_PER_DAY', 3600),
    maxTimeoutSec: Math.min(envInt('SANDBOX_MAX_TIMEOUT_SEC', 300), 300),
    idleMinutes: envInt('SANDBOX_IDLE_MINUTES', 10),
  };
}

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
const QUOTA_TTL_SECONDS = 48 * 3600;

export interface Usage {
  day: string;
  runs: number;
  seconds: number;
}

export async function readUsage(kv: Kv, userId: number, now: number): Promise<Usage> {
  const day = utcDay(now);
  const [runs, secs] = await Promise.all([kv.get(quotaKey(userId, day, 'runs')), kv.get(quotaKey(userId, day, 'secs'))]);
  return { day, runs: Number(runs ?? 0), seconds: Number(secs ?? 0) };
}

/**
 * Refuses the run when today's runs or run-seconds are spent; otherwise
 * charges the run. Seconds are charged after the run (chargeSeconds), with the
 * time actually used. Callers treat a Redis error here as a refusal: an open
 * counter spends our money.
 */
export async function chargeRun(kv: Kv, userId: number, now: number): Promise<Usage> {
  const limits = sandboxLimits();
  const usage = await readUsage(kv, userId, now);
  if (usage.runs >= limits.maxRunsPerDay) {
    throw new UserError(`Daily sandbox limit reached: ${usage.runs} of ${limits.maxRunsPerDay} runs today (UTC). It resets at midnight UTC.`);
  }
  if (usage.seconds >= limits.maxSecondsPerDay) {
    throw new UserError(`Daily sandbox limit reached: ${usage.seconds} of ${limits.maxSecondsPerDay} seconds of run time today (UTC). It resets at midnight UTC.`);
  }
  const key = quotaKey(userId, usage.day, 'runs');
  const runs = await kv.incrby(key, 1);
  await kv.expire(key, QUOTA_TTL_SECONDS);
  return { ...usage, runs };
}

export async function chargeSeconds(kv: Kv, userId: number, day: string, seconds: number): Promise<void> {
  const key = quotaKey(userId, day, 'secs');
  await kv.incrby(key, seconds);
  await kv.expire(key, QUOTA_TTL_SECONDS);
}
