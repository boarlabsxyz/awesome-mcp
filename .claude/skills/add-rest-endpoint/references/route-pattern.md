# Canonical REST route pattern

The shape every `GET /api/v1/*` handler in `src/website/webServer.ts` follows, and why each part is there. Read this before generating a handler.

## The skeleton

```ts
// GET /api/v1/<service>/<resource>/:id - <summary>
app.get('/api/v1/<service>/<resource>/:id', require<X>ApiKey, async (req: ApiAuthenticatedRequest, res) => {
  try {
    const id = req.params.id as string;
    const limit = qint(req.query.limit, 50, { max: 200 });
    const cursor = qstr(req.query.cursor) || undefined;

    const result = await <upstream call>;

    res.json(result);
  } catch (err) {
    sendUpstreamError(res, err, { notFound: '<Resource> not found', fallback: 'Failed to <verb>' });
  }
});
```

Five invariants: service-specific auth middleware, `ApiAuthenticatedRequest` typing, coerced query params, raw upstream JSON in the success path, and a shared error mapper in the catch.

## Auth middleware

Never hand-roll the bearer check. `createServiceAuth(primarySlug, fallbackSubstring)` resolves bearer → user → that user's MCP connection for the service → a provider-specific `UserSession` on `req.userSession`. It accepts three token kinds: the 5-minute REST bearer from `mintRestBearerForCurl`, the permanent dashboard API key (ChatGPT Custom Actions compat), and an Auth0 opaque token.

The middleware constants live together around line 2602. Use the one matching your service; add one if it doesn't exist.

`req.userSession!` is non-null inside a handler — the middleware always sets it before `next()`. The `!` is the house style; don't add a redundant guard *except* for token-shape checks the middleware can't make (see Slack below).

## Query parameters — always coerce

```ts
import { qstr, qint } from '../util/queryParams.js';
```

`req.query.X` is `string | string[] | ParsedQs | ParsedQs[] | undefined`. The old `(req.query.X ?? '').toString()` pattern produced `'[object Object]'` for a nested query like `?foo[bar]=baz` and silently corrupted downstream parsing. `qstr` falls back to a default for non-string input; `qint` parses base-10 with `{ min, max }` clamping.

Always clamp anything that sizes a response: `qint(req.query.limit, 50, { max: 200 })`. The whole point of the data plane is bulk reads, so an unclamped limit is an easy way to hand someone a 200 MB response.

Path params are typed `string | undefined` by Express; cast with `as string` as the surrounding routes do.

## Success path — raw upstream JSON

Default behavior is the untransformed upstream payload from Google/Slack/ClickUp. Callers reach for REST precisely to `jq` the real thing.

Two acceptable deviations:

1. **Light envelope** when the upstream response buries the payload or hides pagination:
   ```ts
   res.json({ channels: result.channels, nextCursor: result.response_metadata?.next_cursor || null });
   ```
2. **Field projection** when the caller asked for text and the full payload is wasteful — see `DOC_TEXT_FIELDS` in the docs route, which narrows the Google `fields` mask instead of fetching everything and throwing it away.

## Content negotiation

```ts
respondNegotiated(req, res, jsonPayload, () => formatEmployeeList(jsonPayload));
```

`webServer.ts` currently imports only `negotiateFormat` from `./restContent.js` (line ~305). `respondNegotiated` is exported there but unused so far — widen that import when you're the first to use it.

`negotiateFormat(req)` returns `'text'` for `?format=text|plain|markdown` or `Accept: text/plain|text/markdown`, else `'json'`. `respondNegotiated` computes the JSON once and only invokes the render callback when text was requested — so pass a **thunk**, never a pre-rendered string.

Only offer text where a formatter already exists in the MCP server module; reuse it by import rather than reimplementing, so the REST text output and the MCP tool output can't drift. Endpoints with no formatter simply return JSON, which is the documented default.

For a hand-rolled text response (streaming, truncation), the direct form is:

```ts
res.type('text/plain; charset=utf-8').send(text);
```

## Errors

```ts
import { sendUpstreamError } from './restUpstreamError.js';
```

It reads `err.code` (googleapis), `err.response.status` (axios-style clients), then `err.status`, and maps 404 → `{ error: notFound }`, 403 → `{ error: 'Permission denied' }`, everything else → 500 with `err.message` or your `fallback`. `fallback` is required so the failing operation is always named in the payload.

Slack is the exception — its errors are string codes, not statuses, so Slack routes use `res.status(mapSlackErrorToHttpStatus(err)).json({ error: err.message || '<fallback>' })`. A new provider whose client throws string codes needs its own mapper in the same style rather than a bare 500.

Validation failures (a missing required query param) are yours to return before touching upstream:

```ts
if (!workspaceId) {
  res.status(400).json({ error: 'workspaceId query parameter is required' });
  return;
}
```

Always `return` after writing a response — these handlers are `async` and falling through double-sends.

## Provider session access

| Provider | Access on `req.userSession` |
|---|---|
| Google (docs/sheets/calendar/drive/gmail/slides) | `req.userSession!.googleDocs`, `.googleDrive`, … or `google.drive({ version: 'v3', auth: req.userSession!.oauthClient })` for a client not on the session |
| ClickUp | `new ClickUpClient(req.userSession!.clickUpAccessToken!)` |
| Slack | `new SlackClient(req.userSession.slackBotToken)` — guard first, see below |
| Outline | `outlineAccessToken` |
| HubSpot / PeopleForce | `createHubSpotSession` / `createPeopleForceSession` exist in `src/userSession.ts` but **are not yet branched in `createServiceAuth`** — add the branch before the first route |

Third-party clients are imported dynamically inside the handler (`const { SlackClient } = await import('../slack/apiHelpers.js')`) to keep the web server's startup import graph small. Follow that.

Slack needs an explicit connection-shape guard the middleware can't make, because a `slack-user` (xoxp) connection carries access rules the REST layer doesn't enforce:

```ts
if (!req.userSession?.slackBotToken) {
  res.status(403).json({ error: 'Slack-bot connection required for REST. Connect via the dashboard.' });
  return;
}
```

## Route ordering

Express matches in registration order. Any static segment that could be read as a param must be registered first:

```ts
app.get('/api/v1/docs/recent', …);        // must come first
app.get('/api/v1/docs/:documentId', …);   // otherwise "recent" is a documentId
```

Applies to `/search`, `/trash`, `/archived`, `/shared-drives` and friends. Leave the comment explaining the ordering, as the docs route does — it's the kind of thing a later refactor reorders without thinking.

## Binary and streaming responses

`downloadDriveFile` is the reference: it sets `Content-Type` and a best-effort `Content-Disposition` from upstream metadata and pipes the stream. Google native types get exported (PDF for docs/slides, CSV for sheets, PNG for drawings) with `?exportMime=` to override. Copy that route wholesale rather than inventing a second streaming style, and record the behavior in the catalog entry's `notes`.

## Logging

REST handlers use `console.error` for failures (`console.error('Error reading doc:', err)`) — the FastMCP `log.info` breadcrumb from the MCP tools has no equivalent here. Log before delegating to `sendUpstreamError` when the error deserves server-side detail; skip it for routine 404s.
