# Write endpoints (POST)

Everything in `route-pattern.md` still applies — auth middleware, `ApiAuthenticatedRequest`, `sendUpstreamError`, route ordering. This document covers only what differs when the endpoint mutates state.

## Why the bar is higher

A GET endpoint's worst failure is a wasted fetch. A POST endpoint's worst failure is corrupted data in the user's Google Doc, ClickUp list, or HubSpot portal — reached over an auth surface that is deliberately more permissive than the MCP path.

Three things stack up:

1. **`createServiceAuth` accepts the permanent dashboard API key**, not just the 5-minute bearer from `mintRestBearerForCurl`. It's there for ChatGPT Custom Actions backward compat. Once a write endpoint exists for a service, that long-lived key can mutate. Say this out loud when proposing the first one — it is a real change in blast radius, and the user should decide it knowingly.
2. **REST bypasses FastMCP's Zod layer.** MCP tool arguments are schema-validated before `execute` runs. `req.body` is whatever the caller sent. Reusing the tool's schema (below) is what closes that gap.
3. **No `destructiveHint`.** MCP clients can surface a confirmation prompt off that annotation. A curl has nothing equivalent.

## Body validation — reuse the tool's Zod schema

The legacy POST routes in `webServer.ts` hand-roll their checks:

```ts
// POST /api/v1/calendars/:calendarId/events — the OLD pattern, do not copy
const { summary, startDateTime, endDateTime } = req.body;
if (!summary) { res.status(400).json({ error: 'summary is required' }); return; }
if (!startDateTime) { res.status(400).json({ error: 'startDateTime is required' }); return; }
```

Three problems: it drifts from the MCP tool's schema the moment either side changes, it validates presence but never type or shape, and it grows one `if` per field forever.

Do this instead — export the tool's schema from the server module and `safeParse` the body:

```ts
const { CreateEventParams } = await import('../google-calendar/server.js');

const parsed = CreateEventParams.safeParse(req.body);
if (!parsed.success) {
  res.status(400).json({ error: 'Invalid request body', issues: parsed.error.flatten() });
  return;
}
const args = parsed.data;
```

If the schema is currently inline in the `addTool({ parameters: z.object({...}) })` call, lift it to a named `export const XParams = z.object({...})` and reference it from the tool. That refactor is part of adding the endpoint, not a separate cleanup — it's the single mechanism keeping the two surfaces in sync. Shared fragments already live in `src/types.ts` (`DocumentIdParameter`, `RangeParameters`, `TextStyleParameters`) — prefer those.

`parsed.error.flatten()` gives `{ formErrors, fieldErrors }`, which is genuinely actionable in a curl response. Return it.

## Body size — the limit goes in a prefix list, not next to the handler

The global `app.use(express.json())` sets no explicit limit, so Express's **100 kb** default applies, and a write whose whole justification is a large request body would 413 at 100 kb with Express's HTML error page.

**Do not mount a per-route parser.** It cannot work here, and the failure is silent:

```ts
// WRONG — this parser never runs
app.post('/api/v1/sheets/:spreadsheetId/write', express.json({ limit: '5mb' }), requireSheetsApiKey, handler);
```

`registerSharedRoutes` mounts the global `express.json()` long before the routes are registered, so by the time a request reaches the route chain the global parser has already read the body — and already 413'd it if it was oversize. `body-parser` also sets `req._body` on the first parse, so every later parser skips the request.

Add the path prefix to `REST_LARGE_BODY_PREFIXES` instead (`webServer.ts`, in `registerSharedRoutes`, right above the global parser):

```ts
const REST_LARGE_BODY_PREFIXES: ReadonlyArray<string> = [
  '/api/v1/redmine/issues',   // createIssue / updateIssue — description and notes are full issue bodies
  …
  '/api/v1/sheets',           // values is a 2D array of rows; bulk rows are the point
];
```

A prefix covers every method and sub-path under it, which is usually what you want (one entry served `/write`, `/append`, `/batchUpdate`, `/ranges/clear` and `POST /api/v1/sheets`). Record the limit in the catalog `notes` so the generated docs state it, and keep the `express.raw()` routes mounted ahead of the global parser undisturbed.

**Test it, because nothing else will.** A 413 here is invisible until a real caller sends real data, and the assertion is cheap — post a body past 100 kb and expect validation, not 413:

```ts
const bigCell = 'x'.repeat(300_000);
const res = await request(app).post('/api/v1/sheets/sheet-123/write').set(auth())
  .send({ range: 'A1', values: bigCell });   // invalid on purpose: values must be rows
assert.equal(res.status, 400, `expected validation, not 413; got ${res.status}`);
```

A 400 proves the body was parsed and reached the schema. (`413` means the prefix is missing or misspelled; `431`/HTML means you are looking at Express's default handler.)

## Status codes and response shape

| Situation | Status | Body |
|---|---|---|
| Created a resource | `201` | The created resource, including its new id |
| Updated / appended | `200` | The updated resource or a result summary |
| Body failed validation | `400` | `{ error, issues }` from `flatten()` |
| Upstream 404/403 | via `sendUpstreamError` | `{ error }` |

Follow `POST /api/v1/calendars/:calendarId/events`: it returns 201 with the created event's fields rather than a bare `{ ok: true }`. Callers chaining curls need the id, and a caller who has to issue a follow-up GET to learn what happened defeats the pipeline the endpoint exists to serve.

Idempotency: HTTP POST isn't idempotent and this layer has no request-id dedupe. If the underlying operation is dangerous to repeat (creating a payment-ish record, sending a message), say so in the catalog `notes`. Don't invent a dedupe mechanism unilaterally — that's a design decision for the user.

## Extract the op, not just the schema

Lifting the Zod schema stops the two surfaces disagreeing about what is *valid*. It does nothing about them disagreeing on what the request *is* — and that drift is already in this repo's history: `webServer.ts` held its own copy of the Calendar event resource and response projection, and the copies had diverged from the MCP tool (the REST copy went a while without Meet handling).

So when the handler would otherwise rebuild what the tool builds, export the body of the tool too and call it from both:

```ts
// src/google-calendar/server.ts
export async function performCreateEvent(calendar, args: CreateEventArgs): Promise<calendar_v3.Schema$Event> { … }
export async function performUpdateEvent(calendar, args): Promise<{ event; wantsNewMeet: boolean }> { … }
export function projectEvent(event): Record<string, unknown> { … }   // the shape REST answers with
```

The tool keeps its formatter and error mapping; the route keeps its status codes and `sendUpstreamError`. Everything that decides *what the answer is* lives in one function. Precedents to match: `performCreateCompany` / `performCreateEngagement` exported from `src/hubspot/server.ts`, and `src/redmine/ops.ts` wholesale.

Two payoffs beyond tidiness:

- A shared projection means a `POST`, its legacy `PATCH` twin and the MCP tool cannot answer the same resource three slightly different ways. Point the legacy verb at the same handler function while you are there.
- It is the only way to get the change past the coverage gate (below), because an exported op can be driven against a stub client while a route handler cannot.

**Read-modify-write needs care when you extract it.** If the upstream call is a full replacement (Google's `events.update`, most `PUT`s), the op must start from the whole fetched resource and override only what the caller named. A whitelist of fields silently *deletes* everything it forgot — in this repo that meant every event update dropped `recurrence`, so changing a weekly meeting's title stopped it repeating. Spread the fetched object; do not rebuild it.

## Reusing a provider's MCP helpers: keep the upstream status

`sendUpstreamError` chooses 404 / 403 / 500 by reading `err.code`, then `err.response.status`, then `err.status`. A provider's MCP helpers often wrap the upstream failure for a human first:

```ts
if (error.code === 404) throw new UserError(`Spreadsheet not found (ID: ${spreadsheetId}).`);   // status lost
```

Reuse that helper from a REST route and every upstream failure becomes a flat 500 with a message the client cannot route on. Preserve the status when wrapping:

```ts
function upstreamUserError(message: string, cause: any): UserError {
  const err = new UserError(message);
  const code = cause?.code ?? cause?.response?.status ?? cause?.status;
  if (typeof code === 'number') (err as any).code = code;   // numeric only — Node throws 'ECONNRESET'
  return err;
}
```

Two rules fall out of that, both learned the hard way:

- **Only a numeric status, ever.** Node's own errors carry string codes (`ENOTFOUND`, `ECONNRESET`), and `res.status('ECONNRESET')` throws inside the error handler. A failure with no status must leave `code` unset — inventing one answers 404 for a DNS outage.
- **Do not map `UserError` → 400 unconditionally.** It is tempting when the op raises `UserError` for genuinely bad input (an unknown sheet name in a batch), but the same type now carries the provider's 404s and 403s, so a nonexistent record gets reported as "fix your request". Branch on whether a numeric status survived: no status → 400, status → `sendUpstreamError`.

Narrow it by **name**, not `instanceof`: `webServer.ts` imports no part of FastMCP, and pulling the framework into the web process to classify one error is not worth it. `FastMCPError` sets `name = new.target.name`, so `err?.name === 'UserError'` is reliable.

## The coverage gate

CI runs a SonarCloud quality gate that **fails the PR below 80% coverage of new code**, counting lines *and* branches. A write-endpoint change is unusually exposed to it, for a reason worth knowing up front: **the handler's success path cannot be covered by any test in this repo.**

- For Google services the client comes off `req.userSession`, built from real tokens by `createUserSessionFromConnection`. There is no injection seam.
- Stubbing `globalThis.fetch` — the trick `restRoutes.providers.test.ts` uses for HubSpot and Redmine — does not reach `googleapis`: `gaxios` imports **bundled `node-fetch`**, not the global.

**If the provider's server module is the entry point, its tool bodies are uncoverable until you make it importable.** `src/google-docs/server.ts` called `startServer()` at import, so no test could import it and its ~770 executable lines — every tool body — sat at 0% coverage, which Sonar counts in full. Guard the boot:

```ts
// Phrased as "start unless testing", NOT "start if this is the entry point":
// the two fail in opposite directions. A wrong argv check silently stops
// production from booting; a wrong test check only boots a server inside a
// test. NODE_TEST_CONTEXT is set by `node --test`.
const UNDER_TEST_RUNNER = process.env.NODE_TEST_CONTEXT !== undefined;
if (!UNDER_TEST_RUNNER) startServer();
```

Check how production launches it first (`Dockerfile` CMD, `railway.json` startCommand) and say so in the commit — this is a change to how the app boots.

So plan for the handler lines staying uncovered and make the extracted op carry the ratio:

- Drive the op against stub clients, the shape `driveToolHandlers.test.ts` established (`mkDrive()` / `mkSheets()` returning `mock.fn`s). Assert the request that would go to the provider — that is the part a caller cannot verify from outside.
- Capture the tool bodies too, by patching `FastMCP.prototype.addTool` before importing the server (the ClickUp suite's trick), which covers each `execute`'s formatter and error mapping.
- Keep the route-level tests on the `safeParse` branch: they are cheap, need no mock, and prove auth runs before validation.

**Measure locally rather than pushing to find out** — the gate blends lines and branches, so a per-file *line* reading reads as passing when the real number is several points lower, and each CI round trip is ~12 minutes. Two steps:

```bash
# 1. lcov over the files you touched, from the suites that touch them
npx c8 --reporter=lcovonly --report-dir=/tmp/cov \
  --include 'src/google-sheets/server.ts' --include 'src/website/webServer.ts' \
  node --import tsx --test src/__tests__/<suite>.test.ts …

# 2. intersect it with the lines this branch added
python3 .claude/skills/add-rest-endpoint/assets/scripts/new-code-coverage.py /tmp/cov/lcov.info \
  src/google-sheets/server.ts src/website/webServer.ts
```

It prints per-file lines and branches, the uncovered line numbers to aim at, and the gate verdict using Sonar's own formula. Calibration: on the Sheets/Calendar pass it reported **83.9%** where CI's gate then measured **83.5%** — close enough to trust, which is why it also warns when the margin is under two points. Pass the same files you gave `c8`; one you forgot is reported as *not instrumented* rather than counted as zero.

Also worth knowing before you start: a coverage reading taken **before** the review round is not the one that ships. Fixing review findings adds production lines of its own, and on this PR that alone moved the gate from 81.2% to 79.9% — below the threshold it had already passed.

Read the per-file breakdown from Sonar itself when a run has already happened — it names exactly which files are dragging:

```bash
curl -s "https://sonarcloud.io/api/qualitygates/project_status?projectKey=<key>&pullRequest=<n>"
curl -s "https://sonarcloud.io/api/measures/component_tree?component=<key>&pullRequest=<n>&metricKeys=new_lines_to_cover,new_uncovered_lines,new_coverage&qualifiers=FIL"
```

Finally: **do not chase a defensive branch you cannot reach honestly.** A `String(cause)` fallback behind a helper that always wraps, or a `throw e` that only fires on a bug in your own translation, are better left uncovered with a comment saying so than reached by contorting the code.

## Read the parameters as an attack surface, not just a schema

The destructiveness check asks what the endpoint does to the *user's* data. This one asks what it does to the **server**, and it is where the two worst findings of the Docs pass came from — both of them reachable through an endpoint that looked like an ordinary image insert.

Before exposing a write, look at every parameter and ask where the value is *used*:

| Parameter shape | What it becomes | What to do |
|---|---|---|
| A filesystem path (`localImagePath`, `filePath`, `outputDir`) | `fs.createReadStream` **on the server** | Refuse it over REST |
| A URL the server fetches itself | an outbound request from inside your network | Guard every redirect hop |
| A URL the *provider* fetches (`insertImageFromUrl`) | Google's request, not yours | No server-side exposure |
| A redirect/callback/webhook target | somewhere your credential goes | Validate against an allowlist |

**The threat model changes when a tool moves to REST**, and that is the whole point. On the MCP stdio path the caller owns the machine, so reading a local file is the feature. Over REST the caller is anyone holding a credential — including the permanent dashboard API key — so the same parameter is a file-read primitive. `insertLocalImage` accepted `localImagePath`, and the helper beneath it read the path, uploaded the bytes to the caller's Drive, granted `anyone` reader, and returned the link. Nothing checked the extension or MIME type (it falls back to `application/octet-stream`), so `/proc/self/environ` or a credentials file went through whole, and the upload completed before the insert, so a later failure did not undo it.

Fix it at **both** levels, because they are different boundaries:

```ts
// 1. The REST schema refuses the field, so the 400 names it rather than
//    degrading into "no image source given".
export const insertImageRestSchema = insertLocalImageSchema.refine(
  (v) => v.localImagePath === undefined,
  { message: 'localImagePath is not accepted over REST: it would read a file from the server filesystem.',
    path: ['localImagePath'] },
);

// 2. The op refuses it unless the caller opts in, so no future call site
//    inherits the hole. The MCP tool opts in only under stdio.
if (args.localImagePath && !opts.allowLocalFilesystem) throw new UserError(…);
```

**This is the one sanctioned exception to "reuse the tool's schema verbatim".** The rule exists to stop the surfaces drifting on what is *valid*; it does not mean they must agree on what is *permitted*, because they do not share a trust model. Derive the REST variant from the tool's schema (`.refine`, `.omit`) so the rest of the contract still cannot drift, name the divergence in a comment, and say why.

**If the server fetches a URL, guard every hop.** Validating the first hostname and then calling `fetch` with the default `redirect: 'follow'` is not a guard: a public URL answering 302 to `169.254.169.254` or `127.0.0.1` is fetched unchecked. Follow redirects manually with `redirect: 'manual'`, re-validate each destination before requesting it, and cap the hops.

**Look for the existing guard before writing one.** That redirect loop already existed twice in this repo (`clickup/docImageStore.ts`, `slack/fileDownload.ts`) while a third call site had a weaker copy — which is exactly how the hole survived. Grep first, and if the correct version is inlined somewhere, hoist it to one place and delegate rather than adding a fourth:

```bash
grep -rn "redirect: 'manual'\|rejectPrivateAddress\|checkBaseUrl" src --include "*.ts" | grep -v __tests__
```

Where it lands matters: put the shared guard in the module that owns the validators it calls, or you create an import cycle. Here that is `google-docs/apiHelpers.ts`, which owns `validateFetchUrl` and `rejectPrivateAddress`.

## Destructive operations

A tool annotated `destructiveHint: true` (delete/remove/clear/archive/trash/resolve) needs explicit user sign-off in the conversation before it gets a REST sibling. There is no confirmation affordance behind a curl, and the permanent API key is in scope.

If the user does sign off:

- Keep it `POST` to an explicit action path (`/api/v1/<svc>/<resource>/{id}/archive`), not `DELETE` on the resource. `DELETE` isn't in the catalog's method union and shouldn't be added casually — an explicit verb path reads as deliberate at the call site.
- Record the sign-off in the catalog `notes` so the generated docs carry the warning.
- Mention it in the report at the end of the change.

## Auth-gate test for writes

`NEW_REST_ENDPOINTS` in `src/__tests__/restRoutes.auth.test.ts` is looped with `request(app).get(path)`. Adding a POST path there tests a nonexistent GET route and fails for the wrong reason. Add a sibling array and loop:

```ts
// POST endpoints — same auth gate, exercised with the right verb. Bodies are
// intentionally empty: the middleware rejects before any body parsing, so a
// 401 here proves the gate runs ahead of validation.
const NEW_REST_WRITE_ENDPOINTS: ReadonlyArray<string> = [
  '/api/v1/sheets/sheet-123/rows',
];

for (const path of NEW_REST_WRITE_ENDPOINTS) {
  it(`POST ${path} → 401 when Authorization is missing`, async () => {
    const res = await request(app).post(path).send({});
    assert.equal(res.status, 401);
    assert.ok(res.body.error, 'expected an error body');
  });

  it(`POST ${path} → 401 when the bearer is unknown`, async () => {
    const res = await request(app).post(path).set('Authorization', 'Bearer not-a-real-token').send({});
    assert.equal(res.status, 401);
    assert.ok(res.body.error);
  });
}
```

A 401 on an empty body is the assertion that matters: it proves auth runs before validation, so an unauthenticated caller can't probe the schema by watching 400s.

Beyond the gate, add a validation test for the `safeParse` branch — a malformed body returning 400 with issues, no upstream mock needed. Authenticate the way `restRoutes.providers.test.ts` does (`createOrUpdateUser` for the bearer, pin the numeric id, then `createMcpInstance`), with one wrinkle: a **Google** service passes no `provider` argument at all —

```ts
await createMcpInstance(USER_ID, 'google-sheets', 'Test Sheets', dummyGoogleTokens, null);
```

— because `createServiceAuth` routes everything without a provider down the Google OAuth path, which is what puts `googleSheets` / `googleCalendar` / `googleDrive` on the session. Passing `null` for `provider` is also a type error, since the parameter is optional rather than nullable.

One more hazard when running these suites: without `DATABASE_URL` the stores are JSON files under `data/`, and `node:test` runs test *files* concurrently in separate processes. Several REST suites writing a user and a connection at once can interleave their writes and leave `data/mcp-connections.json` unparseable — which then fails every suite that reads it, looking exactly like a code regression. If a passing suite suddenly fails with `Unexpected non-whitespace character after JSON`, truncate the file to its last valid array rather than debugging the handler.

## OpenAPI

`buildRootOpenapi.mjs`'s stub pass emits `operationId`, `summary`, `description`, `tags`, and 200/401/403/404 responses. It has **no `requestBody`** and no 201/400. For a POST endpoint that stub is actively misleading — a generated client would call it with no body.

Chain `/update-openapi <provider>` in the same change to write a real entry in the per-service spec (`public/openapi-<service>.json`), which the merge step prefers over the stub. The Zod schema you reused for validation is the source for that request-body schema.
