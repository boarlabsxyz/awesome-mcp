# Admin MCP

The `/admin` usage analytics (`src/usage/`) as MCP tools — read-only, `ADMIN_EMAILS` only. Six tools: `getUsageOverview`, `listToolUsage`, `listTopErrors`, `listRetryLoops`, `getUserActivity`, `listUsers`. Data comes from this server's own Postgres; there is no third-party credential.

## Rules

- **`isAdminEmail` (`src/auth/admin.ts`) is the only gate.** OAuth scopes are not one: any user can request `mcp:admin` (Auth0 has no RBAC, opaque tokens pass `hasScope`, API keys are not scope-checked). Every admin surface — this MCP and the `/admin` page routes — asks `isAdminEmail` and nothing else. It reads `ADMIN_EMAILS` per call, so the web and admin services cannot disagree after one restarts.
- **The check runs twice, on purpose.** `resolveSession` (`src/mcpAuthenticate.ts`) refuses a non-admin with 403 *before* every other path — the instanceId path skips ownership and the global-Google-token fallback would hand any Google user a session for any slug. But FastMCP authenticates once per session, so `requireAdminForEveryTool` (`adminGuard.ts`) re-checks the caller on every call. Verified live: a session opened by an admin is refused on its next call after the address is removed.
- **The check is on the CALLER's email (the API key / token owner), never the connection's owner.** An Admin MCP instance id grants nothing; replayed against another server it answers 400.
- **The caller's identity reaches FastMCP through headers only the proxy may set** — a client-supplied `x-mcp-user-id` used to pass straight through (root `CLAUDE.md`), which would have made anyone an admin by naming an admin's user id.
- **That email is only as trustworthy as the sign-in that produced it.** Auth0 identities link to accounts only by a verified email (root `CLAUDE.md`); before that rule, registering an admin's address at Auth0 without verifying it would have mapped onto the admin's account and passed this gate.
- **The server is built as `requireAdminForEveryTool(instrumentServer(new FastMCP(...), 'admin'))`.** The guard wraps registration, so a new tool cannot skip it; it sits outside the recorder so refused attempts are recorded. `adminGuard.test.ts` fails any other construction. Admin tool calls therefore appear in usage analytics under `admin`.
- **`mcp:admin` is in `SLUG_SCOPE_MAP` only, never `ROUTE_SCOPE_MAP`.** The route map is matched against request paths, and `/admin` is the admin web page.
- **The catalog row is active for everyone and filtered per request.** `is_active` is global, so `/api/v1/catalogs` and `/api/v1/catalogs/:slug` drop `ADMIN_ONLY_SLUGS` unless the request's dashboard session belongs to an admin — the public integrations page and anonymous callers never see it, and `:slug` answers 404. The local fallback URL is `/admin-mcp`, never `/admin`.
- **Connecting is one click and creates only a row.** `GET /connect/admin` (`connect.ts`) refuses non-admins with 403, creates at most one connector per admin, and stores no credential. Its health probe reports `healthy`: there is nothing to expire.
- **No database is an error, never an empty answer** — "no usage" and "no database" must not look alike.
- **Tool descriptions are plain string literals** — `scripts/buildMcpToolsDoc.mjs` reads them from source and skips a template literal.

## Deployment

A Railway service like the other connectors: `TRANSPORT=httpStream`, `MCP_MODE=mcp`, `MCP_SLUG=admin`, `ADMIN_EMAILS`, `DATABASE_URL`, `REDIS_URL`; set `ADMIN_MCP_URL` on the web service. `ADMIN_EMAILS` must match on both. Removing an admin is an env change plus restart, which drops every session.

## Source files

| File | Contains |
|------|----------|
| `server.ts` | The six tool registrations |
| `ops.ts` | Tool bodies with injected pool / user lookups, the no-database error, email-or-id user resolution |
| `format.ts` | Plain-text renderings; every capped list states its total |
| `adminGuard.ts` | `requireAdminForEveryTool` — the per-call admin check |
| `connect.ts` | One-click connector creation for `/connect/admin` |
| `../auth/admin.ts` | `isAdminEmail` — the one admin check, shared with the `/admin` page |
| `../usage/adminUsers.ts` | Users with their connections, shared with `/api/admin/users`; flags unreadable connections instead of reporting none |
