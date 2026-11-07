// One-click connect for the Sandbox MCP (GET /connect/sandbox).
//
// The sandbox runs on this platform's E2B key, so there is no credential to
// collect; connecting only creates the dashboard row that carries the MCP URL.
// One connector per user: they all reach the same per-user sandbox.
import { isDatabaseAvailable } from '../db.js';
import {
  connectFirstPartyMcp,
  defaultFirstPartyConnectDeps,
  type FirstPartyConnectDeps,
  type FirstPartyConnectResult,
} from '../util/firstPartyConnect.js';

export interface SandboxConnectDeps extends FirstPartyConnectDeps {
  /** Something can serve the tools, and there is a database to keep the connector in. */
  isConfigured: () => boolean;
}

/**
 * The E2B key lives on the service that runs the tools. With SANDBOX_MCP_URL
 * set that is a separate service, which this web service cannot see into, so
 * the URL stands in for the key (that service's tools name a missing key
 * themselves). Without the URL the tools run in this process and need the key here.
 */
export function sandboxConfigured(env: NodeJS.ProcessEnv, databaseAvailable: boolean): boolean {
  return databaseAvailable && Boolean(env.SANDBOX_MCP_URL || env.E2B_API_KEY);
}

const defaultDeps: SandboxConnectDeps = {
  ...defaultFirstPartyConnectDeps,
  isConfigured: () => sandboxConfigured(process.env, isDatabaseAvailable()),
};

export async function connectSandboxMcp(
  user: { id: number },
  deps: SandboxConnectDeps = defaultDeps,
): Promise<FirstPartyConnectResult> {
  if (!deps.isConfigured()) return { outcome: 'unavailable' };
  return connectFirstPartyMcp(user.id, 'sandbox', 'Sandbox', deps);
}
