// Shared 404/403/500 mapper for REST passthrough handlers in webServer.ts.
//
// Translates the upstream error shape from googleapis (err.code) and the
// ClickUp/HTTP client (err.response.status / err.status) into a uniform
// response so each route's catch block stays a one-liner.

import type { Response } from 'express';

export interface UpstreamErrorOpts {
  /** 404 message. Defaults to "Resource not found". */
  notFound?: string;
  /** 500 fallback used when err.message is empty. Required so the operation
   * is at least named in the user-facing payload. */
  fallback: string;
}

export function sendUpstreamError(res: Response, err: unknown, opts: UpstreamErrorOpts): void {
  const e = err as { code?: unknown; message?: unknown; status?: unknown; response?: { status?: unknown } } | null | undefined;
  const status =
    (typeof e?.code === 'number' ? e.code : undefined) ??
    (typeof e?.response?.status === 'number' ? e.response.status : undefined) ??
    (typeof e?.status === 'number' ? e.status : undefined);
  if (status === 404) {
    res.status(404).json({ error: opts.notFound || 'Resource not found' });
    return;
  }
  if (status === 403) {
    res.status(403).json({ error: 'Permission denied' });
    return;
  }
  const msg = typeof e?.message === 'string' && e.message ? e.message : opts.fallback;
  res.status(500).json({ error: msg });
}
