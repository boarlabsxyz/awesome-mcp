# Running the web-client smokes on Browserbase

Optional transport for the browser-based clients — **`claude-web`** (default)
and `chatgpt-web`. Instead of attaching to a real Chrome on the Mac Studio, the
driver connects to a cloud browser, which lets that CI job leave the self-hosted
runner.

`claude-web` drives claude.ai. It is the browser sibling of `claude-desktop`,
which drives the signed Electron app through Appium and macOS Accessibility
(CDP is fused off) and therefore cannot run anywhere but the Mac Studio. Same
product, two clients, only one of which is portable.

**Read the caveat at the bottom before investing time.** Whether this works at
all is decided by Cloudflare, not by us.

## What changes, and what doesn't

Only the transport. `runSmokeTest.ts`, all 18 smoke tests, the gate manifest,
fixtures, prompt templates and the whole `setup/` scratch layer are untouched —
`setup/` talks to Google/Slack/ClickUp APIs and never opens a browser.

Transport lives in `connect.ts` and is shared by both web drivers, so adding a
third web client is a selectors-only job and a transport fix lands for every
client at once. Only the site-specific selectors live in each driver.

`claude-desktop` **cannot** move here, ever. It drives a signed Electron app
through Appium and macOS Accessibility because CDP is fused off; Browserbase
runs browsers, not desktop apps. That job stays on the Mac Studio — and it is
the blocking gate signal, while `chatgpt-web` is `continue-on-error: true`.
So this buys CI decoupling for the advisory half, not gate independence.

## Setup

### 1. Account and credentials

Sign up at <https://browserbase.com>, then from **Settings**:

- `BROWSERBASE_API_KEY`
- `BROWSERBASE_PROJECT_ID`

The Free tier (1 browser-hour, 3 concurrent sessions) is enough to answer the
Cloudflare question. It is *not* enough to run a gate — see Cost.

```bash
export BROWSERBASE_API_KEY=bb_live_…
export BROWSERBASE_PROJECT_ID=…
```

### 2. Seed a Context with a logged-in session

Pick the client first — one context per client, since claude.ai and chatgpt.com
cookies are unrelated:

```bash
export CLIENT=claude-web     # default; use chatgpt-web for the other
```

A Context is Browserbase's persistent cookie jar. This replaces the warmed
`$HOME/e2e-chrome-profile` the local transport relies on.

```bash
cd e2e
npm install
npm run seed:browserbase
```

The script prints a **Live View URL**. Open it, log in by hand — 2FA included,
since you are driving a real browser — then press Enter in the terminal. It verifies a composer is present before saving, so an incomplete
login is reported rather than silently stored.

It prints the context id to keep:

```bash
export BROWSERBASE_CONTEXT_ID=ctx_…
```

Confirm the MCP connector is configured **on that account** while you are in
there. Connectors are account-side, not browser-side, so this is once only.

Re-run the same command whenever ChatGPT expires the session. Pass an existing
`BROWSERBASE_CONTEXT_ID` to refresh in place instead of creating a new one.

### 3. Run a test

```bash
cd e2e
E2E_BROWSER=browserbase CLIENT=claude-web \
  node --import tsx --test tests/readGoogleDoc.smoke.ts
```

`CLIENT` selects the driver; the tests themselves are client-agnostic.

On `main` there is exactly one smoke test, at that path. The 18-test suite under
`tests/read/` and `tests/write/` arrives with PR #45 — until that merges, the
paths in the Cost section below describe the future state, not this branch.

Each run logs a session id and a replay URL. The replay is a full video of the
run — considerably better than the local harness's screenshot when a selector
drifts.

Anything other than `E2E_BROWSER=browserbase` keeps the existing local-Chrome
behaviour, so the Mac Studio path is unaffected by default.

### 4. CI (once the spike passes)

In `.github/workflows/e2e-smoke.yml`, the `chatgpt-web` job becomes:

```yaml
runs-on: ubuntu-latest        # was: [self-hosted, macOS, mac-studio]
env:
  CLIENT: claude-web
  E2E_BROWSER: browserbase
  BROWSERBASE_API_KEY: ${{ secrets.BROWSERBASE_API_KEY }}
  BROWSERBASE_PROJECT_ID: ${{ secrets.BROWSERBASE_PROJECT_ID }}
  BROWSERBASE_CONTEXT_ID: ${{ secrets.BROWSERBASE_CONTEXT_ID }}
  # CHATGPT_CDP_ENDPOINT no longer needed
```

Leave `claude-desktop` on the Mac Studio.

## Two design decisions worth knowing

**Tests run with `persist: false`.** Node's test runner parallelises across
files, so a gate run opens ~18 sessions at once. If each wrote its cookie jar
back to the shared context on close they would race, and whichever finished last
would define everyone's auth state. Tests read the seeded auth and write
nothing. Only `seed:browserbase` uses `persist: true`, and it runs alone.

**`dispose()` means two different things.** Locally it only disconnects, leaving
Chrome warm for the next run. On Browserbase it *ends the session*, which is
what stops it billing. Same call, opposite intent.

## Cost

18 smoke tests, one session each, roughly 2 min per session ≈ **36
browser-minutes per gate run**.

| Plan | Price | Browser hours | Concurrent |
|---|---|---|---|
| Free | $0 | 1 | 3 |
| Developer | $20/mo | 100 | 25 |
| Startup | $99/mo | 500 | 100 |
| Scale | custom | flexible | 250+ |

Developer covers ~165 gate runs/month and its 25 concurrent sessions clear the
18 a parallel gate needs. Free cannot run a gate — 3 concurrent — but is fine
for a single test.

## Selector status

**Every selector in `claude-web.ts` is unverified against a live claude.ai
session.** They are written with ordered fallbacks, and completion is detected
by watching the reply text stop changing rather than by a stop-button selector —
so a DOM rename produces a named error listing what was tried, not a silent
wrong answer. Watch the first run; the replay URL logged at session start is
exactly the tool for it.

`chatgpt-web.ts`'s selectors carry the same SELECTOR-TODO caveat and predate
this work.

## The caveat that decides this

`chatgpt-web.ts` opens with:

> Chrome is launched outside Playwright with a warmed persistent profile so
> Cloudflare doesn't see Playwright's bundled Chromium fingerprint or a
> webdriver flag set by Playwright.

That is exactly the fight a cloud browser re-opens — for ChatGPT. Whether
claude.ai is as aggressive is unknown and worth measuring separately; it is a
different site with different protections. Browserbase's advanced
anti-detection ("Verified" identity) is **Scale plan only**; Developer and
Startup get basic identity plus automatic captcha solving.

So the outcomes are: works on $20/mo, works only at Scale pricing, or does not
work reliably at all. **Spike it on the Free tier before committing** — seed a
context, run one read smoke, and you have a binary answer for an hour's work and
no spend.

Separately: automating `chatgpt.com` in a cloud browser is worth checking
against OpenAI's terms of service. That is a judgement call for whoever owns the
account, not a technical blocker.
