// The Admin MCP's tool bodies, with their I/O injected so they run against a
// stub pool in tests. server.ts only registers them.
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { usagePool, type UsagePool } from '../usage/usageStore.js';
import {
  usageOverview,
  usageRetryLoops,
  usageToolStats,
  usageTopErrors,
  usageUserTimeline,
  type UsageFilter,
} from '../usage/usageQueries.js';
import { listUsersWithConnections, type AdminUser } from '../usage/adminUsers.js';
import { getUserByEmail } from '../userStore.js';
import {
  formatOverview,
  formatRetryLoops,
  formatTimeline,
  formatToolUsage,
  formatTopErrors,
  formatUsers,
  type ToolSortKey,
} from './format.js';

// Same bounds as usageFilterSchema (the /admin page's), with descriptions for
// the model. Not coerced: MCP arguments arrive typed.
export const filterParams = {
  days: z.number().int().min(1).max(90).default(7)
    .describe('How many days back to look, 1-90 (default 7). Events are kept for USAGE_RETENTION_DAYS, 30 by default.'),
  slug: z.string().regex(/^[a-z0-9-]{1,40}$/).optional()
    .describe('Only this MCP service, by catalog slug: google-docs, google-sheets, clickup, slack, github, admin, … Omit for all.'),
  surface: z.enum(['mcp', 'rest']).optional()
    .describe('Only MCP tool calls ("mcp") or only REST API calls ("rest"). Omit for both.'),
};

export interface AdminOpsDeps {
  pool: () => UsagePool | null;
  getUserByEmail: (email: string) => Promise<{ id?: number } | undefined>;
  listUsers: () => Promise<AdminUser[]>;
}

export const defaultAdminOpsDeps: AdminOpsDeps = {
  pool: usagePool,
  getUserByEmail,
  listUsers: () => listUsersWithConnections(),
};

/**
 * The pool, or an error that says why there is none. Never an empty answer:
 * "no usage" and "no database" must not look the same.
 */
function requirePool(deps: AdminOpsDeps): UsagePool {
  const pool = deps.pool();
  if (!pool) {
    throw new UserError('Usage data is unavailable: this service has no database connection (DATABASE_URL and REDIS_URL must both be set).');
  }
  return pool;
}

const toFilter = (a: { days: number; slug?: string; surface?: 'mcp' | 'rest' }): UsageFilter => ({
  days: a.days,
  slug: a.slug,
  surface: a.surface,
});

export async function opUsageOverview(args: { days: number; slug?: string; surface?: 'mcp' | 'rest' }, deps = defaultAdminOpsDeps) {
  const f = toFilter(args);
  return formatOverview(await usageOverview(requirePool(deps), f), f);
}

export async function opToolUsage(
  args: { days: number; slug?: string; surface?: 'mcp' | 'rest'; sortBy: ToolSortKey; limit: number },
  deps = defaultAdminOpsDeps,
) {
  const f = toFilter(args);
  return formatToolUsage(await usageToolStats(requirePool(deps), f), f, args.sortBy, args.limit);
}

export async function opTopErrors(args: { days: number; slug?: string; surface?: 'mcp' | 'rest' }, deps = defaultAdminOpsDeps) {
  const f = toFilter(args);
  return formatTopErrors(await usageTopErrors(requirePool(deps), f), f);
}

export async function opRetryLoops(args: { days: number; slug?: string }, deps = defaultAdminOpsDeps) {
  const f = toFilter(args);
  return formatRetryLoops(await usageRetryLoops(requirePool(deps), f), f);
}

const PG_INT_MAX = 2_147_483_647;

/** A user id from "42" or "someone@example.com". */
export async function resolveUserId(user: string, deps: AdminOpsDeps): Promise<number> {
  const value = user.trim();
  if (/^\d+$/.test(value)) {
    const id = Number(value);
    if (id < 1 || id > PG_INT_MAX) throw new UserError(`"${value}" is not a valid user id.`);
    return id;
  }
  if (!value.includes('@')) {
    throw new UserError(`"${value}" is neither a numeric user id nor an email address. Use listUsers to find one.`);
  }
  const found = await deps.getUserByEmail(value);
  if (!found) throw new UserError(`No user with the email ${value}. Use listUsers to search by part of an address.`);
  if (!found.id) {
    throw new UserError(`${value} exists only in the file-based user store, which has no numeric id, so it has no recorded usage.`);
  }
  return found.id;
}

export async function opUserActivity(args: { user: string; limit: number; before?: number }, deps = defaultAdminOpsDeps) {
  const pool = requirePool(deps);
  const userId = await resolveUserId(args.user, deps);
  return formatTimeline(await usageUserTimeline(pool, userId, { limit: args.limit, before: args.before }));
}

export async function opListUsers(args: { query?: string; limit: number }, deps = defaultAdminOpsDeps) {
  const all = await deps.listUsers();
  const q = args.query?.trim().toLowerCase();
  const matched = q
    ? all.filter((u) => u.email.toLowerCase().includes(q) || (u.name ?? '').toLowerCase().includes(q))
    : all;
  return formatUsers(matched, args.query?.trim() || undefined, args.limit);
}
