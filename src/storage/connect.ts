// One-click connect for the Storage MCP (GET /connect/storage).
//
// There is no credential to collect — the data lives in this server's own
// database, keyed by the caller — so connecting only creates the dashboard row
// that carries the MCP URL. Data is per user, so one connector per user.
import { createMcpInstance, getUserConnectedMcps } from '../mcpConnectionStore.js';

export type StorageConnectResult =
  | { outcome: 'exists'; instanceId: string; instanceName: string }
  | { outcome: 'created'; instanceId: string; instanceName: string };

export interface StorageConnectDeps {
  getUserConnectedMcps: (userId: number) => Promise<Array<{ mcpSlug: string; instanceId: string; instanceName: string }>>;
  createMcpInstance: typeof createMcpInstance;
}

const defaultDeps: StorageConnectDeps = { getUserConnectedMcps, createMcpInstance };

const EMPTY_GOOGLE_TOKENS = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };

/** Creates the user's single Storage MCP connector, unless they already have one. */
export async function connectStorageMcp(
  user: { id: number },
  deps: StorageConnectDeps = defaultDeps,
): Promise<StorageConnectResult> {
  const existing = (await deps.getUserConnectedMcps(user.id)).find((c) => c.mcpSlug === 'storage');
  if (existing) return { outcome: 'exists', instanceId: existing.instanceId, instanceName: existing.instanceName };
  const connection = await deps.createMcpInstance(user.id, 'storage', 'Storage', EMPTY_GOOGLE_TOKENS, null, 'storage', {} as any, null);
  return { outcome: 'created', instanceId: connection.instanceId, instanceName: connection.instanceName };
}
