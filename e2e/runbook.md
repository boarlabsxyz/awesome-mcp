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

```bash
cd e2e
npm ci
E2E_FIXTURE_DOC_TITLE="E2E Smoke Fixture Doc" \
E2E_FIXTURE_DOC_NEEDLE="BANANA-PHONE-7714" \
CLIENT=claude-desktop npm test

# Artifacts in e2e/.artifacts/local/claude-desktop/readGoogleDoc/
```

Repeat with `CLIENT=chatgpt-web` to validate the web path.

## Account rotation (Anthropic / OpenAI / Google)

| Trigger | Action |
|---|---|
| Session expired / sign-in challenge in Claude Desktop | Manually re-log on the Mac Studio with the e2e account. Confirm the dev MCP connector is still listed. |
| ChatGPT session expired in the warmed Chrome profile | Log back in via the real Chrome window. Do **not** start a new profile — fingerprint drift will re-trigger Cloudflare. |
| Google OAuth refresh token revoked / expired | Re-run the dev MCP server's OAuth flow with the e2e Google account. Update `GOOGLE_TOKEN` env var on the **dev** Railway service. Do not touch prod. |
| Plan tier change required on ChatGPT for MCP | Upgrade the e2e ChatGPT account; verify connectors UI still shows the dev URL. |

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
