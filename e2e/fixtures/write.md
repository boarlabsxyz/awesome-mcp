# Write fixtures — index

Write-tool smoke tests never reuse a read fixture. Each one creates its own
scratch resource through the **direct provider API** (not the MCP — that would
couple the test to the thing under test), runs the MCP tool against it, asserts
the resulting state, and destroys the resource in teardown. A safety-net sweep
runs after each test file to clean up whatever teardown missed.

Provisioning is grouped by backend rather than by service, because that's how it
actually works: six Google services share one account, one OAuth grant, and one
set of scratch containers.

| Doc | Covers | Direct-API client | Scratch factory |
|---|---|---|---|
| [write-google.md](./write-google.md) | `google-docs`, `google-drive`, `google-sheets`, `google-slides`, `google-gmail`, `google-calendar` | `setup/googleClient.ts` | `setup/scratchFactory.ts`, `setup/gmailScratch.ts`, `setup/calendarScratch.ts` |
| [write-clickup.md](./write-clickup.md) | `clickup` | `setup/clickupClient.ts` | `setup/clickupScratch.ts` |
| [write-slack.md](./write-slack.md) | `slack` (bot token), `slack-user` (user OAuth) | `setup/slackClient.ts` | `setup/slackScratch.ts` |

## Scratch resource naming convention

One rule, enforced in one place (`setup/scratchNaming.ts`), for every backend:

```
[e2e] <label> <ISO timestamp>
```

e.g. `[e2e] append smoke 2026-06-01T03:14:15.000Z`. Two things depend on it:

1. **Recognizability.** An orphan left by a crashed run is obvious in any UI.
2. **Cleanup scoping.** Backends with no container to scope to (Gmail, Slack,
   ClickUp, Calendar) sweep by this prefix, so the safety nets can never touch a
   resource the harness didn't create.

Write tests that ask the MCP to create the resource (rather than creating it in
setup) pass a `[e2e]`-prefixed name in the prompt for exactly this reason — the
sweep still catches it even though the harness never held its id.

Assertions key off a separate short **marker** (`BANANA-<SERVICE>-<epoch ms>`,
from `scratchMarker()`) embedded in the name or payload. The name proves cleanup
scoping; the marker proves the write actually landed.

## Shared GHA secret

| Secret | Source |
|---|---|
| `E2E_SLACK_WEBHOOK_URL` | Incoming webhook for nightly regression failure notifications (unrelated to the `slack` service under test) |

## Health checks

- **Scratch containers hover near empty between runs.** If any exceeds ~10
  resources, the teardown layer is broken — run the relevant `cleanup*()` helper
  and investigate the most recent failed run.
- **Tokens.** Every direct-API credential is a rotation trigger in
  `e2e/runbook.md` § Account rotation. Google refresh tokens for desktop clients
  expire after ~6 months unused; `googleClient.ts` logs each refresh so a
  forensics bundle shows whether it still works.
