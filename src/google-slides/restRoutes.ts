// src/google-slides/restRoutes.ts
// The Slides REST writes as data, registered by webServer.ts from a loop. Same
// shape and reasons as src/google-gmail/restRoutes.ts: each request is validated
// with the MCP tool's own schema and goes through the same perform* function.
//
// Both routes were served long before they were catalogued, as ChatGPT Custom
// Actions compat, so their paths, 200 status and response keys stay as they were.

import type { slides_v1 } from 'googleapis';
import type { ZodTypeAny } from 'zod';

import { batchUpdatePresentationSchema, createPresentationSchema } from './schemas.js';
import { performBatchUpdatePresentation, performCreatePresentation, slidesBatchUpdateErrorResponse } from './toolHandlers.js';

/** The parts of an Express request a descriptor reads. */
export interface SlidesRestRequest {
  params: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface SlidesWriteResult {
  status: number;
  body: unknown;
}

export interface SlidesWriteRoute {
  path: string;
  tool: string;
  schema: ZodTypeAny;
  /** Path params, which override same-named body keys. */
  params: (req: SlidesRestRequest) => Record<string, unknown>;
  run: (slides: slides_v1.Slides, args: any) => Promise<SlidesWriteResult>;
  /** A Google failure this route answers itself, or null for the shared mapping. */
  errorResponse?: (err: unknown, args: Record<string, unknown>) => SlidesWriteResult | null;
  notFound?: string;
  fallback: string;
}

const param = (req: SlidesRestRequest, name: string): string => {
  const v = req.params[name];
  return Array.isArray(v) ? v.join('/') : (v ?? '');
};

export const SLIDES_WRITE_ROUTES: ReadonlyArray<SlidesWriteRoute> = [
  {
    path: '/api/v1/slides', tool: 'createPresentation', schema: createPresentationSchema,
    params: () => ({}),
    run: async (slides, args) => {
      const p = await performCreatePresentation(slides, args);
      return { status: 200, body: { presentationId: p.presentationId, title: p.title } };
    },
    fallback: 'Failed to create presentation',
  },
  {
    path: '/api/v1/slides/:presentationId/batchUpdate', tool: 'batchUpdatePresentation', schema: batchUpdatePresentationSchema,
    params: (req) => ({ presentationId: param(req, 'presentationId') }),
    run: async (slides, args) => {
      // An empty batch writes nothing and Google answers 200; over curl that reads as a write.
      if (args.requests.length === 0) return { status: 400, body: { error: 'requests is empty.' } };
      return { status: 200, body: await performBatchUpdatePresentation(slides, args) };
    },
    // 409 for a stale requiredRevisionId, 400 for a request Google refused.
    errorResponse: (err, args) => slidesBatchUpdateErrorResponse(err, args.requiredRevisionId),
    notFound: 'Presentation not found', fallback: 'Failed to batch update presentation',
  },
];

/** The body merged with the path params, which win: the URL names the record. */
export function writeArgs(route: SlidesWriteRoute, req: SlidesRestRequest): Record<string, unknown> {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  return { ...body, ...route.params(req) };
}
