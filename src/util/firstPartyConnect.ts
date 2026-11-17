// One-click connect for the first-party connectors that collect no
// credential (Storage, Sandbox): connecting only creates the dashboard row that
// carries the MCP URL. Each is one connector per user, enforced by a partial
// unique index (src/db.ts) as well as the check below.
import { createMcpInstance, getUserConnectedMcps } from '../mcpConnectionStore.js';

/** Postgres unique-violation code. */
const UNIQUE_VIOLATION = '23505';

export type FirstPartyConnectResult =
  | { outcome: 'unavailable' }
  | { outcome: 'exists'; instanceId: string; instanceName: string }
  | { outcome: 'created'; instanceId: string; instanceName: string };

export interface FirstPartyConnectDeps {
  getUserConnectedMcps: (userId: number) => Promise<Array<{ mcpSlug: string; instanceId: string; instanceName: string }>>;
  createMcpInstance: typeof createMcpInstance;
}

export const defaultFirstPartyConnectDeps: FirstPartyConnectDeps = { getUserConnectedMcps, createMcpInstance };

const EMPTY_GOOGLE_TOKENS = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };

async function findExisting(userId: number, slug: string, deps: FirstPartyConnectDeps) {
  return (await deps.getUserConnectedMcps(userId)).find((c) => c.mcpSlug === slug);
}

/** Creates the user's single connector for `slug`, unless they already have one. */
export async function connectFirstPartyMcp(
  userId: number,
  slug: string,
  instanceName: string,
  deps: FirstPartyConnectDeps,
): Promise<FirstPartyConnectResult> {
  const existing = await findExisting(userId, slug, deps);
  if (existing) return { outcome: 'exists', instanceId: existing.instanceId, instanceName: existing.instanceName };
  try {
    const connection = await deps.createMcpInstance(userId, slug, instanceName, EMPTY_GOOGLE_TOKENS, null, slug, {} as any, null);
    return { outcome: 'created', instanceId: connection.instanceId, instanceName: connection.instanceName };
  } catch (err: any) {
    // A concurrent connect won the unique index: answer with its connector.
    if (err?.code === UNIQUE_VIOLATION) {
      const winner = await findExisting(userId, slug, deps);
      if (winner) return { outcome: 'exists', instanceId: winner.instanceId, instanceName: winner.instanceName };
    }
    throw err;
  }
}
