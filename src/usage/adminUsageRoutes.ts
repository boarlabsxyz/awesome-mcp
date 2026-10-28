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
  app.get('/api/admin/usage/tools', requireAdmin, filtered(async (pool, f) => ({ tools: await usageToolStats(pool, f) })));
  app.get('/api/admin/usage/errors', requireAdmin, filtered(async (pool, f) => ({ errors: await usageTopErrors(pool, f) })));
  app.get('/api/admin/usage/loops', requireAdmin, filtered(async (pool, f) => ({ loops: await usageRetryLoops(pool, f) })));

  app.get('/api/admin/usage/users/:userId/events', requireAdmin, async (req: Request, res: Response) => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
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
