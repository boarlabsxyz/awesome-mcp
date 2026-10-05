---
name: add-rest-endpoint
description: Add or wire a REST data-plane endpoint (GET or POST /api/v1/*) in this repo — the curl-able passthrough surface documented in docs/REST_ENDPOINTS.md. Adds the entry to src/restCatalog.ts (the single source of truth), registers the Express handler in src/website/webServer.ts with the right service auth middleware, adds the auth-gate test, and regenerates docs/REST_ENDPOINTS.md + public/openapi.json + docs/MCP_TOOLS.md. Use whenever the user wants to add, wire, expose, or promote a REST endpoint, give an MCP tool a curl/HTTP sibling, flip a `planned` catalog entry to `live`, ship the whole REST surface for a service, or expose a write/mutation tool over HTTP POST. Also invoked automatically by `add-mcp-server` (its step 6e) to wire a newly scaffolded service's endpoints, which ship as their own pull request. Also use when invoked as `/add-rest-endpoint <mcpToolName|service> [service]`.
metadata:
  argument-hint: <mcpToolName|service> [service]
---

# Add REST Endpoint

The REST data plane exists so a shell-capable client can `curl | jq` bulk payloads without the bytes crossing the LLM context window. Endpoints are passthroughs for existing MCP tools.

**Reads (GET) are the default and the well-trodden path.** Writes (POST) are supported but gated: a write earns a REST sibling only when its request body is large or it belongs in a shell pipeline, and it widens what the permanent dashboard API key can mutate. The one-time type and test widening is **already done** (peopleforce, hubspot, redmine, sheets and calendar all have live POSTs), so a new write is steps 1–8 plus the per-endpoint rules. See [Write endpoints](#write-endpoints-post) before starting one.

Also check [Four jobs](#four-jobs-tell-them-apart-first) before writing any code: the most common surprise is that `webServer.ts` **already serves the route**, uncatalogued, as ChatGPT Custom Actions compat.

Adding an endpoint touches six files, three of them generated. This SKILL.md is the procedure; `references/route-pattern.md` is the canonical handler shape; `references/write-endpoints.md` covers the write-specific rules.

## Inputs

- `<mcpToolName>` — the MCP tool getting a REST sibling (e.g. `getEmployee`), **or** a scope phrase ("wire all the hubspot endpoints"), **or** a bare service slug. A scope phrase expands to every `planned` catalog entry for that service; a bare slug is how `add-mcp-server` invokes this skill and means *the service's whole tool surface* — every implemented read, plus every write that passes the [gate](#is-this-write-worth-a-rest-sibling). On that path expect some tools to be declined, and say which and why in the report.
- `[service]` — one of the `RestService` union values in `src/restCatalog.ts`: `docs`, `sheets`, `calendar`, `drive`, `gmail`, `slides`, `clickup`, `slack`, `outline`, `peopleforce`, `hubspot`. Infer from the tool's home server; ask only if genuinely ambiguous.

If neither is given, ask which service.

## Four jobs, tell them apart first

1. **Promote `planned` → `live`** — the catalog entry already exists, which is the normal state for a service freshly scaffolded by `add-mcp-server` (its step 6a writes the read entries at `planned`). Skip step 2 except to flip `status`; do steps 3–8. **Check `src/restCatalog.ts` first — this is the most common case.**
2. **Catalogue a route that already exists** — no catalog entry, but `webServer.ts` already serves the path. The ChatGPT Custom Actions compat routes are uncatalogued and invisible in every generated doc, and they hand-roll their validation. Do steps 1–8, but **keep the path, the response shape, AND the body shape** (see step 1). That last one is the trap: an old route's body may be the *provider's* native field names while the MCP tool's parameters are a camelCase translation of them, in which case "validate with the tool's own schema" would reject every existing caller. Diff them before assuming they agree.
3. **New read endpoint** — nothing exists. Do steps 1–8.
4. **New write endpoint** — do the [prerequisites](#write-endpoints-post) once, then steps 1–8 with the write variants called out inline.

## Procedure

### 1. Find the MCP tool and classify it

Grep `src/<provider>/server.ts` for `name: '<mcpToolName>'`. Note three things:

- **Its annotation, then what it actually does.** `readOnlyHint: true` → GET, `readOnlyHint: false` → POST (the write path, with its extra rules), `destructiveHint: true` → stop and read the destructive-ops section of `references/write-endpoints.md` before going further. **But `readOnlyHint: true` is not by itself a licence to use GET**: if the call creates server-side work — queues a job, starts an export, sends something — it is neither safe nor idempotent, and GET is fair game for a proxy or retry middleware to repeat after a timeout. Outline's `exportCollection`/`exportAllCollections` are annotated read-only and each call queues another export; shipped as GETs, a single dropped connection would have queued a second whole-workspace export. POST them to an action path regardless of the annotation. Read the annotation as "does this mutate the user's records", not as "is this free to retry".
- **The upstream client call in its `execute`.** The REST handler makes the same call and returns raw upstream JSON instead of a formatted string.
- **Its Zod `parameters` schema.** For reads this tells you the query params. For writes the tool's parameters are the source for validating `req.body` — that's the mechanism that stops the REST and MCP surfaces from drifting. Two caveats the ClickUp pass established:
  - **Share the FIELDS, not the whole schema.** The two surfaces compose the same fields differently — the tool takes the resource id as a parameter, the route takes it from the path — and the REST side usually adds `.refine()` guards the tool only states in prose. So export a plain field *object* and spread it (`z.object({ taskId: …, ...taskUpdateFields })` in the tool, `z.object(taskUpdateFields).refine(…)` in the route) rather than trying to reuse one `z.object`.
  - **It is only free on a NEW path.** On an already-served route, check what the published spec promises first:

    ```bash
    python3 -c "import json;d=json.load(open('public/openapi-<service>.json'));[print(m.upper(),p,list(o.get('requestBody',{}).get('content',{}).get('application/json',{}).get('schema',{}).get('properties',{}))) for p,ops in d['paths'].items() for m,o in ops.items() if m in ('post','patch','put')]"
    ```

    If the published body uses the provider's native names (`due_date`, `custom_item_id`, `comment_text`, `tid`) while the tool takes camelCase, the route has its own contract and reusing the tool's schema would 400 every generated client. Leave that path's body alone and put the camelCase version on a separate action path — one path, one body shape.

**Check the tool is actually implemented.** `NOT_IMPLEMENTED` in `e2e/tools.ts` lists tools that exist and throw — `editTableCell`, `fixListFormatting`, `findElement` today. An endpoint for one of those advertises a 500, so exclude it and say so in the report rather than shipping it for completeness.

```bash
grep -n "NOT_IMPLEMENTED" e2e/tools.ts
```

Also check what is already live before promising a count: on a mature service the reads may all be wired already, so "every tool" can turn out to be a writes-only pass (Docs: 8 of 9 reads live, the 9th unimplemented).

Then **check whether the route already exists**, before designing a path:

```bash
grep -nE -A1 "app\.(get|post|patch|delete)\(" src/website/webServer.ts | grep "api/v1/<service>"
```

The `-A1` is not decoration: some registrations put the path on the *next* line (`app.post(\n  '/api/v1/images', …`), and a pipeline expecting `app.post(` and the path to share a line silently reports no route where one exists — the single failure this step exists to prevent.

A hit that is absent from `restCatalog.ts` is job 2 above, and it changes what you do: the ChatGPT Custom Actions compat routes have been served for a long time, clients parse their response bodies, and they typically validate with `if (!field)` presence checks. **Keep the path and the response keys exactly as they are** and change only the validation, or you break a live integration to gain a tidier URL. Three of the eight endpoints in the Sheets/Calendar write pass were already there this way.

A hit that is *also* in the catalog means somebody already did this — stop and re-read, rather than registering a second handler Express will never reach.

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
- **If `public/openapi-<service>.json` already describes that path + method, use ITS `operationId` verbatim.** `buildRootOpenapi.mjs` only stub-fills what no per-service spec covers (`if (root.paths[pathOnly]?.[method]) continue`), so the per-service id wins and a different catalog id is **silently never emitted** — leaving the catalog and `docs/REST_ENDPOINTS.md` naming an operation that nothing in the published spec answers to, and a generated client calling the other name. Check before inventing one:

  ```bash
  python3 -c "import json;d=json.load(open('public/openapi-<service>.json'));[print(m.upper(),p,o.get('operationId')) for p,ops in d['paths'].items() for m,o in ops.items()]"
  ```

  Observed: the catalog wanted `writeSpreadsheet` / `appendSpreadsheetRows` / `createCalendarEvent` while the specs publish `writeRange` / `appendRows` / `createEvent`. The specs won.
- **A new method on a path whose other verb is already in the spec needs its own id.** One `operationId` cannot name two operations, so a POST added beside a legacy `PATCH` that already publishes `updateEvent` becomes `updateCalendarEvent`; a `/cancel` action path beside a published `deleteEvent` becomes `cancelCalendarEvent`.
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

**First, check whether the provider's server module is safe to import.** If `src/<provider>/server.ts` is the application entry point, `webServer.ts` cannot import it in either direction — not statically, and not with a dynamic `await import()` inside a handler, because in web-only mode that boots an entire MCP server to validate a request body:

```bash
grep -n "createWebApp\|startServer()" src/<provider>/server.ts
```

A hit means the schemas and ops go in their own modules (`writeSchemas.ts`, `writeOps.ts`) that both surfaces import. `src/google-docs/server.ts` is the one today. When in doubt do it anyway — separate modules are never wrong here.

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

**The gate has a second condition that a batch trips: duplication.** `new_duplicated_lines_density` must stay under 3%, and near-identical handlers are the usual cause — see [the table rule](#past-about-four-endpoints-register-them-from-a-table). Structurally identical one-line catalog entries also register as duplicated; that is what a data table looks like and is not worth deforming, but it means the budget for duplicated handler bodies is smaller than it looks.

**Then check the coverage gate, before you push.** CI runs a SonarCloud quality gate that fails the PR at **under 80% coverage of new code**, and a write-endpoint change lands squarely in its blast radius: the handler's success path cannot be covered by any test in this repo (see [The coverage gate](references/write-endpoints.md#the-coverage-gate)), so the op you extracted has to carry the ratio. Two things make this wasteful to get wrong — the gate blends **lines and branches**, so a per-file line reading looks like it passes when it does not, and each CI round trip is ~12 minutes. Measure locally instead; the recipe is in that section.

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
New-code coverage: <N>%   ← gate is 80%, lines + branches (POST changes only)

Declined (if any):
  <toolName>   ← why: no large body, no pipeline / destructive, no sign-off

Next:
  /update-openapi <provider>   ← required for POST (the stub has no requestBody)
  open a SEPARATE pull request for this pass   ← never folded into a scaffold or feature PR
```

Name the declined tools explicitly. Silence reads as "every tool is covered", and the gap is then found by whoever reaches for the missing endpoint rather than by the person who could have overruled the gate.

## Write endpoints (POST)

Writes are legitimate but they are **not** the reason the data plane exists. The read rationale — keep large responses off the LLM context — doesn't transfer, because a write's *response* is small. So apply the gate before writing any code.

### Is this write worth a REST sibling?

Ship it when at least one holds:

- **The request body is large.** Appending 5,000 spreadsheet rows, importing a long document body, batch operations. Sending that through the tool-result channel is exactly the waste the data plane was built to avoid — the direction is just reversed.
- **It belongs in a shell pipeline.** `curl … | jq … | curl -X POST …` where forcing a hop through the LLM to perform the write is pure overhead.

Push back when neither holds. A one-field update is cheaper and safer as an MCP tool call: Zod validation, the `destructiveHint` annotation the e2e readonly connector keys off, and no new auth surface. Say so plainly rather than mirroring all 40 write tools by reflex.

Worked example, from the Sheets and Calendar pass — of eleven write tools, eight shipped and three did not:

| Tool | Verdict |
|---|---|
| `writeSpreadsheet`, `appendSpreadsheetRows`, `batchUpdateSpreadsheet`, `createSpreadsheet` | **Ship** — `values` / `operations` / `initialData` are the large body the plane exists for |
| `createEvent`, `updateEvent` | **Ship** — bulk event creation from an external feed is a shell pipeline |
| `clearSpreadsheetRange`, `deleteEvent` | **Ship, with sign-off** — `destructiveHint`, so they needed an explicit decision first |
| `addSpreadsheetSheet`, `updateCellByFieldName` | **Decline** — one field each, no body, no pipeline. They stay MCP-only |

When a destructive tool is in scope, ask in **one** question that lists the candidates and says what the sign-off buys the caller (no confirmation affordance behind a curl, and the permanent API key is in scope), then record the answer in the catalog `notes`. Note the question is broader than the `destructiveHint` flag: `batchUpdateSpreadsheet` carries no such annotation, yet its operation list reaches `deleteSheet`, which destroys a tab and every value on it. Read what the schema can express, not just the annotation.

### One-time prerequisites (already done — verify, do not redo)

These four were needed before the repo's first write endpoint and are all in place now; the list stays so a reviewer can confirm nothing regressed:

1. **`src/restCatalog.ts`** — the interface reads `method: 'GET' | 'POST';` and the header comment describes the gate rather than claiming writes stay MCP-only.
2. **`src/__tests__/restCatalog.test.ts`** — asserts the method is one of `['GET', 'POST']` rather than exactly `GET`. The assertion must stay: it is what keeps `PATCH`/`DELETE` out until someone decides deliberately.
3. **`src/__tests__/restRoutes.auth.test.ts`** — has the `NEW_REST_WRITE_ENDPOINTS` array and its POST loop (shape in `references/write-endpoints.md`). Add your path to that array, not the GET one.
4. **`src/sharedTools/listRestEndpoints.ts`** — the tool description covers both directions ("GET fetches large responses straight to disk, and POST sends a large request body"), not the read-only framing it started with.

The three build scripts need no change — their regexes capture `method` generically and `buildRootOpenapi.mjs` already lowercases it into the OpenAPI object.

Scope stays `'GET' | 'POST'`. `PATCH`/`DELETE` are a separate decision; the legacy `PATCH`/`DELETE` routes in `webServer.ts` are ChatGPT Custom Actions compat and are not catalogued.

### Per-endpoint write rules

Full detail in `references/write-endpoints.md`. The load-bearing ones:

- **Validate `req.body` with the MCP tool's own Zod schema** via `safeParse`, returning 400 with the flattened issues. The legacy POST routes hand-roll `if (!summary) …` checks — do not copy that; it's the drift the schema reuse exists to prevent.
- **201 for create, 200 for update.** Return the created/updated resource, not just an id.
- **Never expose a `destructiveHint: true` tool** without explicit user sign-off in the conversation, recorded in the catalog `notes`.
- **Flag the auth widening.** `createServiceAuth` accepts the permanent dashboard API key alongside the 5-minute bearer. A key that could only read yesterday can mutate once you ship a write endpoint. State that consequence when proposing the first one.
- **Read the parameters as an attack surface.** A parameter naming a filesystem path, or a URL the *server* fetches, means something different once anyone with a key can set it: the Docs pass shipped both, and both were file/network exfiltration primitives until fixed. The table and the two-level fix are in `references/write-endpoints.md` — do this before the endpoint exists, not after review finds it.

## Batch mode (scope phrase)

For "wire the hubspot endpoints": step 3 once (middleware + session branch — the expensive, easy-to-miss part), then step 4 once as a **table** (below), step 5 one line per endpoint, then steps 6–7 once. Flip each `status` to `live` only as its route lands, so a partial batch never advertises endpoints that 404.

Prefer wiring a whole service in one pass — the session-branch work dominates, and the auth test grows by one line per route.

**A brand-new service, chained from `add-mcp-server`, is the batch case by default.** It arrives with read entries already written at `planned` (that skill's step 6a), so it is job 1 for the reads and job 3/4 for anything else. Two extras on that path:

- The scaffold templates omit `registerMintRestBearerForCurl` / `registerListRestEndpoints`, so step 2's registration requirement always applies — without them the service's first `live` entry fails `sharedToolsRegistration.test.ts`.
- There is no `public/openapi-<slug>.json` yet, so every POST would get only the body-less stub. Write the per-service spec in the same change (see step 6), and add the file to `SERVICE_PREFIX` in `scripts/buildRootOpenapi.mjs` or the merge step skips it with a warning.

Ship the result as its own PR — see [One pass, one PR](#one-pass-one-pr).

### Past about four endpoints, register them from a table

Hand-writing N handlers that differ only in schema, op, status code and response shape **fails the duplication gate**, and it is the wrong shape anyway. Nineteen Docs write handlers measured **23% duplicated** (88 of 384 new lines), taking the project over the 3% `new_duplicated_lines_density` threshold and failing the PR after everything else was green.

Write it as a table of route descriptors plus one generic handler:

```ts
type Ops = typeof import('../<provider>/writeOps.js');
type BodySchema = { safeParse(v: unknown): { success: boolean; data?: any; error?: any } };

interface WriteRoute {
  path: string;                      // Express path; array order IS registration order
  status?: 200 | 201;                // 201 where a resource is created
  notFound: string;
  fallback: string;
  schema?: (m: Ops) => BodySchema;   // omit for a body-less route
  run: (m: Ops, client: Client, args: any, p: Record<string, string>) => Promise<unknown>;
}

for (const route of WRITE_ROUTES) {
  app.post(route.path, requireApiKey, async (req: ApiAuthenticatedRequest, res) => {
    const ops = await import('../<provider>/writeOps.js');   // once, not per row
    /* one handler: safeParse 400, route.run(ops, …), status, error branch */
  });
}
```

**Inject the ops module; do not give each row its own `load: async () => { const m = await import(…); … }`.** That wrapper is 4 lines of identical ceremony per route, and it is exactly what the duplication gate counts — 24 copies measured as 7.5% duplicated new lines in `webServer.ts`, which dropped to 4.1% (and 85 fewer lines) once the handler imported the module once and passed it in. Type safety is unchanged: `typeof import(...)` still makes a renamed export a compile error, and the per-row `as string` casts on path params disappear with it.

Three things get better, not just the duplication number:

- **Coverage goes up.** One handler the tests reach beats N copies they do not: on the Docs pass this moved new-code coverage from 81.4% to 91.4%, because `webServer`'s new lines fell from 374 to 283 with 86% of them covered.
- **The cross-cutting rules live in one place** — the path-params-over-body merge (`{...req.body, ...req.params}`), the `safeParse` 400, the `UserError`-versus-upstream-status branch. Nineteen copies of a catch block is nineteen places a later fix can fail to be applied.
- **It is shorter.** The table version of those nineteen routes was 108 lines less than the hand-written one.

Static paths still have to come first — put them at the top of the array, since array order is registration order.

## One pass, one PR

**A REST pass ships as its own pull request, never folded into a larger change.** That applies whether this skill was invoked directly or chained from `add-mcp-server` step 6e.

The reason is what the diff contains. A REST pass is where two decisions live that a reviewer must actually see:

- **The auth widening.** `createServiceAuth` accepts the permanent dashboard API key, so every write endpoint enlarges what a long-lived credential can mutate.
- **Any destructive exposure**, with its sign-off recorded in the catalog `notes`.

Both get rubber-stamped when they arrive inside a 10k-line scaffold. Separately, the generated artifacts (`public/openapi.json`, the two `docs/*.md`) are large and noisy, which is another reason not to mix them with hand-written code a reviewer needs to read closely.

Practicalities, in the order they bite:

- **When chained from a scaffold, branch off the scaffold's branch, not `main`.** The routes import the provider's server module, so `main` cannot typecheck them until the scaffold lands. The REST PR is therefore stacked — rebase or retarget it onto `main` after the scaffold merges.
- **After any merge, verify nothing was stranded.** A PR that merges at an older commit silently drops whatever was pushed afterwards, and the branch still looks merged. Check each commit you expected to ship:

  ```bash
  git fetch origin
  for c in <sha> <sha>; do git merge-base --is-ancestor $c origin/main && echo "$c in" || echo "$c NOT in"; done
  ```

  This is not hypothetical: a pass ended with a data-loss fix and a skill update both pushed after the merge point, and both were left behind on a branch GitHub reported as merged.
- **Keep a follow-up fix in its own PR too** when the original has already merged — especially a correctness fix, which should not wait on a docs review.

## Failure modes

- **Catalog line doesn't match the parser regex** — endpoint silently missing from all three generated docs. Symptom: `npm test` passes, `docs/REST_ENDPOINTS.md` diff is empty. Cause: reordered fields, double quotes, a line break, or an apostrophe in `summary`.
- **Duplicate `openapiOperationId`** — `restCatalog.test.ts` fails loudly. Prefix with the service.
- **`status: 'live'` with no route** — the docs promise an endpoint that 404s. Only flip after the handler exists.
- **Parameterized route shadows a static sibling** — `/docs/recent` 404s or returns garbage because `:documentId` matched first. Order the `app.get` calls, not the catalog rows.
- **Non-Google provider with no session branch** — 401 passes, then the handler throws on an undefined token. See step 3.
- **POST path added to the GET-only auth-test array** — fails for a reason that has nothing to do with the bug it looks like. Use the write array.
- **POST endpoint shipped with only the OpenAPI stub** — clients see an operation with no `requestBody` and can't call it. Chain `/update-openapi`.
- **A write endpoint proposed with no size or pipeline justification** — apply the gate above and recommend the MCP tool instead. Mirroring every write tool doubles the mutation surface for no gain.
- **A second handler registered for a path that already has one** — the uncatalogued ChatGPT-compat routes are easy to miss. Express serves the first match, so the new handler is dead code that tests at the wrong URL. Grep first (step 1).
- **`openapiOperationId` differs from the per-service spec's id for the same path + method** — no test catches it; the catalog simply names an operation the published spec does not have. Check the spec (step 2).
- **A per-route `express.json({ limit })` next to the handler** — never runs, and the endpoint 413s at 100 kb anyway. The limit belongs in `REST_LARGE_BODY_PREFIXES`; see `references/write-endpoints.md`.
- **Upstream 404/403 answered as 500** — the provider's MCP helpers may wrap errors in a `UserError` that drops `err.code`, which is what `sendUpstreamError` reads. Check before reusing a helper.
- **An MCP `UserError` mapped straight to 400** — those helpers raise `UserError` for the provider's own 404s too, so a missing record gets reported as "fix your request". Branch on whether a numeric status survived.
- **The duplication gate fails the PR** — N near-identical handlers. Expected past about four endpoints; use the table (see Batch mode) rather than writing them out and refactoring afterwards.
- **An endpoint shipped for a tool that throws** — check `NOT_IMPLEMENTED` in `e2e/tools.ts` (step 1).
- **The Sonar new-code coverage gate fails the PR** — expected on a write change, and not a reason to waive the gate. Cover the extracted op; see `references/write-endpoints.md`.
- **The GitHub `sonarcloud` check says SUCCESS while the quality gate is ERROR.** The check only reports that the scan ran. Read the gate, and get the per-file breakdown before fixing anything:

  ```bash
  curl -s "https://sonarcloud.io/api/qualitygates/project_status?projectKey=<key>&pullRequest=<n>"
  curl -s "https://sonarcloud.io/api/measures/component_tree?component=<key>&pullRequest=<n>&metricKeys=new_lines,new_duplicated_lines_density&qualifiers=FIL&ps=100"
  ```

  Confirm **which commit was analysed** (`api/project_pull_requests/list`) — a reading taken a minute after pushing is still the previous commit's, and chasing a stale number is its own time sink.
- **The duplication gate can be mathematically unreachable, and the catalog is why.** `src/restCatalog.ts` measures ~97% duplicated new lines: 50 structurally identical one-line entries is precisely what copy-paste detection exists to flag. Do the arithmetic before grinding — at 1673 new lines a 3% threshold allows 50 duplicated lines, and the catalog alone was 75, so no handler refactor could pass. At that point the only honest options are a `sonar.cpd.exclusions` entry, a won't-fix, or an override; raise it as a decision rather than deforming a data table whose field order three build scripts parse with a regex. (Real handler duplication is still worth removing: injecting the ops module once instead of per table row took `webServer.ts` from 7.5% to 4.1% and removed 85 lines.)
- **Tests that pass but never EXIT hang the whole suite, and it reads like anything but that.** With no local Redis, `oauthServer.ts`'s `getRedis()` leaves an `ioredis` client retrying, so `auth/exchangeAuthCode` and `auth/oauthProxy` print `ok` for every assertion and then hold the event loop open — `node --test` waits on them indefinitely. Two things disguise it: stdout is block-buffered when redirected, so a dead run sits at a plausible ~67 lines and looks like slow progress; and the giveaway is the parent at 0% CPU with **no child workers**. Before suspecting your change, reproduce on unmodified main (`git checkout --detach origin/main`) — if it reproduces there, it is the environment, not the diff. To get a verdict anyway, run each file separately with a hard timeout and treat a `not ok` line as the only failure signal.
- **`data/*.json` grows without bound and widens the corruption race.** Every run appends to `data/mcp-connections.json` and nothing prunes it; at 1340 entries / 652 KB, ~120 concurrent test processes read-modify-writing it reliably interleave into `Unexpected non-whitespace character after JSON`, or hang. It is gitignored scratch — truncate to `[]` rather than debugging a handler.

## File layout

```
add-rest-endpoint/
├── SKILL.md
├── references/
│   ├── route-pattern.md          ← canonical Express handler shape + helpers
│   └── write-endpoints.md        ← POST rules: Zod body validation, body-size prefixes,
│                                   op extraction, upstream status, the coverage gate
└── assets/
    ├── scripts/
    │   └── new-code-coverage.py  ← local read of the Sonar new-code gate (lines + branches)
    └── templates/
        ├── google-route.ts.tmpl
        ├── third-party-route.ts.tmpl
        └── write-route.ts.tmpl
```

## Relationship to other skills

- **`add-mcp-server`** **hard-chains into this skill at its step 6e**, with the new service's slug as the scope phrase, right after it writes the catalog entries at `planned`. So the common way this skill runs is not one tool at a time but a whole new service at once — see [Batch mode](#batch-mode-scope-phrase), and note that the scaffold templates do **not** include `registerMintRestBearerForCurl` / `registerListRestEndpoints`, so step 2's registration requirement always applies on that path. **That chain's output belongs in its own PR, separate from the scaffold** — see [One pass, one PR](#one-pass-one-pr).
- **`add-mcp-tool`** creates the MCP tool — the prerequisite for an endpoint here. Its step 9 offers `/update-openapi` but not this skill, because a single new tool rarely needs a REST sibling; only bulk reads and large-body writes do. Whole-service coverage arrives via `add-mcp-server` instead.
- **`update-openapi`** upgrades the auto-generated stub into a spec with real request/response schemas. Optional for GET, **required for POST**.
- **`add-e2e-test`** covers MCP tools through a live client, not REST routes. The REST equivalent is the auth-gate array in step 5.
