// Who may read compensation (salary) data through this server.
//
// An operator gate, deliberately not owner-editable: the PeopleForce API key
// belongs to the connection owner, but the people asking through it are
// other users, and the key's own restriction ("the answer follows the key,
// not the asking person") says nothing about WHO is asking. So a signed-in
// user may see compensation only if their email is in
// PEOPLEFORCE_COMPENSATION_EMAILS (comma-separated, case-insensitive) or in
// ADMIN_EMAILS. Read per call, like adminEmails() in ./admin.ts.
//
// requireCompensationAccessFor patches addTool/addTools, so wrap the server
// OUTSIDE instrumentServer (same as requireAdminForEveryTool in
// src/admin-mcp/adminGuard.ts): the recorder then runs outermost at call time
// and a refused attempt is still recorded in usage analytics.
import { UserError, type FastMCP } from 'fastmcp';
import { isAdminEmail } from './admin.js';

type AnyTool = { name: string; execute: (args: any, context: any) => Promise<any> };

export const COMPENSATION_RESTRICTED_MESSAGE =
  'Compensation data is restricted on this server: your account is not in PEOPLEFORCE_COMPENSATION_EMAILS (or ADMIN_EMAILS). Ask an administrator to add you.';

/** The configured compensation-viewer addresses, lowercased and trimmed. */
export function compensationEmails(): string[] {
  return (process.env.PEOPLEFORCE_COMPENSATION_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** True for an admin or a listed address (case-insensitive). Anything not a non-empty string is false. */
export function mayViewCompensation(email: unknown): boolean {
  if (typeof email !== 'string' || !email.trim()) return false;
  return isAdminEmail(email) || compensationEmails().includes(email.trim().toLowerCase());
}

function guardCompensationTool<T extends AnyTool>(tool: T, names: ReadonlySet<string>): T {
  if (!names.has(tool.name)) return tool;
  const execute = tool.execute;
  return {
    ...tool,
    execute: async (args: any, context: any) => {
      if (!mayViewCompensation(context?.session?.email)) throw new UserError(COMPENSATION_RESTRICTED_MESSAGE);
      return execute.call(tool, args, context);
    },
  };
}

/** Makes the named tools, when later added to `server`, refuse callers who may not view compensation. */
export function requireCompensationAccessFor<S extends FastMCP<any>>(server: S, toolNames: ReadonlySet<string>): S {
  const addTool = server.addTool.bind(server);
  const addTools = server.addTools.bind(server);
  (server as any).addTool = (tool: AnyTool) => addTool(guardCompensationTool(tool, toolNames) as any);
  (server as any).addTools = (tools: AnyTool[]) => addTools(tools.map((t) => guardCompensationTool(t, toolNames)) as any);
  return server;
}
