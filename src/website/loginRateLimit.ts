// src/website/loginRateLimit.ts
//
// Attempt throttling for the email+password endpoints. Password login is the
// one route here where an attacker can guess the credential offline-style, one
// HTTP request at a time, so it needs a ceiling that the Google OAuth path
// never did.
import { isDatabaseAvailable, getRedis } from '../db.js';

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the caller may retry. Only meaningful when blocked. */
  retryAfter: number;
}

/** Attempts tolerated inside one window before a per-client key is blocked. */
const MAX_ATTEMPTS = 8;

/**
 * Ceiling across all callers combined, which the per-key buckets cannot
 * provide: `trust proxy: true` lets a client rewrite its apparent IP, and the
 * email dimension is caller-chosen too, so an attacker can mint an endless
 * supply of fresh buckets and keep every one of them under its own limit
 * while spending ~190ms of bcrypt CPU per request.
 *
 * The trade-off is deliberate and worth stating: an attacker who burns this
 * bucket also blocks legitimate sign-ins for the rest of the window. That is
 * load-shedding, and it is the better failure — a saturated CPU takes the
 * whole service down, not just its login route. Sized so ordinary traffic
 * never approaches it (~0.4 sign-in attempts/second sustained); raise it for
 * a busier deployment.
 */
const GLOBAL_MAX_ATTEMPTS = 400;

const WINDOW_SECONDS = 15 * 60;

/**
 * Cap on distinct keys held in the process-local fallback.
 *
 * Every unseen email or IP mints an entry, and entries used to be reclaimed
 * only if that exact key came back after expiring — so a caller varying the
 * email each time grew this Map without bound until the heap gave out. The
 * limiter protecting the login route must not itself be the way to exhaust
 * the process.
 */
const MAX_MEMORY_KEYS = 10_000;

// Process-local fallback for deployments without Redis. Honest limitation: it
// is per-process, so N web dynos allow N× the attempts. Redis is the real
// backing store and is present in every deployed configuration.
const memoryHits = new Map<string, { count: number; resetAt: number }>();

/**
 * Reclaim space in the fallback map: expired entries first, then — only if
 * that was not enough — the oldest live ones.
 *
 * Evicting a live entry does forgive that key's accumulated attempts. That is
 * the right way round: the eviction path is reachable only under a flood of
 * distinct keys, where bounded memory matters more than one counter's
 * precision, and the global bucket still holds the line.
 */
function pruneMemoryHits(now: number): void {
  for (const [key, entry] of memoryHits) {
    if (entry.resetAt <= now) memoryHits.delete(key);
  }
  if (memoryHits.size < MAX_MEMORY_KEYS) return;

  // Map iterates in insertion order, so this drops the least recently added.
  const target = Math.floor(MAX_MEMORY_KEYS * 0.9);
  for (const key of memoryHits.keys()) {
    if (memoryHits.size <= target) break;
    memoryHits.delete(key);
  }
}

function memoryConsume(key: string, maxAttempts: number): RateLimitVerdict {
  const now = Date.now();
  const entry = memoryHits.get(key);
  if (!entry || entry.resetAt <= now) {
    if (memoryHits.size >= MAX_MEMORY_KEYS) pruneMemoryHits(now);
    memoryHits.set(key, { count: 1, resetAt: now + WINDOW_SECONDS * 1000 });
    return { allowed: true, retryAfter: 0 };
  }
  entry.count += 1;
  if (entry.count > maxAttempts) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
}

async function redisConsume(key: string, maxAttempts: number): Promise<RateLimitVerdict> {
  const redis = getRedis();
  const redisKey = `login_attempts:${key}`;
  const count = await redis.incr(redisKey);
  if (count === 1) {
    await redis.expire(redisKey, WINDOW_SECONDS);
  }
  if (count > maxAttempts) {
    const ttl = await redis.ttl(redisKey);
    return { allowed: false, retryAfter: ttl > 0 ? ttl : WINDOW_SECONDS };
  }
  return { allowed: true, retryAfter: 0 };
}

/**
 * Record an attempt against `key` and report whether it may proceed.
 *
 * Counts every attempt, not only failures. Counting failures alone lets an
 * attacker reset the window with one valid login against any account they
 * already control, so the ceiling would bound nothing.
 */
export async function consumeLoginAttempt(
  key: string,
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<RateLimitVerdict> {
  if (isDatabaseAvailable()) {
    try {
      return await redisConsume(key, maxAttempts);
    } catch (err: any) {
      // A Redis blip must not lock everyone out of signing in; fall back to
      // the local counter rather than failing closed on the login path.
      console.error(`[login-rate-limit] Redis unavailable, using in-memory counter: ${err.message}`);
      return memoryConsume(key, maxAttempts);
    }
  }
  return memoryConsume(key, maxAttempts);
}

/** Clear a key's counter. Called after a successful sign-in. */
export async function resetLoginAttempts(key: string): Promise<void> {
  memoryHits.delete(key);
  if (isDatabaseAvailable()) {
    try {
      await getRedis().del(`login_attempts:${key}`);
    } catch {
      // Best-effort: the window expires on its own.
    }
  }
}

/** Test seam — drops all process-local counters. */
export function __resetLoginRateLimitForTests(): void {
  memoryHits.clear();
}

export const LOGIN_RATE_LIMIT = { MAX_ATTEMPTS, GLOBAL_MAX_ATTEMPTS, WINDOW_SECONDS, MAX_MEMORY_KEYS };

/** Test seam — current size of the process-local fallback map. */
export function __memoryKeyCountForTests(): number {
  return memoryHits.size;
}
