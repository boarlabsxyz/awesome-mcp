// src/util/isoDate.ts
// Shared ISO-date (YYYY-MM-DD) Zod schema.

import { z } from 'zod';

/**
 * ISO-date string (YYYY-MM-DD) whose value is also a real calendar date.
 * Rejects 2026-02-31, 2026-13-01, etc. A regex-only check accepts those and
 * only fails downstream at the provider, where the error is far less legible.
 *
 * Lives here rather than in one provider's server so the PeopleForce v2/v3 and
 * v4 connectors validate dates identically instead of drifting apart.
 */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO date format YYYY-MM-DD.')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'Not a valid calendar date.');
