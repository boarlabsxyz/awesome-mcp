// One-time setup: log into ChatGPT inside a Browserbase Context so the smoke
// tests can reuse that session without ever handling a password.
//
// This replaces the warmed `$HOME/e2e-chrome-profile` the local transport
// depends on — the thing that currently pins the ChatGPT job to the Mac Studio.
//
// Run it, open the printed Live View URL, log in by hand (2FA included — you
// are driving a real browser), then press Enter here. The cookies are written
// back to the Context on close, and every later session reads them.
//
//   npm run seed:browserbase            # creates a new context
//   BROWSERBASE_CONTEXT_ID=ctx_… npm run seed:browserbase   # refresh an existing one
//
// Re-run whenever ChatGPT expires the session; nothing else needs touching.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { chromium } from 'playwright';
import { browserbaseClient, createBrowserbaseSession, liveViewUrl } from '../drivers/browserbase.ts';

const CHATGPT_URL = process.env.CHATGPT_URL ?? 'https://chatgpt.com/';

async function main(): Promise<void> {
  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
    console.error('Set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID first. See e2e/BROWSERBASE.md.');
    process.exit(1);
  }

  const bb = browserbaseClient();

  let contextId = process.env.BROWSERBASE_CONTEXT_ID;
  if (contextId) {
    console.error(`[seed] refreshing existing context ${contextId}`);
  } else {
    const context = await bb.contexts.create({ projectId: process.env.BROWSERBASE_PROJECT_ID! });
    contextId = context.id;
    console.error(`[seed] created context ${contextId}`);
  }

  // persist: true is correct HERE and nowhere else — this is the one run whose
  // job is to WRITE the cookie jar. The tests read it with persist: false so a
  // parallel gate run cannot race 18 sessions writing back at once.
  process.env.BROWSERBASE_CONTEXT_ID = contextId;
  const session = await createBrowserbaseSession({
    persist: true,
    // Generous: a human is logging in, possibly hunting for a 2FA code.
    timeoutSeconds: 1800,
    keepAlive: true,
  });

  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' });

  const live = await liveViewUrl(session.sessionId);
  console.error('');
  console.error('  Open this and log into ChatGPT:');
  console.error(`    ${live}`);
  console.error('');
  console.error('  Confirm the MCP connector is configured on the account too —');
  console.error('  connectors are account-side, so once it is set there is nothing');
  console.error('  per-session to redo.');
  console.error('');

  const rl = createInterface({ input: stdin, output: stdout });
  await rl.question('Press Enter once you are logged in and the chat UI is loaded… ');
  rl.close();

  // Prove the login actually took before saving, rather than persisting an
  // anonymous jar that fails confusingly on the first test run.
  const loggedIn = await page
    .locator('#prompt-textarea, div[contenteditable="true"]')
    .first()
    .isVisible()
    .catch(() => false);

  await browser.close(); // ends the session, which is what flushes the context
  await new Promise((r) => setTimeout(r, 5_000)); // docs: allow a few seconds to sync

  if (!loggedIn) {
    console.error('');
    console.error('[seed] WARNING: no composer found on the page, so the login may not have');
    console.error('[seed] completed. The context was still saved — re-run to try again.');
  }

  console.error('');
  console.error('[seed] done. Add to CI secrets / your shell:');
  console.error(`    BROWSERBASE_CONTEXT_ID=${contextId}`);
  console.error('');
  console.error('Then run a test against it:');
  console.error('    E2E_BROWSER=browserbase CLIENT=chatgpt-web \\');
  console.error('      node --import tsx --test tests/read/readGoogleDoc.smoke.ts');
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
