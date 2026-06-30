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

const SERVICE_VALUES: [RestService, ...RestService[]] = [
  'docs', 'sheets', 'calendar', 'drive', 'gmail', 'slides', 'clickup', 'slack',
];

export function registerListRestEndpoints(server: FastMCP<UserSession>): void {
  server.addTool({
    name: 'listRestEndpoints',
    annotations: { readOnlyHint: true },
    description:
      `List REST data-plane endpoints under ${BASE_URL}/api/v1/*. Use to ` +
      'discover the GET URL for a given MCP read tool when you want to fetch ' +
      'bulk data via curl + a bearer from mintRestBearerForCurl instead of an MCP ' +
      'tool result. Optional `service` narrows the result to one provider.',
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
