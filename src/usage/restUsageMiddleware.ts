// Records /api/v1/* calls into tool_call_events with surface 'rest'.
//
// Mounted at the top of registerRestApiRoutes so every app factory that serves
// the REST plane gets it from one place. Only authenticated calls are recorded
// (the route's auth middleware sets req.userSession): the plane is public, and
// recording every unauthenticated probe would bury real usage in scanner noise.
//
// Request BODIES are never summarised here — on this plane they are bulk rows,
// wiki pages and call transcripts. Only query-string key names are kept.
import type { NextFunction, Request, Response } from 'express';
import { recordToolCall } from './usageStore.js';

// The URL segment after /api/v1/ → the catalog slug mcp_connections uses, for
// the sessions that do not carry mcpSlug themselves (plain Google sessions).
const PATH_SERVICE_TO_SLUG: Record<string, string> = {
  docs: 'google-docs',
  sheets: 'google-sheets',
  calendars: 'google-calendar',
  calendar: 'google-calendar',
  drive: 'google-drive',
  gmail: 'google-gmail',
  slides: 'google-slides',
};

/** The catalog slug a REST call belongs to: the session's own, else derived from the path. */
export function restServiceSlug(originalUrl: string, sessionSlug?: string): string {
  if (sessionSlug) return sessionSlug;
  const segment = originalUrl.split('?')[0].split('/')[3] ?? '';
  return PATH_SERVICE_TO_SLUG[segment] ?? (segment || 'rest');
}

/** The matched route TEMPLATE, so `/tasks/123` and `/tasks/456` count as one endpoint. */
export function restRouteName(req: Request): string {
  const route = (req as any).route?.path;
  const path = Array.isArray(route) ? route.join('|') : route ? String(route) : '(unmatched)';
  return `${req.method} ${path}`;
}

/**
 * Records the call once the response is over. Listens for `close`, not
 * `finish`: a response destroyed mid-stream (a download whose upstream failed)
 * never emits `finish`, and would otherwise vanish from the failure counts.
 * `close` fires exactly once either way, and `writableFinished` says which
 * ending it was.
 */
export function restUsageMiddleware(req: Request, res: Response, next: NextFunction): void {
  const started = performance.now();
  res.once('close', () => {
    try {
      const session = (req as any).userSession as { userId?: number; instanceId?: string; mcpSlug?: string } | undefined;
      if (!session) return;
      const completed = res.writableFinished;
      const ok = completed && res.statusCode < 400;
      recordToolCall({
        userId: typeof session.userId === 'number' ? session.userId : null,
        instanceId: session.instanceId ?? null,
        mcpSlug: restServiceSlug(req.originalUrl, session.mcpSlug),
        tool: restRouteName(req),
        surface: 'rest',
        clientName: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 100) : null,
        durationMs: performance.now() - started,
        ok,
        errorKind: ok ? null : completed ? String(res.statusCode) : 'aborted',
        argKeys: Object.keys(req.query ?? {}),
      });
    } catch {
      // Analytics must never affect a response.
    }
  });
  next();
}
