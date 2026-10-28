# Awesome MCP

Multi-service FastMCP hosting platform: one MCP server per provider under `src/<provider>/server.ts` — Google Docs, Sheets, Calendar, Drive, Gmail and Slides, ClickUp, Slack (bot + user), Outline, PeopleForce (v2/v3 and v4), HubSpot, Redmine, Browserbase, GitHub and Pinecone — plus a curl-able REST data plane under `/api/v1/*`.

## Tool Inventory

Do not keep tool counts here; they drift. The generated lists are the source of truth:

- `docs/MCP_TOOLS.md` — every MCP tool, grouped by service (`scripts/buildMcpToolsDoc.mjs`)
- `docs/REST_ENDPOINTS.md` — every REST endpoint, generated from `src/restCatalog.ts`

## Per-service notes

Service-specific rules and limitations live next to the code, in nested `CLAUDE.md` files that load only when you work in that directory:

- `src/browserbase/CLAUDE.md` — Browserbase
- `src/clickup/CLAUDE.md` — ClickUp
- `src/github/CLAUDE.md` — GitHub
- `src/google-calendar/CLAUDE.md` — Google Calendar
- `src/google-docs/CLAUDE.md` — Google Docs, including its parameter patterns and the tools that throw (`NOT_IMPLEMENTED`)
- `src/google-sheets/CLAUDE.md` — Google Sheets
- `src/hubspot/CLAUDE.md` — HubSpot
- `src/outline/CLAUDE.md` — Outline
- `src/peopleforce/CLAUDE.md` — PeopleForce (v2/v3) and the snapshot collector
- `src/peopleforce-v4/CLAUDE.md` — PeopleForce v4
- `src/pinecone/CLAUDE.md` — Pinecone
- `src/redmine/CLAUDE.md` — Redmine
- `src/slack/CLAUDE.md` — Slack shared code and the `slack-bot` server
- `src/slack-user/CLAUDE.md` — Slack user server and its access rules
- `src/website/CLAUDE.md` — dashboard sign-up/login, REST-plane handlers, body parsing

**Where new notes go:** a rule about one provider goes in that provider's `CLAUDE.md`; this file holds only what applies across services. Write the rule plus the one-clause reason it exists. The investigation story belongs in the commit message or PR; detailed reasoning belongs in a code comment next to the guard it protects. Verification status ("verified live", "UNVERIFIED", what to check first on a live run) stays in the note — it tells the next reader which assumption to suspect first.

## Cross-cutting rules

- **Never report a silent no-op as success.** Several upstreams answer 200 to a write they ignored. Where the response cannot prove the write happened, re-read, or report confirmation as three-valued (`true` / `false` / `null` = unconfirmed) rather than echoing the request.
- **A capped or partial result must say so** — scan extent, floor vs total, the next cursor. A bare "No X found" after a truncated scan reads as "X does not exist".
- **Refuse bad argument combinations in `execute`, not in Zod.** A Zod rejection surfaces as FastMCP's generic `InvalidParams`, which explains nothing; a `.refine()` also yields a `ZodEffects` with no `.shape`, which breaks the tests that walk tool schemas.
- **REST writes validate with the MCP tool's own exported Zod schema** (`safeParse` → 400 with `flatten()`), never hand-rolled `if (!field)` checks. Path params override same-named body keys. Where two surfaces compose fields differently, share a field object instead (guarded by `src/__tests__/restWriteSchemaSharing.test.ts`).
- **The permanent dashboard API key can call every REST write.** `createServiceAuth` accepts it alongside the 5-minute `mintRestBearerForCurl` bearer, and a curl has no confirmation step. Destructive endpoints ship only with explicit sign-off recorded in the catalog `notes` (`src/restCatalog.ts`). The catalog method union is `GET | POST`, so updates and deletes are POSTs to action paths.
- **`sendUpstreamError` (`src/website/restUpstreamError.ts`) maps only 404 and 403**, reading the status from `err.code`, `err.response.status` or `err.status`; everything else becomes a 500. A handler whose upstream signals a caller error (400, 422, 429) or keeps its status elsewhere must map it itself. Never echo an upstream 401 on the REST plane — there it would mean the caller's bearer is bad.
- **Every app factory that calls `registerRestApiRoutes` must call `registerRestBodyParsers` first**, or `req.body` is `undefined` and POSTs fail with misleading "Required" errors. Details in `src/website/CLAUDE.md`.
- **`src/google-docs/server.ts` is the application entry point.** It imports `createWebApp`, so `webServer.ts` must never import it; shared schemas and ops go in separate modules (the `writeSchemas.ts` / `writeOps.ts` pattern). It boots unless `NODE_TEST_CONTEXT` is set.
- **New OAuth scopes need already-connected users to reconnect** — a token keeps the scopes it was minted with. Never seed a scope string the provider does not define: an unknown scope fails the whole consent flow.
- **Hidden connectors seed `isActive` from `<NAME>_ENABLED`** — strict `=== 'true'`, so anything else (including unset) means `false`; flipping it is a restart, not a deploy. Seed rather than skip, so existing connections are not orphaned.
- **Reconnect merges keep any non-empty `providerTokens.accessRules`** (`PRESERVED_ON_RECONNECT`). To clear rules, delete the key — `{}` is non-empty and would survive every reconnect.
- **`sharedToolsRegistration.test.ts` strips whole-line `//` comments before block comments.** The order is load-bearing: a line comment ending in `/` + `*` would otherwise swallow the registration calls after it.

## Source Files (shared)

Per-provider files are listed in each provider's `CLAUDE.md`.

| File | Contains |
|------|----------|
| `src/types.ts` | Zod schemas, hex color validation, style parameter definitions |
| `src/restCatalog.ts` | Single source of truth for the REST plane (drives `docs/REST_ENDPOINTS.md` and the OpenAPI specs) |
| `src/util/mcpProxyClient.ts` | Streamable-HTTP MCP transport shared by Browserbase and Pinecone: per-call transport, SSE frames; a replica-affine session is never cached |
| `src/util/baseUrlGuard.ts` | `isPrivateHost` + `checkBaseUrl` — SSRF guard for the self-hosted connectors (Outline, Redmine) |
| `src/util/oauthTokenGrant.ts` | `postTokenGrant` — shared OAuth token-endpoint POST (HubSpot, Redmine) |
| `src/website/webServer.ts` | Express app, proxy routes, registration/OAuth pages, REST routes |
| `src/website/restUpstreamError.ts` | `sendUpstreamError` — the shared 404/403/500 mapper for REST handlers |
| `src/website/oauthServer.ts` | MCP OAuth 2.1 authorization server |
| `src/website/sessionStore.ts` | Session management (cookie/Redis) |

## See Also

- `README.md` — setup instructions and usage examples
