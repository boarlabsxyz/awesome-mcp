// /api/admin/usage/* — the JSON behind the /admin Usage tab.
//
// The admin gate is injected rather than imported because it lives inside
// webServer.ts's route registration closure; that also lets these routes be
// tested with a stand-in gate instead of a full session + ADMIN_EMAILS setup.
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodError } from 'zod';
import { usagePool, type UsagePool } from './usageStore.js';
import {
  timelineQuerySchema,
  usageFilterSchema,
  usageOverview,
  usageRetryLoops,
  usageToolStats,
  usageTopErrors,
  usageUserTimeline,
} from './usageQueries.js';

type Gate = (req: any, res: Response, next: NextFunction) => unknown;

const PG_INT_MAX = 2_147_483_647;

function badRequest(res: Response, err: ZodError): void {
  res.status(400).json({ error: 'Invalid query parameters', issues: err.flatten().fieldErrors });
}

/**
 * Without Postgres there is nothing to read. Answer 503 rather than empty
 * data: an empty Usage tab would read as "nobody uses the MCPs".
 */
function requirePool(res: Response): UsagePool | null {
  const pool = usagePool();
  if (!pool) {
    res.status(503).json({ error: 'Usage tracking needs a database. Set DATABASE_URL.' });
    return null;
  }
  return pool;
}

function filtered(run: (pool: UsagePool, filter: ReturnType<typeof usageFilterSchema.parse>) => Promise<unknown>): RequestHandler {
  return async (req: Request, res: Response) => {
    const parsed = usageFilterSchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);
    const pool = requirePool(res);
    if (!pool) return;
    try {
      res.json(await run(pool, parsed.data));
    } catch (err: any) {
      console.error(`[usage] admin query ${req.path} failed:`, err?.message || err);
      res.status(500).json({ error: 'Failed to read usage data' });
    }
  };
}

export function registerAdminUsageRoutes(app: Express, requireAdmin: Gate): void {
  app.get('/api/admin/usage/overview', requireAdmin, filtered(usageOverview));
  app.get('/api/admin/usage/tools', requireAdmin, filtered(usageToolStats));
  app.get('/api/admin/usage/errors', requireAdmin, filtered(usageTopErrors));
  app.get('/api/admin/usage/loops', requireAdmin, filtered(usageRetryLoops));

  app.get('/api/admin/usage/users/:userId/events', requireAdmin, async (req: Request, res: Response) => {
    const userId = Number(req.params.userId);
    // users.id is a Postgres INT: anything larger would reach the query and
    // come back as a 500 "out of range" instead of the caller's 400.
    if (!Number.isInteger(userId) || userId <= 0 || userId > PG_INT_MAX) {
      res.status(400).json({ error: 'userId must be a positive integer' });
      return;
    }
    const parsed = timelineQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);
    const pool = requirePool(res);
    if (!pool) return;
    try {
      res.json(await usageUserTimeline(pool, userId, parsed.data));
    } catch (err: any) {
      console.error('[usage] admin timeline query failed:', err?.message || err);
      res.status(500).json({ error: 'Failed to read usage data' });
    }
  });
}
