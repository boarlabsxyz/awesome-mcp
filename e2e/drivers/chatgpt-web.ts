// Drives ChatGPT web (chatgpt.com) by attaching to a long-running real Chrome
// process via CDP. Chrome is launched outside Playwright with a warmed
// persistent profile so Cloudflare doesn't see Playwright's bundled Chromium
// fingerprint or a webdriver flag set by Playwright.
//
// To start Chrome before tests:
//   open -na "Google Chrome" --args \
//     --remote-debugging-port=9222 \
//     --user-data-dir="$HOME/e2e-chrome-profile"
//
// Then connect via CDP_ENDPOINT (default http://127.0.0.1:9222).
//
// SELECTOR-TODO: ChatGPT's DOM changes frequently. Confirm selectors after any
// app refresh; surface failures clearly in forensics rather than silently
// matching the wrong element.

import { type Page } from 'playwright';
import type { Driver } from './driver.ts';
import { connectBrowser } from './connect.ts';

const CDP_ENDPOINT = process.env.CHATGPT_CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
const CHATGPT_URL = process.env.CHATGPT_URL ?? 'https://chatgpt.com/';
const RESPONSE_TIMEOUT_MS = Number(process.env.RESPONSE_TIMEOUT_MS ?? 120_000);

export async function createChatGptWebDriver(): Promise<Driver> {
  // Only the TRANSPORT differs between local Chrome and a Browserbase cloud
  // browser — everything below is shared, so the selectors that change most
  // often live in exactly one place. E2E_BROWSER=browserbase picks the cloud
  // path; anything else keeps the local warmed-profile behaviour that is the
  // default on the Mac Studio.
  const conn = await connectBrowser(CDP_ENDPOINT);
  const context = conn.browser.contexts()[0] ?? (await conn.browser.newContext());
  let page: Page = context.pages()[0] ?? (await context.newPage());

  if (!page.url().includes('chatgpt.com')) {
    await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' });
  }

  return {
    async newConversation() {
      // Navigating to the root URL starts a fresh conversation.
      // SELECTOR-TODO: alternatively click the "New chat" button by data-testid
      // if URL navigation triggers a Cloudflare interstitial.
      await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
        // Networkidle is best-effort on ChatGPT; long-polling connections
        // never idle. Continue regardless.
      });
    },

    async sendAndWait(prompt) {
      // SELECTOR-TODO: ChatGPT has used both #prompt-textarea and a
      // contenteditable div historically; cover both.
      const composer = page.locator('#prompt-textarea, div[contenteditable="true"]').first();
      await composer.click();
      await composer.fill(prompt);
      await composer.press('Enter');
      return waitForResponseComplete(page);
    },

    async captureAccessibilitySnapshot() {
      // Playwright removed page.accessibility in v1.49+. Dump the full HTML so
      // forensics still captures DOM state at assertion time.
      return page.content();
    },

    async captureScreenshot() {
      return page.screenshot({ fullPage: true });
    },

    async appVersion() {
      const ua = await page.evaluate(() => navigator.userAgent);
      return `chatgpt-web ${conn.describe()} userAgent=${ua}`;
    },

    async dispose() {
      // The same call means two different things, which is worth stating
      // rather than inferring:
      //  - local: Chrome is a long-lived process started outside Playwright,
      //    so this only DISCONNECTS and the warmed profile survives for the
      //    next run.
      //  - browserbase: this ENDS the cloud session, which is what stops it
      //    billing. Leaving it open would burn browser-minutes until the
      //    session timeout expires.
      await conn.browser.close();
    },
  };
}

async function waitForResponseComplete(page: Page): Promise<string> {
  // Streaming heuristic: the stop button appears as soon as ChatGPT starts
  // streaming a reply and disappears when the stream ends. Waiting only for
  // disappearance races the network round-trip — the predicate is already
  // true the instant we check, so we'd read the *previous* turn's assistant
  // message. First wait for the button to appear so we know we're inside the
  // current turn's stream, then wait for it to disappear.
  // SELECTOR-TODO: data-testid="stop-button" is the historical id; verify.
  await page.waitForSelector('button[data-testid="stop-button"]', {
    state: 'attached',
    timeout: 15_000,
  });

  await page.waitForFunction(
    () => !document.querySelector('button[data-testid="stop-button"]'),
    null,
    { timeout: RESPONSE_TIMEOUT_MS, polling: 500 },
  );
  await page.waitForTimeout(750);

  // SELECTOR-TODO: assistant turns historically marked with
  // data-message-author-role="assistant".
  const messages = page.locator('[data-message-author-role="assistant"]');
  const count = await messages.count();
  if (count === 0) {
    throw new Error('No assistant messages found in ChatGPT DOM');
  }
  return messages.nth(count - 1).innerText();
}
