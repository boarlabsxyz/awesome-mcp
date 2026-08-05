---
name: add-mcp-server
description: Scaffold and wire a brand-new MCP server into this google-docs-mcp hosting platform. Creates the server file, registers it in scopeMap + dispatch router + UserSession + catalog, and optionally clones a reference GitHub MCP repo and ports its tools into this codebase's FastMCP + Zod + UserSession pattern. Use this skill whenever the user mentions adding, creating, or wiring up a new MCP server, integration, or provider in this repo — even when phrased indirectly ("plug in Notion", "expose a new service", "stand up a server for X"). Also use when invoked as `/add-mcp-server <slug> [github-url]`.
metadata:
  argument-hint: <slug> [github-url]
---

# Add MCP Server

Scaffolds a new MCP server end-to-end: server file, registration, catalog, docs, optional adaptation of tools from a reference repo.

This repo is a multi-MCP hosting platform — each MCP runs as its own process selected by `MCP_SLUG`, dispatched by a router inside `src/google-docs/server.ts`. Adding a server is mechanical but touches several files; the value of this skill is hitting all of them and getting the cross-file invariants right.

## Inputs

- `<slug>` (required): kebab-case identifier, e.g. `notion`, `linear`, `google-photos`.
- `[github-url]` (optional): a reference MCP repo whose tools should be ported.

If `<slug>` is missing, ask. Reject slugs that don't match `^[a-z][a-z0-9-]*$` — the slug is used as a directory name, a route segment, a scope key, and a catalog primary key, and stray characters break all of those.

## Procedure

### 1. Check uniqueness

A duplicate slug silently overwrites catalog entries and clobbers the dispatch router, so abort early:

- Grep `src/auth/scopeMap.ts` for the slug.
- Read `data/mcp-catalog.json` and look for the slug.
- Check `src/<slug>/` does not exist.

Stop with a clear message if any of these hit.

### 2. Gather metadata

Use a single AskUserQuestion call to collect:

- **Provider type**: Google API or third-party. This drives whether you generate `apiHelpers.ts` and how `UserSession` gets extended.
- **Display name** (e.g. `"Notion MCP Server"`).
- **Description** — one line, used in the catalog.
- **Route path** — defaults to slug, e.g. `notion` becomes `/notion` and `/notion-sse`.

For third-party, also ask:
- **Auth method** — **prefer OAuth 2.0 by default when the provider supports it** ("Connect with X"), falling back to paste-token only when the provider has no OAuth app model (e.g. Slack bot tokens) or the user explicitly wants it. OAuth is the better UX (one-click connect, no manual key handling) and the platform already has the machinery (Slack/ClickUp/Outline/HubSpot). It costs more wiring — a token-exchange + refresh module and a `/connect/<slug>/callback` branch (step 5g) — and requires the user to register an app in the provider's developer console. Paste-token is simpler but asks each user to create and paste a key. Recommend OAuth; let the user opt down to paste-token.
- **Session token field** — name of the field on `UserSession` that holds the token. Default: `<camelCaseSlug>AccessToken`.
- **OAuth authorize / token URLs** — for OAuth providers, the provider's authorize + token endpoints (stored in the catalog). For HubSpot: `https://app.hubspot.com/oauth/authorize` + `https://api.hubapi.com/oauth/v1/token`.

For Google, ask:
- **Which `session.google<X>` client to reuse**, OR a new API + version (e.g. `photos/v1`). If a new client is needed, the skill must also extend `UserSession` and instantiate the client in the three factory functions in `src/userSession.ts`.

Icon URL is optional; default `null`.

### 3. (Optional) Clone and analyze the reference repo

If a github-url was given:

1. Shallow clone: `git clone --depth 1 <url> /tmp/mcp-source-<slug>`.
2. Capture commit sha (`git -C /tmp/mcp-source-<slug> rev-parse HEAD`) for attribution.
3. Detect language: `package.json` → TypeScript; `pyproject.toml` or `requirements.txt` → Python; else stop adaptation and tell the user.
4. Read `references/translation.md` for tool discovery patterns and schema/auth/error translation tables.
5. Port every discovered tool. Don't ask per-tool — the user picked "all".
6. Delete the temp clone after the scaffold is written.

Every ported tool gets a one-line attribution comment: `// Adapted from <url>@<sha> <relative-path>:<line>`. This is the only way to audit ports later, so don't skip it.

When a source body is non-trivial, prefer a TODO stub over an approximate translation. Silent approximations are the worst-case outcome: the tool compiles, looks ported, and is wrong. The TODO template (`assets/ported-tool-todo.ts.tmpl`) pastes the original body inside a block comment so the user can finish it deliberately.

### 4. Generate the server files

Templates live in `assets/` so they can be edited without touching SKILL.md. Substitute the placeholders (`{{slug}}`, `{{slugCamel}}`, `{{displayName}}`, etc.) and write:

- `src/<slug>/server.ts` — from `assets/server-google.ts.tmpl` or `assets/server-third-party.ts.tmpl`.
- `src/<slug>/apiHelpers.ts` — from `assets/apiHelpers.ts.tmpl` (third-party only).
- `src/__tests__/<slug>.test.ts` — from `assets/test-stub.ts.tmpl`.

If tools were ported in step 3, replace the placeholder `ping` tool with the ported ones. Otherwise the `ping` tool stays as a working starting point.

The `ping` tool in both server templates is intentionally minimal; for the canonical shape of real tools (Zod conventions, `UserError` mapping, `log.info` breadcrumb, response formatting), see `../add-mcp-tool/references/tool-pattern.md`. Both skills point at the same document so the tool shape stays consistent across the codebase.

### 5. Wire registration

This is the part future contributors are most likely to miss, so do it in this order:

**a. `src/auth/scopeMap.ts`** — add an entry to both `ROUTE_SCOPE_MAP` (route → scope) and `SLUG_SCOPE_MAP` (slug → scope). The scope value is `mcp:<slug>` — except for slugs prefixed `google-`, where the convention is to drop the prefix (`google-sheets` → `mcp:sheets`). Match the existing entries.

Then update `src/__tests__/auth/scopeMap.test.ts` — the "should contain all N scopes" test hard-codes `ALL_SCOPES.length` and enumerates every scope by name. Bump the count in both the `it(...)` title and the assertion, add `assert.ok(ALL_SCOPES.includes('mcp:<slug>'))`, and add `assert.deepEqual(getScopesForSlug('<slug>'), ['mcp:<slug>'])` to the known-slugs test. Miss this and CI stays red — the typecheck won't catch it.

**b. `src/google-docs/server.ts`** — two runtime modes to wire. The mcp-only dispatch is critical; the combined mode is only needed if that deployment mode is in use.

**mcp-only mode** (`MCP_MODE=mcp`, one MCP per service): find the dispatch ternary around line 1852. Two edits:
- Add `import { <slugCamel>Server } from '../<slug>/server.js';` near the other server imports at the top.
- Add a branch to the ternary: `: MCP_SLUG === "<slug>" ? <slugCamel>Server`.

Without this, the new server compiles but never runs — the symptom is the wrong MCP responding on the route.

**web+mcp combined mode** (all MCPs in one process, ~line 1934+): NOT wired by default. If the user runs the combined mode, they also need an `<SLUG>_MCP_PORT` constant, an `<slugCamel>Server.start({ ... port: <SLUG>_MCP_PORT ... })` block, an extended `createWebApp(...)` signature that accepts the new port, and a matching proxy route in `src/website/webServer.ts`. Ask the user whether they want the combined mode wired now; if not, flag it as a manual follow-up in step 9 so `/<slug>` doesn't silently 404 later.

**c. `src/userSession.ts`** — third-party only:
- Add the token field to the `UserSession` interface (group with the existing third-party fields).
- Default the field to `undefined` in the three session factory functions. The factories appear in roughly three places — look for blocks already initializing `clickUpAccessToken` or `slackBotToken` and mirror them.

If the user picked a new Google API, also add the client field to `UserSession`, instantiate it via `google.<api>({ version: '<v>', auth: oauthClient })` in the two real-session factories, and null-default it in the third-party-only factory.

Then wire the session **router** in `src/mcpAuthenticate.ts` — a factory that nothing dispatches to is dead code, and the pasted token never reaches the tools. Add the factory to the `AuthDeps` interface and to `defaultDeps`, then add a branch in `sessionFromConnection`: `if (connection.provider === '<slug>') return deps.create<X>Session(user, connection);` (mirror the `outline` / `peopleforce` branches). Two tests build a mock `AuthDeps` — `src/__tests__/mcpAuthenticate.test.ts` and `src/__tests__/clickup/auth.test.ts` — and will fail typecheck until the new factory is added to each mock. We hit exactly this gap with HubSpot: catalog + session field wired, but the token never flowed because the router branch was missing.

**d. `src/mcpCatalogStore.ts` — `seedDefaultCatalogs()`** — this is the *authoritative* seed. It runs on every boot against whatever backend is active (Postgres in dev/prod, JSON file locally when `DATABASE_URL` is unset) and `INSERT … ON CONFLICT DO UPDATE`s the row for each slug. **A new server that skips this step will silently vanish from `/api/v1/catalogs` and the dashboard on every fresh environment**, even after the code, scopeMap, dispatch router, and session token field are all wired correctly — we hit exactly that in #63/#68 with the Outline connector.

Add a `createMcpCatalog({...})` block alongside the existing providers at the bottom of `seedDefaultCatalogs()`. Use an env-configurable URL following the pattern of the other in-process connectors:

```ts
const <slugCamel>McpUrl = normalizeUrl(process.env.<SLUG_UPPER>_MCP_URL, '/<route>');

await createMcpCatalog({
  slug: '<slug>',
  name: '<display-name>',
  description: '<description>',
  iconUrl: <'url' or null>,
  mcpUrl: <slugCamel>McpUrl,
  provider: '<slug>',                       // third-party only
  scopes: [<google-api-scope-urls>],        // Google only, [] for third-party
  googleClientId: <slugCamel>ClientId,      // env-derived, null for third-party without OAuth proxy
  googleClientSecret: <slugCamel>ClientSecret,
  oauthAuthorizationUrl: '<url or empty>',  // third-party only
  oauthTokenUrl: '<url or empty>',          // third-party only
  oauthScopes: [...],                       // Google: userinfo + api scopes; third-party: provider scopes or []
  isLocal: !process.env.<SLUG_UPPER>_MCP_URL,
  isActive: true,
});
```

For third-party connectors whose OAuth is brokered out-of-band (e.g. Outline via Auth0), `oauthAuthorizationUrl` and `oauthTokenUrl` stay empty strings — the connect flow doesn't consult them. That's fine, but call it out in the report so the user knows why those fields look sparse.

**e. `data/mcp-catalog.json`** — append a matching entry for local-file-backend usage. Compute the next id by reading the file (`max(id) + 1`). Both timestamps use `new Date().toISOString()`. Use the shapes below.

Note: `data/mcp-catalog.json` is gitignored — this edit is local-only and will NOT show up in the PR. It's the fallback backend for `DATABASE_URL`-less local dev; `seedDefaultCatalogs()` (step 5d) is what actually lands the row in every real environment. Mention both edits in the final report so the user isn't confused about why the JSON change isn't in the diff.

Google entry:
```json
{
  "id": <next-id>,
  "slug": "<slug>",
  "name": "<display-name>",
  "description": "<description>",
  "iconUrl": null,
  "mcpUrl": "/<route>",
  "scopes": ["<google-api-scope-url>"],
  "googleClientId": null,
  "googleClientSecret": null,
  "oauthScopes": [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "<google-api-scope-url>"
  ],
  "isLocal": true,
  "isActive": true,
  "createdAt": "<iso>",
  "updatedAt": "<iso>"
}
```

Third-party entry — same shape plus `provider`, `oauthAuthorizationUrl`, `oauthTokenUrl`, and empty `oauthScopes`:
```json
{
  ...common fields...,
  "scopes": [],
  "oauthScopes": [],
  "provider": "<slug>",
  "oauthAuthorizationUrl": "<authorize-url-or-empty>",
  "oauthTokenUrl": "<token-url-or-empty>"
}
```

**f. Paste-token connect flow (third-party paste-token providers only)** — three edits let a user actually *connect* from the dashboard. Skip for Google and OAuth-proxy providers. All three are easy to forget because the scaffold compiles and the catalog looks complete without them.

- **`src/<slug>/connectToken.ts`** — export `validate<X>Token` and `build<X>InstanceName`. Do NOT hand-roll the fetch / timeout / redirect-guard / status-mapping — delegate to `src/util/pasteTokenValidation.ts` (`validatePasteToken` + `buildSimpleInstanceName`), passing the provider's validation URL, headers, base-URL resolver, and message labels. Mirror `src/peopleforce/connectToken.ts`. Hand-rolling it instead duplicates ~130 lines and trips the SonarCloud duplication gate. Add a unit test mirroring `src/__tests__/peopleforce/connectToken.test.ts`.
- **`src/website/webServer.ts`** — in the `/api/connect-token` handler, add an `if (mcpSlug === '<slug>')` branch that calls the shared `connectPasteToken('<slug>', '<ServiceName>', () => validate<X>Token({ token }))` helper (peopleforce + hubspot already share it).
- **`public/dashboard.html`** — the step most often missed; its symptom is the runtime error `"<slug> uses direct token authentication. Please connect via the dashboard."` the instant the user clicks Connect. In `selectMcpType`, add the provider to the `isTokenProvider` allowlist; add a `provider === '<slug>'` block that sets the token label / placeholder / hint (and hides the URL field); add the provider to the `autoName` set in `connectWithToken` (so it uses `build<X>InstanceName`'s fallback); and add its empty-token validation message. Without this, Connect routes to the OAuth `/connect/<slug>` flow, which 400s for paste-token providers. `public/` is baked into the image at build (`cp -r public dist/public`), so the **web** service must be redeployed for the change to take effect.

**g. OAuth 2.0 connect flow (third-party OAuth providers)** — the preferred path (step 2). Model it on Outline/HubSpot (`src/hubspot/oauthCallback.ts` is the cleanest worked example).

- **`src/<slug>/oauthCallback.ts`** (new) — export `exchange<X>OauthCode` (authorization_code → tokens) and `refresh<X>Token` (refresh_token grant), plus a best-effort user/account lookup for naming the instance. Factor the token-POST fetch/error mapping into small helpers so it does NOT clone `outline/oauthCallback.ts` (the CPD gate flags a ~25-line copy otherwise). Add a unit test mirroring `src/__tests__/hubspot/oauthCallback.test.ts`.
- **`src/userSession.ts`** — add OAuth session fields (`<slug>RefreshToken`, `<slug>TokenExpiry`, `<slug>OauthClientId`, `<slug>OauthClientSecret`, `<slug>InstanceId`) and populate them in `create<X>Session` from `providerTokens` + the client-cred env vars. No-op for any paste-token connection (no refresh token/expiry).
- **`src/<slug>/apiHelpers.ts`** — add `maybeRefresh<X>Token` / `perform<X>Refresh` (single-flight guard) and call `await maybeRefresh<X>Token(session, log)` at the top of `with<X>Client`. Access tokens that expire (HubSpot ≈ 30 min) are refreshed at tool-call time, the cached session is mutated in place, and the rotated tokens are persisted via `updateMcpInstanceProviderTokens`.
- **`src/website/webServer.ts`** — the generic authorize redirect in `/connect/:mcpSlug` already covers OAuth 2.0 (`response_type=code` + space-joined `scope`); you only add an `else if (provider === '<slug>')` branch in the `/connect/:mcpSlug/callback` handler that calls `exchange<X>OauthCode`, builds `providerTokens` = `{ access_token, refresh_token, expiry_date }`, names the instance, and `createMcpInstance(...)`.
- **`src/mcpCatalogStore.ts` — `seedDefaultCatalogs()`** — set `oauthAuthorizationUrl` / `oauthTokenUrl` / `oauthScopes` and `googleClientId`/`googleClientSecret` (from `<SLUG_UPPER>_CLIENT_ID` / `_CLIENT_SECRET`). Two flavors: **env-gated** (Outline) sets the OAuth URLs only when the creds are present, so an unconfigured deploy falls back to paste-token; **OAuth-by-default** (HubSpot) sets the URLs unconditionally so the dashboard always shows "Connect with X" — but then the connect button breaks if the creds are unset, so only do this when the user wants OAuth-only. The **dashboard needs no change** for OAuth — `isTokenProvider` is false whenever `oauthAuthorizationUrl` is set, so it shows the Connect button automatically.

### 6. Wire the REST catalog and doc generators

The two markdown docs under `docs/` are generated. Both need the new service registered before regeneration.

**a. `src/restCatalog.ts`** — add the slug to the `RestService` union type. Then append entries for every *read-only* tool (annotations `readOnlyHint: true`). Mark each `status: 'planned'` unless you're also wiring the actual `/api/v1/<slug>/*` routes in `src/website/webServer.ts` right now (usually you aren't — that's a follow-up). `openapiOperationId` values must be unique globally, so prefix common names with the service (`getComment` → `getOutlineComment`).

Then add the slug to the `SERVICE_VALUES` array in **`src/sharedTools/listRestEndpoints.ts`** — it's a *separate* `z.enum` from the `RestService` union, and a slug missing there is silently rejected when a client calls `listRestEndpoints({ service: '<slug>' })`, even though the catalog has entries. `src/__tests__/restCatalog.test.ts` guards this (it asserts every in-catalog service validates), so a miss shows up as a test failure, not just a typecheck error.

**b. `scripts/buildMcpToolsDoc.mjs`** — append a row to the `SERVICES` array: `['src/<slug>/server.ts', '<Display Name>', '<slug>']` (or `null` as the third field if this server has no REST siblings at all).

**c. `scripts/buildRestEndpointsDoc.mjs`** — add the slug to `SERVICE_TITLE` and append it to `SERVICE_ORDER`. Skip this if there are no REST entries in step 6a.

**d. Regenerate.** Run:
```
node scripts/buildMcpToolsDoc.mjs
node scripts/buildRestEndpointsDoc.mjs
```
Both are idempotent. `docs/MCP_TOOLS.md` and `docs/REST_ENDPOINTS.md` update in place. The MCP_TOOLS.md REST column intentionally shows `—` for `planned` entries — the cross-ref only fires once you flip status to `live`.

### 7. Update `CLAUDE.md` (lightly)

`CLAUDE.md` is manually maintained and its "N tools" header is usually stale relative to auto-generated `docs/MCP_TOOLS.md` — don't waste effort keeping the exact count in sync. What's worth adding:

- A row in the Source Files table pointing at `src/<slug>/server.ts` (and `apiHelpers.ts` for third-party).
- If the source repo flagged any tools as unimplemented or had known limitations, surface them under Known Limitations so the user doesn't get bitten later.

Skip the Tool Categories row and the tool-count bump — `docs/MCP_TOOLS.md` is authoritative for both.

### 8. Verify

Run both:
```
npm run typecheck
npm test
```

Two failure modes get caught here that the typechecker won't:
- The scopeMap unit test (`src/__tests__/auth/scopeMap.test.ts`) hard-codes `ALL_SCOPES.length`. If step 5a's test edit was missed, this fails with `expected 9, actual 10` (or similar). Fix by bumping the count and adding the new-slug assertions.
- The doc generators can silently produce a table without the new service if the SERVICES/SERVICE_ORDER entries are missing. Spot-check `docs/MCP_TOOLS.md` for the new section.

Don't reach for `as any` or `// @ts-ignore` if typecheck fails — the typechecker is catching the kind of cross-file slip this skill exists to prevent.

### 9. Report and offer the next step

End with a tight summary:
- Files created and patched (one bullet each, with path).
- Number of tools generated, split into fully translated vs TODO-stubbed.
- Source repo + commit sha if used.
- Anything the user still has to do manually. The common list:
  - Set env vars (base URL, API key defaults) if the server reads any.
  - Add OAuth scopes / register the app in the provider console.
  - Wire a new route in `webServer.ts` if a new Google API was introduced.
  - Wire web+mcp combined mode (port constant, `.start()` call, `createWebApp` signature, proxy route) if skipped in step 5b.
  - Wire the planned REST routes in `webServer.ts` and flip `status: 'planned'` → `'live'` in `src/restCatalog.ts`, then re-run the doc generators.
  - Set the `<SLUG_UPPER>_MCP_URL` env var in each Railway service that runs the combined web app (dev/prod). Without it the catalog seeds `isLocal: true` and the mcpUrl defaults to the relative `/<route>`, which works only in single-service `MCP_MODE=all` deployments.
  - For a per-service (`MCP_MODE=mcp`) deploy, the new service needs `TRANSPORT=httpStream`, `MCP_MODE=mcp`, and `MCP_SLUG=<slug>` (match a working sibling). A `TRANSPORT` typo silently falls back to stdio and fails the healthcheck — see failure modes.
  - For a paste-token provider, redeploy the **web** service after step 5f so the updated `public/dashboard.html` ships (it's baked into the image at build).
  - `data/mcp-catalog.json` was edited locally but is gitignored — the PR contains the `seedDefaultCatalogs()` edit, which is what actually seeds dev/prod. Both are correct; just mention them so the user isn't surprised.

Then offer the soft chain:

> The server is scaffolded with a `ping` tool. Want me to add real tools now? Tell me the tool names and I'll invoke `/add-mcp-tool <name>` for each, using the same patterns.

If the user lists tools, follow `../add-mcp-tool/SKILL.md` for each one in turn — its procedure handles the addTool block, tools.ts classification, CLAUDE.md bump, and the optional e2e test chain. If the user says no, just mention they can run `/add-mcp-tool <name>` later.

This is a soft chain (suggestion, not auto-execution) because the user often wants to review the scaffold, run typecheck, and look at the diff before adding tools — not be rushed into more decisions while their attention is still on the server wiring.

Finally, delete `/tmp/mcp-source-<slug>` if it exists.

## Failure modes

Each of these is here because we've seen the failure mode in the wild or it produces a subtle broken state that the user won't notice immediately.

- **Source repo private or 404** — tell the user, ask for a different URL, don't proceed. Tools you invented from imagination are worse than no tools.
- **Source language unsupported** — only TS and Python are covered. Ask whether to scaffold without adaptation.
- **Slug already exists** — abort before any writes. Overwriting a working server is far worse than asking the user to pick another name.
- **Typecheck fails after scaffolding** — surface errors. Don't delete the new files; the user will likely fix them in place.
- **Tool name collisions between ported tools** — rename the second occurrence with a numeric suffix and flag in the report. Two tools with the same name silently shadow each other.
- **More than ~30 tools in the source** — confirm with the user before generating. This is a big diff and worth pausing for.
- **`scopeMap.test.ts` hard-codes the scope count** — `assert.equal(ALL_SCOPES.length, N)`. Adding a scope makes it `N+1` and CI turns red on `npm test`. Typecheck passes; only the test suite catches this. Always update the test in step 5a alongside `scopeMap.ts`.
- **`data/mcp-catalog.json` is gitignored** — the catalog edit is local-only. Don't be surprised when it's absent from the PR diff. Prod catalog is seeded through a separate path — call this out in the final report.
- **Web+mcp combined mode wiring is separate** — the dispatch ternary in `MCP_MODE=mcp` covers per-service deployment; the combined mode has its own port constants, `.start()` calls, `createWebApp` signature, and proxy routes in `webServer.ts`. If the user runs the combined mode and you only wired the ternary, `/<slug>` silently 404s.
- **REST catalog entries default to `planned`** — until the actual `/api/v1/<slug>/*` routes are wired in `webServer.ts`, marking anything `live` is a lie. The doc generator honors the status: `planned` entries show `—` in `docs/MCP_TOOLS.md`'s REST column, which is correct behavior.
- **`CLAUDE.md` tool count drifts** — it's manually maintained. Don't try to keep it exact; `docs/MCP_TOOLS.md` is authoritative and auto-regenerates.
- **Dashboard paste-token form is a separate allowlist** — `public/dashboard.html`'s `selectMcpType` hardcodes which providers show the token-input form (step 5f). A paste-token provider missing there routes to the OAuth `/connect/<slug>` flow, which 400s with `"<slug> uses direct token authentication. Please connect via the dashboard."` The catalog, session router, and `/api/connect-token` branch can all be correct and the user still can't connect. Symptom is a *runtime* error in the browser, not a build/test failure — the scaffold looks done.
- **`TRANSPORT` typo bricks a per-service deploy** — the boot only treats `httpStream` / `http` / `remote` as multi-user HTTP mode (`src/google-docs/server.ts`); any other value (a stray `httpsStream`) silently falls back to stdio, which calls `initializeGoogleClient()` and hard-exits when Google creds are absent — so `/health` never binds and the healthcheck fails. If a newly-created per-service MCP fails its healthcheck, check `TRANSPORT=httpStream`, `MCP_MODE=mcp`, `MCP_SLUG=<slug>` on that Railway service before suspecting the scaffold.
- **OAuth client creds must be on BOTH services** — the web service uses `<SLUG_UPPER>_CLIENT_ID`/`_CLIENT_SECRET` for the catalog seed + `/connect/<slug>` exchange; the MCP service uses the same vars for the tool-call-time refresh. Set them only on the web service and connect succeeds but tools 401 once the access token expires. With **OAuth-by-default** catalogs (unconditional `oauthAuthorizationUrl`), missing creds are worse — the Connect button redirects with an invalid client and there is no paste-token fallback in the UI. Prefer the env-gated catalog unless the user explicitly wants OAuth-only.

## OAuth 2.0 provider setup — HubSpot worked example

After the code is wired (step 5g), the user must register an app in the provider's developer console and set the client credentials. Hand them these HubSpot steps (adapt the URLs/scopes for other providers):

1. **Create a HubSpot app** — go to a HubSpot **developer account** (`developers.hubspot.com` → *Apps → Create app*). This is separate from a normal HubSpot account/portal.
2. **Set the redirect URL** — in the app's *Auth* tab, add **`<BASE_URL>/connect/hubspot/callback`** exactly (the web-service domain, e.g. `https://your-web-service.up.railway.app/connect/hubspot/callback`). HubSpot requires an exact match; a trailing-slash or host mismatch fails the callback.
3. **Select scopes** — the app's scopes must be a **superset** of the catalog's `oauthScopes`: `crm.objects.contacts.read`/`.write`, `crm.objects.companies.read`/`.write`, `crm.schemas.contacts.read`/`.write`, `crm.schemas.companies.read`/`.write`, `tickets`, `conversations.read`. If the authorize request asks for a scope the app doesn't have, HubSpot shows an error page instead of the consent screen.
4. **Copy the Client ID + Client Secret** from the app's Auth tab.
5. **Set env vars on BOTH services** — `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET` on the **web** service (drives the catalog seed + the `/connect/hubspot` exchange) **and** the **hubspot MCP** service (drives the tool-call-time token refresh in `createHubSpotSession` / `withHubSpotClient`). Miss the MCP service and connect works but tools 401 after the first ~30 minutes.
6. **Redeploy both**, then the dashboard shows **"Connect with HubSpot"**. Access tokens expire (~30 min) and refresh automatically; the refresh token is long-lived and does not rotate.

Verify end-to-end with a real connect **and** a tool call made >30 min later (or with a deliberately short expiry) to exercise the refresh path — mocked-`fetch` unit tests can't prove the live refresh works.

## Conventions reference

| Input | Form |
|-------|------|
| slug | `notion`, `google-photos` |
| camelCase export | `notionServer`, `googlePhotosServer` |
| display name (default) | `<Title Case> MCP Server` |
| route | same as slug unless user overrides |
| scope | `mcp:<slug>` (Google prefix stripped: `google-sheets` → `mcp:sheets`) |

## File layout

```
add-mcp-server/
├── SKILL.md
├── assets/
│   ├── server-google.ts.tmpl
│   ├── server-third-party.ts.tmpl
│   ├── apiHelpers.ts.tmpl
│   ├── test-stub.ts.tmpl
│   └── ported-tool-todo.ts.tmpl
└── references/
    └── translation.md     ← read only when porting from a github-url
```

## Relationship to other skills

- **`add-mcp-tool`** owns the canonical tool shape (`references/tool-pattern.md` over there). This skill's `ping` example deliberately stays minimal — for real tools, the user follows up with `/add-mcp-tool <name>` (offered as a soft chain in step 8).
- **`add-e2e-test`** scaffolds smoke tests. Not chained from here directly — the chain goes via `/add-mcp-tool`, which offers it for the tool the user just added.
