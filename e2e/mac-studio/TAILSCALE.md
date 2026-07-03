# Mac Studio over Tailscale

How to set up remote access to the e2e Mac Studio via Tailscale so you can
bootstrap it, run smoke tests, and debug failures without physical access.

> Tailscale is **for operators**. The GitHub Actions runner is outbound only
> and does not need the tailnet. Nothing in the smoke tests themselves uses
> Tailscale — Appium (:4723) and Chrome CDP (:9222) still bind to `127.0.0.1`
> and are reached by the test process running locally on the Mac Studio.

## What you get

| Access | How | Use for |
|---|---|---|
| SSH shell | `ssh mcpe2e@mac-studio-e2e` | Run `install.sh`, tail logs, reload launch agents, kick jobs. |
| Screen Sharing / VNC | `open vnc://mac-studio-e2e:5900` (or Finder → Go → Connect to Server) | Grant Accessibility permission, log into Claude Desktop, warm the ChatGPT Chrome profile, pass Cloudflare challenges. **Required for one-time GUI steps.** |
| Port-forwarded Appium | `ssh -L 4723:127.0.0.1:4723 mcpe2e@mac-studio-e2e` | `curl http://127.0.0.1:4723/status` from your laptop. |
| Port-forwarded Chrome CDP | `ssh -L 9222:127.0.0.1:9222 mcpe2e@mac-studio-e2e` | Inspect the warmed Chrome instance from your laptop. |
| File transfer | `scp`, `rsync`, or `tailscale file cp` | Ship forensics bundles off-box for triage. |

## Prerequisites

- Physical or Screen Sharing access to the Mac Studio **once** to install
  Tailscale (Tailscale needs a GUI login the first time).
- A Tailscale account with an admin who can add devices and edit ACLs.
- On the admin laptop: Tailscale installed and signed into the same tailnet.

## 1. Install Tailscale on the Mac Studio (one-time, at the console)

Do this on the physical Mac Studio, signed in as the `mcpe2e` user.

```bash
brew install --cask tailscale
open -a Tailscale
```

Then in the Tailscale menu-bar app:

1. **Log in** — use the shared boarlabs Tailscale account. The device
   registers as e.g. `mac-studio-e2e`.
2. **Preferences → Advanced → Use Tailscale SSH** → enable. This lets you SSH
   in without provisioning Unix accounts / SSH keys separately.
3. **Preferences → General → Run at login** → enable.
4. Rename the device to `mac-studio-e2e` in the Tailscale admin console
   (https://login.tailscale.com/admin/machines). MagicDNS will then give you
   a stable hostname `mac-studio-e2e` (or the FQDN
   `mac-studio-e2e.<tailnet>.ts.net`).

Verify from the admin laptop:

```bash
tailscale status | grep mac-studio-e2e
tailscale ping mac-studio-e2e
```

## 2. Tag the device and lock down ACLs

In the Tailscale admin console → Access controls, add a tag and grant the
operator group access. Example additions to the ACL policy:

```jsonc
{
  "tagOwners": {
    "tag:e2e-runner": ["group:boarlabs-ops"]
  },
  "acls": [
    // Operators can reach the e2e runner on SSH + Screen Sharing only.
    {
      "action": "accept",
      "src":    ["group:boarlabs-ops"],
      "dst":    ["tag:e2e-runner:22", "tag:e2e-runner:5900"]
    }
  ],
  "ssh": [
    {
      "action": "accept",
      "src":    ["group:boarlabs-ops"],
      "dst":    ["tag:e2e-runner"],
      "users":  ["mcpe2e", "root"]
    }
  ]
}
```

Then apply the tag on the Mac Studio:

```bash
sudo tailscale up --ssh --advertise-tags=tag:e2e-runner
```

> **Do not** expose Appium (:4723) or Chrome CDP (:9222) via `tailscale serve`
> or by opening them past `127.0.0.1`. They are unauthenticated. If you need
> to hit them from your laptop, use SSH port forwarding (§5).

## 3. Enable Screen Sharing (required for GUI-only steps)

Several bootstrap steps need a real GUI session:

- Grant Accessibility permission to the Appium binary.
- First sign-in for Claude Desktop and Chrome/ChatGPT.
- Pass the Cloudflare human-check on ChatGPT once (to warm the Chrome
  profile so subsequent runs don't get challenged).
- Add the GitHub Actions runner as a **launch agent** (must be done inside
  the GUI user session, not over an SSH-only shell).

Enable Screen Sharing on the Mac Studio:

```bash
sudo systemsetup -setremotelogin on          # SSH (usually already on)
sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart \
  -activate -configure -access -on -restart -agent -privs -all
```

Or via GUI: System Settings → General → Sharing → Screen Sharing → on;
Remote Login → on.

From the admin laptop:

```bash
open vnc://mac-studio-e2e
```

The macOS Screen Sharing client will prompt for the `mcpe2e` password.
Choose "Ask to share the display" if the physical monitor is on; "Take
over" otherwise. Keep the physical monitor connected (or use a display
dongle) so `windowserver` has a display to render into — Appium drives
this same display.

## 4. First-time bootstrap from your laptop

Once Tailscale + SSH + Screen Sharing are up, the rest of the setup in
[README.md](./README.md) can be driven remotely:

```bash
# 1. SSH in over the tailnet.
ssh mcpe2e@mac-studio-e2e

# 2. Clone and run the idempotent installer.
git clone https://github.com/boarlabsxyz/awesome-mcp.git
cd awesome-mcp/e2e/mac-studio
./install.sh
```

Then switch to Screen Sharing to complete the steps `install.sh` cannot
automate — they are enumerated in [README.md §Manual steps](./README.md):

1. Grant Accessibility permission to `$(which appium)`.
2. Register the GitHub Actions runner as a **launch agent** (not daemon).
3. Sign in to Claude Desktop and to ChatGPT in the warmed Chrome profile.
   Register the dev Railway MCP URLs as `awesome-mcp-readonly` and
   `awesome-mcp-full` connectors (see [runbook.md §Two-connector model](../runbook.md)).
4. Pin Claude Desktop and disable auto-update.

## 5. Verify Appium and Chrome from your laptop

Both listeners bind to `127.0.0.1` and are not reachable across the tailnet
directly. Use SSH port forwarding — this is safe (encrypted, authenticated
by Tailscale SSH) and does not widen the exposure:

```bash
# Forward both ports in one shell.
ssh -N \
  -L 4723:127.0.0.1:4723 \
  -L 9222:127.0.0.1:9222 \
  mcpe2e@mac-studio-e2e

# In another laptop shell:
curl -sS http://127.0.0.1:4723/status       # Appium
curl -sS http://127.0.0.1:9222/json/version # Chrome CDP
```

If either curl fails, the launch agent is not up — SSH in and check:

```bash
launchctl print gui/$(id -u)/com.boarlabs.e2e.appium
launchctl print gui/$(id -u)/com.boarlabs.e2e.chrome
tail -f /tmp/appium.err.log /tmp/chrome.err.log
```

## 6. Trigger a smoke run remotely

```bash
ssh mcpe2e@mac-studio-e2e
cd ~/awesome-mcp/e2e
export E2E_FIXTURE_DOC_ID="<from fixtures/read.md>"
export E2E_FIXTURE_DOC_NEEDLE="BANANA-PHONE-7714"
CLIENT=claude-desktop npm run test:gate
```

The test needs the console session's `windowserver` to be active. If nothing
happens visually, open Screen Sharing and confirm the desktop is unlocked
(caffeinate keeps it awake but a manually locked screen still blocks
automation).

Pull forensics back to the laptop:

```bash
rsync -av mcpe2e@mac-studio-e2e:awesome-mcp/e2e/.artifacts/ ./e2e-artifacts/
```

## 7. Reliability hardening

| Concern | Fix |
|---|---|
| Tailscale sleeps on macOS | `Preferences → General → Run at login` on the app; also `sudo tailscale up --ssh --advertise-tags=tag:e2e-runner` after any tailnet re-key. |
| SSH host key changes after macOS upgrade | Prefer Tailscale SSH (skips OpenSSH host-key management entirely). If using stock OpenSSH, keep the `known_hosts` entry keyed on the Tailscale hostname, not the IP. |
| Runner idle after long uptime | Nightly reboot via `pmset repeat wakeorpoweron` + auto-login. Tailscale reconnects on wake. |
| Screen locks kill tests | `caffeinate -dimsu` runs as a launch agent (already installed by `install.sh`). Also disable screensaver + screen lock in System Settings → Lock Screen. |
| VNC is slow across long links | Use Tailscale's DERP relay by default; if your admin laptop and the Mac Studio are on the same LAN, Tailscale will negotiate a direct connection and VNC becomes snappy. |

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `tailscale ping mac-studio-e2e` fails | Device signed out. Screen Share in, click the Tailscale menu-bar icon, re-log. |
| SSH prompts for password | Tailscale SSH not enabled, or ACL blocks port 22. Check the admin console's ACL preview. |
| SSH connects but `sudo` prompts hang | Sudo password needed; either configure passwordless sudo for `mcpe2e` on ops-safe commands, or run interactively over Screen Sharing. |
| Screen Sharing shows a black screen | No physical display attached and no display emulation. Plug in a dummy HDMI plug or leave the monitor on. |
| Appium `curl` returns nothing over the forwarded port | Launch agent didn't start after login. See §5's `launchctl print` commands; often a stale Node upgrade broke `PATH`. |
| Everything works but tests still fail at the client UI | Not a Tailscale problem. Follow [runbook.md §Failure triage](../runbook.md). |

## What Tailscale does **not** replace

- **The GitHub Actions self-hosted runner.** It talks outbound to
  github.com; it does not need the tailnet.
- **Appium/CDP exposure.** Keep them bound to `127.0.0.1`. Use SSH port
  forwarding when you need to poke at them from off-box.
- **Physical presence for the very first Tailscale login.** After that,
  you can be fully remote.
