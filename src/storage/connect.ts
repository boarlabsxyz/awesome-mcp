// One-click connect for the Storage MCP (GET /connect/storage).
//
// There is no credential to collect — the data lives in this server's own
// database, keyed by the caller — so connecting only creates the dashboard row
// that carries the MCP URL. Data is per user, so one connector per user
// (src/util/firstPartyConnect.ts).
import { isDatabaseAvailable } from '../db.js';
import {
  connectFirstPartyMcp,
  defaultFirstPartyConnectDeps,
  type FirstPartyConnectDeps,
  type FirstPartyConnectResult,
} from '../util/firstPartyConnect.js';

export type StorageConnectResult = FirstPartyConnectResult;

export interface StorageConnectDeps extends FirstPartyConnectDeps {
  isDatabaseAvailable: () => boolean;
}

const defaultDeps: StorageConnectDeps = { ...defaultFirstPartyConnectDeps, isDatabaseAvailable };

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
  return connectFirstPartyMcp(user.id, 'storage', 'Storage', deps);
}
