# E2E Runbook

Operational procedures for the live-client e2e suite. Covers the Mac Studio runner, test accounts, and recovery paths.

## Mac Studio runner state

| Concern | Procedure |
|---|---|
| Auto-login | System Settings → Users & Groups → Automatic login enabled for the e2e user. |
| FileVault | Unlock-at-boot configured so the runner survives reboots without manual unlock. |
| Sleep / lock | `caffeinate -dimsu` running as a launch agent. Screensaver + screen lock disabled. Display-off allowed; screen-lock is what kills automation. |
| GHA runner | Installed as a **launch agent** in the e2e user GUI session (`~/Library/LaunchAgents/`). Not a launch daemon — daemons cannot drive windowserver. Verify with `launchctl print gui/$(id -u)/actions.runner.*`. |
| Accessibility permission | Granted to the Appium server binary in System Settings → Privacy & Security → Accessibility. Re-grant after every Appium or Node upgrade — the grant is keyed to the binary signature and is invalidated by updates. |
| Claude Desktop version pin | Auto-update disabled (block the Sparkle update endpoint at `/etc/hosts` or via Claude's settings). Current pinned version: _record here_. Forensics bundles include `CFBundleShortVersionString` for correlation. |
| Chrome profile | Real Google Chrome (not Playwright's bundled Chromium), launched with `--user-data-dir=$HOME/e2e-chrome-profile` and `--remote-debugging-port=9222`. Profile must be manually logged into ChatGPT once. |

## Starting the test infrastructure (Mac Studio)

```bash
# 1. Appium (foreground or via launchd)
appium

# 2. Chrome with persistent profile + CDP
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/e2e-chrome-profile" \
  https://chatgpt.com/

# 3. Verify
curl -sS http://127.0.0.1:4723/status   # Appium
curl -sS http://127.0.0.1:9222/json/version   # Chrome CDP
```

The GHA runner expects (1) and (2) to be running before a job fires.

## Local smoke run

The gate suite is **1 read + 1 write smoke per service that has write tools** —
currently 18 tests across 9 services. The exact file list lives in
`e2e/tests/gate.manifest.ts`; `npm run test:gate` runs precisely that list and
nothing else (`scripts/runGate.ts` spawns `node --test` with those paths).

```bash
cd e2e
npm ci

# Read fixtures — see fixtures/read.md for how each is provisioned
export E2E_FIXTURE_DOC_ID="…"                  E2E_FIXTURE_DOC_NEEDLE="BANANA-PHONE-7714"
export E2E_FIXTURE_DRIVE_FOLDER_ID="…"         E2E_FIXTURE_DRIVE_NEEDLE="…"
export E2E_FIXTURE_GMAIL_QUERY="…"             E2E_FIXTURE_GMAIL_NEEDLE="…"
export E2E_FIXTURE_CALENDAR_ID="…"             E2E_FIXTURE_CALENDAR_NEEDLE="…"
export E2E_FIXTURE_SHEET_ID="…"                E2E_FIXTURE_SHEET_NEEDLE="…"
export E2E_FIXTURE_SLIDES_ID="…"               E2E_FIXTURE_SLIDES_NEEDLE="…"
export E2E_FIXTURE_CLICKUP_LIST_ID="…"         E2E_FIXTURE_CLICKUP_NEEDLE="…"
export E2E_FIXTURE_SLACK_CHANNEL_ID="…"        E2E_FIXTURE_SLACK_NEEDLE="…"
export E2E_FIXTURE_SLACK_USER_CHANNEL_ID="…"   E2E_FIXTURE_SLACK_USER_NEEDLE="…"

# Direct-API credentials for write setup/teardown — see fixtures/write.md
export E2E_WRITE_GOOGLE_REFRESH_TOKEN="…"      # fixtures/write-google.md
export E2E_GOOGLE_CLIENT_ID="…" E2E_GOOGLE_CLIENT_SECRET="…"
export E2E_SCRATCH_FOLDER_ID="…" E2E_CALENDAR_SCRATCH_ID="…"
export E2E_CLICKUP_API_TOKEN="…"               # fixtures/write-clickup.md
export E2E_CLICKUP_SCRATCH_LIST_ID="…" E2E_CLICKUP_SCRATCH_SPACE_ID="…"
export E2E_SLACK_BOT_TOKEN="xoxb-…"            # fixtures/write-slack.md
export E2E_SLACK_USER_TOKEN="xoxp-…" E2E_SLACK_SCRATCH_CHANNEL_ID="C…"

CLIENT=claude-desktop npm run test:gate
# Artifacts under e2e/.artifacts/local/claude-desktop/
```

Running one service while iterating is just `node --test` with its two paths:

```bash
node --import tsx --test tests/read/listTasks.smoke.ts tests/write/createTask.smoke.ts
```

Repeat with `CLIENT=chatgpt-web`. The full nightly glob (every `tests/**/*.smoke.ts`)
runs with `npm run test:full`.

## Two-connector model (per service)

Every service in `src/` is tested through a **connector PAIR**: a read-only
connector bound to a fixture identity that is never modified, and a full-access
connector bound to a throwaway write identity. Splitting them is what lets write
tools be exercised without polluting the read fixtures.

Connector names follow one scheme, `awesome-mcp-<service>-<mode>`, where
`<service>` is the directory name under `src/`. The names are referenced
verbatim by the prompts (`e2e/promptTemplates.ts` builds them; `runSmokeTest`
prepends `preface(service, mode)` to every prompt), so a typo in the client
surfaces as the model answering from the wrong connector — or from none.

| Service (`src/<dir>`) | Catalog slug | Readonly connector | Full connector | Write identity holds |
|---|---|---|---|---|
| `google-docs` | `google-docs` | `awesome-mcp-google-docs-readonly` | `awesome-mcp-google-docs-full` | Docs in `e2e-scratch/` |
| `google-drive` | `google-drive` | `awesome-mcp-google-drive-readonly` | `awesome-mcp-google-drive-full` | Folders in `e2e-scratch/` |
| `google-gmail` | `google-gmail` | `awesome-mcp-google-gmail-readonly` | `awesome-mcp-google-gmail-full` | Drafts under the `e2e-scratch` label |
| `google-calendar` | `google-calendar` | `awesome-mcp-google-calendar-readonly` | `awesome-mcp-google-calendar-full` | Events on the scratch calendar |
| `google-sheets` | `google-sheets` | `awesome-mcp-google-sheets-readonly` | `awesome-mcp-google-sheets-full` | Sheets in `e2e-scratch/` |
| `google-slides` | `google-slides` | `awesome-mcp-google-slides-readonly` | `awesome-mcp-google-slides-full` | Decks in `e2e-scratch/` |
| `clickup` | `clickup` | `awesome-mcp-clickup-readonly` | `awesome-mcp-clickup-full` | Tasks in the scratch list |
| `slack` | **`slack-bot`** | `awesome-mcp-slack-readonly` | `awesome-mcp-slack-full` | Messages in the scratch channel (bot identity) |
| `slack-user` | **`slack`** | `awesome-mcp-slack-user-readonly` | `awesome-mcp-slack-user-full` | Messages in the scratch channel (user identity) |

> The two Slack rows are a genuine footgun: `src/slack/` is the **bot-token**
> server and registers under the catalog slug `slack-bot`, while `src/slack-user/`
> is the **user-OAuth** server and registers under the slug `slack`. The e2e
> harness keys off the directory name everywhere. When registering, pick the
> catalog entry by slug and name the connector after the directory.

### Renaming the Phase 2 connectors

Phase 2 shipped two unqualified names, `awesome-mcp-readonly` and
`awesome-mcp-full`, both bound to Google Docs. With nine services those names
are ambiguous. Rename them in the client UI to
`awesome-mcp-google-docs-readonly` / `awesome-mcp-google-docs-full`. **A rename
only** — the underlying connection, its `instanceId`, its OAuth grant, and the
per-tool checkboxes are all unaffected.

### Registering a connector pair

In the awesome-mcp dashboard, signed in as the e2e user, for each service:

1. **Connect \<service\>** → OAuth (or paste the token) as the **write** identity → copy the generated MCP URL.
2. **Connect \<service\>** again (a fresh instance) → authorize as the **readonly** identity → copy that MCP URL.

Both connections point at the same MCP server with the same catalog slug. The
dashboard mints a fresh `instanceId` (nanoid) per dashboard-side Connect, and
each `instanceId` is bound to its own OAuth grant / token — that's what isolates
the identities.

Then in Claude Desktop and ChatGPT, signed in as the e2e accounts, register both
URLs as separate connectors under the names in the table above.

Record every URL (with its `instanceId`) in a private note. Connection deletion
regenerates the `instanceId`; the URL in the client must be updated, and the
manual tool blocking must be redone.

### Manual write-tool blocking on each readonly connector

Open Claude Desktop → Settings → Connectors → `awesome-mcp-<service>-readonly` →
Tools panel. Uncheck every tool in that service's `WRITE_TOOLS`, leave every
tool in `READ_TOOLS` checked.

The canonical lists live in code, one file per service — read them from there,
not from this doc:

```bash
cd e2e
node --import tsx -e "
  import('./tools/index.ts').then(({ SERVICES, TOOLS }) => {
    for (const s of SERVICES) console.log(s, '->', TOOLS[s].WRITE_TOOLS.join(', '));
  });
"
```

Those files are generated from each server's `annotations.readOnlyHint`, so a
tool added to `src/<service>/server.ts` without updating `e2e/tools/<service>.ts`
silently widens what the readonly connector can mutate. Treat the two as one
change.

If ChatGPT's connector UI supports per-tool toggles, repeat there. Otherwise the
ChatGPT readonly tests rely solely on prompt discipline; flag this and skip
readonly tests on the ChatGPT job until the UI catches up.

## Account rotation (Anthropic / OpenAI / Google)

| Trigger | Action |
|---|---|
| Session expired / sign-in challenge in Claude Desktop | Manually re-log on the Mac Studio with the e2e Anthropic account. Confirm all 18 connectors are still listed and that write tools are still unchecked on every `-readonly` one. |
| ChatGPT session expired in the warmed Chrome profile | Log back in via the real Chrome window. Do **not** start a new profile — fingerprint drift will re-trigger Cloudflare. |
| OAuth grant revoked on a readonly or write identity (any service) | Re-run the dashboard-side Connect flow as the affected identity. The instanceId regenerates — update the URL in the relevant client connector AND redo write-tool blocking if it was a readonly identity. |
| Direct-API write token expires | Re-issue it and update the GHA secret: Google → `E2E_WRITE_GOOGLE_REFRESH_TOKEN` per `fixtures/write-google.md`; ClickUp → `E2E_CLICKUP_API_TOKEN` per `fixtures/write-clickup.md`; Slack → `E2E_SLACK_BOT_TOKEN` / `E2E_SLACK_USER_TOKEN` per `fixtures/write-slack.md`. |
| Slack write smoke leaks messages (`cant_delete_message` in the run log) | The direct-API token and the `-full` connector are different Slack identities. `chat.delete` only removes the caller's own messages. Re-issue the token from the same app/user the connector is bound to. |
| Readonly fixture drift detected (a read smoke starts failing on the assertion content) | Investigate which write tool was incorrectly enabled on that service's readonly connector. Restore fixture content from `e2e/fixtures/read.md`. |
| A new tool lands in `src/<service>/server.ts` | Add it to `e2e/tools/<service>.ts` in the same PR, on the side its `readOnlyHint` says, and uncheck it on the readonly connector if it's a write tool. |
| A brand-new service is added under `src/` | `e2e/tests/gate.manifest.ts` will fail typecheck until its gate pair is listed — that's deliberate. Add `e2e/tools/<service>.ts`, a connector pair, a scratch factory, and the two smokes. |
| Plan tier change required on ChatGPT for MCP | Upgrade the e2e ChatGPT account; verify both connectors still appear. |
| Nightly Slack alert noise | If false positives > 1/week, tune the Slack notification step (file: `.github/workflows/e2e-regression.yml`) before adding more nightly tests. |

## Failure triage

1. **Find the forensics bundle**: GHA run page → Artifacts → `e2e-<client>-<sha>.zip`. Expires after 90 days.
2. Open `summary.json` — check `passed`, `error`, `appVersion`. If `appVersion` doesn't match the pinned version, that's likely the cause.
3. Compare `snapshot.txt` against a known-good snapshot to find selector drift.
4. Cross-check `screenshot.png` for unexpected modals (auth challenge, permission prompt, paywall).
5. If selectors drifted, update the corresponding driver file's `SELECTOR-TODO`-marked locator with the new value from `snapshot.txt`.

## Promoting ChatGPT smoke to blocking

Currently advisory (`continue-on-error: true`). Promotion criteria:
- 30 consecutive runs with no false-positive failures.
- ChatGPT MCP/Connectors surface stable (no UI rewrite in the last 30 days).

When ready: remove `continue-on-error` from the `chatgpt-web` job in `.github/workflows/e2e-smoke.yml`, and add the check name to the required list in `create-tag.yml` (see below).

## Wiring the prod-tag gate (deferred — do not flip yet)

`create-tag.yml` currently requires `['lint', 'typecheck', 'test', 'build']`. To gate prod tags on e2e, add the e2e check name. **Do not flip this until the Mac Studio runner is online and producing green runs reliably**, otherwise every prod tag will be blocked.

The edit, when ready:

```js
// .github/workflows/create-tag.yml, "Check CI passed on commit" step
const required = ['lint', 'typecheck', 'test', 'build', 'claude-desktop'];
```

(The check name `claude-desktop` comes from the job name in `e2e-smoke.yml`.)
