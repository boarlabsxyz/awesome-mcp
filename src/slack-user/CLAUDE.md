# Slack user server (slack-user) — notes for Claude

Shared Slack code (files, posting/editing, channel events, `SlackClient`): see `src/slack/CLAUDE.md`.

## Rules and limitations

### Access rule engine (`accessControl.ts`)
- **One rule engine for list and read** — `filterChannelList` wraps `classifyChannelList`, which calls the same `assertAccess` a read calls. Never reintroduce a separate copy of the rules in `listChannels`.
- **Only deliberate seam: unknown org ≠ denied** — a shared channel whose list payload names no org is `needsOrgBackfill`; `listChannels` resolves it with `conversations.info` for up to `CHANNEL_INFO_BACKFILL_MAX` (25), half the tier-3 minute budget since DM/group-DM member lookups share it. Channels past the cap are reported, never silently unchecked.
- **`assertAccess` checks orgs before channel patterns** — anything treating an org denial specially must call `assertNonOrgAccess` first (`passesNonOrgRules` in `server.ts`), or a channel the user's own patterns exclude leaks out on an org technicality.
- **Denials are typed** (`SlackAccessDenied` with `reason`/`orgIds`/`patterns`); don't parse the message text.
- **Org enforcement requires ALL the channel's orgs be allowed, not `some`** — `some` passes any channel that includes your own workspace.
- **Never read `shared_team_ids` directly** — Slack Connect partners are in `connected_team_ids` / `pending_connected_team_ids`. Use `channelTeamIds()` (`src/slack/apiHelpers.ts`): `includePending: true` for discovery, `false` for enforcement (an unaccepted invite must not deny).
- **`diagnoseChannelAccess` is the generic "why can't I see #x"** — never hardcode a channel-name exemption (spoofable by any workspace).

### `listChannels` output
- **Three buckets, counted separately in the summary**, on both the payload-org and backfill (`verifyBackfilledChannel`) paths: org-denied rows that pass `passesNonOrgRules` are listed with `⚠ Not readable: shared with <Org> (ID)` and topic/purpose withheld; channels past the backfill cap are `caution` (`⚠ Organisation unverified`, free text kept — nothing denied them); rows denied by the user's own patterns are hidden but counted (listing them would expose names they excluded).

### Org names (`teamNames.ts`)
- **`resolveTeamNames` cache is keyed by token and bypassed without one** — `team.info` success depends on the calling token; a bare team-ID key would serve one tenant's names to another.
- **Expect names to be missing** — `team.info` on a foreign org usually fails even with `team:read`. Always keep the raw `T0…` ID (`nameResolved: false` is expected): it is what the dashboard checkbox is labelled with.

### Search
- **`searchMessages`/`searchFiles` are slack-user only** — bot tokens get `not_allowed_token_type`; no stub on slack-bot. Need **`search:read` + reconnect** (the dashboard Reconnect button is `renderInstanceRow`'s `showReauthorize`, since `needsReconnect()` is false for non-Google providers). `callSearch` rewrites `missing_scope` keeping Slack's `needed`/`provided` (`formatScopeDetail`); `provided` tells "never reconnected" from "reconnected, still not granted".
- **Access is post-filtered and fails CLOSED** — `enforceAccess` takes one channel and the query DSL has no deny-list, so `buildChannelFilter` runs `fetchChannelMeta` + `assertAccess` + `assertDmMemberAccess` per distinct channel (memoised per call over the 5-min meta cache). The DM check is required or DM/group-DM results bypass rules a direct read enforces. A file shows if any channel it's shared into is allowed.
- **Page numbers are Slack's, not the filtered list's** — a page can be empty while more exist; the response says so and how many results the rules hid. `search.*` pages by `page`/`count`, not `cursor`.
- **No REST sibling** — the REST plane is gated on `slackBotToken` because access rules can't be applied there.

### Org discovery (`orgDiscovery.ts`, `discoverConnectedOrgs`)
- **An undiscovered org has no checkbox and can never be allowed**, so under-reporting is a silent access failure — every cap is reported via `orgDiscovery.truncated` + notes and shown as a warning.
- **Five sources, none sufficient alone:** `conversations.list` (public+private, `limit: 1000`, capped by `LIST_MAX_PAGES`); `users.conversations` public+private (member-scoped, reaches the user's shared channels when the workspace sweep runs out); `users.conversations` `im,mpim` (`conversations.list` never returns DMs); `users.list` (each user's `team_id`); `conversations.info` for shared channels with no team in the payload.
- **The `conversations.info` queue (100-call budget) is ranked by `infoPriority`** — member+external, member, external, rest — not discovery order. External = `is_ext_shared`/`is_pending_ext_shared`; `is_shared` alone can be Enterprise Grid internal sharing. Failed lookups (often 429) are counted and reported, not swallowed.
- **Saved orgs are always returned**, even if not rediscovered — the dashboard rebuilds `allowedOrgs` from rendered checkboxes, so a missing row would revoke it on Save (the client also merges unrendered saved orgs).
- **Manual add (`addOrgById`, `T…`/`E…`) is shape-validated only** — `team.info` on foreign orgs fails by design; it is saved and returned as a `saved` row.
- **Cached 5 min per `(instance, saved allowlist)`**; the dashboard must pass `tokenKey` (the Slack token, same as `getTokenKey`) or the name cache is bypassed and the `team.info` budget re-spent on every open.

## Source Files

| File | Contains |
|------|----------|
| `src/slack-user/server.ts` | User-OAuth tool definitions (`slack` slug, `xoxp-`); `enforceAccess` on every channel-scoped tool; `buildChannelFilter`, `passesNonOrgRules` |
| `src/slack-user/accessControl.ts` | `assertAccess`, `assertNonOrgAccess`, `classifyChannelList` |
| `src/slack-user/orgDiscovery.ts` | `discoverConnectedOrgs` — Access Rules org checkboxes |
| `src/slack-user/teamNames.ts` | `resolveTeamNames` — token-keyed org-name cache |
