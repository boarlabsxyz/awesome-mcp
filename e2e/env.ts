// Env-var access for checks. Fail at import time with a pointer to the doc that
// explains how to get the value, not at assertion time with "undefined".

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}. See e2e/accounts.md.`);
  return value;
}

/**
 * `min` defaults to 1 because every current caller is a threshold -- "at least
 * this many documents", "at least this many characters". A zero or negative
 * threshold is satisfied by anything, so the check goes green having asserted
 * nothing, which is the exact failure these thresholds exist to prevent.
 */
export function optionalNumber(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  if (n < min) {
    throw new Error(
      `${name} must be at least ${min}, got ${n}. A threshold below that is satisfied by ` +
        'any result, so the check would pass without asserting anything.',
    );
  }
  return n;
}
