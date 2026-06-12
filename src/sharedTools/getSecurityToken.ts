// Shared MCP tool: getSecurityToken
//
// Mints a 5-minute bearer for the REST data plane at $BASE_URL/api/v1/*.
// Registered on every FastMCP server in this repo so any session can mint one
// regardless of which service the LLM is currently talking to.

import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import type { UserSession } from '../userSession.js';
import { mintRestToken } from '../website/restTokenStore.js';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');

export function registerGetSecurityToken(server: FastMCP<UserSession>): void {
  server.addTool({
    name: 'getSecurityToken',
    annotations: { readOnlyHint: false },
    description:
      'Mint a 5-minute bearer token for the REST data plane. Use it as ' +
      '`Authorization: Bearer <token>` against the GET endpoints under ' +
      `${BASE_URL}/api/v1/* so bulk responses can be saved directly to disk ` +
      'with curl/jq instead of flowing through the LLM context window. ' +
      'Call listRestEndpoints for the catalog of available URLs.',
    parameters: z.object({}),
    execute: async (_args, { session }) => {
      if (!session?.userId) {
        throw new UserError(
          'Not authenticated. Connect via the awesome-mcp dashboard before requesting a security token.',
        );
      }
      const minted = await mintRestToken(session.userId);
      return JSON.stringify(
        {
          token: minted.token,
          tokenType: 'Bearer',
          expiresIn: minted.ttlSeconds,
          expiresAt: new Date(minted.expiresAt).toISOString(),
          baseUrl: `${BASE_URL}/api/v1`,
          usage: `curl -H "Authorization: Bearer <token>" ${BASE_URL}/api/v1/<resource>`,
        },
        null,
        2,
      );
    },
  });
}
