// src/auth/password.ts
//
// Password primitives for the email+password login path. Kept in one module so
// the cost factor, the length limits, and the failure-timing behaviour are
// decided once rather than per call site.
import bcrypt from 'bcrypt';
import * as crypto from 'crypto';

/** Cost factor for new hashes. */
const BCRYPT_ROUNDS = 12;

export const MIN_PASSWORD_LENGTH = 10;

/**
 * bcrypt hashes at most the first 72 *bytes* of its input and silently
 * discards the rest, so a long passphrase and its 72-byte prefix authenticate
 * identically. We reject past the limit rather than accept-and-truncate: the
 * truncating version tells the user their whole passphrase protects the
 * account when only the head of it does. Measured in bytes, not characters —
 * non-ASCII passphrases hit the ceiling sooner than their length suggests.
 */
export const MAX_PASSWORD_BYTES = 72;

/**
 * Comparison target for accounts that have no stored hash. Verifying against
 * this on an unknown email keeps the failure path's cost identical to a
 * wrong-password failure, so response time doesn't disclose which emails have
 * accounts.
 *
 * Derived at startup from 32 CSPRNG bytes rather than written as a literal.
 * A checked-in hash is indistinguishable from a leaked credential to any
 * scanner (and to anyone reading the diff), and it would be identical across
 * every deployment forever. Generating it here means the preimage exists
 * nowhere — not in the repo, not in memory past this line — and no account
 * can ever hold it, so there is nothing here to rotate or revoke.
 *
 * Cost is one bcrypt at BCRYPT_ROUNDS on module load. It must use the same
 * cost factor as real hashes or the timing parity it exists to provide is
 * lost.
 */
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('base64'), BCRYPT_ROUNDS);

/** Lowercase and trim so `A@b.com ` and `a@b.com` resolve to one account. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Deliberately permissive: this is a typo check, not an RFC 5322 parser.
 * Address validity is proven by delivery, and this path does not send mail.
 *
 * Written with string scans instead of a regex. The obvious pattern for this
 * — /^[^\s@]+@[^\s@]+\.[^\s@]+$/ — has two adjacent quantifiers over
 * classes that both match '.', so a non-matching input makes the engine retry
 * every split point and the cost grows quadratically with length. Attacker
 * controlled input reaches this function before any authentication, which is
 * precisely where that should not be true. indexOf/lastIndexOf are single
 * linear passes with no backtracking at all.
 */
export function isValidEmail(email: string): boolean {
  // Bound the work first, so everything below is linear over a capped length.
  if (email.length === 0 || email.length > 255) return false;

  // Exactly one '@', with a non-empty local part and domain either side.
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) return false;

  // No whitespace anywhere (the original's [^\s@] classes enforced this).
  for (let i = 0; i < email.length; i++) {
    const c = email.charCodeAt(i);
    // space, tab, LF, VT, FF, CR
    if (c === 32 || (c >= 9 && c <= 13)) return false;
  }

  // Domain needs a dot that is neither its first nor its last character.
  const domain = email.slice(at + 1);
  const dot = domain.indexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

/** Returns null when acceptable, else a message safe to show the user. */
export function validatePassword(password: string): string | null {
  if (typeof password !== 'string' || password.length === 0) {
    return 'Password is required.';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return `Password must be at most ${MAX_PASSWORD_BYTES} bytes (about ${MAX_PASSWORD_BYTES} characters).`;
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Verify a password against a stored hash. Pass a null/undefined hash for an
 * account that has none (unknown email, or a Google-only account): the compare
 * still runs against DUMMY_HASH so the caller cannot shorten the response and
 * turn login into an account-existence oracle.
 */
export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  // Enforce the byte ceiling here rather than at the call site, so no login
  // path can forget it. Registration already rejects anything longer, so no
  // stored password can exceed 72 bytes — but bcrypt compares only the first
  // 72, so without this check a password that IS exactly 72 bytes would also
  // be authenticated by every string that merely starts with it.
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return false;

  const target = hash || DUMMY_HASH;
  const matches = await bcrypt.compare(password, target);
  return Boolean(hash) && matches;
}
