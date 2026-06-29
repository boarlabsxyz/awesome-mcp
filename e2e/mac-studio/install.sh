#!/usr/bin/env bash
# Bootstrap the Mac Studio for e2e smoke tests.
# Idempotent: safe to re-run after Appium/Node upgrades.
set -euo pipefail

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
LAUNCH_AGENTS_SRC="$SCRIPT_DIR/launchagents"
LAUNCH_AGENTS_DEST="$HOME/Library/LaunchAgents"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }

require_macos() {
  if [[ "$(uname)" != "Darwin" ]]; then
    echo "This script only runs on macOS." >&2
    exit 1
  fi
}

ensure_homebrew() {
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew is required. Install from https://brew.sh and re-run." >&2
    exit 1
  fi
  ok "Homebrew present: $(brew --version | head -1)"
}

ensure_node() {
  step "Ensuring Node.js 20"
  if command -v node >/dev/null 2>&1 && node -v | grep -q '^v20\.'; then
    ok "node $(node -v)"
  else
    brew install node@20
    brew link --overwrite --force node@20
    ok "installed node $(node -v)"
  fi
}

ensure_appium() {
  step "Ensuring Appium + mac2 driver"
  if ! command -v appium >/dev/null 2>&1; then
    npm install -g appium
  fi
  ok "appium $(appium --version)"
  if ! appium driver list --installed 2>&1 | grep -q 'mac2'; then
    appium driver install mac2
  fi
  ok "appium-mac2-driver installed"
}

ensure_chrome() {
  step "Checking for Google Chrome"
  if [[ -d "/Applications/Google Chrome.app" ]]; then
    ok "Google Chrome present"
  else
    warn "Google Chrome not found in /Applications. Install from https://www.google.com/chrome/ before continuing."
  fi
}

install_launch_agents() {
  step "Installing launch agents to $LAUNCH_AGENTS_DEST"
  mkdir -p "$LAUNCH_AGENTS_DEST"
  for src in "$LAUNCH_AGENTS_SRC"/com.boarlabs.e2e.*.plist; do
    name="$(basename "$src")"
    dest="$LAUNCH_AGENTS_DEST/$name"
    # Substitute __HOME__ placeholder (used in the Chrome plist for user-data-dir).
    sed "s|__HOME__|$HOME|g" "$src" > "$dest"
    chmod 644 "$dest"
    # Reload if already loaded; otherwise just load.
    launchctl unload "$dest" 2>/dev/null || true
    launchctl load "$dest"
    ok "loaded $name"
  done
}

print_manual_steps() {
  cat <<'EOF'

────────────────────────────────────────────────────────────────────────
Remaining manual steps (cannot be automated):
────────────────────────────────────────────────────────────────────────

1. Grant Accessibility permission to Appium:
     System Settings → Privacy & Security → Accessibility → add the binary
     at $(which appium). Re-grant after any Appium/Node upgrade.

2. Register the GitHub Actions runner (as a launch AGENT, not daemon):
     Follow https://github.com/boarlabsxyz/awesome-mcp/settings/actions/runners/new
     Labels: self-hosted, macOS, mac-studio
     After install: cd ~/actions-runner && ./svc.sh install && ./svc.sh start
     Verify with: launchctl print gui/$(id -u)/actions.runner.*

3. Sign in to Claude Desktop and ChatGPT (in the e2e Chrome window) with
   the dedicated mcp-e2e accounts. Register the dev Railway MCP URL as a
   connector on both. Set "Always allow" for the connector.

4. Pin Claude Desktop and disable auto-update:
     defaults write com.anthropic.claudefordesktop SUEnableAutomaticChecks -bool false
     defaults write com.anthropic.claudefordesktop SUAutomaticallyUpdate -bool false

5. Verify infrastructure:
     curl -sS http://127.0.0.1:4723/status
     curl -sS http://127.0.0.1:9222/json/version

6. First local run (selectors will likely need adjusting; see SELECTOR-TODO
   markers in e2e/drivers/*.ts):
     cd ~/awesome-mcp/e2e && npm ci
     E2E_FIXTURE_DOC_TITLE="..." \
     E2E_FIXTURE_DOC_NEEDLE="BANANA-PHONE-7714" \
     CLIENT=claude-desktop npm test

────────────────────────────────────────────────────────────────────────
EOF
}

main() {
  require_macos
  ensure_homebrew
  ensure_node
  ensure_appium
  ensure_chrome
  install_launch_agents
  print_manual_steps
}

main "$@"
