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
  /** E2B key and Redis both present: without either, every tool would fail. */
  isConfigured: () => boolean;
}

const defaultDeps: SandboxConnectDeps = {
  ...defaultFirstPartyConnectDeps,
  isConfigured: () => Boolean(process.env.E2B_API_KEY) && isDatabaseAvailable(),
};

export async function connectSandboxMcp(
  user: { id: number },
  deps: SandboxConnectDeps = defaultDeps,
): Promise<FirstPartyConnectResult> {
  if (!deps.isConfigured()) return { outcome: 'unavailable' };
  return connectFirstPartyMcp(user.id, 'sandbox', 'Sandbox', deps);
}
