// One-click connect for the Storage MCP (GET /connect/storage).
//
// There is no credential to collect — the data lives in this server's own
// database, keyed by the caller — so connecting only creates the dashboard row
// that carries the MCP URL. Data is per user, so one connector per user,
// enforced by a partial unique index (src/db.ts) as well as the check below.
import { isDatabaseAvailable } from '../db.js';
import { createMcpInstance, getUserConnectedMcps } from '../mcpConnectionStore.js';
import { UNIQUE_VIOLATION } from './store.js';

export type StorageConnectResult =
  | { outcome: 'unavailable' }
  | { outcome: 'exists'; instanceId: string; instanceName: string }
  | { outcome: 'created'; instanceId: string; instanceName: string };

export interface StorageConnectDeps {
  isDatabaseAvailable: () => boolean;
  getUserConnectedMcps: (userId: number) => Promise<Array<{ mcpSlug: string; instanceId: string; instanceName: string }>>;
  createMcpInstance: typeof createMcpInstance;
}

const defaultDeps: StorageConnectDeps = { isDatabaseAvailable, getUserConnectedMcps, createMcpInstance };

const EMPTY_GOOGLE_TOKENS = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };

async function findExisting(userId: number, deps: StorageConnectDeps) {
  return (await deps.getUserConnectedMcps(userId)).find((c) => c.mcpSlug === 'storage');
}

/**
 * Creates the user's single Storage MCP connector, unless they already have
 * one. Without a database it refuses: the connection store would fall back to
 * files and the connect would succeed, but every tool would then fail.
 */
export async function connectStorageMcp(
  user: { id: number },
  deps: StorageConnectDeps = defaultDeps,
): Promise<StorageConnectResult> {
  if (!deps.isDatabaseAvailable()) return { outcome: 'unavailable' };
  const existing = await findExisting(user.id, deps);
  if (existing) return { outcome: 'exists', instanceId: existing.instanceId, instanceName: existing.instanceName };
  try {
    const connection = await deps.createMcpInstance(user.id, 'storage', 'Storage', EMPTY_GOOGLE_TOKENS, null, 'storage', {} as any, null);
    return { outcome: 'created', instanceId: connection.instanceId, instanceName: connection.instanceName };
  } catch (err: any) {
    // A concurrent connect won the unique index: answer with its connector.
    if (err?.code === UNIQUE_VIOLATION) {
      const winner = await findExisting(user.id, deps);
      if (winner) return { outcome: 'exists', instanceId: winner.instanceId, instanceName: winner.instanceName };
    }
    throw err;
  }
}
