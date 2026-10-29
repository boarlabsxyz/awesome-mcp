// One-click connect for the Admin MCP (GET /connect/admin).
//
// There is no credential to collect — the Admin MCP reads this server's own
// database — so connecting only creates the dashboard row that carries the
// MCP URL. The row grants nothing by itself: every call re-checks the CALLER
// against ADMIN_EMAILS (mcpAuthenticate.ts, adminGuard.ts).
import { isAdminEmail } from '../auth/admin.js';
import { createMcpInstance, getUserConnectedMcps } from '../mcpConnectionStore.js';

export type AdminConnectResult =
  | { outcome: 'forbidden' }
  | { outcome: 'exists'; instanceId: string; instanceName: string }
  | { outcome: 'created'; instanceId: string; instanceName: string };

export interface AdminConnectDeps {
  getUserConnectedMcps: (userId: number) => Promise<Array<{ mcpSlug: string; instanceId: string; instanceName: string }>>;
  createMcpInstance: typeof createMcpInstance;
}

const defaultDeps: AdminConnectDeps = { getUserConnectedMcps, createMcpInstance };

const EMPTY_GOOGLE_TOKENS = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };

/** Creates the user's single Admin MCP connector, unless they are not an admin or already have one. */
export async function connectAdminMcp(
  user: { id: number; email: string },
  deps: AdminConnectDeps = defaultDeps,
): Promise<AdminConnectResult> {
  if (!isAdminEmail(user.email)) return { outcome: 'forbidden' };
  const existing = (await deps.getUserConnectedMcps(user.id)).find((c) => c.mcpSlug === 'admin');
  if (existing) return { outcome: 'exists', instanceId: existing.instanceId, instanceName: existing.instanceName };
  const connection = await deps.createMcpInstance(user.id, 'admin', 'Admin', EMPTY_GOOGLE_TOKENS, null, 'admin', {} as any, null);
  return { outcome: 'created', instanceId: connection.instanceId, instanceName: connection.instanceName };
}
