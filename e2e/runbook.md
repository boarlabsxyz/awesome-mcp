# E2E Runbook

Operational procedures for the e2e suites. Start here when something is red.

Setup from scratch is [SETUP.md](SETUP.md); what each account and variable means
is [accounts.md](accounts.md). This file is for running and repairing.

## The three suites

| Suite | Command | Runs on | Needs |
|---|---|---|---|
| Tool checks | `npm run check` | `ubuntu-latest` | three account API keys |
| Harness units | `npm run test:unit` | anywhere | nothing |
| Live clients | `npm test`, `npm run test:tasks` | `ubuntu-latest` + Browserbase | a seeded browser context |

Only the third opens a browser. That is the distinction that decides where a
failure comes from: a red tool check is about the server, a red live-client test
is usually about the client, the browser, or the harness.

**Live-client tests are not per-tool coverage and must not grow that way.** Their
job is the two things nothing else can see: the argument combinations a *model*
chooses, and whether a tool failure surfaces as the assistant politely explaining
itself. Per-tool coverage belongs on the direct transport, which is faster,
exact, and needs no browser.

## Where the live clients run

**Browserbase cloud browsers, on GitHub-hosted runners.** `E2E_BROWSER=browserbase`
is the switch; unset it and the same drivers attach to a local Chrome over CDP
instead, which is the right mode for debugging selectors.

`claude-desktop` is the exception and always will be: it drives a signed Electron
app through Appium and macOS Accessibility because CDP is fused off by Electron
Fuses. Browserbase runs browsers, not desktop apps. That job is gated behind
`E2E_MAC_STUDIO` and is **off**; see [mac-studio/README.md](mac-studio/README.md)
if it ever needs reviving.

What is lost while it is off, stated plainly: nothing exercises the desktop app
many people actually use. The web clients are a proxy for it, not a replacement.

## Running locally

```bash
cd e2e
npm install
npm run test:unit          # no credentials

# Live clients against a local Chrome — best for selector work, since you can
# watch the window and open devtools.
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/e2e-chrome-profile" \
  https://claude.ai/new
CLIENT=claude-web npm run test:tasks

# Live clients against Browserbase — what CI does.
E2E_BROWSER=browserbase CLIENT=claude-web npm run test:tasks
```

Real Chrome, not Playwright's bundled Chromium: the bundled fingerprint is more
likely to draw a Cloudflare challenge.

## Failure triage

Every run writes a bundle to `.artifacts/<sha|local>/<client>/<test>/`. Start
with `summary.json`, then `response.txt`. Browser clients also capture
`screenshot.png` and `snapshot.txt` — **read the screenshot early**, it has
repeatedly been faster than reading the DOM.

Work down this list. It is ordered by how often each has actually been the cause.

| Symptom | Likely cause | Fix |
|---|---|---|
| `test timed out after Nms` with no other detail | the outer bound is below the driver's inner budget, so every diagnostic was preempted | `budget.ts` derives it; if you raised an inner timeout by hand, raise it there instead |
| `no assistant message … SELECTOR-TODO` | rarely the selectors. Check the screenshot for a permission dialog, a sign-in page, or a paused message | see the three rows below |
| screenshot shows "Claude wants to use X" | a tool needs approval and the turn is blocked | `approvePendingToolUse` handles it; if it did not fire, the dialog markup moved |
| screenshot shows a sign-in page | the browser context has no valid login | re-seed: `CLIENT=<client> npm run seed:browserbase` |
| screenshot shows a mangled prompt | two tests sharing one browser tab | `--test-concurrency=1` in the npm script; check it survived an edit |
| the model answered but the assertion failed | usually a format expectation, not a bug | assert on the outcome; do not demand an exact reply shape |
| `BROWSERBASE_CONTEXT_ID_… is empty` | that client's context was never seeded | `CLIENT=<client> npm run seed:browserbase` |

**A red live-client run is more often the harness than the thing it tests.**
That has been true of every failure this suite has produced so far. Confirm the
server independently with `npm run check` before hunting in the driver.

## Selector repair

Every selector in the web drivers is a liability; claude.ai and chatgpt.com both
move. When one breaks:

1. Open `snapshot.txt` from the failing bundle — it is the full DOM.
2. Find the text of the reply, then walk up to the nearest element carrying a
   stable-looking attribute. Prefer `data-*` hooks over classes.
3. Confirm the candidate does **not** also match the user's turn. On claude.ai
   the user turn is `data-cds="UserMessage"`; the assistant reply currently
   carries `data-perf-reply-text`.
4. Put verified selectors first and leave the old guess last — a selector that
   matched nothing in a real capture costs nothing to keep for one cycle, and
   should be deleted the next time someone reads a snapshot.

## Rotation

| Trigger | Action |
|---|---|
| A browser context stops authenticating | Re-seed it. The seeder verifies by reopening the context and refuses to report success if the login did not stick. |
| An account API key is rotated | `POST /api/regenerate-key` on the dashboard, then `gh secret set E2E_<ACCOUNT>_API_KEY`. |
| Google OAuth revoked for a test account | Reconnect on the **dev** dashboard. Never point these at prod. |
| The fixture doc is edited | Update `E2E_FIXTURE_DOC_NEEDLE` in the same change — the doc and the variable are one fixture in two places. |

## Gating a release on the checks

`create-tag.yml` reads check runs on the SHA being tagged, so gating is one line:

```js
const required = ['lint', 'typecheck', 'test', 'build', 'tool-checks'];
```

Name `tool-checks`, the aggregator job — never the matrix legs, whose names
change when a shape is added.

**Not yet.** `Deploy → Dev` is dispatch-only, so a commit has no `tool-checks`
result unless that commit was deployed to dev first; adding this makes
"deploy the candidate before tagging" a mandatory release step. Criteria are in
[SETUP.md](SETUP.md) step 10.
