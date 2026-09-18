// Opens a Browserbase cloud browser and hands back a CDP endpoint.
//
// This module is deliberately ONLY the connection. Everything about driving
// ChatGPT — selectors, the streaming-complete heuristic, response extraction —
// stays in chatgpt-web.ts and is shared by both transports. A forked driver
// would drift the moment ChatGPT changed its DOM, and the whole point of the
// SELECTOR-TODO comments there is that they change often.
//
// Why this exists: the local transport attaches to a real Chrome started
// outside Playwright with a warmed profile, which pins the ChatGPT job to the
// self-hosted Mac Studio. A cloud browser lets that job run on ubuntu-latest.
// See BROWSERBASE.md for setup and for the Cloudflare caveat, which is the
// thing most likely to decide whether this is usable at all.

import Browserbase from '@browserbasehq/sdk';
import type { ClientName } from './driver.ts';
import { taskTimeoutMs } from '../budget.ts';

export interface BrowserbaseSession {
  /** Pass to chromium.connectOverCDP(). */
  connectUrl: string;
  sessionId: string;
  /** Dashboard replay of the whole run — worth attaching to a failure bundle. */
  replayUrl: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Browserbase transport needs BROWSERBASE_API_KEY, ` +
        'BROWSERBASE_PROJECT_ID and BROWSERBASE_CONTEXT_ID — see e2e/BROWSERBASE.md.',
    );
  }
  return value;
}

/**
 * The seeded context for one client.
 *
 * Contexts are per-client, not per-project: claude.ai and chatgpt.com are
 * unrelated logins, and seedBrowserbaseContext.ts writes one context per client
 * for that reason. A single shared BROWSERBASE_CONTEXT_ID therefore cannot serve
 * both -- whichever client ran second would open the other one's cookie jar and
 * land on a sign-in page, which reads as a broken selector.
 *
 * `BROWSERBASE_CONTEXT_ID_CLAUDE_WEB` / `..._CHATGPT_WEB` win; the unsuffixed
 * form stays as the fallback so a single-client setup needs no change.
 */
export function contextIdFor(client?: ClientName): string {
  const scoped = client ? process.env[`BROWSERBASE_CONTEXT_ID_${client.toUpperCase().replace(/-/g, '_')}`] : undefined;
  const value = scoped || process.env.BROWSERBASE_CONTEXT_ID;
  if (!value) {
    throw new Error(
      `No Browserbase context for ${client ?? 'this client'}. Set ` +
        `BROWSERBASE_CONTEXT_ID_${(client ?? 'client').toUpperCase().replace(/-/g, '_')} ` +
        'or BROWSERBASE_CONTEXT_ID -- see e2e/BROWSERBASE.md.',
    );
  }
  return value;
}

/**
 * End a session now rather than letting it idle to its api_timeout.
 *
 * Browserbase bills browser-minutes until the session actually ends, so an
 * abandoned session is a silent cost, not just untidy. Best-effort on purpose:
 * failing to release must never turn a passing run red.
 */
export async function releaseSession(sessionId: string): Promise<void> {
  try {
    await browserbaseClient().sessions.update(sessionId, { status: 'REQUEST_RELEASE' });
  } catch (err: any) {
    console.error(`[e2e] could not release browserbase session ${sessionId}: ${err?.message ?? err}`);
  }
}

/** True when the harness has been asked to run against a cloud browser. */
export function usingBrowserbase(): boolean {
  return (process.env.E2E_BROWSER ?? '').toLowerCase() === 'browserbase';
}

export function browserbaseClient(): Browserbase {
  return new Browserbase({ apiKey: required('BROWSERBASE_API_KEY') });
}

/**
 * Start a session carrying the seeded ChatGPT login.
 *
 * `persist` defaults to FALSE, and that default is load-bearing. Node's test
 * runner parallelises across files, so a gate run opens ~18 sessions at once;
 * if each wrote its cookie jar back to the shared context on close, they would
 * race and the last one to finish would define everyone's auth state. Tests
 * read the seeded auth and write nothing. Only the seeding script sets
 * persist: true, and it runs alone.
 */
export async function createBrowserbaseSession(
  opts: { persist?: boolean; timeoutSeconds?: number; keepAlive?: boolean; client?: ClientName } = {},
): Promise<BrowserbaseSession> {
  const bb = browserbaseClient();
  const projectId = required('BROWSERBASE_PROJECT_ID');
  const contextId = contextIdFor(opts.client);

  const session = await bb.sessions.create({
    projectId,
    browserSettings: {
      context: { id: contextId, persist: opts.persist ?? false },
    },
    // `api_timeout`, not `timeout` — the Node SDK carries the Python parameter
    // name here (SessionCreateParams in @browserbasehq/sdk), and `timeout` is
    // silently rejected as an unknown property.
    //
    // Derived from the test's own budget rather than a flat 300. When node:test
    // abandons a timed-out test it never runs dispose(), so nothing releases the
    // session and it bills until this fires. Tying it to the test timeout means
    // an abandoned session outlives its test by a known margin instead of an
    // arbitrary one -- which matters on a plan measured in browser-minutes per
    // month.
    api_timeout: opts.timeoutSeconds ?? Math.ceil(taskTimeoutMs() / 1000) + 30,
    ...(opts.keepAlive ? { keepAlive: true } : {}),
  });

  return {
    connectUrl: session.connectUrl,
    sessionId: session.id,
    replayUrl: `https://browserbase.com/sessions/${session.id}`,
  };
}

/** Live View URL — a human can watch, or drive, a running session from here. */
export async function liveViewUrl(sessionId: string): Promise<string> {
  const bb = browserbaseClient();
  const links = await bb.sessions.debug(sessionId);
  return links.debuggerFullscreenUrl;
}
