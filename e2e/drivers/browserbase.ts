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
  opts: { persist?: boolean; timeoutSeconds?: number; keepAlive?: boolean } = {},
): Promise<BrowserbaseSession> {
  const bb = browserbaseClient();
  const projectId = required('BROWSERBASE_PROJECT_ID');
  const contextId = required('BROWSERBASE_CONTEXT_ID');

  const session = await bb.sessions.create({
    projectId,
    browserSettings: {
      context: { id: contextId, persist: opts.persist ?? false },
    },
    // `api_timeout`, not `timeout` — the Node SDK carries the Python parameter
    // name here (SessionCreateParams in @browserbasehq/sdk), and `timeout` is
    // silently rejected as an unknown property. Bounded so a hung ChatGPT
    // stream cannot burn browser-minutes up to the 6h ceiling; comfortably
    // above RESPONSE_TIMEOUT_MS (120s).
    api_timeout: opts.timeoutSeconds ?? 300,
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
