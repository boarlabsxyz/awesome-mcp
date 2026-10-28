// src/admin-mcp/server.ts
// The Admin MCP: the /admin usage analytics, read from Claude. Read-only, and
// for ADMIN_EMAILS only — checked when the session is created
// (mcpAuthenticate.ts) and again on every call (requireAdminForEveryTool).
import { FastMCP } from 'fastmcp';
import { instrumentServer } from '../usage/instrumentServer.js';
import { z } from 'zod';
import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { requireAdminForEveryTool } from './adminGuard.js';
import {
  filterParams,
  opListUsers,
  opRetryLoops,
  opToolUsage,
  opTopErrors,
  opUsageOverview,
  opUserActivity,
} from './ops.js';

export const adminServer = requireAdminForEveryTool(instrumentServer(new FastMCP<UserSession>({
  name: 'Admin MCP',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'admin'),
}), 'admin'));

adminServer.addTool({
  name: 'getUsageOverview',
  annotations: { readOnlyHint: true },
  // Descriptions are plain string literals: scripts/buildMcpToolsDoc.mjs reads them from source.
  description: 'Summary of how the MCPs on this platform are used: total calls, active users, error rate, calls per service and per day, client apps (Claude, ChatGPT, Cursor, curl…) and the busiest users. Start here for "how are people using the MCPs". MCP clients never send the user\'s prompt to a server, so prompts are not recorded; argument values are kept only for search-type fields (query, textToFind, title, …), truncated and with secrets redacted.',
  parameters: z.object(filterParams),
  execute: async (args) => opUsageOverview(args),
});

adminServer.addTool({
  name: 'listToolUsage',
  annotations: { readOnlyHint: true },
  description: 'Per-tool usage: calls, error count and rate, last use, and WHICH users called each tool (busiest first, with their call counts). Sort by errorRate to find broken tools, by calls for the most used, by lastUsed for recent activity. A tool with no calls in the period does not appear.',
  parameters: z.object({
    ...filterParams,
    sortBy: z.enum(['calls', 'errorRate', 'users', 'lastUsed']).default('calls')
      .describe('Order of the list, highest first (default calls).'),
    limit: z.number().int().min(1).max(200).default(50)
      .describe('How many tools to show, 1-200 (default 50). The answer says how many exist in total.'),
  }),
  execute: async (args) => opToolUsage(args),
});

adminServer.addTool({
  name: 'listTopErrors',
  annotations: { readOnlyHint: true },
  description: 'The most frequent failures, grouped by tool, error kind and message (up to 50 groups), with how many calls and users each affected and when it was last seen. Error messages are stored truncated and with secrets redacted.',
  parameters: z.object(filterParams),
  execute: async (args) => opTopErrors(args),
});

adminServer.addTool({
  name: 'listRetryLoops',
  annotations: { readOnlyHint: true },
  description: 'Bursts of repeated calls to one tool: 4+ MCP calls in one session, each within 60s of the last. Often a model retrying because a response or tool description confused it — but a legitimate batch looks the same, so runs containing failures are listed first. Follow up with getUserActivity to read the calls themselves.',
  parameters: z.object({
    days: filterParams.days,
    slug: filterParams.slug,
  }),
  execute: async (args) => opRetryLoops(args),
});

adminServer.addTool({
  name: 'getUserActivity',
  annotations: { readOnlyHint: true },
  description: 'One user\'s recorded calls, newest first, grouped by MCP session: tool, arguments (names, plus values for search-type fields), result or error, and duration. The closest available view of what the user was trying to do. MCP clients never send the user\'s prompt to a server, so prompts are not recorded; argument values are kept only for search-type fields, truncated and with secrets redacted.',
  parameters: z.object({
    user: z.string().min(1).describe('The user\'s email address or numeric user id (from listUsers or getUsageOverview).'),
    limit: z.number().int().min(1).max(200).default(50).describe('How many calls to return, 1-200 (default 50).'),
    before: z.number().int().positive().optional()
      .describe('Paging cursor: return calls older than this event id. Use the value the previous answer gives.'),
  }),
  execute: async (args) => opUserActivity(args),
});

adminServer.addTool({
  name: 'listUsers',
  annotations: { readOnlyHint: true },
  description: 'Every account on the platform with its sign-in method, join date and connected MCPs (connector name and, for Google ones, the Google account). Filter by part of an email address or name.',
  parameters: z.object({
    query: z.string().optional().describe('Only users whose email or name contains this text (case-insensitive).'),
    limit: z.number().int().min(1).max(500).default(100).describe('How many users to show, 1-500 (default 100). The answer says how many matched.'),
  }),
  execute: async (args) => opListUsers(args),
});
