// src/browserbase/restOps.ts
// The REST-plane half of the Browserbase connector: one perform* per route,
// each returning DATA so the route emits JSON and the MCP tool renders a string
// from the same source.
//
// Why this module exists at all rather than the routes calling the client
// directly: webServer.ts would otherwise hold a second copy of the proxy
// plumbing and the session-id handling, which is the drift that bit Calendar.
// The body schemas live in schemas.ts and are composed from field objects
// shared with the MCP tools, so the two surfaces cannot disagree about what is
// valid.
//
// Note which tools are NOT here. `act` has no REST sibling on purpose — it
// submits forms on third-party systems, this plane accepts the permanent
// dashboard API key, and a curl has no confirmation affordance. `end` has none
// either, because releaseSession reaches the same operation by id and works in
// states the proxy call does not. See the notes in src/restCatalog.ts.

import {
  BrowserbaseClient,
  BrowserbaseSession,
  sessionDashboardUrl,
} from './apiHelpers.js';
import { BrowserbaseAccessRules, assertDomainAllowed } from './accessRules.js';
import { parseSessionId } from './mcpProxyClient.js';
import type { HostedProxy } from './ops.js';

export interface SessionListResult {
  sessions: BrowserbaseSession[];
  /** How many are still billing. The reason this endpoint exists. */
  running: number;
}

export async function performListSessions(
  client: BrowserbaseClient,
  status?: string,
): Promise<SessionListResult> {
  const sessions = await client.listSessions(status);
  return { sessions, running: sessions.filter(s => s.status === 'RUNNING').length };
}

export function performGetSession(
  client: BrowserbaseClient,
  sessionId: string,
): Promise<BrowserbaseSession> {
  return client.getSession(sessionId);
}

export interface ReleaseResult {
  sessionId: string;
  released: true;
  status?: string;
}

export async function performReleaseSession(
  client: BrowserbaseClient,
  sessionId: string,
): Promise<ReleaseResult> {
  const session = await client.releaseSession(sessionId);
  return { sessionId, released: true, status: session?.status };
}

export interface StartResult {
  sessionId: string;
  dashboardUrl: string;
  session?: BrowserbaseSession;
  /** Restated per response because the id is not remembered between calls. */
  note: string;
}

/**
 * Start (or reattach to) a session and report its id.
 *
 * The id is the contract every later call depends on, so a start that cannot
 * produce one throws rather than answering 201 with nothing usable — otherwise
 * a browser is left running that the caller has no way to address or close.
 */
export async function performStartSession(
  proxy: HostedProxy,
  client: BrowserbaseClient,
  requestedSessionId?: string,
): Promise<StartResult> {
  const text = await proxy('start', requestedSessionId ? { sessionId: requestedSessionId } : {});
  const sessionId = parseSessionId(text) ?? requestedSessionId;
  if (!sessionId) {
    const err: any = new Error(
      `Browserbase started a session but returned no id this endpoint could read, so later calls have nothing to target. ` +
        `GET /api/v1/browserbase/sessions to find and release it. Raw response: ${text}`,
    );
    err.status = 502;
    throw err;
  }

  let session: BrowserbaseSession | undefined;
  try {
    session = await client.getSession(sessionId);
  } catch {
    // Best-effort: the session exists either way, and failing a create that
    // succeeded would invite a retry that starts a second browser.
  }

  return {
    sessionId,
    dashboardUrl: sessionDashboardUrl(sessionId),
    session,
    note: 'Pass this sessionId in the path of every later call, and release the session when done — it bills until then.',
  };
}

export interface PageActionResult {
  sessionId: string;
  result: string;
}

/**
 * Navigate. Domain rules are enforced here and only here, for the same reason
 * as on the MCP side: it is the one operation that names a destination.
 */
export async function performNavigate(
  proxy: HostedProxy,
  sessionId: string,
  args: { url: string },
  rules?: BrowserbaseAccessRules,
): Promise<PageActionResult> {
  const url = assertDomainAllowed(rules, args.url);
  const result = await proxy('navigate', { url: url.toString(), sessionId });
  return { sessionId, result };
}

export async function performObserve(
  proxy: HostedProxy,
  sessionId: string,
  args: { instruction: string },
): Promise<PageActionResult> {
  return { sessionId, result: await proxy('observe', { instruction: args.instruction, sessionId }) };
}

export async function performExtract(
  proxy: HostedProxy,
  sessionId: string,
  args: { instruction?: string },
): Promise<PageActionResult> {
  const result = await proxy('extract', {
    ...(args.instruction ? { instruction: args.instruction } : {}),
    sessionId,
  });
  return { sessionId, result };
}
