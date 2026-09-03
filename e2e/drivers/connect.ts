// Shared browser transport for the web-based drivers (chatgpt-web, claude-web).
//
// Both connect the same two ways — a local Chrome over CDP, or a Browserbase
// cloud session — and only the site they drive differs. Keeping the switch here
// means adding a third web client is a selectors-only job, and that a fix to
// the transport lands for every client at once.

import { chromium, type Browser } from 'playwright';
import { createBrowserbaseSession, usingBrowserbase, type BrowserbaseSession } from './browserbase.ts';

export interface Connection {
  browser: Browser;
  /** Null when running against a local Chrome. */
  remote: BrowserbaseSession | null;
  /** For appVersion() / forensics, so a failure says where it ran. */
  describe(): string;
}

export async function connectBrowser(localCdpEndpoint: string): Promise<Connection> {
  const remote = usingBrowserbase() ? await createBrowserbaseSession() : null;
  if (remote) {
    console.error(`[e2e] browserbase session ${remote.sessionId} — replay: ${remote.replayUrl}`);
  }

  const browser = await chromium.connectOverCDP(remote ? remote.connectUrl : localCdpEndpoint);

  return {
    browser,
    remote,
    describe: () => (remote ? `browserbase session=${remote.sessionId}` : 'local-cdp'),
  };
}
