# Slack (shared + slack-bot) — notes for Claude

Access rules, search and org discovery (user-token server): see `src/slack-user/CLAUDE.md`.

## Rules and limitations

### Scopes & reconnects
- **`files:read`, `search:read`, `reactions:read` need a reconnect** for existing connections. Everything using only `chat:write` (posting, editing, unfurl, rich text, broadcast) needs none. No REST sibling for Slack writes (plane is hard-gated).

### Files
- **Attachments render as `📎 <name> — <mime>, <size> — file ID: F…`** via `formatFileRef`/`formatFiles` in `formatMessage`. Without `files:read`: stubs with `file_access: 'check_file_info'` ("file hidden"), `files.info` 403s.
- **`downloadFile(fileId, channelId, format)` must verify the file is shared in `channelId`** — `fileShareTargets` unions `channels`/`groups`/`ims` and `shares.public`/`shares.private`; stops a denied channel's file being laundered through an allowed one (slack-user runs `enforceAccess` first).
- **`format: 'url'` re-hosts via `store(..., { ephemeral: true })`** (`src/images/imageBlobStore.ts`) to a **public, unauthenticated** `/images/<hash>.webp` (a private-DM screenshot becomes URL-fetchable). Ephemeral bounds exposure to `IMAGE_RETENTION_DAYS` (default 30, `0` disables) — not a guarantee: a content-addressed blob shared with a permanent use is promoted. Needs `DATABASE_URL` + `IMAGE_PUBLIC_BASE_URL`.
- **`format: 'inline'` returns a FastMCP `imageContent` block** (≤1.5 MB, no image host) — the repo's only non-string result. Text files return text; others metadata + permalink.
- **`fileDownload.ts` attaches the bearer per redirect hop, only for `*.slack.com`** (never to S3). A token lacking `files:read` gets **200 + an HTML sign-in page**; reject it, never store it.

### Posting & editing
- **mrkdwn has no lists** — `- item` renders literally. `postMessage`/`replyInThread`/`editMessage` (both servers) take `richTextParams`: `markdownText` → `markdown_text` (preferred, 12,000-char cap) and `blocks` → Block Kit (list = `rich_text` holding `rich_text_list`, `style: 'bullet'|'ordered'`).
- **`blocks` is `JSON.stringify`d inside `chatPostMessage`/`chatUpdate`, never at call sites** — `request()` uses `String(v)`, so a raw array sends `[object Object]`. Tested in `apiHelpers.test.ts`.
- **Combination rules live in `resolveMessageBody`, not Zod** — `.refine()` loses `.shape` (breaks the `.describe()` walk in `slack-user/tools.test.ts`) and Zod errors surface as generic `InvalidParams`. Refuses `markdownText`+`text`, `markdownText`+`blocks`, an all-empty call, and `blocks: []` (on `chat.update` = remove every block). `blocks`+`text` is allowed (`text` = notification/screen-reader fallback).
- **`renderNote` reports the block types Slack echoed** (`Rendered as: rich_text (rich_text_list ×2)`); no blocks in the echo = *may* be plain text, never asserted.
- **Define shared params once in `helpers.ts`** (`unfurlParams`, `richTextParams`, `broadcastParam`) so registrations can't drift; confirmations stay byte-identical when they're not passed (tested).
- **`unfurlLinks`/`unfurlMedia` (post/reply only): omit unset flags, never send `false`** — defaults differ by token (bot: media only; user: both), so `false` changes behaviour. No readback, so the confirmation says it reports what was *requested*. Can't retract existing previews; per-domain previews are an admin setting.
- **`editMessage` deliberately has no unfurl flags** — effect on `chat.update` is UNVERIFIED with no readback; a silent no-op parameter is worse than none.
- **`broadcast` → `reply_broadcast` on `replyInThread` only**, confirmed from `message.subtype === 'thread_broadcast'`, else reported unconfirmed. Not forwarded on `chat.update` (UNVERIFIED, not echoed).
- **`editMessage` is gated by authorship, not scope** (a token edits only its own messages). `handleEditMessage` maps `cant_update_message`, `edit_window_closed` (admin limit; delete+repost), `message_not_found` (`ts` is per-channel), `msg_too_long`, plus `invalid_blocks`/`msg_blocks_too_long`/`markdown_text_conflict` (shared with post paths).
- **`chat.update` with `text` but no `blocks` strips existing blocks** (descriptions warn). Old text is unrecoverable, so a plain-text edit's confirmation echoes the new text.
- **`editMessage` is registered on both servers**; on slack-user wrapped in `enforceAccess` like `postMessage`. slack-bot has no `enforceAccess` on any tool. `readOnlyHint: false`, no `destructiveHint` (deletes only). Registry guard: `src/__tests__/slack/tools.test.ts`.

### Channel events (slack-user tools, shared code)
- **A store you poll, not a push** (`subscribeToChannelEvents` & co.). No per-user Slack subscription API: delivery is app-wide (Request URL + `SLACK_SIGNING_SECRET`), so subscribing only inserts a local filter.
- **One delivery fans out to N rows** — `findSubscriptionsForChannel` looks up by `(team, channel)` and returns an array.
- **Dedup is mandatory** — Slack retries non-prompt-2xx (`X-Slack-Retry-Num`); `UNIQUE(subscription_id, event_id)` + `ON CONFLICT DO NOTHING`.
- **Answer 200 to everything except signature failures (401)** — a non-2xx disables the whole workspace's Request URL. Signature: `v0=` HMAC over `v0:{ts}:{body}`, ±5-min replay window, checked before echoing `url_verification`.
- **Parsing:** `reaction_added` carries channel/ts under `event.item`. `event.type` is `message` for all of `message.channels/groups/im/mpim`, which are separate app toggles — `requiredMessageEventSubscription()` names the one a channel needs (`is_im`/`is_mpim`/`is_private`, ID-prefix fallback; `C` ≠ public). Join/leave/topic subtypes dropped; `bot_message` kept.
- **`matchPattern` is a literal case-insensitive substring, never a regex.** `[slack-ingest]` logs never include message text.
- **`enforceAccess` on subscribe and every history read** — rules re-read per call, so history goes unreadable if the channel is later denied.
- **`slack_ingest_health` holds one row per outcome branch** (`recordIngestDelivery`/`readIngestHealth`) — bounded (~13 rows) because the ingest URL is public. `debugChannelEventSubscription` reads it (never-POSTed / handshake-only / rejected / unmatched). Writes are best-effort and never change the status Slack sees.

## Source Files

| File | Contains |
|------|----------|
| `src/slack/server.ts` | slack-bot tool definitions (`slack-bot` slug, `xoxb-`) |
| `src/slack/helpers.ts` | Shared handlers/rendering, shared params, `resolveMessageBody`, `renderNote` |
| `src/slack/apiHelpers.ts` | `SlackClient`, `fileShareTargets`, `channelTeamIds`, `formatScopeDetail` |
| `src/slack/fileDownload.ts` | `url_private_download` fetch: per-hop SSRF, Slack-only bearer, login-page detection |
| `src/slack/eventStore.ts` | Postgres: `slack_event_subscriptions`, `slack_channel_events`, `slack_ingest_health` |
| `src/slack/eventHelpers.ts` | `verifySlackSignature`, `handleSlackEventIngest`, subscribe/query/debug flows |
