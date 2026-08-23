// Shared MCP tool: listRestEndpoints
//
// Returns the catalog of REST passthrough endpoints in-session so LLMs can
// pick the right URL without round-tripping to /openapi.json. Payload is kept
// small — paths + summaries only, no schemas.

import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import type { UserSession } from '../userSession.js';
import { REST_CATALOG, RestService } from '../restCatalog.js';
import { stripTrailingSlashes } from '../util/url.js';

const BASE_URL = stripTrailingSlashes(process.env.BASE_URL || 'http://localhost:8080');

// Keep in sync with the RestService union in restCatalog.ts — a service missing
// here is silently rejected by the z.enum on the `service` param below, even
// though it has entries in REST_CATALOG. (restCatalog.test.ts guards the drift.)
export const SERVICE_VALUES: [RestService, ...RestService[]] = [
  'docs', 'sheets', 'calendar', 'drive', 'gmail', 'slides', 'clickup', 'slack',
  'outline', 'peopleforce', 'hubspot',
];

export function registerListRestEndpoints(server: FastMCP<UserSession>): void {
  server.addTool({
    name: 'listRestEndpoints',
    annotations: { readOnlyHint: true },
    description:
      'ESCAPE HATCH companion to mintRestBearerForCurl — only useful if YOU ' +
      '(the client) can run shell commands like curl. The regular MCP tools ' +
      'work without any of this; do NOT call this as a routine discovery step. ' +
      `Lists REST data-plane endpoints under ${BASE_URL}/api/v1/* so a ` +
      'shell-capable client can move bulk payloads without them crossing the ' +
      'LLM context window: GET fetches large responses straight to disk, and ' +
      'POST sends a large request body (or chains a write into a curl | jq ' +
      'pipeline) without pasting it through a tool call. Optional `service` ' +
      'narrows the result to one provider.',
    parameters: z.object({
      service: z.enum(SERVICE_VALUES).optional().describe('Restrict to one service.'),
    }),
    execute: async (args) => {
      const entries = args.service
        ? REST_CATALOG.filter(e => e.service === args.service)
        : REST_CATALOG;
      return JSON.stringify(
        {
          baseUrl: `${BASE_URL}/api/v1`,
          count: entries.length,
          auth: 'Authorization: Bearer <token from mintRestBearerForCurl>',
          endpoints: entries.map(e => ({
            service: e.service,
            method: e.method,
            path: e.path,
            summary: e.summary,
            mcpTool: e.mcpToolName,
            status: e.status,
            ...(e.notes ? { notes: e.notes } : {}),
          })),
        },
        null,
        2,
      );
    },
  });
}
