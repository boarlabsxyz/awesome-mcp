// Navigation for the SPA clients, where "the navigation event succeeded" is the
// wrong success condition.
//
// claude.ai and chatgpt.com both rewrite the URL client-side the moment they
// boot -- /new becomes a conversation route, an auth check bounces through a
// redirect. Chrome reports a navigation superseded that way as
//
//   page.goto: net::ERR_ABORTED at https://claude.ai/new
//
// which reads like the site refused the request. It did not: the page usually
// lands exactly where it was going. Treating that as fatal fails the run before
// a single selector is tried, and the error names the URL rather than the real
// problem.
//
// So an aborted navigation is tolerated here and the caller decides, by looking
// for the thing it actually needs -- a composer. Every other navigation error
// (DNS, connection refused, a closed target) still throws, because those never
// end with a usable page.

import type { Page } from 'playwright';

/** Errors that mean "superseded", not "failed". */
const SUPERSEDED = ['ERR_ABORTED', 'Navigation interrupted', 'frame was detached'];

export async function gotoTolerantly(page: Page, url: string, timeoutMs = 45_000): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!SUPERSEDED.some((s) => message.includes(s))) throw err;
    // Let the client-side route settle before the caller starts hunting for its
    // composer, otherwise the first selector query races the redirect.
    await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
  }
}
