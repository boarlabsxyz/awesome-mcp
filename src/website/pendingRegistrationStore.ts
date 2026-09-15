// src/website/pendingRegistrationStore.ts
//
// Sign-ups that have been submitted but not yet proven. A registration lives
// here — never in `users` — until the applicant clicks the link mailed to the
// address, which is what makes "the account exists" mean "someone could read
// mail at that address".
import * as crypto from 'crypto';
import { isDatabaseAvailable, getRedis } from '../db.js';

/** How long a verification link stays usable. */
const TTL_SECONDS = 24 * 60 * 60;

const REDIS_PREFIX = 'pending_registration:';

/**
 * Cap on pending sign-ups held in the process-local fallback. Registration is
 * unauthenticated, so without a ceiling a caller could mint entries until the
 * heap gave out — the same failure the login limiter's map had.
 */
const MAX_MEMORY_ENTRIES = 10_000;

export interface PendingRegistration {
  email: string;
  /** Already bcrypt-hashed. A plaintext password must never rest here. */
  passwordHash: string;
  expiresAt: number;
}

/**
 * Look records up by digest, never by the token itself.
 *
 * The token is a bearer credential: whoever holds it can bring an account into
 * existence. Storing only its SHA-256 means a dump of Redis (or a stray log of
 * these keys) yields nothing usable, exactly as with a password hash. SHA-256
 * without a work factor is right here — unlike a password, the input is 32
 * bytes of CSPRNG output, so there is no guessable preimage to slow down.
 */
function digest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ---------- Process-local fallback ----------

const memoryPending = new Map<string, PendingRegistration>();

function pruneMemory(now: number): void {
  for (const [key, record] of memoryPending) {
    if (record.expiresAt <= now) memoryPending.delete(key);
  }
  if (memoryPending.size < MAX_MEMORY_ENTRIES) return;

  // Insertion-ordered, so this drops the oldest pending sign-ups first.
  const target = Math.floor(MAX_MEMORY_ENTRIES * 0.9);
  for (const key of memoryPending.keys()) {
    if (memoryPending.size <= target) break;
    memoryPending.delete(key);
  }
}

// ---------- Public API ----------

/**
 * Record a sign-up awaiting proof and return the token to mail out.
 *
 * The token is returned once and never stored, so it cannot be recovered from
 * this process — a lost link means registering again, which is the intended
 * property.
 */
export async function createPendingRegistration(
  email: string,
  passwordHash: string,
): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const record: PendingRegistration = {
    email,
    passwordHash,
    expiresAt: Date.now() + TTL_SECONDS * 1000,
  };

  if (isDatabaseAvailable()) {
    await getRedis().setex(`${REDIS_PREFIX}${digest(token)}`, TTL_SECONDS, JSON.stringify(record));
    return token;
  }

  pruneMemory(Date.now());
  memoryPending.set(digest(token), record);
  return token;
}

/**
 * Redeem a token, returning the sign-up it stands for.
 *
 * Single use: the record is removed before it is returned, so a link that is
 * clicked twice — by a mail scanner prefetching it, say, and then by the
 * person — cannot create two accounts. Returns null for anything unknown,
 * already used, or expired; the caller must not distinguish those to the user.
 */
export async function consumePendingRegistration(
  token: string,
): Promise<PendingRegistration | null> {
  if (!token) return null;
  const key = digest(token);

  if (isDatabaseAvailable()) {
    const redis = getRedis();
    const raw = await redis.get(`${REDIS_PREFIX}${key}`);
    if (!raw) return null;
    // Delete before returning: two concurrent clicks both read, but only the
    // one whose DEL removed a key may proceed.
    const removed = await redis.del(`${REDIS_PREFIX}${key}`);
    if (removed === 0) return null;
    const record = JSON.parse(raw) as PendingRegistration;
    return record.expiresAt > Date.now() ? record : null;
  }

  const record = memoryPending.get(key);
  if (!record) return null;
  memoryPending.delete(key);
  return record.expiresAt > Date.now() ? record : null;
}

/**
 * Drop a pending sign-up without redeeming it.
 *
 * Used when the verification mail could not be delivered: the token existed
 * only inside that request, so the record is unreachable by anyone and would
 * otherwise sit until its TTL. Cleaning up keeps a failed sign-up from leaving
 * state behind.
 */
export async function deletePendingRegistration(token: string): Promise<void> {
  if (!token) return;
  const key = digest(token);
  if (isDatabaseAvailable()) {
    await getRedis().del(`${REDIS_PREFIX}${key}`);
    return;
  }
  memoryPending.delete(key);
}

/**
 * Put a consumed record back under its original token.
 *
 * `consumePendingRegistration` deletes before returning, so a redemption that
 * then fails for an unrelated reason — the database being down, say — would
 * otherwise burn a valid link and force the person to sign up again. Restoring
 * is safe precisely because that path creates no account: single-use still
 * holds, since only a *successful* redemption keeps the record consumed.
 *
 * Keeps the original expiry rather than extending it; a failed attempt must
 * not lengthen the window.
 */
export async function restorePendingRegistration(
  token: string,
  record: PendingRegistration,
): Promise<void> {
  const remainingMs = record.expiresAt - Date.now();
  if (remainingMs <= 0) return;

  const key = digest(token);
  if (isDatabaseAvailable()) {
    await getRedis().setex(
      `${REDIS_PREFIX}${key}`,
      Math.ceil(remainingMs / 1000),
      JSON.stringify(record),
    );
    return;
  }
  memoryPending.set(key, record);
}

/** Test seam — current size of the process-local map. */
export function __pendingCountForTests(): number {
  return memoryPending.size;
}

/**
 * Test seam — mint a token whose record is already past its expiry.
 *
 * Expiry is otherwise unreachable in a test: the TTL is 24 hours, and the
 * timestamp is computed inside createPendingRegistration. Writes to the
 * process-local map only, which is the path tests run on (no Redis).
 */
export function __seedExpiredPendingForTests(email: string, passwordHash: string): string {
  const token = crypto.randomBytes(32).toString('base64url');
  memoryPending.set(digest(token), { email, passwordHash, expiresAt: Date.now() - 1000 });
  return token;
}

export const PENDING_REGISTRATION = { TTL_SECONDS, MAX_MEMORY_ENTRIES };
