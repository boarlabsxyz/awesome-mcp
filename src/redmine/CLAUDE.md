# Redmine — notes for Claude

REST-plane handlers for this service: see src/website/CLAUDE.md.

## Rules and limitations

### Auth & connection
- **Base URL is per-connection, never an env default** — no public Redmine host exists, so guessing one would send the credential somewhere unnamed. `getRedmineClient` throws on a missing base URL; the dashboard URL field is mandatory (`isOutline || isRedmine` gate in `connectWithToken`); the connect route is Outline-shaped, not `connectPasteToken` (which stores only `{ access_token }`).
- **Base URL goes through `checkBaseUrl`** (`src/util/baseUrlGuard.ts`, shared with Outline) — it is attacker-controlled input we send a credential to. `requireHttps` is on by default; the HTTPS check runs *after* the private-host check so loopback/RFC1918 still gets "must point to a public host" (Outline tests depend on that order). No DNS-rebinding defence (known gap).
- **Dual-mode auth, inferred from `session.redmineRefreshToken`** — API key → `X-Redmine-API-Key` (any Redmine); OAuth token → `Authorization: Bearer` (Redmine 6.1+ Doorkeeper only). Mode is not stored; `resolveRedmineAuthMode` decides, and `connectionHealth.ts` must pass the matching `authMode` or a healthy OAuth connection is probed as an API key and reported bad.
- **OAuth is env-gated** — `REDMINE_CLIENT_ID` + `REDMINE_CLIENT_SECRET` + `REDMINE_BASE_URL` enable "Connect with Redmine"; otherwise the paste form. Keep the paste fallback: an admin registers the OAuth app per instance (`<base>/oauth/applications`), so one `client_id` serves one Redmine, and pre-6.1 can only paste.
- **Doorkeeper rotates the refresh token on use** (access tokens ~2h) — `performRedmineRefresh` must persist whatever comes back, or the connection dies on the next refresh.
- **OAuth scopes are Redmine permission names (`view_issues`, `add_issues`, …, `admin`) and not a security boundary** — they must exist on the instance and be ticked on the app or authorize errors; issue edit/notes/delete ignore `oauth_scope` (Redmine defect #44271), so a narrow token can still write.
- **Session cache key = token + base URL + auth mode** — a reconnect can change `providerTokens.baseUrl` without changing the key; `authMode` picks the header.

### Errors
- **401 ≠ 403** — 403 usually means an admin disabled the REST API (Administration → Settings → API); 401 means the credential was rejected, but before Redmine 4.1 a disabled API also answered 401, so the 401 text names both causes. `validateRedmineToken` passes a function as `rejectedMessage` (`validatePasteToken` accepts `string | (status) => string`).
- **A 403 on one route (e.g. `/time_entries.json`) has four possible causes** — `describeRedmineDenial` lists all four and suggests the browser test (if the same account sees the HTML page, permission and project module are ruled out; a plugin or proxy rule is likely). Do not assert "missing `view_time_entries`".
- **Evidence rides on the error** via `noteRedmineEvidence` (a Symbol read only by `mapRedmineError` for message text — status stays on normal fields), e.g. "header form bounced to login, `?key=` form got 403".
- **`RedirectRefusedError.status` is 502, not the 3xx** — `sendUpstreamError` passes `.status` to `res.status()`, and a 3xx would make our REST client follow a Location we refused; real status is on `.redirect.status`.

### Redirects & credential safety
- **`jsonApiRequest` uses `redirect: 'manual'`, never `'error'` or `'follow'`** — Node fetch keeps custom headers across origins, so following would hand `X-Redmine-API-Key` to the `Location` host; manual lets us read `Location` and name the cause (proxy rewrite / SSO hop / login bounce / loop). Connect-time `validatePasteToken` also refuses redirects, so a redirecting base URL is never stored.
- **Follow rules** — same-origin compared to the *original* request (not the previous hop); GET/HEAD only (3xx replays writes); never follow a login path (200 HTML resolves to `undefined` = fake empty result); max 3 hops.
- **Login-bounce retry** — `RedmineClient` retries a same-host login bounce with `?key=` then HTTP Basic `key:x` (proxies may strip `X-*` headers on one route). GET-only, API-key mode only, never cross-origin; a non-redirect failure on a retry stops the chain.
- **Redact secrets everywhere** — `jsonApiRequest` takes a `secrets` list and redacts message, log, `.redirect`, `RedirectRefusal.resolved` **and `target`** (it prefixes every thrown message). Redmine echoes the URL in `back_url`. The raw URL needed to follow is returned beside the record, not read off it.
- **Scheme change ≠ host change** — `http://`→`https://` 301 gets its own "reconnect over https" message; a prose `baseUrlHint` falls back to generic wording.

### Lists & filters
- **Most endpoints are Alpha** — Stable: Issues, Projects, Users, Time Entries, News; Beta: Attachments; Alpha: Wiki, Versions, Memberships, Relations, Categories, Enumerations, Custom Fields, Search (~20 of 46 tools).
- **`limit` default 25, hard cap 100** — every list formatter prints `Showing N-M of TOTAL` and the next `offset`; a silent truncation reads as "that's everything".
- **Filters fail open** — multi-values must be one comma-joined param (`issue_id=1,2,3`; repeated keys ignored), and unknown keys are dropped returning MORE rows. `mergeCustomFieldFilters` accepts only `cf_<digits>`; `activityId` exists because billable is usually modelled as activity.
- **`listUsers`/`listCustomFields` are admin-only** (403 otherwise) — use `listMemberships` to resolve user IDs.

### Time entries
- **Single page sums are labelled `Hours on this page`**; `allPages=true` (opt-in, MCP and REST `?allPages=true`) pages to the end and labels `Hours across all N entries`. Single-page output points at the flag. Scan cap 5000 entries (reported when hit); stops on a short page too (plugins may omit `total_count`). REST `allPages` answers `{ items, scan }` with no `page`.
- **Per-project fallback when `/time_entries.json` fails** — must call `listProjectTimeEntries` (`/projects/{id}/time_entries.json`), never `listTimeEntries({ project_id })`, which hits the same broken route; tests assert the path. Triggered by route-level failures (refused redirect, 403, 404, 405, 501, 5xx — `isGlobalRouteWorthRetrying`), not 401/422. Also used on the single-page path and when `projectId` is named (one extra request).
- **Workspace-wide fallback is bounded** — abandon after `DENIAL_PROBE_LIMIT = 3` consecutive refusals with nothing collected; if no project answers, rethrow the original error (an empty result would read as "no hours logged").
- **Deduplicate by entry id** — project queries include subprojects when `display_subprojects_issues` is on (not readable via API), so concatenation over-counts.
- **Per-project scan total is a FLOOR** — labelled `FLOOR, not a total`, names unreadable projects and why the global list failed. A single named project answered via `projectRoute` is a full total (not a floor), but say it came from the fallback route.

### Deletes
- **Permanent, no recycle bin** — `deleteProject` cascades to subprojects' issues, wiki, versions and time entries; `archiveProject` is the reversible option. All seven delete tools carry `destructiveHint: true`.

## Source Files

| File | Contains |
|------|----------|
| `src/redmine/server.ts` | Tool definitions (46 tools) |
| `src/redmine/apiHelpers.ts` | `RedmineClient` (API-key/Bearer), all formatters, OAuth refresh |
| `src/redmine/ops.ts` | One exported `op*` per tool body (testable against a stub client) |
| `src/redmine/schemas.ts` | Zod schemas; separate from `server.ts` to avoid an import cycle with `ops.ts` |
| `src/redmine/authMode.ts` | `resolveRedmineAuthMode`, shared by client and health probe |
| `src/redmine/connectToken.ts` | `validateRedmineToken` against `GET <base>/users/current.json` |
| `src/redmine/oauthCallback.ts` | Doorkeeper code exchange + refresh grant |
