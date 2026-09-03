# Write fixtures — Slack (`slack` and `slack-user`)

Two servers, two identities, **one** scratch channel.

| Service | `src/` dir | Catalog slug | Auth | Token env var |
|---|---|---|---|---|
| `slack` | `src/slack/` | `slack-bot` | Bot token | `E2E_SLACK_BOT_TOKEN` (`xoxb-…`) |
| `slack-user` | `src/slack-user/` | `slack` | User OAuth | `E2E_SLACK_USER_TOKEN` (`xoxp-…`) |

The directory-name/slug inversion is real and easy to get backwards — see
`e2e/runbook.md` § Two-connector model.

## Workspace requirements

Use a dedicated **test workspace**. Provision:

| Container | What it is | Env var |
|---|---|---|
| Scratch channel | A private channel holding only e2e traffic. Invite the bot **and** the user identity. | `E2E_SLACK_SCRATCH_CHANNEL_ID` |
| Read fixture channels | Two separate channels with pinned fixture messages, one per identity | `E2E_FIXTURE_SLACK_CHANNEL_ID`, `E2E_FIXTURE_SLACK_USER_CHANNEL_ID` (see [read.md](./read.md)) |

Both write smokes share the scratch channel — they post `[e2e]`-prefixed
messages and sweep by prefix, so they don't collide.

## Tokens

Each token must be **the same identity as the matching `-full` connector**.
Slack's `chat.delete` only removes messages authored by the calling token, so a
mismatch means every write smoke leaks a message it can't clean up. The harness
surfaces that as a `cant_delete_message` warning in the run log rather than
failing an otherwise-green test — watch for it.

Scopes needed by the direct-API client (setup/teardown only; the MCP has its own):

- Bot token: `chat:write`, `channels:history` (or `groups:history` for a private
  channel), `chat:write` covers `chat.delete` for its own messages.
- User token: `chat:write`, `channels:history` / `groups:history`.

`SLACK_WRITES_ENABLED=true` must be set on the **dev MCP server** — both
`postMessage` implementations refuse to write otherwise. That's a server-side
env var, not an e2e one.

## Required GHA secrets

| Secret | Source |
|---|---|
| `E2E_SLACK_BOT_TOKEN` | Bot token (`xoxb-…`) for the app behind `awesome-mcp-slack-full` |
| `E2E_SLACK_USER_TOKEN` | User token (`xoxp-…`) for the identity behind `awesome-mcp-slack-user-full` |

Not to be confused with `E2E_SLACK_WEBHOOK_URL`, which is the nightly failure
notification webhook and has nothing to do with the Slack service under test.

## Required GHA repo variable

| Variable | Example | Source |
|---|---|---|
| `E2E_SLACK_SCRATCH_CHANNEL_ID` | `C01234ABCDE` | Channel details → bottom of the About tab |

## What the write smokes do

1. Setup builds a `[e2e]`-prefixed message text carrying a `BANANA-SLACK-<ms>` marker.
2. The prompt asks the MCP for `postMessage` to the scratch channel, then
   `readChannelHistory`.
3. The assertion requires the marker inside the `OUTPUT_BEGIN`/`OUTPUT_END` fence.
4. Teardown runs `cleanupScratchChannel(service)`; the `after()` hook runs it again.

The sweep is bounded to the most recent 200 messages. An unbounded sweep of a
channel someone later repurposed is exactly the destructive accident the bound
exists to prevent — if the channel ever holds more than 200 stale `[e2e]`
messages, teardown has been broken long enough to warrant a manual look.

## Health checks

- **Scratch channel**: near empty between runs.
- **`cant_delete_message` in the run log**: token/connector identity drift. Re-issue
  the token from the same app or user the connector is bound to.
