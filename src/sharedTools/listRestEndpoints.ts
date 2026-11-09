// Shared MCP tool: listRestEndpoints
//
// Returns the catalog of REST passthrough endpoints in-session so LLMs can
// pick the right URL without round-tripping to /openapi.json. Payload is kept
// small — paths + summaries only, no schemas — and without a `service` it is
// only an index: the whole catalog is over 100 KB, more than clients keep.

import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import type { UserSession } from '../userSession.js';
import { REST_CATALOG, REST_SERVICE_NOTES, RestService } from '../restCatalog.js';
import { stripTrailingSlashes } from '../util/url.js';

const BASE_URL = stripTrailingSlashes(process.env.BASE_URL || 'http://localhost:8080');

// Keep in sync with the RestService union in restCatalog.ts — a service missing
// here is silently rejected by the z.enum on the `service` param below, even
// though it has entries in REST_CATALOG. (restCatalog.test.ts guards the drift.)
export const SERVICE_VALUES: [RestService, ...RestService[]] = [
  'docs', 'sheets', 'calendar', 'drive', 'gmail', 'slides', 'clickup', 'slack',
  'outline', 'peopleforce', 'hubspot', 'redmine', 'browserbase', 'github', 'pinecone', 'supabase',
  'storage',
];

export function registerListRestEndpoints(server: FastMCP<UserSession>): void {
  server.addTool({
    name: 'listRestEndpoints',
    annotations: { readOnlyHint: true },
    description:
      'ESCAPE HATCH companion to mintRestBearerForCurl — only useful if YOU ' +
      '(the client) can run shell commands like curl, or code that calls the ' +
      'API (the Sandbox MCP\'s runCode). The regular MCP tools ' +
      'work without any of this; do NOT call this as a routine discovery step. ' +
      `Lists REST data-plane endpoints under ${BASE_URL}/api/v1/* so a ` +
      'shell-capable client can move bulk payloads without them crossing the ' +
      'LLM context window: GET fetches large responses straight to disk, and ' +
      'POST sends a large request body (or chains a write into a curl | jq ' +
      'pipeline) without pasting it through a tool call. Without `service` ' +
      'it returns only an index of services and their endpoint counts; call ' +
      'it again with one `service` for its paths.',
    parameters: z.object({
      service: z.enum(SERVICE_VALUES).optional().describe(`The service whose endpoints to list: ${SERVICE_VALUES.join(', ')}. Omit it for the index.`),
    }),
    execute: async (args) => {
      const common = {
        baseUrl: `${BASE_URL}/api/v1`,
        auth: 'Authorization: Bearer <token from mintRestBearerForCurl>',
      };
      if (!args.service) {
        const services = SERVICE_VALUES
          .map(service => {
            const own = REST_CATALOG.filter(e => e.service === service);
            const live = own.filter(e => e.status === 'live').length;
            return { service, live, planned: own.length - live };
          })
          .filter(s => s.live + s.planned > 0);
        return JSON.stringify(
          {
            ...common,
            totalEndpoints: REST_CATALOG.length,
            services,
            next: 'Call listRestEndpoints again with `service` set to one of these for its methods, paths and summaries. Only live endpoints answer; planned ones are not served yet.',
          },
          null,
          2,
        );
      }
      const entries = REST_CATALOG.filter(e => e.service === args.service);
      const serviceNotes = Object.fromEntries(
        Object.entries(REST_SERVICE_NOTES).filter(([svc]) => entries.some(e => e.service === svc)),
      );
      return JSON.stringify(
        {
          baseUrl: common.baseUrl,
          count: entries.length,
          ...(Object.keys(serviceNotes).length ? { serviceNotes } : {}),
          auth: common.auth,
          multipleConnections:
            'The bearer serves the account of the connector that minted it — mint it from the connector you mean. ' +
            'To pick another connection to the same service, send X-Instance-Id: <instanceId>. ' +
            'A 409 lists the instance ids when the bearer came from another service and several connections match.',
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
