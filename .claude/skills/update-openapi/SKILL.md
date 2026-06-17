---
name: update-openapi
description: Sync the OpenAPI specs in public/openapi*.json with the actual MCP tool surface defined in src/<provider>/server.ts. Diffs tools against operationIds, scaffolds new operation entries from each tool's Zod parameter schema, flags missing or stale entries, and updates descriptions that drifted. Used to keep the ChatGPT Custom Actions surface in sync with the MCP tools — these specs are how the REST clients discover what tools exist, so drift causes silent breakage downstream. Use this skill whenever the user wants to update, regenerate, sync, or audit OpenAPI specs after adding or modifying MCP tools, or invokes `/update-openapi [provider]`.
metadata:
  argument-hint: <provider | all>
---

# Update OpenAPI

Sync `public/openapi*.json` with the tools actually defined in `src/<provider>/server.ts`. These specs are how ChatGPT Custom Actions and external REST consumers discover the tool surface; when they drift, downstream integrations silently break.

The mapping from MCP tool → OpenAPI operation is not 1:1 trivial — HTTP method and path are judgment calls. This skill diffs the two sides, scaffolds draft entries for what's missing, and surfaces what needs human review. It does not blindly regenerate the file from scratch; that would lose the manually-curated paths, request bodies, and response schemas that already work.

For the scaffold rules (HTTP method by tool name, path shape, Zod → OpenAPI translation, required fields per operation), read `references/scaffold-rules.md`.

## Inputs

- `[provider]` — one of `docs` / `sheets` / `calendar` / `gmail` / `drive` / `slides` / `clickup`, or `all`. Default: `all`. Loose aliases accepted (`google-sheets`, `google sheets` → sheets).

If `[provider]` is unrecognized, ask. Don't default to `all` when the user clearly meant one provider but typed a typo.

## Procedure

### 1. Resolve the provider → file mapping

See the table in `references/scaffold-rules.md` for which server file maps to which OpenAPI file. Note that `google-docs` maps to `public/openapi.json` (the default name), not `public/openapi-docs.json`.

If the user picked `all`, iterate over every provider that has both a server file and an OpenAPI file. Skip providers with no OpenAPI file (e.g. Slack) and mention them in the report.

### 2. Extract the tool surface from `server.ts`

For each target provider, read `src/<provider>/server.ts` and parse every `addTool({ ... })` block. Collect:

- `name` — the operationId in OpenAPI terms.
- `description` — the operation description.
- `annotations.readOnlyHint` — implies HTTP method GET.
- `parameters` — the Zod object schema.

Be tolerant of formatting — multi-line `description` strings, nested Zod schemas, comments inside the addTool block.

### 3. Extract the operation surface from the OpenAPI file

Read the OpenAPI JSON and walk `paths.<path>.<method>` entries. Collect:

- `operationId` — used to match against tool names.
- `description` — for drift detection.
- The full operation object — preserved as-is if no changes are needed.

### 4. Compute the diff

Produce three lists:

- **New tools** — operationId exists in server.ts but not in any operation in the OpenAPI file. These get a draft scaffold (step 5).
- **Stale operations** — operationId exists in the OpenAPI file but not in server.ts. Flag these; do NOT delete automatically. The user might have intentionally kept a deprecated entry, or the tool was renamed and the operationId needs a rename + deprecation note.
- **Drifted descriptions** — operationId matches but the description in server.ts differs from OpenAPI. Patch these.

For each side, also list:
- Tools in `NOT_IMPLEMENTED` (from `e2e/tools.ts`) — these probably shouldn't be in OpenAPI either; if they appear, flag.

### 5. Scaffold new operations

For each new tool, follow `references/scaffold-rules.md` to produce the OpenAPI operation:

- HTTP method from the tool name prefix table.
- Path from the resource hierarchy.
- Parameters / requestBody from the Zod schema using the translation table.
- Responses: 200 (success), 400 (bad request, `$ref` Error), 401 (unauthorized, `$ref` Error). Add 403/404/etc. only if the tool's failure modes warrant it.

Important: the scaffold is a starting point. For non-trivial path choices (a tool that does something the existing path structure doesn't anticipate), leave the path as `/api/v1/<resource>/TODO-<toolName>` and flag in the report — that's the user's call.

For tools that return formatted strings (most read tools), use `{ "type": "string" }` as the 200 response schema. For tools that return structured data the user wants typed, leave the response schema as `{ "type": "object", "description": "TODO: define response shape" }` and flag — adding a new component to `components.schemas` should be deliberate.

### 6. Show the diff before writing

When new operations are scaffolded, drifted descriptions are patched, or stale operations are flagged, **print the diff first** (or a compact summary if it's large) and ask the user to confirm before writing the file. Stale flags never trigger a write; they're surfaced for the user's judgment.

Concretely:

```
Provider: sheets (public/openapi-sheets.json)

New operations to add (4):
  + listSheetsTabs   GET  /api/v1/sheets/{spreadsheetId}/tabs
  + renameSheetsTab  POST /api/v1/sheets/{spreadsheetId}/tabs/{tabId}/rename
  + ...

Drifted descriptions to patch (2):
  ~ readSpreadsheet
  ~ writeSpreadsheet

Stale operations (flagged, NOT auto-removed):
  ! deleteSheet     — not in server.ts. Renamed to deleteSpreadsheet? Confirm.

Path TODOs (1):
  ? exportSheetsAsPdf — couldn't infer path; please confirm placement.

Apply these changes?
```

### 7. Write the file

Once confirmed, write the updated OpenAPI JSON. Preserve the existing key order — JSON has no semantic order, but minimizing diff noise matters for review. Use the same indentation as the existing file (most use 2 spaces).

### 8. Verify

Run `jq . public/openapi-<file>.json > /dev/null` (or `jq empty`) to confirm valid JSON. There is no schema validator wired into this repo, but if `jq` reports a parse error the file is unusable.

For a sanity check, also count: the number of `operationId` entries should equal the number of tools in the server file minus tools that are intentionally omitted (Slack-style server with no OpenAPI). Surface this count in the report.

### 9. Report

```
Synced <N> OpenAPI files:

  public/openapi-sheets.json
    Added: <count> operations
    Patched: <count> descriptions
    Flagged stale: <count>
    Path TODOs: <count>

  public/openapi-calendar.json
    ...

Operations in OpenAPI vs tools in server.ts (after sync):
  sheets:   <opcount> / <toolcount>
  calendar: <opcount> / <toolcount>
  ...

Manual follow-ups:
  - Confirm path for <provider>.<tool> (TODO marker in the JSON)
  - Decide whether to remove stale operation <provider>.<op> from OpenAPI
```

## When the OpenAPI file is missing for a provider

Don't create it on the fly. New OpenAPI files are a design decision — they require server URL setup, security scheme config, and component schemas. If the user wants a new file for Slack or another provider, that's a separate ticket; surface the gap in the report and stop.

## Failure modes

- **Server file has tools with no parameters and no Zod schema** — unusual but possible (a `z.object({})` tool like `ping`). Generate an operation with an empty `parameters` array and a body that's `null`/empty.
- **OpenAPI file has operations the server's never had** — stale flag only; never auto-delete.
- **Description in server.ts is multi-line / contains template literals** — keep the multi-line content; in OpenAPI, collapse newlines to spaces (OpenAPI tooling renders descriptions as paragraphs).
- **Tool name conflict** (two tools with the same name in different providers) — should be impossible per `add-mcp-tool`'s uniqueness check, but if it shows up, flag it as a real bug, not just OpenAPI drift.

## File layout

```
update-openapi/
├── SKILL.md
└── references/
    └── scaffold-rules.md   ← HTTP-method table, path conventions, Zod → OpenAPI translation
```

## Relationship to other skills

- **`add-mcp-tool`** is the natural upstream — it adds a tool but doesn't update OpenAPI. Run `update-openapi <provider>` after a session of tool additions, or wire `/update-openapi` into your pre-PR checklist.
- **`add-mcp-server`** doesn't create an OpenAPI file for new servers — see the "When the OpenAPI file is missing" note above. The user makes that call separately.
