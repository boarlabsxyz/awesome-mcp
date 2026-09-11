// Env-var access for checks. Fail at import time with a pointer to the doc that
// explains how to get the value, not at assertion time with "undefined".

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}. See e2e/accounts.md.`);
  return value;
}

export function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  return n;
}
