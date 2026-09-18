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

import type { Locator, Page } from 'playwright';
import type { Driver } from './driver.ts';
import { connectBrowser } from './connect.ts';
import { gotoTolerantly } from './navigate.ts';
import { TIMEOUTS } from '../budget.ts';

const CDP_ENDPOINT = process.env.CLAUDE_CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
const CLAUDE_URL = process.env.CLAUDE_URL ?? 'https://claude.ai/new';
const RESPONSE_TIMEOUT_MS = TIMEOUTS.response;

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

// VERIFIED against a live claude.ai DOM (2026-09-16), not guesses.
//
// `data-perf-reply-text` appeared exactly once in the captured page, on the
// element holding the reply text, and is the most precise hook available.
// `[data-cds="Prose"]` is the design-system wrapper around the same content and
// is the structural fallback; the user turn is `data-cds="UserMessage"` with a
// `cds-user-message-body`, so neither matches it.
//
// `.font-claude-message` is kept last and matched nothing in that capture. It is
// retained only because it costs nothing and may still exist on other surfaces;
// if it is still dead the next time someone reads a snapshot, delete it.
const ASSISTANT_SELECTORS = [
  '[data-perf-reply-text]',
  '[data-cds="Prose"].prose',
  '.font-claude-message',
];

export async function createClaudeWebDriver(): Promise<Driver> {
  const conn = await connectBrowser(CDP_ENDPOINT, 'claude-web');
  const context = conn.browser.contexts()[0] ?? (await conn.browser.newContext());
  const page: Page = context.pages()[0] ?? (await context.newPage());

  if (!page.url().includes('claude.ai')) {
    await gotoTolerantly(page, CLAUDE_URL, TIMEOUTS.navigate);
  }

  return {
    async newConversation() {
      await gotoTolerantly(page, CLAUDE_URL, TIMEOUTS.navigate);
      await firstMatching(page, COMPOSER_SELECTORS, 'composer', TIMEOUTS.composer);
    },

    async sendAndWait(prompt) {
      const composer = await firstMatching(page, COMPOSER_SELECTORS, 'composer', TIMEOUTS.composer);
      await composer.click();

      // Clear first. claude.ai keeps a per-conversation draft, so a run that
      // died mid-prompt leaves text behind and the next prompt is appended to
      // it -- which reads downstream as the model answering a question nobody
      // asked.
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');

      // Claude's composer is a ProseMirror contenteditable, not a textarea, so
      // fill() is unreliable. But keyboard.type() is worse: it dispatches one
      // key event per character, and ProseMirror's controlled input cannot keep
      // up, so characters land INTERLEAVED. A real run sent
      //
      //   "IWh ihcavhe o fa  Gmoy ogGloeo DogclW ehs aotDm oecdwsoh…"
      //
      // for "I have a Google Doc somewhere that mentions…", and Claude's
      // safeguards paused the mangled message. No assistant reply was ever
      // produced, and the driver reported it as a selector problem 120 seconds
      // later -- three layers away from the actual cause.
      //
      // insertText dispatches a single input event per line, which ProseMirror
      // applies atomically. Enter SENDS in this composer, so newlines go in as
      // Shift+Enter or the first line would submit on its own.
      const lines = prompt.split('\n');
      for (const [i, line] of lines.entries()) {
        if (i > 0) await page.keyboard.press('Shift+Enter');
        await page.keyboard.insertText(line);
      }

      // Read it back before sending. Silent corruption in the composer is
      // invisible downstream -- the failure surfaces as a missing reply, or
      // worse, as a reply to a question nobody asked. Better to fail here,
      // holding both strings.
      await assertComposerMatches(composer, prompt);

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
  // Naming the page is what separates "the selector is wrong" from "this is a
  // sign-in page and no composer exists" — the first run hit the latter and the
  // error blamed the selectors.
  const url = page.url();
  const title = await page.title().catch(() => '(unknown)');
  const signedOut = /sign in|log in|sign up/i.test(title);

  const detail = signedOut
    ? `The page is "${title}" (${url}) — this session is NOT LOGGED IN, so no ${label} exists. ` +
      'The selectors are probably fine. Re-run `npm run seed:browserbase` to save a working ' +
      'login into the Browserbase context, and note it now verifies the context afterwards.'
    : `The page is "${title}" (${url}). Tried: ${candidates.join(', ')}. These are ` +
      'SELECTOR-TODO guesses — inspect the live DOM (Browserbase Live View or the replay ' +
      'URL logged at session start) and update claude-web.ts.';

  throw new Error(`claude-web: no ${label} found after ${timeoutMs}ms. ${detail}`);
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
export async function waitForResponseComplete(page: Page): Promise<string> {
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  let lastText = '';
  let stableSince = 0;
  // Assistant text as it stood when a tool use was approved.
  //
  // Settling on text-stability alone is wrong across an approval. A model that
  // says "Let me search your Drive" and then blocks on the permission dialog has
  // text that does not change for SETTLE_MS, so the wait would return the
  // PREAMBLE -- text from before the tool ran -- and the assertion would judge
  // an answer the model had not given yet. A silent wrong answer is worse than
  // a timeout, so until the text moves past this mark, "unchanged" means "the
  // tool is still running".
  let textAtApproval: string | null = null;

  while (Date.now() < deadline) {
    // A first-ever call to a tool opens "Claude wants to use X" and the turn
    // stops dead until someone answers. Nothing downstream can tell that apart
    // from a slow reply, so without this the run burns its whole timeout and
    // then blames the assistant selectors -- which is exactly what happened on
    // the first real run, twice.
    if (await approvePendingToolUse(page)) {
      // Baseline read AFTER the click, not from the previous poll.
      //
      // The previous poll's value is stale by exactly the interval where this
      // goes wrong: if a preamble renders in the same gap the dialog appears in,
      // the baseline is the older empty string, the very next read differs from
      // it, the guard clears itself, and the unchanged preamble then satisfies
      // SETTLE_MS -- returning text from before the tool ran, which is the
      // failure the guard exists to prevent.
      //
      // Reading here instead captures the text at the instant the turn resumes.
      // Whatever the tool produces must come after that, so the guard holds
      // until it does.
      textAtApproval = await lastAssistantText(page);
      lastText = textAtApproval;
      stableSince = 0;
      await page.waitForTimeout(POLL_MS);
      continue;
    }

    const text = await lastAssistantText(page);
    if (textAtApproval !== null && text !== textAtApproval) textAtApproval = null;

    if (text && text === lastText && textAtApproval === null) {
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


/**
 * Fail if what is in the composer is not what we meant to send.
 *
 * Whitespace is normalised because the editor represents soft breaks its own
 * way; the comparison that matters is the characters and their order.
 */
async function assertComposerMatches(composer: Locator, intended: string): Promise<void> {
  const actual = ((await composer.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  const expected = intended.replace(/\s+/g, ' ').trim();
  if (actual === expected) return;
  throw new Error(
    'claude-web: the composer does not contain the prompt that was typed into it. ' +
      'This is character-level corruption in the editor, not a selector problem.\n' +
      `  intended: ${JSON.stringify(expected.slice(0, 160))}\n` +
      `  composer: ${JSON.stringify(actual.slice(0, 160))}`,
  );
}


/**
 * Grant a pending tool-use request, if one is on screen.
 *
 * Clicks "Always allow" rather than "Allow once": a single run calls several
 * tools and a fresh browser context has approved none of them, so per-call
 * approval would stall on every one of them in turn.
 *
 * This is deliberate automation of a human consent step, and it is only
 * defensible because of where it runs: a dedicated e2e account whose connector
 * points at the dev deployment. Do not lift it into anything driving a real
 * person's session.
 *
 * `data-approval-digit` is the keyboard-shortcut index the dialog assigns its
 * buttons -- 2 is "Always allow", 3 is "Allow once" -- with a text locator
 * behind it in case that attribute is an implementation detail that moves.
 */
export async function approvePendingToolUse(page: Page): Promise<boolean> {
  const approve = page
    .locator('[data-approval-digit="2"], button:has-text("Always allow")')
    .first();

  if (!(await approve.isVisible().catch(() => false))) return false;

  try {
    await approve.click({ timeout: 5_000 });
  } catch (err) {
    // One benign case: the dialog was answered between the visibility check and
    // the click, so the control detached. Everything else means the dialog is
    // STILL UP and the turn is still blocked -- and swallowing that produces a
    // response timeout blaming the reply, when the real story is a prompt nobody
    // answered. That is the exact misdirection this handler exists to remove, so
    // it must not reintroduce it one layer down.
    if (await approve.isVisible().catch(() => false)) throw err;
    return false;
  }

  console.error('[e2e] claude-web: approved a pending tool use');
  return true;
}
