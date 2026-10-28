// Every Admin MCP tool re-checks that the caller is an administrator.
//
// The session check in mcpAuthenticate.ts runs once, when FastMCP creates a
// session, and that session then lives until the transport closes. This guard
// makes the check per CALL. It wraps registration rather than each tool body,
// so a tool added later cannot forget it — the same chokepoint
// instrumentServer uses.
//
// Apply it OUTSIDE instrumentServer:
//   requireAdminForEveryTool(instrumentServer(new FastMCP(...), 'admin'))
// Registration then passes through this guard first and the recorder second,
// so at call time the recorder runs outermost and a refused attempt is still
// recorded in usage analytics.
import { UserError, type FastMCP } from 'fastmcp';
import { isAdminEmail } from '../auth/admin.js';

type AnyTool = { name: string; execute: (args: any, context: any) => Promise<any> };

export const NOT_ADMIN_MESSAGE =
  'The Admin MCP is for administrators only. Your account is not in ADMIN_EMAILS.';

/** `tool` with an `execute` that refuses any caller whose session email is not an admin. */
export function guardTool<T extends AnyTool>(tool: T): T {
  const execute = tool.execute;
  return {
    ...tool,
    execute: async (args: any, context: any) => {
      if (!isAdminEmail(context?.session?.email)) throw new UserError(NOT_ADMIN_MESSAGE);
      return execute.call(tool, args, context);
    },
  };
}

/** Makes every tool later added to `server` refuse non-admin callers. Must wrap the constructor. */
export function requireAdminForEveryTool<S extends FastMCP<any>>(server: S): S {
  const addTool = server.addTool.bind(server);
  const addTools = server.addTools.bind(server);
  (server as any).addTool = (tool: AnyTool) => addTool(guardTool(tool) as any);
  (server as any).addTools = (tools: AnyTool[]) => addTools(tools.map((t) => guardTool(t)) as any);
  return server;
}
