// Content negotiation for REST data plane responses.
//
// REST endpoints return raw upstream JSON by default. When a caller wants the
// same rendered markdown an MCP tool returns, they pass Accept: text/plain
// (or ?format=text). The handler computes the JSON once and calls
// respondNegotiated, which decides whether to send JSON or invoke renderText.

import type { Request, Response } from 'express';

export type RestFormat = 'json' | 'text';

export function negotiateFormat(req: Request): RestFormat {
  const q = (req.query.format ?? '').toString().toLowerCase();
  if (q === 'text' || q === 'plain' || q === 'markdown') return 'text';
  if (q === 'json') return 'json';

  const accept = (req.headers.accept ?? '').toString().toLowerCase();
  if (accept.includes('text/plain') || accept.includes('text/markdown')) return 'text';
  // application/json, */*, missing — default to JSON
  return 'json';
}

export function respondNegotiated(
  req: Request,
  res: Response,
  jsonPayload: unknown,
  renderText: () => string,
): void {
  if (negotiateFormat(req) === 'text') {
    res.type('text/plain; charset=utf-8').send(renderText());
    return;
  }
  res.json(jsonPayload);
}
