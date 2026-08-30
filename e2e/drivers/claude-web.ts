// Drives Claude on the web (claude.ai) — the browser sibling of the
// claude-desktop driver, and the only Claude client that can run on a cloud
// browser. claude-desktop drives a signed Electron app through Appium and
// macOS Accessibility because CDP is fused off, which pins it to the Mac
// Studio; this one runs anywhere Playwright can reach a Chrome, including
// Browserbase.
//
// Transport (local Chrome vs Browserbase) is shared with chatgpt-web via
// connect.ts. Only the selectors below are Claude-specific.
//
// SELECTOR-TODO — EVERY selector in this file is UNVERIFIED against a live
// claude.ai session. They are written with fallbacks and a DOM-independent
// completion heuristic so they degrade into a clear error rather than a silent
// wrong answer, but the first run must be watched. With Browserbase that is
// easy: each run logs a replay URL, and `bb.sessions.debug()` gives a Live
// View you can drive by hand while inspecting the DOM.

import type { Page } from 'playwright';
import type { Driver } from './driver.ts';
import { connectBrowser } from './connect.ts';

const CDP_ENDPOINT = process.env.CLAUDE_CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
const CLAUDE_URL = process.env.CLAUDE_URL ?? 'https://claude.ai/new';
const RESPONSE_TIMEOUT_MS = Number(process.env.RESPONSE_TIMEOUT_MS ?? 120_000);

/** How long the reply text must stop changing before it counts as finished. */
const SETTLE_MS = Number(process.env.CLAUDE_SETTLE_MS ?? 2_500);
const POLL_MS = 500;

// Ordered by how specific they are. The first one that matches anything wins,
// so a future rename only needs a new entry at the front.
// SELECTOR-TODO: confirm against a live DOM.
const COMPOSER_SELECTORS = [
  'div[contenteditable="true"].ProseMirror',
  '[data-testid="chat-input"]',
  'div[contenteditable="true"]',
];

// SELECTOR-TODO: confirm. `.font-claude-message` has been the assistant-turn
// marker historically; the data-testid variants are defensive.
const ASSISTANT_SELECTORS = [
  '[data-testid="chat-message-content"]',
  '.font-claude-message',
  '[data-is-streaming] .font-claude-message',
];

export async function createClaudeWebDriver(): Promise<Driver> {
  const conn = await connectBrowser(CDP_ENDPOINT);
  const context = conn.browser.contexts()[0] ?? (await conn.browser.newContext());
  let page: Page = context.pages()[0] ?? (await context.newPage());

  if (!page.url().includes('claude.ai')) {
    await page.goto(CLAUDE_URL, { waitUntil: 'domcontentloaded' });
  }

  return {
    async newConversation() {
      await page.goto(CLAUDE_URL, { waitUntil: 'domcontentloaded' });
      await firstMatching(page, COMPOSER_SELECTORS, 'composer', 30_000);
    },

    async sendAndWait(prompt) {
      const composer = await firstMatching(page, COMPOSER_SELECTORS, 'composer', 30_000);
      await composer.click();

      // Claude's composer is a ProseMirror contenteditable, not a textarea, so
      // fill() is unreliable — type through the keyboard instead. The prompts
      // are multi-line and Enter SENDS, so newlines go in as Shift+Enter or the
      // first line would submit on its own.
      const lines = prompt.split('\n');
      for (const [i, line] of lines.entries()) {
        if (i > 0) await page.keyboard.press('Shift+Enter');
        await page.keyboard.type(line);
      }
      await page.keyboard.press('Enter');

      return waitForResponseComplete(page);
    },

    async captureAccessibilitySnapshot() {
      // Same as chatgpt-web: page.accessibility was removed in Playwright 1.49,
      // so the full HTML is what forensics gets.
      return page.content();
    },

    async captureScreenshot() {
      return page.screenshot({ fullPage: true });
    },

    async appVersion() {
      const ua = await page.evaluate(() => navigator.userAgent);
      return `claude-web ${conn.describe()} userAgent=${ua}`;
    },

    async dispose() {
      // Local: only disconnects, leaving Chrome warm for the next run.
      // Browserbase: ENDS the session, which is what stops it billing.
      await conn.browser.close();
    },
  };
}

/**
 * Resolve the first selector in `candidates` that actually matches.
 *
 * Trying them in order and reporting all of them on failure is what turns a
 * DOM rename into "none of these matched, go look" instead of a bare Playwright
 * timeout naming one selector that was only ever a guess.
 */
async function firstMatching(
  page: Page,
  candidates: string[],
  label: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of candidates) {
      const locator = page.locator(selector).first();
      if (await locator.count().then((n) => n > 0).catch(() => false)) {
        if (await locator.isVisible().catch(() => false)) return locator;
      }
    }
    await page.waitForTimeout(POLL_MS);
  }
  throw new Error(
    `claude-web: no ${label} found after ${timeoutMs}ms. Tried: ${candidates.join(', ')}. ` +
      'These are SELECTOR-TODO guesses — inspect the live DOM (Browserbase Live View ' +
      'or the replay URL logged at session start) and update claude-web.ts.',
  );
}

/**
 * Wait for the reply to finish by watching the text stop changing.
 *
 * Deliberately NOT keyed on a stop-button selector the way chatgpt-web is.
 * That selector is the single most brittle thing in the ChatGPT driver, and
 * every selector here is unverified, so a heuristic that only needs to find
 * the assistant turn at all is a better bet: text that has not changed for
 * SETTLE_MS is done, whatever the button markup does next.
 *
 * The trade-off is honest — a long pause mid-stream could settle early. Hence
 * SETTLE_MS is generous and tunable, and it still refuses to return empty.
 */
async function waitForResponseComplete(page: Page): Promise<string> {
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  let lastText = '';
  let stableSince = 0;

  while (Date.now() < deadline) {
    const text = await lastAssistantText(page);

    if (text && text === lastText) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince >= SETTLE_MS) return text;
    } else {
      lastText = text;
      stableSince = 0;
    }

    await page.waitForTimeout(POLL_MS);
  }

  if (lastText) {
    // Timed out mid-stream: returning what we have lets the assertion say what
    // was actually wrong, instead of masking it as a timeout.
    console.error(`[e2e] claude-web: response still changing after ${RESPONSE_TIMEOUT_MS}ms — asserting on partial text`);
    return lastText;
  }
  throw new Error(
    `claude-web: no assistant message after ${RESPONSE_TIMEOUT_MS}ms. Tried: ${ASSISTANT_SELECTORS.join(', ')}. ` +
      'Either the reply never arrived or these SELECTOR-TODO guesses are wrong — check the session replay.',
  );
}

async function lastAssistantText(page: Page): Promise<string> {
  for (const selector of ASSISTANT_SELECTORS) {
    const messages = page.locator(selector);
    const count = await messages.count().catch(() => 0);
    if (count > 0) {
      const text = await messages.nth(count - 1).innerText().catch(() => '');
      if (text.trim()) return text;
    }
  }
  return '';
}
