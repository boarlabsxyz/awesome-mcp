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
// `act` and `end` joined this plane on the owner request for full REST
// coverage of non-destructive writes. `act` submits forms and clicks buttons on
// third-party systems and the plane accepts the permanent dashboard API key,
// with no confirmation affordance behind a curl; that was accepted knowingly.
// `end` is the clean shutdown (hosted end, then a release); `release` stays the
// by-id force-close that works when no browser-control session holds it.

import {
  BrowserbaseClient,
  BrowserbaseSession,
  sessionDashboardUrl,
} from './apiHelpers.js';
import { BrowserbaseAccessRules, assertDomainAllowed } from './accessRules.js';
import {
  extractNavigationFacts,
  renderPayload,
  safeErrorText,
  sanitize,
  unwrapEnvelope,
} from './responseSafety.js';
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

export interface NavigationResult {
  sessionId: string;
  /** The URL that was requested — authoritative, and not read from the payload. */
  url: string;
  status?: number;
  title?: string;
}

/**
 * Unwrap the `{success,data}` envelope, collapse degenerate runs, redact
 * credentials and cap the size.
 *
 * Shared with the MCP ops through responseSafety so the two surfaces cannot
 * disagree about what is safe to return — the REST plane leaked exactly the
 * same payload as the tool did.
 */
function safePayload(text: string): string {
  return sanitize(renderPayload(unwrapEnvelope(text))).text;
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
): Promise<NavigationResult> {
  const url = assertDomainAllowed(rules, args.url);
  const text = await proxy('navigate', { url: url.toString(), sessionId });

  // The upstream payload is NOT returned. `navigate` answers with a serialized
  // Page/CDP object carrying the internal connect websocket URL, its signingKey
  // JWT several times over, internal cluster hostnames and a flow-logger
  // session id — and this endpoint was handing all of it to any API-key holder.
  // Projected to an allowlist rather than redacted, for the same reason as the
  // MCP tool: the payload's shape is Browserbase's to change.
  const facts = extractNavigationFacts(unwrapEnvelope(text));
  return { sessionId, url: url.toString(), status: facts.status, title: facts.title };
}

export async function performObserve(
  proxy: HostedProxy,
  sessionId: string,
  args: { instruction: string },
): Promise<PageActionResult> {
  const text = await proxy('observe', { instruction: args.instruction, sessionId });
  return { sessionId, result: safePayload(text) };
}

export async function performExtract(
  proxy: HostedProxy,
  sessionId: string,
  args: { instruction?: string },
): Promise<PageActionResult> {
  const text = await proxy('extract', {
    ...(args.instruction ? { instruction: args.instruction } : {}),
    sessionId,
  });
  return { sessionId, result: safePayload(text) };
}

/**
 * One action on the current page. Domain rules are NOT applied, for the same
 * reason as on the MCP side: an action names no destination, so a rule could
 * only be checked against a page the browser is already on. The rules bind
 * navigate, and the act description says an action can lead off-list.
 */
export async function performAct(
  proxy: HostedProxy,
  sessionId: string,
  args: { action: string },
): Promise<PageActionResult> {
  const text = await proxy('act', { action: args.action, sessionId });
  return { sessionId, result: safePayload(text) };
}

export interface EndResult {
  sessionId: string;
  closed: true;
  /** `end` when the hosted call closed it; `release` when that failed and the REST release did. */
  closedVia: 'end' | 'release';
  /**
   * true once Browserbase accepted a release. null when only the hosted end
   * succeeded: a keep-alive session can survive it, so whether it still bills
   * is unknown rather than false.
   */
  billingStopped: true | null;
  /** Why the hosted end failed, when closedVia is release. */
  endError?: string;
  /** Why the follow-up release was refused, when billingStopped is null. */
  releaseError?: string;
  dashboardUrl: string;
}

const errorText = (err: any): string => safeErrorText(err?.message ?? String(err));

/**
 * Close a session by id: the hosted `end`, then always a REST release, because a
 * keep-alive session may survive the hosted call. When the hosted call fails the
 * release is the fallback. Shared with the MCP tool (opEnd renders this), so the
 * two surfaces cannot disagree about when a session counts as closed.
 *
 * Both failing throws, tagged 404 when the release says the session does not
 * exist and 502 otherwise: nothing confirmed the close, so reporting one would
 * leave a browser billing that the caller believes is gone.
 */
export async function performEnd(
  proxy: HostedProxy,
  client: BrowserbaseClient,
  sessionId: string,
): Promise<EndResult> {
  const dashboardUrl = sessionDashboardUrl(sessionId);
  let endError: string | undefined;
  try {
    // The upstream payload is dropped: a close either happened or it did not,
    // and the payload is a CDP fragment that tells the caller nothing.
    await proxy('end', { sessionId });
  } catch (err: any) {
    endError = errorText(err);
  }

  try {
    await client.releaseSession(sessionId);
  } catch (releaseErr: any) {
    if (endError === undefined) {
      return { sessionId, closed: true, closedVia: 'end', billingStopped: null, releaseError: errorText(releaseErr), dashboardUrl };
    }
    const err: any = new Error(
      `Could not close session ${sessionId}. The browser-control call failed (${endError}) and so did the ` +
        `REST release (${errorText(releaseErr)}). It may still be running and billing — check ${dashboardUrl} and close it there.`,
    );
    err.name = 'BrowserbaseEndFailed';
    err.status = releaseErr?.status === 404 ? 404 : 502;
    throw err;
  }

  return endError === undefined
    ? { sessionId, closed: true, closedVia: 'end', billingStopped: true, dashboardUrl }
    : { sessionId, closed: true, closedVia: 'release', billingStopped: true, endError, dashboardUrl };
}
