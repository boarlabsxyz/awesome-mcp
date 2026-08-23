# OpenAPI scaffold rules

Each MCP tool maps to one OpenAPI operation. The mapping is conventional, not mechanical — picking the HTTP method and path is a judgment call the skill makes explicit. These rules keep new entries consistent with the existing files.

## File ↔ provider table

| Provider (server file) | OpenAPI file |
|---|---|
| `src/google-docs/server.ts` | `public/openapi.json` (not `openapi-docs.json` — the default file is the docs surface) |
| `src/google-sheets/server.ts` | `public/openapi-sheets.json` |
| `src/google-calendar/server.ts` | `public/openapi-calendar.json` |
| `src/google-gmail/server.ts` | `public/openapi-gmail.json` |
| `src/google-drive/server.ts` | `public/openapi-drive.json` |
| `src/google-slides/server.ts` | `public/openapi-slides.json` |
| `src/clickup/server.ts` | `public/openapi-clickup.json` |
| `src/slack/server.ts` | (no OpenAPI file yet — Slack isn't exposed as REST) |

If a server file has no matching OpenAPI file, the skill skips that provider with a one-line note rather than scaffolding a new file. New OpenAPI files are a design decision, not a side effect of tool addition.

## HTTP method by tool prefix

Pick by what the tool actually does, not by name. These prefixes are a good starting point and match the existing entries:

| Tool name prefix | HTTP method | Why |
|---|---|---|
| `list*`, `get*`, `search*`, `read*`, `find*`, `inspect*` | `GET` | Idempotent, read-only |
| `create*`, `import*`, `add*` (creating a new resource) | `POST` | Server creates and assigns an id |
| `update*`, `set*`, `apply*`, `edit*`, `format*`, `findAndReplace`, `move*`, `batchUpdate*` | `POST` (matching existing entries) — sometimes `PATCH` if the entry is a partial update of an existing path |
| `delete*`, `clear*`, `resolve*` | `DELETE` (when targeting a specific id) or `POST` (when the action is logical, not RESTful) |
| `append*`, `insert*` | `POST` to a sub-resource path (e.g. `/{id}/append`) |
| `export*`, `move*`, `copy*` | `POST` |

If you can't decide, copy the method from the most similar existing entry in the same file.

## Path shape

Paths in the existing files follow this hierarchy:

- Top-level resource collection: `/api/v1/<resource>` (e.g. `/api/v1/sheets`, `/api/v1/docs`, `/api/v1/calendars`).
- Specific resource by id: `/api/v1/<resource>/{<id-param>}` (e.g. `/api/v1/sheets/{spreadsheetId}`).
- Action on a resource: `/api/v1/<resource>/{<id-param>}/<verb>` (e.g. `/api/v1/sheets/{spreadsheetId}/append`).

ID parameters in the path must appear in the operation's `parameters` array with `"in": "path"`, `"required": true`.

## Parameters

Zod → OpenAPI parameter / schema translation:

| Zod | OpenAPI |
|---|---|
| `z.string()` | `{ "type": "string" }` |
| `z.number()` | `{ "type": "number" }` or `{ "type": "integer" }` if the source is `z.number().int()` |
| `z.boolean()` | `{ "type": "boolean" }` |
| `z.enum(['A', 'B'])` | `{ "type": "string", "enum": ["A", "B"] }` |
| `z.array(<T>)` | `{ "type": "array", "items": <T> }` |
| `z.object({...})` | `{ "type": "object", "properties": {...}, "required": [...] }` |
| `.optional()` | omit from `required` array; do not change the parameter's `required` field |
| `.default(x)` | `{ "default": x }` |
| `.describe('...')` | `"description": "..."` |
| `.min(n)` / `.max(n)` on strings | `{ "minLength": n, "maxLength": n }` |
| `.min(n)` / `.max(n)` on numbers | `{ "minimum": n, "maximum": n }` |

Body params (POST/PATCH) go in `requestBody`. Query params (GET) and path params go in `parameters`.

## Required scaffold fields per operation

Every new operation needs at minimum:

```json
{
  "operationId": "<toolName>",
  "summary": "<short title, 3-5 words>",
  "description": "<the tool's description from server.ts>",
  "parameters": [ /* path + query params */ ],
  "requestBody": { /* only for non-GET */ },
  "responses": {
    "200": { "description": "...", "content": { "application/json": { "schema": { ... } } } },
    "400": { "description": "Bad request", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } },
    "401": { "description": "Unauthorized", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } }
  }
}
```

`Error` schema lives in `components.schemas` of every existing file — reuse the `$ref`, don't redefine it.

## When the response schema isn't obvious

Tools that return formatted strings (most read tools) should have a 200 schema of `{ "type": "string" }`. Tools that return structured data should have a typed response — if the type isn't already in `components.schemas`, add it there and `$ref` it from the operation. Don't inline complex response schemas in the operation — they get unwieldy.

## What to do, what NOT to do automatically

Always: add new operations for tools that exist in the server but not in OpenAPI.

Never automatically: remove operations for tools that no longer exist in the server. They might be deprecated tools we still want to document, or the tool got renamed. Flag for the user to confirm.

Always: update the `description` field if the server.ts description changed.

Never: change the operationId for an existing operation, even if the tool was renamed. Renames need a deprecation cycle.
