# GitHub — notes for Claude

## Rules and limitations

### Port of the archived reference server — do not "restore parity"
Tools come from `modelcontextprotocol/servers-archived` (`src/github`); the Go `github-mcp-server` cross-checked them. Each departure fixes a bug that read as success (listed in the `ops.ts` header):
- **`pushFiles` fast-forwards only** (no `force: true`), reports a lost race, keeps file modes from the base tree (not blanket `100644`), refuses a directory/submodule/symlink target.
- **`createBranch` reads the default branch from the repo** — never guesses `main`/`master`.
- **Branch reads use exact `git/ref/heads/<name>`** — plural `git/refs/` is a prefix match. The PATCH stays plural.
- **`createOrUpdateFile`: only a 404 means "file absent"** — not 401/rate limit/5xx.
- **`createRepository` sends `auto_init`**, not `autoInit`.
- **`getPullRequestStatus` reads check runs as well as statuses** — Actions never writes statuses. Check runs are best-effort (fine-grained PAT needs **Checks (read)**), degrading with a note. `PASSING` only if every check was read; a failed read or >100 runs → `UNKNOWN` (REST `unread`).
- **`mergePullRequest` reads the PR first** — GitHub reports success re-merging a merged PR. Says already-merged (REST 200, `alreadyMerged: true`, `merged: false`); refuses closed-unmerged with 409.
- **`parseLinkHeader` drops a `next` beyond `last`** (`/commits` can send `next=2, last=1`).

### Errors
- **Same 403, different causes, distinguished by headers** — `jsonApiRequestWithMeta` exposes them (`.headers` on errors); `mapGitHubError` reads `x-ratelimit-remaining`, `retry-after`, `x-github-sso` (SAML, URL quoted), `x-accepted-github-permissions`, and `x-accepted-oauth-scopes` vs `x-oauth-scopes` (implied scopes honoured; no `x-oauth-scopes` header ≠ no scopes).
- **404 is worded "does not exist OR you cannot see it"** (GitHub never 403s private resources).
- **Issue writes diff response vs request** — labels/assignees/milestone are silently dropped without push access.
- **OAuth App org restrictions**: a 403 naming "OAuth App access restrictions" is rewritten by `forbiddenMessage` to name the org and the approval page.

### Auth and scopes
- **Dual mode, github.com only** — `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` enable OAuth, else a PAT is pasted. No GHES (needs a per-connection guarded URL, not an env host).
- **Scopes `repo` + `read:org`; `workflow` deliberately NOT requested** — so a prompt-injected model cannot rewrite CI. Writes under `.github/workflows/` are refused locally (`assertNoWorkflowPaths`, 403); GitHub would 404 at the ref update. `read:org` only lists orgs; older connections need Reconnect for private memberships.
- **GitHub App user tokens expire (8h) and the refresh token rotates every use** — `maybeRefreshGitHubToken` is single-flight per connection; `performGitHubRefresh` reads the record and swaps only token fields (a whole-record write would wipe `accessRules`). No-op for OAuth App tokens and PATs.
- **Token endpoint fails with 200 + `{"error": …}`** — `postTokenGrant` handles it.

### Access rules (`providerTokens.accessRules.allowedOwners`) — a guardrail, not a boundary
- **Lets one account serve several workspaces**; a fine-grained PAT scoped to one owner is the GitHub-enforced limit.
- **Absent = unrestricted; null from the dialog deletes the key** (never store `{}` — reconnect merge keeps non-empty `accessRules`).
- **Enforced only in `GitHubClient.request`**: excluded `/repos/<owner>/…` refused before sending (`GitHubAccessDenied`, REST 403); fork target checked from body `organization`; `/search/{repositories,code,issues}` hits post-filtered with `hiddenByAccessRules` (`total_count` stays GitHub's), unreadable owners dropped; `/repositories/<id>` rename redirects not followed.
- **Re-read every call (`loadGitHubOwnerPolicy`), failing CLOSED** (REST 503); the transport's `UserSession` is long-lived.
- **`githubRestError` uses `instanceof`, not `error.name === 'UserError'`** (subclasses have their own name).
- **Discovery (`ownerDiscovery.ts`) merges `/user/orgs` (403 without `read:org`, empty for fine-grained), `/users/{login}/orgs` (public only) and owners of `/user/repos` counted per owner.** A member org with zero repos usually restricts OAuth Apps — the dialog and `listOrganizations` point at `/settings/connections/applications/<client_id>` (`oauthAppApprovalUrl`). Show all notes, report caps, keep saved rows, allow add-by-name.
- **Switching to "Only the ticked ones" starts with every reachable owner ticked** (`restrictGithubRules`).
- **Connected account added at save time** (`includeConnectedAccount`, one `/user` call; 502 and nothing written if unknown), for org-less forks and `POST /user/repos`.
- **Second connect of the same account is supported** — `uniqueGitHubInstanceName` suffixes the name.

### Revocation (`revoke.ts`)
- **Delete and reconnect revoke on GitHub** (`DELETE /api/instances/:id`, `/connect/github?reconnect=`) so the consent screen (org picking) reappears.
- **Grant vs token**: `DELETE /applications/{client_id}/grant` restores consent but kills every token the account holds for the app; `.../token` revokes one. Grant only if no other connector of this user has the same login (unknown = shared); other dashboard users are NOT checked. Reported as `githubRevoke`.
- **Only `gho_`/`ghu_` tokens are revocable**; PAT users are told to delete it on GitHub. Best-effort, never blocks. Org-owner approvals are per app and survive.

### REST plane (`/api/v1/github/*`, `restRoutes.ts`)
- **14 GETs + 5 POSTs (`createIssue`, `addIssueComment`, `pushFiles`, `createOrUpdateFile`, `mergePullRequest`), explicit sign-off** — the permanent dashboard API key can commit and merge anywhere the account can write.
- **Same schemas and `READS`/`perform*` as tools; `public/openapi-github.json` generated from them.**
- **`githubRestError`, not `sendUpstreamError`**: rate limit 429 + Retry-After; rejected stored credential 502 (never 401 — that means the caller's bearer); op refusals 400 unless they carry a status (missing branch 404, push race 409); GitHub `merged: false` → 409.
- **REST uses the OLDEST GitHub connector** (`getMcpConnection` … `ORDER BY connected_at ASC LIMIT 1`) regardless of which minted the bearer. Documented once in `REST_SERVICE_NOTES` (not per entry: Sonar duplication); not fixed.

### Known gaps
- No tool reads issue/PR conversation comments (`getIssue` gives a count; `getPullRequestComments` is inline diff comments only). Nothing deletes a file.

## Source Files

| File | Contains |
|------|----------|
| `src/github/server.ts` | 26 ported tools + `listOrganizations` |
| `src/github/apiHelpers.ts` | `GitHubClient`, `mapGitHubError`, App token refresh |
| `src/github/ops.ts` / `schemas.ts` | `op*` per tool and Zod schemas; `ops.ts` header lists departures |
| `src/github/accessRules.ts` / `ownerDiscovery.ts` | Owner allowlist, `GitHubAccessDenied`, fail-closed loader; owner discovery |
| `src/github/connectToken.ts` / `oauthCallback.ts` | PAT validation, instance naming, OAuth exchange + refresh |
