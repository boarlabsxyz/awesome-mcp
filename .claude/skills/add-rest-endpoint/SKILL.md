---
name: add-rest-endpoint
description: Add or wire a REST data-plane endpoint (GET or POST /api/v1/*) in this repo — the curl-able passthrough surface documented in docs/REST_ENDPOINTS.md. Adds the entry to src/restCatalog.ts (the single source of truth), registers the Express handler in src/website/webServer.ts with the right service auth middleware, adds the auth-gate test, and regenerates docs/REST_ENDPOINTS.md + public/openapi.json + docs/MCP_TOOLS.md. Use whenever the user wants to add, wire, expose, or promote a REST endpoint, give an MCP tool a curl/HTTP sibling, flip a `planned` catalog entry to `live`, ship the REST siblings for a service (outline, peopleforce, hubspot are catalogued but unwired), or expose a write/mutation tool over HTTP POST. Also use when invoked as `/add-rest-endpoint <mcpToolName> [service]`.
metadata:
  argument-hint: <mcpToolName|service> [service]
---

# Add REST Endpoint

The REST data plane exists so a shell-capable client can `curl | jq` bulk payloads without the bytes crossing the LLM context window. Endpoints are passthroughs for existing MCP tools.

**Reads (GET) are the default and the well-trodden path.** Writes (POST) are supported but gated — the catalog was GET-only by construction, so the first write endpoint requires a one-time widening of the types and tests. See [Write endpoints](#write-endpoints-post) before starting one.

Adding an endpoint touches six files, three of them generated. This SKILL.md is the procedure; `references/route-pattern.md` is the canonical handler shape; `references/write-endpoints.md` covers the write-specific rules.

## Inputs

- `<mcpToolName>` — the MCP tool getting a REST sibling (e.g. `getEmployee`), **or** a scope phrase ("wire all the hubspot endpoints"). A scope phrase expands to every `planned` catalog entry for that service.
- `[service]` — one of the `RestService` union values in `src/restCatalog.ts`: `docs`, `sheets`, `calendar`, `drive`, `gmail`, `slides`, `clickup`, `slack`, `outline`, `peopleforce`, `hubspot`. Infer from the tool's home server; ask only if genuinely ambiguous.

If neither is given, ask which service.

## Three jobs, tell them apart first

1. **Promote `planned` → `live`** — the catalog entry already exists (all of outline, peopleforce, hubspot today). Skip step 2 except to flip `status`; do steps 3–8. **Check `src/restCatalog.ts` first — this is the most common case.**
2. **New read endpoint** — no catalog entry. Do steps 1–8.
3. **New write endpoint** — do the [prerequisites](#write-endpoints-post) once, then steps 1–8 with the write variants called out inline.

## Procedure

### 1. Find the MCP tool and classify it

Grep `src/<provider>/server.ts` for `name: '<mcpToolName>'`. Note three things:

- **Its annotation.** `readOnlyHint: true` → GET. `readOnlyHint: false` → POST, and you're in the write path with its extra rules. `destructiveHint: true` → stop and read the destructive-ops section of `references/write-endpoints.md` before going further.
- **The upstream client call in its `execute`.** The REST handler makes the same call and returns raw upstream JSON instead of a formatted string.
- **Its Zod `parameters` schema.** For reads this tells you the query params. For writes this schema is **reused verbatim** to validate `req.body` — that's the mechanism that stops the REST and MCP surfaces from drifting.

### 2. Add or update the catalog entry in `src/restCatalog.ts`

One line, appended to the service's block. Field order is **not stylistic** — three build scripts parse this file with a regex that hardcodes it:

```ts
{ service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/employees/{employeeId}', summary: 'Get a single PeopleForce employee', mcpToolName: 'getEmployee', openapiOperationId: 'getPeopleForceEmployee', status: 'live' },
```

Hard rules (violations fail silently — the entry just vanishes from every generated doc):

- Exact field order: `service, method, path, summary, mcpToolName, openapiOperationId, status[, notes]`.
- Single quotes, one line per entry.
- **No apostrophes** in `summary` or `notes` — the parser matches `'([^']+)'` and an apostrophe truncates the field mid-string.
- `openapiOperationId` must be globally unique (`restCatalog.test.ts` enforces it). Prefix the service when the bare tool name collides: `getComment` → `getOutlineComment`, `listEmployees` → `listPeopleForceEmployees`.
- `path` uses `{braces}` for params (OpenAPI style), not Express `:colons`. Query templates go in the path string for documentation (`?q={query}`); the builders strip everything after `?` when emitting OpenAPI paths.
- `status: 'live'` only once the Express route exists — `planned` entries are excluded from `public/openapi.json` and from the REST column of `docs/MCP_TOOLS.md` precisely so the docs never advertise a 404.

If the service is new to the union, add it to `RestService`, to `SERVICE_SERVER_PATH` in `src/restCatalog.ts` (a total `Record<RestService, string>`, so this one is a *compile* error rather than silent drift), to `SERVICE_VALUES` in `src/sharedTools/listRestEndpoints.ts` (a service missing there is silently rejected by the `z.enum` — `restCatalog.test.ts` guards this drift), to `SERVICE_TITLE`/`SERVICE_ORDER` in `scripts/buildRestEndpointsDoc.mjs`, and to `SERVICES` in `scripts/buildMcpToolsDoc.mjs`.

The first time you flip any of a service's entries to `status: 'live'`, its MCP server must also register the two shared tools:

```ts
registerMintRestBearerForCurl(<service>Server);
registerListRestEndpoints(<service>Server);
```

`src/__tests__/sharedToolsRegistration.test.ts` enforces this and will fail the moment an entry goes live without them — a live REST surface that no MCP client can mint a bearer for, or discover, forces users onto the permanent dashboard API key instead of a 5-minute one.

### 3. Make sure the service has auth middleware — and a session branch

In `src/website/webServer.ts` (~line 2602):

```ts
const requireApiKey = createServiceAuth('google-docs', 'docs');
const requireClickUpApiKey = createServiceAuth('clickup', 'clickup');
const requireSlackApiKey = createServiceAuth('slack-bot', 'slack');
```

If your service has none, add one: `createServiceAuth('<mcpSlug>', '<fallbackSubstring>')`.

**The gotcha that will bite on outline/peopleforce/hubspot:** `createServiceAuth` builds the session with a provider switch. It handles `clickup`, `slack-bot`, `slack`, `outline` explicitly and sends **everything else** to `createUserSessionFromConnection`, the Google OAuth path. A HubSpot or PeopleForce connection routed there yields a session with no provider token, and the handler fails confusingly at call time rather than at auth time. `createHubSpotSession` and `createPeopleForceSession` already exist in `src/userSession.ts` — add the matching `else if (connection.provider === '<provider>')` branch before wiring the first route for that service.

### 4. Register the route in `src/website/webServer.ts`

Read `references/route-pattern.md` first. Then generate from:

- `assets/templates/google-route.ts.tmpl` — GET, googleapis clients off `req.userSession`.
- `assets/templates/third-party-route.ts.tmpl` — GET, a `new XClient(token)` imported dynamically.
- `assets/templates/write-route.ts.tmpl` — POST. Also read `references/write-endpoints.md`.

Placement rules:

- Group with the service's other routes; don't append at the bottom of a 5000-line file.
- **Static paths before parameterized ones.** `/api/v1/docs/recent` is registered before `/api/v1/docs/:documentId` or Express matches `recent` as a documentId. Same for any `/search`, `/trash`, `/archived` sibling.
- Express uses `:param`; the catalog uses `{param}`. Keep the param names identical so the docs and the code read the same.

### 5. Add the auth-gate test

In `src/__tests__/restRoutes.auth.test.ts`, push the concrete path (placeholder ids, plus any required query string) into `NEW_REST_ENDPOINTS`:

```ts
'/api/v1/peopleforce/employees/emp-123',
```

That array drives a cheap no-mocking test asserting 401 for a missing header and 401 for an unknown bearer. It is the only thing between a typo'd route path and a silent 404 in production, so never skip it.

**The loop is GET-only** (`request(app).get(path)`). A POST endpoint needs the sibling array and loop described in `references/write-endpoints.md` — adding a POST path to `NEW_REST_ENDPOINTS` tests a route that doesn't exist and passes for the wrong reason (Express 404s unmatched methods, and the test only asserts 401… which it won't get, so it fails confusingly).

### 6. Regenerate the three derived artifacts

All three are marked "Do not edit by hand" and all three read `src/restCatalog.ts`:

```bash
node scripts/buildRestEndpointsDoc.mjs   # docs/REST_ENDPOINTS.md
node scripts/buildRootOpenapi.mjs        # public/openapi.json (skips `planned`)
node scripts/buildMcpToolsDoc.mjs        # docs/MCP_TOOLS.md — its REST column
```

No npm scripts wrap these; run them directly. `buildRootOpenapi.mjs` merges `public/openapi-*.json` and then stub-fills any `live` catalog entry no per-service spec covers, so a new endpoint gets a usable (if schema-less) OpenAPI entry for free. **The stub has no `requestBody`** — for POST endpoints it advertises a body-less operation, which is worse than useless to a client. Write endpoints should get a real per-service spec entry via `/update-openapi <provider>` in the same change, not later.

### 7. Verify

```bash
npm run typecheck
npm test
```

Then eyeball the diff of `docs/REST_ENDPOINTS.md` — if your endpoint isn't in it, the catalog line broke the parser regex (step 2), which is the single most common failure here.

### 8. Report

```
Added <mcpToolName> → <METHOD> <path>

  src/restCatalog.ts                     entry (status: live)
  src/website/webServer.ts               handler + <requireXApiKey>
  src/__tests__/restRoutes.auth.test.ts  auth-gate path
  docs/REST_ENDPOINTS.md                 regenerated (N endpoints)
  public/openapi.json                    regenerated
  docs/MCP_TOOLS.md                      regenerated

Typecheck: <pass | N errors>
Tests: <pass | N failing>

Next:
  /update-openapi <provider>   ← required for POST (the stub has no requestBody)
```

## Write endpoints (POST)

Writes are legitimate but they are **not** the reason the data plane exists. The read rationale — keep large responses off the LLM context — doesn't transfer, because a write's *response* is small. So apply the gate before writing any code.

### Is this write worth a REST sibling?

Ship it when at least one holds:

- **The request body is large.** Appending 5,000 spreadsheet rows, importing a long document body, batch operations. Sending that through the tool-result channel is exactly the waste the data plane was built to avoid — the direction is just reversed.
- **It belongs in a shell pipeline.** `curl … | jq … | curl -X POST …` where forcing a hop through the LLM to perform the write is pure overhead.

Push back when neither holds. A one-field update is cheaper and safer as an MCP tool call: Zod validation, the `destructiveHint` annotation the e2e readonly connector keys off, and no new auth surface. Say so plainly rather than mirroring all 40 write tools by reflex.

### One-time prerequisites (first POST endpoint only)

The catalog is GET-only by construction today. Before the first write endpoint, make these four changes in one commit:

1. **`src/restCatalog.ts`** — widen the interface: `method: 'GET' | 'POST';`. Update the header comment, which currently states writes stay MCP-only, to describe the new gate instead of contradicting it.
2. **`src/__tests__/restCatalog.test.ts`** — relax `assert.equal(e.method, 'GET')` to `assert.ok(['GET', 'POST'].includes(e.method), …)`. Don't delete the assertion; it's what keeps `PATCH`/`DELETE` out until someone decides deliberately.
3. **`src/__tests__/restRoutes.auth.test.ts`** — add the `NEW_REST_WRITE_ENDPOINTS` array and its POST loop (shape in `references/write-endpoints.md`).
4. **`src/sharedTools/listRestEndpoints.ts`** — the tool description tells the LLM these endpoints exist to "fetch bulk responses straight to disk". Once writes are listed, that framing is wrong; update it to cover both directions.

The three build scripts need no change — their regexes capture `method` generically and `buildRootOpenapi.mjs` already lowercases it into the OpenAPI object.

Scope stays `'GET' | 'POST'`. `PATCH`/`DELETE` are a separate decision; the legacy `PATCH`/`DELETE` routes in `webServer.ts` are ChatGPT Custom Actions compat and are not catalogued.

### Per-endpoint write rules

Full detail in `references/write-endpoints.md`. The load-bearing ones:

- **Validate `req.body` with the MCP tool's own Zod schema** via `safeParse`, returning 400 with the flattened issues. The legacy POST routes hand-roll `if (!summary) …` checks — do not copy that; it's the drift the schema reuse exists to prevent.
- **201 for create, 200 for update.** Return the created/updated resource, not just an id.
- **Never expose a `destructiveHint: true` tool** without explicit user sign-off in the conversation, recorded in the catalog `notes`.
- **Flag the auth widening.** `createServiceAuth` accepts the permanent dashboard API key alongside the 5-minute bearer. A key that could only read yesterday can mutate once you ship a write endpoint. State that consequence when proposing the first one.

## Batch mode (scope phrase)

For "wire the hubspot endpoints": step 3 once (middleware + session branch — the expensive, easy-to-miss part), then steps 4–5 per endpoint, then steps 6–7 once. Flip each `status` to `live` only as its route lands, so a partial batch never advertises endpoints that 404.

Prefer wiring a whole service in one pass — the session-branch work dominates, and the auth test grows by one line per route.

## Failure modes

- **Catalog line doesn't match the parser regex** — endpoint silently missing from all three generated docs. Symptom: `npm test` passes, `docs/REST_ENDPOINTS.md` diff is empty. Cause: reordered fields, double quotes, a line break, or an apostrophe in `summary`.
- **Duplicate `openapiOperationId`** — `restCatalog.test.ts` fails loudly. Prefix with the service.
- **`status: 'live'` with no route** — the docs promise an endpoint that 404s. Only flip after the handler exists.
- **Parameterized route shadows a static sibling** — `/docs/recent` 404s or returns garbage because `:documentId` matched first. Order the `app.get` calls, not the catalog rows.
- **Non-Google provider with no session branch** — 401 passes, then the handler throws on an undefined token. See step 3.
- **POST path added to the GET-only auth-test array** — fails for a reason that has nothing to do with the bug it looks like. Use the write array.
- **POST endpoint shipped with only the OpenAPI stub** — clients see an operation with no `requestBody` and can't call it. Chain `/update-openapi`.
- **A write endpoint proposed with no size or pipeline justification** — apply the gate above and recommend the MCP tool instead. Mirroring every write tool doubles the mutation surface for no gain.

## File layout

```
add-rest-endpoint/
├── SKILL.md
├── references/
│   ├── route-pattern.md          ← canonical Express handler shape + helpers
│   └── write-endpoints.md        ← POST rules: Zod body validation, status codes, auth surface
└── assets/
    └── templates/
        ├── google-route.ts.tmpl
        ├── third-party-route.ts.tmpl
        └── write-route.ts.tmpl
```

## Relationship to other skills

- **`add-mcp-tool`** creates the MCP tool — the prerequisite for an endpoint here. Its step 9 offers `/update-openapi` but not this skill, because most tools never need a REST sibling; only bulk reads and large-body writes do.
- **`update-openapi`** upgrades the auto-generated stub into a spec with real request/response schemas. Optional for GET, **required for POST**.
- **`add-e2e-test`** covers MCP tools through a live client, not REST routes. The REST equivalent is the auth-gate array in step 5.
