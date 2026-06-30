// Shared MCP tool: mintRestBearerForCurl
//
// Mints a 5-minute bearer for the REST data plane at $BASE_URL/api/v1/*.
// Registered on every FastMCP server in this repo so any session can mint one
// regardless of which service the LLM is currently talking to.
//
// Renamed from `getSecurityToken` because that name pattern-matched too easily
// to "routine OAuth-style precondition" — clients (notably ChatGPT) were
// calling it before every action even though MCP sessions are already
// authenticated and the token is only useful to clients with shell access.

import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import type { UserSession } from '../userSession.js';
import { mintRestToken } from '../website/restTokenStore.js';
import { stripTrailingSlashes } from '../util/url.js';

const BASE_URL = stripTrailingSlashes(process.env.BASE_URL || 'http://localhost:8080');

export function registerMintRestBearerForCurl(server: FastMCP<UserSession>): void {
  server.addTool({
    name: 'mintRestBearerForCurl',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description:
      'ESCAPE HATCH — do NOT call this as a routine auth step. The regular ' +
      'MCP tools (readGoogleDoc, listGoogleDocs, listChannels, etc.) work ' +
      'without any token; you are already authenticated via the MCP session. ' +
      'Only call this if YOU (the client) can run shell commands like curl, ' +
      'and you specifically want to fetch a large/bulk response straight to ' +
      'disk instead of through the LLM context window. The minted bearer is ' +
      `valid 5 minutes against GET ${BASE_URL}/api/v1/* (see listRestEndpoints). ` +
      'If you cannot exec shell, this token is useless to you — skip it.',
    parameters: z.object({}),
    execute: async (_args, { session }) => {
      if (!session?.userId) {
        throw new UserError(
          'Not authenticated. Connect via the awesome-mcp dashboard before requesting a REST bearer.',
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
