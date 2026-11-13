// Env-var access for checks. Fail at import time with a pointer to the doc that
// explains how to get the value, not at assertion time with "undefined".

import type { ServiceName } from './accounts.ts';

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

/**
 * Services every account is connected to by SETUP.md. Everything else has to be
 * named in E2E_SERVICES before its checks run.
 */
const BASELINE_SERVICES: ServiceName[] = ['google-docs', 'google-drive'];

export interface ServiceEnv {
  /** Pass straight to node:test's `skip`. A string names what is missing. */
  skip: string | false;
  /** Read one of the names the gate was built with. Only call inside the test body. */
  get(name: string): string;
}

/**
 * Gate a check on its service being seeded, rather than failing at import.
 *
 * The Docs checks use `required` and go red when a variable is missing, which is
 * right for the one service SETUP.md asks every account to connect. The other
 * services are seeded one tenant at a time, and a suite that is red until all
 * thirteen exist trains people to ignore it. So a check outside the baseline
 * skips -- with a reason naming exactly what to set -- until its service is
 * listed in E2E_SERVICES (comma-separated catalog slugs, or `all`) and every
 * fixture variable it reads is present.
 *
 * Listing the service is a separate switch from the variables on purpose: a
 * zero-shape check with an impossible query reads no fixture variable at all,
 * and without it would run, and fail, against an account that never connected
 * the service.
 */
export function serviceEnv(service: ServiceName, names: string[] = []): ServiceEnv {
  const listed = (process.env.E2E_SERVICES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const enabled = BASELINE_SERVICES.includes(service) || listed.includes('all') || listed.includes(service);
  const missing = names.filter((n) => !process.env[n]);

  let skip: string | false = false;
  if (!enabled) skip = `${service} is not listed in E2E_SERVICES. See e2e/accounts.md.`;
  else if (missing.length > 0) skip = `unset: ${missing.join(', ')}. See e2e/accounts.md.`;

  return {
    skip,
    get(name) {
      if (!names.includes(name)) throw new Error(`${name} was not declared to serviceEnv('${service}')`);
      return required(name);
    },
  };
}
