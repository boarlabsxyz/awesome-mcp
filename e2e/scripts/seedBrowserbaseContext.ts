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

// Which site's login this context is for. One context per client — cookies for
// claude.ai and chatgpt.com are unrelated, and mixing them in one context would
// mean re-seeding both whenever either expires.
const CLIENT = process.env.CLIENT ?? 'claude-web';
const SEED_TARGETS: Record<string, { url: string; label: string }> = {
  'claude-web': { url: process.env.CLAUDE_URL ?? 'https://claude.ai/new', label: 'Claude' },
  'chatgpt-web': { url: process.env.CHATGPT_URL ?? 'https://chatgpt.com/', label: 'ChatGPT' },
};

/**
 * Strip quotes and whitespace off an env value.
 *
 * `export KEY="bb_live_…"` in some shells, or a copy-paste that grabs a
 * trailing newline, leaves the quotes/whitespace IN the value. The API then
 * returns a bare 401 that looks like a bad key rather than a bad paste.
 */
function envValue(name: string): string {
  return (process.env[name] ?? '').trim().replace(/^['"]|['"]$/g, '');
}

/** Turn a 401 into something that says what to check. */
function explainAuthFailure(apiKey: string, projectId: string): void {
  console.error('');
  console.error('[seed] Browserbase rejected the credentials (HTTP 401).');
  console.error('');
  console.error(`  BROWSERBASE_API_KEY    = ${mask(apiKey)}`);
  console.error(`  BROWSERBASE_PROJECT_ID = ${mask(projectId)}`);
  console.error('');
  // Both live next to each other on the Settings page and neither is labelled
  // in a way that survives a hurried copy-paste, so this is the usual cause.
  if (projectId.startsWith('bb_') && !apiKey.startsWith('bb_')) {
    console.error('  These look SWAPPED — the project id starts with "bb_", which is the');
    console.error('  API key prefix. Try exchanging the two values.');
  } else if (!apiKey.startsWith('bb_')) {
    console.error('  The API key does not start with "bb_", so this may be the project id');
    console.error('  (a UUID) pasted into the key. Both are on the same Settings page.');
  } else {
    console.error('  The key looks well-formed, so check it has not been revoked or');
    console.error('  regenerated, and that it belongs to this project.');
  }
  console.error('');
  console.error('  Verify the key on its own:');
  console.error(`    curl -s -o /dev/null -w '%{http_code}\\n' \\`);
  console.error(`      -H "X-BB-API-Key: $BROWSERBASE_API_KEY" \\`);
  console.error('      https://api.browserbase.com/v1/projects');
  console.error('  200 = key is good; 401 = the key itself is the problem.');
  console.error('');
}

function mask(value: string): string {
  if (!value) return '(unset)';
  if (value.length <= 8) return `${value.slice(0, 2)}… (${value.length} chars)`;
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
}

async function main(): Promise<void> {
  const apiKey = envValue('BROWSERBASE_API_KEY');
  let projectId = envValue('BROWSERBASE_PROJECT_ID');
  if (!apiKey) {
    console.error('Set BROWSERBASE_API_KEY first. See e2e/BROWSERBASE.md.');
    process.exit(1);
  }
  // Write the cleaned key back so the SDK sees the trimmed form rather than the
  // raw paste. The project id is written back after it has been validated.
  process.env.BROWSERBASE_API_KEY = apiKey;

  const target = SEED_TARGETS[CLIENT];
  if (!target) {
    console.error(`[seed] CLIENT=${CLIENT} has no browser login to seed.`);
    console.error(`[seed] Expected one of: ${Object.keys(SEED_TARGETS).join(', ')}.`);
    console.error('[seed] (claude-desktop authenticates in the app itself, not in a browser context.)');
    process.exit(1);
  }
  console.error(`[seed] seeding a ${target.label} login (CLIENT=${CLIENT})`);

  const bb = browserbaseClient();

  // Cheapest authenticated call there is, and it doubles as the project check.
  // Failing here means the credentials are wrong, and saying so beats a stack
  // trace out of contexts.create().
  let projects: Array<{ id: string; name: string }>;
  try {
    projects = await bb.projects.list();
  } catch (err: any) {
    if (err?.status === 401) {
      explainAuthFailure(apiKey, projectId);
      process.exit(1);
    }
    throw err;
  }

  // A key that authenticates fine will still 401 on contexts.create() when the
  // projectId belongs to someone else — the error says "Unauthorized" and
  // names nothing, which is indistinguishable from a bad key. Since we already
  // know every project this key owns, check it here and say which is wrong.
  const owned = projects.map((p) => p.id);
  if (projectId && !owned.includes(projectId)) {
    console.error('');
    console.error(`[seed] BROWSERBASE_PROJECT_ID (${mask(projectId)}) is not a project this API key owns.`);
    console.error('[seed] That is what produces a 401 from contexts.create() even though the key is valid.');
    console.error('');
    console.error('  Projects this key can use:');
    for (const p of projects) console.error(`    ${p.id}  ${p.name}`);
    console.error('');
    process.exit(1);
  }
  if (!projectId) {
    if (projects.length === 1) {
      projectId = projects[0].id;
      console.error(`[seed] BROWSERBASE_PROJECT_ID not set — using the only project: ${projectId} (${projects[0].name})`);
    } else {
      console.error('[seed] BROWSERBASE_PROJECT_ID is not set and this key owns several projects:');
      for (const p of projects) console.error(`    ${p.id}  ${p.name}`);
      process.exit(1);
    }
  }
  process.env.BROWSERBASE_PROJECT_ID = projectId;

  let contextId = envValue('BROWSERBASE_CONTEXT_ID') || undefined;
  if (contextId) {
    console.error(`[seed] refreshing existing context ${contextId}`);
  } else {
    const context = await bb.contexts.create({ projectId });
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
  await page.goto(target.url, { waitUntil: 'domcontentloaded' });

  const live = await liveViewUrl(session.sessionId);
  console.error('');
  console.error(`  Open this and log into ${target.label}:`);
  console.error(`    ${live}`);
  console.error('');
  console.error(`  Confirm the MCP connector is configured on the ${target.label} account`);
  console.error('  too — connectors are account-side, so once set there is nothing');
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
  console.error(`    E2E_BROWSER=browserbase CLIENT=${CLIENT} \\`);
  console.error('      node --import tsx --test tests/readGoogleDoc.smoke.ts');
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
