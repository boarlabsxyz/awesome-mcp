# Web server, dashboard auth and the REST plane — notes for Claude

## Rules and limitations

### Sign-up & login

- **Sign-up is verify-first; `GET /auth/verify` must stay inert** — `POST /api/auth/register` creates nothing in `users`: it parks the bcrypt hash in `pendingRegistrationStore.ts` (Redis `pending_registration:<sha256(token)>`, 24h; memory fallback 10k, oldest-first) and mails a link. The GET only serves `public/verify.html`; its `POST /auth/verify` calls `createPasswordUser` and opens the session — a consuming GET lets mail scanners burn the link.
- **Token: SHA-256 only, single-use, one failure answer** — a Redis dump yields nothing usable (32 CSPRNG bytes, no work factor needed); deleted before the record is returned; unknown/used/expired all go to `/login?verify=invalid`. `/auth/verify` sets `Referrer-Policy: no-referrer` (token is in the query string).
- **No existence oracles** — register answers 202 `REGISTRATION_ACCEPTED` whether or not the address is taken (taken → owner gets a no-link notice mail) and hashes on both paths so bcrypt timing leaks nothing; login runs `verifyPassword` unconditionally (null hash → dummy hash of equal cost). The register log line is branch-independent and carries no address.
- **Duplicate pending sign-ups** — first link redeemed wins; the other gets `?verify=exists` (`DuplicateEmailError` caught) and is not signed in.
- **Pending records die on our failures, not the user's** — undelivered link → deleted; non-duplicate redemption failure → restored (a DB outage must not spend a link); `DuplicateEmailError` keeps it consumed.
- **Mail: Resend over `fetch`** (`mailer.ts`, `authEmails.ts`; `RESEND_API_KEY` + `MAIL_FROM`) — dev without a key logs the body incl. link; prod throws `MailNotConfiguredError` → 503, nothing created. `isMailConfigured()` requires `MAIL_FROM` too in production (fallback is Resend's sandbox sender).
- **Passwords > 72 bytes are rejected, not truncated** — bcrypt (cost 12, `src/auth/password.ts`) silently ignores the rest.
- **Rate limit counts every attempt** — `src/website/loginRateLimit.ts`, per IP and per email, 8 / 15 min, Redis with per-process memory fallback. Failure-only counting lets a valid login reset it; the email bucket is load-bearing (`trust proxy: true` makes `req.ip` spoofable) and stops register mail-bombing.
- **Sessions are keyed by `userId`** — resolve via `resolveSessionUser` (userId, then googleId for old sessions), never `getUserByGoogleId` inline (401s for password accounts). `/connect/:mcpSlug` OAuth state carries `userId`; park-and-login targets `/login`. Use `regenerateApiKeyByUserId` only (the googleId variant was deleted).
- **Linking Google to a same-email password account keeps the password and `auth_method='password'`** — DB `ON CONFLICT (email)` path and file store; the dashboard renders `authMethod` verbatim.
- **`password_hash` stays out of `DB_USER_COLUMNS` and `UserProfile`** — so it can't leak.
- **`HIDE_GOOGLE_SIGNIN=true` hides the button, never `GET /auth/google`** — `sendSigninPage` strips the `<!-- google-signin:start/end -->` block from `public/login.html`/`dashboard.html` server-side (read-and-sent, not `sendFile`d). The route stays: Google-created accounts have no password. Presentation only (default: shown), reported as `googleSigninHidden` at `/api/config`; overlay focus falls back to `'.btn-google-login, .login-alt a'`. `public/index.html` copy ignores it.
- **Gap: no password reset** — mail exists; needs a token store + two routes.

### REST plane (HubSpot + Redmine)

- **Refresh at call time** — `hubspotRestClient`/`redmineRestClient` run `maybeRefreshHubSpotToken`/`maybeRefreshRedmineToken` (single-flight; refresh tokens rotate) before `getXClient` (refresh mutates the session). Never `new XClient(token)`.
- **Don't route errors through `sendUpstreamError` alone** — HubSpot keeps the missing-scope 403 path (`parseHubSpotMissingScopes` → `fetchHubSpotGrantedScopes` → `formatHubSpotScopeError`, needed + granted). Redmine uses `mapRedmineError` (403 may mean REST API off; 422 carries `errors`; unreachable host has no status). **Never echo Redmine's 401 — map it to 502**; a 401 here means the caller's bearer.
- **Validate Redmine GET query params with the tools' schemas** — Redmine drops unknown filters and caps `limit` at 100 (fails open). `redmineCustomFieldFilters` (`src/util/queryParams.ts`) accepts only `cf_<digits>`; a repeated `cf_N` is a 400, not dropped (a missing filter returns more rows).
- **`GET /hubspot/tickets` clamps `maxRetries`/`retryDelay` to 3/2** — retries sleep `retryDelay * (2^maxRetries - 1)` s and would strand the socket; MCP stays unbounded.
- **Don't re-derive mappings in `webServer.ts`** — use `issueListQuery`/`projectListQuery`/`userListQuery`/`timeEntryListQuery`/`searchQuery`/`issueBody`/`timeEntryBody`/`wikiPageBody` from `src/redmine/ops.ts` and `fetchCompanyActivity`/`fetchCompanyDeals`+`renderCompanyDeals`/`fetchTickets`/`fetchRecentConversations`/`fetchTicketConversationThreads`/`performCreate{Company,Contact,Engagement}` from `src/hubspot/server.ts`.
- **Shapes** — Redmine lists `{ items, page }`, HubSpot raw JSON; `?format=text` on reads. `performCreateCompany`/`Contact` return `created` (201 vs 200: no-op on an existing match). `performCreateEngagement` returns the association outcome; `attempted && !attached` is an orphan, still 201.
- **MCP-only writes, on purpose** — exposed: HubSpot `createCompany`/`createContact`/`createDeal`/`createNote`/`logCall`/`logMeeting`, Redmine `createIssue`/`updateIssue`/`createTimeEntry`/`updateWikiPage`. Not exposed: all Redmine `delete*`, `archiveProject`, project/version/category/membership creates, HubSpot `deleteEngagement`, one-field `update*`s, property-schema writes (no recycle bin, `deleteProject` cascades, curl can't confirm).
- **Security: `createServiceAuth` accepts the permanent dashboard API key** — it can mutate HubSpot CRM and Redmine issues/time/wiki.
- **`POST /api/v1/redmine/issues/{issueId}` is an update** — catalog methods are `GET | POST` only.

### Body parsing

- **Every factory calling `registerRestApiRoutes` must call `registerRestBodyParsers` + `registerRestBodyParseErrorHandler` first** — else `req.body` is undefined and POSTs 400 with misleading "Required" errors while GETs work.
- **Large-body parser before the global `express.json()`** — `REST_LARGE_BODY_PREFIXES` get `express.json({ limit: REST_LARGE_BODY_LIMIT })`; later parsers skip once `req._body` is set, so a per-route one never runs (the 100 kb global already 413'd).
- **The `/api/v1` JSON error handler goes after the parsers, before the routes** — `entity.too.large`/`entity.parse.failed` become JSON, not Express HTML.
- **`createMcpOnlyApp` (`MCP_MODE=mcp`, per-service subdomains) mounts parsers on `/api/v1` only** — a global `express.json()` would consume `/mcp` and `/sse` streams before `http-proxy-middleware` forwards them. Pinned by `src/__tests__/restRoutes.mcpOnlyApp.test.ts` (the parser assertion; a 401 proves nothing).
