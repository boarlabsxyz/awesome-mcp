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
appium --base-path /wd/hub

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

The gate suite (1 read + 1 write) — uses both connectors and direct Google API:

```bash
cd e2e
npm ci

# Required for the read smoke
export E2E_FIXTURE_DOC_ID="<from fixtures/read.md>"
export E2E_FIXTURE_DOC_NEEDLE="BANANA-PHONE-7714"

# Required for the write smoke (direct Google API setup/teardown)
export E2E_WRITE_GOOGLE_REFRESH_TOKEN="<from one-time grant, see fixtures/write.md>"
export E2E_GOOGLE_CLIENT_ID="<oauth client id>"
export E2E_GOOGLE_CLIENT_SECRET="<oauth client secret>"
export E2E_SCRATCH_FOLDER_ID="<e2e-scratch folder id in the write account>"

CLIENT=claude-desktop npm run test:gate
# Artifacts under e2e/.artifacts/local/claude-desktop/
```

Repeat with `CLIENT=chatgpt-web`. The full nightly glob (read + write + future regression) runs with `npm run test:full`.

## Two-connector model (Phase 2)

Phase 2 introduces a split between **read-only** and **full-access** connectors so write tools can be tested without polluting the read fixtures.

Two MCP connections are registered through the dashboard:

| Connector | URL (instance-specific) | Bound Google account | Tool surface in client |
|---|---|---|---|
| `awesome-mcp-readonly` | `https://<dev-host>/mcp?instanceId=<id-B>` | `mcp-e2e-readonly@…` (rich fixtures, never modified) | All `WRITE_TOOLS` manually unchecked in Claude UI |
| `awesome-mcp-full` | `https://<dev-host>/mcp?instanceId=<id-A>` | `mcp-e2e-write@…` (empty; tests create + clean up) | All tools enabled |

Both connectors point at the same MCP server with the same catalog slug (`google-docs`). The dashboard mints a fresh `instanceId` (nanoid) per dashboard-side Connect, and each `instanceId` is bound to its own Google OAuth grant — that's what isolates the accounts.

### Registering the connectors

In the awesome-mcp dashboard, signed in as the e2e user:

1. **Connect Google Docs** → OAuth as `mcp-e2e-write@…` → copy the generated MCP URL.
2. **Connect Google Docs** again (a fresh instance) → OAuth as `mcp-e2e-readonly@…` → copy the generated MCP URL.

Then in Claude Desktop and ChatGPT, signed in as the e2e accounts, register both URLs as separate connectors. Use the exact names `awesome-mcp-readonly` and `awesome-mcp-full` (the test prompts reference these names verbatim via `e2e/promptTemplates.ts`).

### Manual write-tool blocking on readonly

Open Claude Desktop → Settings → Connectors → `awesome-mcp-readonly` → Tools panel. Uncheck every tool that appears in `e2e/tools.ts` `WRITE_TOOLS` (currently 21 tools, exact list lives in code — read it from there, not from this doc). Leave every tool in `READ_TOOLS` checked.

If ChatGPT's connector UI supports per-tool toggles, repeat there. Otherwise the ChatGPT readonly tests rely solely on prompt discipline; flag this and skip readonly tests on the ChatGPT job until the UI catches up.

Record both URLs (with their instanceIds) in a private note. Connection deletion regenerates the instanceId; the URL in the client must be updated, and the manual tool blocking must be redone.

## Account rotation (Anthropic / OpenAI / Google)

| Trigger | Action |
|---|---|
| Session expired / sign-in challenge in Claude Desktop | Manually re-log on the Mac Studio with the e2e Anthropic account. Confirm both connectors (`awesome-mcp-readonly` + `awesome-mcp-full`) are still listed and that write tools are still unchecked on readonly. |
| ChatGPT session expired in the warmed Chrome profile | Log back in via the real Chrome window. Do **not** start a new profile — fingerprint drift will re-trigger Cloudflare. |
| Google OAuth refresh token revoked on the readonly or write Google account | Re-run the dashboard-side Connect flow as the affected Google account. The instanceId regenerates — update the URL in the relevant client connector AND redo write-tool blocking if it was the readonly account. |
| Direct-API write token (`E2E_WRITE_GOOGLE_REFRESH_TOKEN`) expires | Re-run the one-time OAuth grant per `e2e/fixtures/write.md`; update the GHA secret. |
| Readonly fixture drift detected (first read smoke starts failing on the assertion content) | Investigate which write tool was incorrectly enabled on the readonly connector. Restore fixture content from `e2e/fixtures/read.md`. |
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
