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

## Body size

The global `app.use(express.json())` at line ~837 sets **no explicit limit**, so Express's 100 kb default applies. A write endpoint whose whole justification is a large request body will 413 at 100 kb with a raw Express HTML error, which is a bad look.

Mount a per-route parser with an explicit limit rather than raising the global one:

```ts
app.post('/api/v1/sheets/:spreadsheetId/rows', express.json({ limit: '5mb' }), requireSheetsApiKey, async (req, res) => {
```

Pick the smallest limit that fits the use case and record it in the catalog `notes` so the docs state it. Note the ordering the file already uses for binary routes: a route-specific body parser must be registered before the handler, and the raw-body routes (`express.raw`) are deliberately mounted **before** the global `express.json()` — don't disturb that.

## Status codes and response shape

| Situation | Status | Body |
|---|---|---|
| Created a resource | `201` | The created resource, including its new id |
| Updated / appended | `200` | The updated resource or a result summary |
| Body failed validation | `400` | `{ error, issues }` from `flatten()` |
| Upstream 404/403 | via `sendUpstreamError` | `{ error }` |

Follow `POST /api/v1/calendars/:calendarId/events`: it returns 201 with the created event's fields rather than a bare `{ ok: true }`. Callers chaining curls need the id, and a caller who has to issue a follow-up GET to learn what happened defeats the pipeline the endpoint exists to serve.

Idempotency: HTTP POST isn't idempotent and this layer has no request-id dedupe. If the underlying operation is dangerous to repeat (creating a payment-ish record, sending a message), say so in the catalog `notes`. Don't invent a dedupe mechanism unilaterally — that's a design decision for the user.

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

Beyond the gate, add a validation test for the `safeParse` branch — a malformed body returning 400 with issues, no upstream mock needed.

## OpenAPI

`buildRootOpenapi.mjs`'s stub pass emits `operationId`, `summary`, `description`, `tags`, and 200/401/403/404 responses. It has **no `requestBody`** and no 201/400. For a POST endpoint that stub is actively misleading — a generated client would call it with no body.

Chain `/update-openapi <provider>` in the same change to write a real entry in the per-service spec (`public/openapi-<service>.json`), which the merge step prefers over the stub. The Zod schema you reused for validation is the source for that request-body schema.
