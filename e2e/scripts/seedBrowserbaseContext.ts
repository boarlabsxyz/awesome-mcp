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
    // NOT keepAlive. `persist` writes the cookie jar back when the SESSION
    // ends, and keepAlive's whole purpose is to keep it running after the
    // client disconnects — so browser.close() would detach without ending
    // anything and the login would never be saved. That produced a context
    // that looked seeded and yielded "Sign in - Claude" on the first test run.
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

  // Disconnect, then ask Browserbase to END the session explicitly. Closing the
  // CDP connection alone is not a guarantee the session completed, and `persist`
  // only writes on completion — so this is the step that actually saves the
  // login. REQUEST_RELEASE is also what stops it billing until the timeout.
  await browser.close();
  try {
    await bb.sessions.update(session.sessionId, { status: 'REQUEST_RELEASE', projectId });
  } catch (err: any) {
    console.error(`[seed] could not release the session: ${err?.message ?? err}`);
    console.error('[seed] the context may not have been written — re-run and check.');
  }
  await new Promise((r) => setTimeout(r, 5_000)); // docs: allow a few seconds to sync

  // Prove the cookies actually landed, rather than trusting the write. This is
  // the check whose absence let a silently-empty context reach a test run.
  await verifyContextPersisted(contextId, target.url);

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

/**
 * Re-open the context in a fresh session and confirm the login survived.
 *
 * Without this the script's "done" only means "we asked it to save". The first
 * evidence of failure was otherwise a smoke test landing on a sign-in page,
 * which reads as a broken selector rather than a broken context.
 */
async function verifyContextPersisted(contextId: string, url: string): Promise<void> {
  console.error('[seed] verifying the saved login by reopening the context…');
  process.env.BROWSERBASE_CONTEXT_ID = contextId;
  const check = await createBrowserbaseSession({ persist: false, timeoutSeconds: 120 });
  const browser = await chromium.connectOverCDP(check.connectUrl);
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4_000); // let any client-side redirect settle

    const title = await page.title().catch(() => '');
    const signedOut = /sign in|log in/i.test(title);
    if (signedOut) {
      console.error('');
      console.error(`[seed] FAILED: the reopened context lands on "${title}".`);
      console.error('[seed] The login did not persist. Re-run and make sure you are fully');
      console.error('[seed] signed in — the chat UI loaded, not just the password submitted —');
      console.error('[seed] before pressing Enter.');
      console.error(`[seed] Replay of this check: ${check.replayUrl}`);
      process.exitCode = 1;
      return;
    }
    console.error(`[seed] verified — reopened context loads "${title}".`);
  } finally {
    await browser.close();
    try {
      // Release rather than letting it idle to timeout — an unreleased check
      // session bills for its full duration.
      browserbaseClient().sessions.update(check.sessionId, { status: 'REQUEST_RELEASE' });
    } catch { /* best-effort */ }
  }
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
