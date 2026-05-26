# Mac Studio bootstrap

Operator notes for setting up the e2e runner. Run these on the Mac Studio that will host the smoke tests.

## Prerequisites

- macOS user account dedicated to e2e (e.g. `mcpe2e`).
- Homebrew installed.
- Admin access (you'll grant Accessibility permission to Appium).

## Quick start

```bash
git clone https://github.com/boarlabsxyz/awesome-mcp.git
cd awesome-mcp/e2e/mac-studio
./install.sh
```

`install.sh` is idempotent — re-run it after Appium/Node upgrades.

## What it does

1. Installs Node 20, Appium, `appium-mac2-driver` via Homebrew/npm.
2. Copies the three launch agent plists from `launchagents/` to `~/Library/LaunchAgents/` and loads them:
   - `com.boarlabs.e2e.caffeinate` — keeps the machine awake.
   - `com.boarlabs.e2e.appium` — runs the Appium server on `:4723`.
   - `com.boarlabs.e2e.chrome` — launches Google Chrome with the warmed e2e profile and CDP on `:9222`.
3. Prints the remaining manual steps (Accessibility grant, GHA runner registration, account logins).

## Manual steps (the install script can't do these)

### 1. Accessibility permission for Appium

System Settings → Privacy & Security → Accessibility → add the Appium binary (`$(which appium)` after install). Re-grant after any `npm install -g appium*` upgrade — the grant is keyed to the binary signature.

### 2. GHA self-hosted runner

Follow the GitHub instructions for adding a self-hosted runner with labels `self-hosted`, `macOS`, `mac-studio`. **Install it as a launch agent in the user session**, not as a launch daemon. Daemons run in system context and cannot drive windowserver, so the smoke tests would never see the GUI.

After registration:

```bash
cd ~/actions-runner
./svc.sh install     # installs as launch agent in current user session
./svc.sh start
launchctl print gui/$(id -u)/actions.runner.*   # confirm it's a gui/ agent, not system/
```

### 3. Account logins

- **Claude Desktop** — open the app, sign in as `mcp-e2e@…`. Block Sparkle auto-update.
- **ChatGPT in Chrome** — open `https://chatgpt.com/` in the e2e Chrome profile, sign in. Pass any Cloudflare challenge manually so the profile gets warmed.
- **Dev MCP connector** — register the dev Railway MCP URL on both Anthropic and OpenAI accounts. Set "Always allow" if available.
- **Google OAuth on dev Railway** — re-authorize the dev MCP service against the e2e Google account; refresh `GOOGLE_TOKEN` env var.

### 4. Pin Claude Desktop

```bash
defaults write com.anthropic.claudefordesktop SUEnableAutomaticChecks -bool false
defaults write com.anthropic.claudefordesktop SUAutomaticallyUpdate -bool false
```

Record the pinned version somewhere durable; bump intentionally after re-validating selectors.

### 5. Verify

```bash
# Both should return 200/JSON
curl -sS http://127.0.0.1:4723/status
curl -sS http://127.0.0.1:9222/json/version

# Run the smoke locally to validate AX selectors
cd ~/awesome-mcp/e2e
npm ci
E2E_FIXTURE_DOC_TITLE="E2E Smoke Fixture Doc" \
E2E_FIXTURE_DOC_NEEDLE="BANANA-PHONE-7714" \
CLIENT=claude-desktop npm test
```

Expect the first run to fail on at least one `SELECTOR-TODO` — fix selectors against the dumped AX tree, commit, repeat until green.

## Launch agent management

```bash
# Unload (e.g. before tweaking a plist)
launchctl unload ~/Library/LaunchAgents/com.boarlabs.e2e.appium.plist

# Reload
launchctl load ~/Library/LaunchAgents/com.boarlabs.e2e.appium.plist

# Logs
tail -f /tmp/appium.out.log /tmp/appium.err.log
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Appium server not reachable | Plist failed to load; check `/tmp/appium.err.log`. Usually a `PATH` issue — confirm `which appium` resolves under a login shell. |
| "Could not establish a session" | Accessibility permission missing or invalidated by upgrade. Re-add Appium under System Settings. |
| Chrome opens but CDP port unreachable | Another Chrome instance is running and stole the port. Quit all Chrome windows, reload the plist. |
| Runner stays idle when a job is queued | Runner installed as launch daemon, not agent. Re-install with `./svc.sh install` while logged into the GUI user session. |
| Tests pass locally but fail in CI | The runner is using a different user account or a different `e2e/.artifacts` dir. Confirm the runner is the e2e user. |
