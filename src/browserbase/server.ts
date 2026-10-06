// src/browserbase/server.ts
// Browserbase MCP server — drives a real cloud browser so an LLM can work with
// sites that have no API or connector.
//
// Conventions worth knowing before adding a tool here:
//
//   - The six browser tools (start/end/navigate/act/observe/extract) are PROXIES
//     to Browserbase's hosted MCP server at https://mcp.browserbase.com/mcp.
//     The names match the hosted server's exactly, so a user moving off it sees
//     the same surface. Stagehand and its model run on Browserbase's side,
//     which is why this connector needs no model key.
//   - `sessionId` must be threaded by the caller through every browser call.
//     A fresh transport is opened per call and nothing is cached, so there is no
//     "current session" to fall back on. Browserbase documents this client shape
//     and prescribes the explicit id; see mcpProxyClient.ts for why caching
//     would be actively wrong across replicas.
//   - A session bills until it is released or hits its timeout. The three REST
//     tools (listBrowserSessions / getBrowserSession / forceEndBrowserSession)
//     exist because without them a stranded session is invisible through this
//     server while still costing money.
//   - Domain rules bind `navigate` only — it is the one tool that names a
//     destination. See accessRules.ts: it is a guardrail, not a boundary.
//
// Mirrors the tool set of https://github.com/browserbase/mcp-server-browserbase
// and the hosted endpoint it documents. Every body here is written against
// UserSession and this repo's per-connection credential model rather than the
// reference's global env config, so this is an adaptation, not a port.

import { FastMCP, UserError } from 'fastmcp';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { registerMintRestBearerForCurl } from '../sharedTools/mintRestBearerForCurl.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';

import {
  BrowserbaseToolLog,
  getBrowserbaseClient,
  withBrowserbaseClient,
} from './apiHelpers.js';
import { BrowserbaseAccessRules } from './accessRules.js';
import {
  HostedProxy,
  hostedProxyFor,
  opAct,
  opEnd,
  opExtract,
  opForceEndBrowserSession,
  opGetBrowserSession,
  opListBrowserSessions,
  opNavigate,
  opObserve,
  opStart,
} from './ops.js';
import {
  actSchema,
  endSchema,
  extractSchema,
  forceEndBrowserSessionSchema,
  getBrowserSessionSchema,
  listBrowserSessionsSchema,
  navigateSchema,
  observeSchema,
  startSchema,
} from './schemas.js';

// Re-exported so the REST routes in webServer.ts validate against the same
// definitions these tools do, rather than a hand-rolled copy that can drift.
export {
  startSchema,
  endSchema,
  navigateSchema,
  actSchema,
  observeSchema,
  extractSchema,
  listBrowserSessionsSchema,
  getBrowserSessionSchema,
  forceEndBrowserSessionSchema,
};

export const browserbaseServer = new FastMCP<UserSession>({
  name: 'Browserbase MCP',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'browserbase'),
});

// REST data-plane companions. Registered because src/restCatalog.ts marks the
// /api/v1/browserbase endpoints live: without mintRestBearerForCurl the only
// credential for them is the PERMANENT dashboard API key, and without
// listRestEndpoints a client cannot discover them in-session.
registerMintRestBearerForCurl(browserbaseServer);
registerListRestEndpoints(browserbaseServer);

/** The API key for the hosted-MCP proxy. Same credential the REST client uses. */
function getApiKey(session?: UserSession): string {
  if (!session?.browserbaseAccessToken) {
    throw new UserError(
      'Browserbase not connected. Visit the dashboard to connect your Browserbase account with an API key.',
    );
  }
  return session.browserbaseAccessToken;
}

function proxyFor(session?: UserSession): HostedProxy {
  return hostedProxyFor(getApiKey(session));
}

/**
 * Re-read domain rules from the database on each call (SSE sessions are
 * long-lived, so a session-cached copy would keep serving rules the user has
 * already changed).
 *
 * Returns undefined when nothing is configured, which means UNRESTRICTED. This
 * is deliberately the opposite of the Slack equivalent, which throws when no
 * rules exist: there the default must be "read nothing", here it must be
 * "browse anything", or a freshly connected instance is inert until someone
 * opens a modal they have no reason to open.
 */
async function getRules(session?: UserSession): Promise<BrowserbaseAccessRules | undefined> {
  const instanceId = session?.browserbaseInstanceId;
  if (!instanceId) return undefined;
  try {
    const { getMcpConnectionByInstanceId } = await import('../mcpConnectionStore.js');
    const connection = await getMcpConnectionByInstanceId(instanceId);
    const rules = (connection?.providerTokens as any)?.accessRules;
    return rules ?? undefined;
  } catch {
    // A rules lookup that fails must not block browsing: the stored default is
    // "no restriction", so failing closed here would break every call for a
    // database blip while protecting nothing the user asked to protect.
    return undefined;
  }
}

/**
 * Shared wrapper for the proxied browser tools: resolve the key, run, and let a
 * UserError through untouched so the proxy's own messages (which explain the
 * sessionId contract) survive.
 */
async function withProxy(
  prefix: string,
  session: UserSession | undefined,
  log: BrowserbaseToolLog,
  fn: (proxy: HostedProxy) => Promise<string>,
): Promise<string> {
  const proxy = proxyFor(session);
  try {
    return await fn(proxy);
  } catch (error: any) {
    if (error instanceof UserError) throw error;
    log.error(`${prefix}: ${error?.message ?? error}`);
    throw new UserError(`${prefix}: ${error?.message ?? error}`);
  }
}

// ==================== Browser session lifecycle ====================

browserbaseServer.addTool({
  name: 'start',
  annotations: { readOnlyHint: false },
  description:
    'Start a cloud browser session (or reattach to an existing one) and return its sessionId. ' +
    'Call this first. The returned sessionId must be passed to every following browser call — navigate, act, observe, extract and end — ' +
    'because each call reaches Browserbase independently and there is no remembered "current" session. ' +
    'The session bills until end is called or it hits its timeout, so end it when the task is done.',
  parameters: startSchema,
  execute: async (args, { log, session }) => {
    log.info('Starting Browserbase session', { reattach: !!args.sessionId });
    const proxy = proxyFor(session);
    const client = getBrowserbaseClient(session);
    const rules = await getRules(session);
    return opStart(proxy, client, args, rules);
  },
});

browserbaseServer.addTool({
  name: 'end',
  annotations: { readOnlyHint: false },
  description:
    'Close a browser session so it stops billing. Pass the sessionId returned by start. ' +
    'If the browser-control call fails, this falls back to releasing the session through the Browserbase REST API and says which path closed it.',
  parameters: endSchema,
  execute: async (args, { log, session }) => {
    log.info('Ending Browserbase session', { sessionId: args.sessionId });
    const proxy = proxyFor(session);
    const client = getBrowserbaseClient(session);
    return opEnd(proxy, client, args);
  },
});

// ==================== Page interaction ====================

browserbaseServer.addTool({
  name: 'navigate',
  annotations: { readOnlyHint: false },
  description:
    'Open a URL in the browser session. Pass the sessionId returned by start. ' +
    'If this connection has domain rules configured on the dashboard, they are enforced here — navigate is the only tool that can enforce them, ' +
    'since it is the only one that names a destination.',
  parameters: navigateSchema,
  execute: async (args, { log, session }) => {
    log.info('Navigating browser', { sessionId: args.sessionId });
    const rules = await getRules(session);
    return withProxy('Failed to navigate', session, log, proxy => opNavigate(proxy, args, rules));
  },
});

browserbaseServer.addTool({
  name: 'act',
  annotations: { readOnlyHint: false },
  description:
    'Perform one action on the current page using plain language — click a button, fill a field, submit a form. Pass the sessionId returned by start. ' +
    'Note this can follow a link to any site: a configured domain allowlist applies to navigate only and does not constrain where an action may lead.',
  parameters: actSchema,
  execute: (args, { log, session }) => {
    log.info('Acting on page', { sessionId: args.sessionId });
    return withProxy('Failed to perform the action', session, log, proxy => opAct(proxy, args));
  },
});

browserbaseServer.addTool({
  name: 'observe',
  annotations: { readOnlyHint: true },
  description:
    'Find the actionable elements on the current page matching an instruction — use it to discover what can be clicked or filled before calling act. ' +
    'Pass the sessionId returned by start.',
  parameters: observeSchema,
  execute: (args, { log, session }) => {
    log.info('Observing page', { sessionId: args.sessionId });
    return withProxy('Failed to observe the page', session, log, proxy => opObserve(proxy, args));
  },
});

browserbaseServer.addTool({
  name: 'extract',
  annotations: { readOnlyHint: true },
  description:
    'Pull data or text out of the current page. Give an instruction describing what you want (e.g. "the plan names and monthly prices") or omit it for the page text. ' +
    'Pass the sessionId returned by start.',
  parameters: extractSchema,
  execute: (args, { log, session }) => {
    log.info('Extracting from page', { sessionId: args.sessionId });
    return withProxy('Failed to extract from the page', session, log, proxy => opExtract(proxy, args));
  },
});

// ==================== Session cost control ====================

browserbaseServer.addTool({
  name: 'listBrowserSessions',
  annotations: { readOnlyHint: true },
  description:
    'List this account\'s Browserbase sessions and flag which are still RUNNING. Use it to find sessions left open by an earlier conversation — ' +
    'a running session bills until it is released or times out, and nothing else in this connector can see one whose id was lost.',
  parameters: listBrowserSessionsSchema,
  execute: (args, { log, session }) =>
    withBrowserbaseClient('Failed to list browser sessions', session, log, client =>
      opListBrowserSessions(client, args),
    ),
});

browserbaseServer.addTool({
  name: 'getBrowserSession',
  annotations: { readOnlyHint: true },
  description:
    'Look up one Browserbase session: its status, region, when it expires, and a dashboard link to its live view and replay. ' +
    'Use it to check whether a sessionId is still live before spending browser calls on it.',
  parameters: getBrowserSessionSchema,
  execute: (args, { log, session }) =>
    withBrowserbaseClient('Failed to fetch browser session', session, log, client =>
      opGetBrowserSession(client, args),
    ),
});

browserbaseServer.addTool({
  name: 'forceEndBrowserSession',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description:
    'Force a Browserbase session to close by id, through the REST API. Works even when no browser-control session holds it, ' +
    'which is the state a stranded session is in. Anything in progress in that browser is lost.',
  parameters: forceEndBrowserSessionSchema,
  execute: (args, { log, session }) =>
    withBrowserbaseClient('Failed to close browser session', session, log, client =>
      opForceEndBrowserSession(client, args),
    ),
});
