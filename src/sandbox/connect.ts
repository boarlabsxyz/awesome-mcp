// One-click connect for the Sandbox MCP (GET /connect/sandbox).
//
// The sandbox runs on this platform's own runner, so there is no credential to
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
 * The runner settings live on the service that runs the tools. With
 * SANDBOX_MCP_URL set that is a separate service, which this web service
 * cannot see into, so the URL stands in for them (that service's tools name
 * a missing runner themselves). Without the URL the tools run in this process
 * and need a runner configured here.
 */
export function sandboxConfigured(env: NodeJS.ProcessEnv, databaseAvailable: boolean): boolean {
  // As engine.ts decides: a runner URL wins, and needs its secret; only without one does local count.
  const runner = env.SANDBOX_RUNNER_URL ? Boolean(env.SANDBOX_RUNNER_SECRET) : env.SANDBOX_RUNNER === 'local';
  return databaseAvailable && Boolean(env.SANDBOX_MCP_URL || runner);
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
