# Canonical tool pattern

This document is the single source of truth for the shape of a tool in this repo. Both `add-mcp-tool` (adding to an existing server) and `add-mcp-server` (scaffolding a new server with an example tool) reference it. If you update the pattern, update it here and the rest of the repo follows.

## The shape

Every tool calls `addTool({ name, annotations, description, parameters, execute })` on a FastMCP server instance. The `execute` callback receives `(args, { log, session })`. Pulling the API client out of the session via a small `get<X>Client(session)` helper at the top of the server file keeps the tool bodies focused on the operation.

```ts
<serverConst>.addTool({
  name: '<toolName>',
  annotations: { readOnlyHint: true },        // ← include for read-only tools; omit for write tools
  description: '<one-line, action-first description>',
  parameters: z.object({
    <paramName>: z.<type>()<modifiers>.describe('<what the param means>'),
    // ...
  }),
  execute: async (args, { log, session }) => {
    const client = get<X>Client(session);
    log.info(`<one-line breadcrumb with the key argument>`);

    try {
      const response = await client.<sdk-call>({ /* ... */ });
      // shape the response into a useful string
      return formatResult(response);
    } catch (error: any) {
      log.error(`Error <doing thing>: ${error.message || error}`);
      if (error.code === 403) throw new UserError('Permission denied. ...');
      throw new UserError(`Failed to <do thing>: ${error.message || 'Unknown error'}`);
    }
  },
});
```

## Why each piece is there

- **`annotations: { readOnlyHint: true }`** lets the MCP client (Claude Desktop, ChatGPT) display read-only tools differently and is the signal the e2e harness uses to decide read vs write fixturing. Adding this to a write tool will silently mis-categorize it; omitting it from a read tool will block it on the readonly connector. Match the intent.
- **`description` is action-first** because the LLM uses it to pick which tool to call. `"Lists all calendars accessible to the user."` is good; `"Calendars endpoint"` is not. Keep it under ~120 characters.
- **Zod parameters with `.describe()` on every field** — the LLM uses the descriptions to fill arguments. Optional fields use `.optional()` (no value passed) or `.optional().default(...)` (default applied on the server side).
- **`log.info` before the API call** leaves a breadcrumb in the e2e forensics bundle that makes failures triagable. Pass the key argument (`documentId`, `calendarId`, the query) — not the whole `args` object, which can be noisy.
- **`UserError` from `fastmcp` is the only error type that surfaces cleanly through MCP.** Wrap user-fixable failures (4xx) with a friendly message; wrap unexpected errors (5xx, network) with `Failed to X: {error.message}`. Plain `throw new Error(...)` works but the message isn't shaped for the LLM-to-user surface.
- **Return a string, not an object.** The MCP protocol expects text content. Format with newlines and `**bold**` for human readability — the LLM forwards it to the user largely verbatim. For lists, prefix with the count: `"Found 3 calendars:\n\n..."` so the LLM can summarize accurately.

## Auth / client wiring

The server file defines a `get<X>Client(session)` helper near the top — exactly one per server. Tools then call it instead of touching `session` directly. This is what isolates the auth check.

### Google flavor

```ts
function getDocsClient(session?: UserSession): docs_v1.Docs {
  if (session?.googleDocs) return session.googleDocs;
  throw new UserError('Google Docs client is not available. Make sure you have granted Docs access.');
}
```

The session has all six Google clients prebuilt; the helper just guards the typing and produces a useful error when the auth handshake hasn't happened.

### Third-party flavor

```ts
function getClickUpClient(session?: UserSession): ClickUpClient {
  if (!session?.clickUpAccessToken) {
    throw new UserError('ClickUp not connected. Visit the dashboard to connect your ClickUp account.');
  }
  return new ClickUpClient(session.clickUpAccessToken);
}
```

For third-party providers we don't have a prebuilt SDK on the session — just the token. The helper builds the client (which lives in `apiHelpers.ts`) on demand.

## Tool naming

- camelCase, verb-first: `listEvents`, `createSpreadsheet`, `insertText`, `formatMatchingText`.
- Match the surrounding tools in the same server file. If the file already has `listX` / `getX` / `createX` patterns, keep going with them rather than inventing `fetchX` or `makeX`.
- For Google services, prefer the SDK's noun where possible: `events.list` → `listEvents`, `documents.batchUpdate` → `batchUpdateDoc`.

## Parameter conventions

- IDs are required strings: `documentId`, `spreadsheetId`, `fileId`, `calendarId`, `eventId`. Always `.describe('The ID of the X (from the URL).')` so the LLM knows where to find it.
- Hex colors validate to `/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/` — reuse the existing Zod helper in `src/types.ts` rather than redefining.
- Alignment uses `z.enum(['START', 'END', 'CENTER', 'JUSTIFIED'])` — these are Google's terms, not LEFT/RIGHT. CLAUDE.md flags this explicitly because the wrong values fail silently.
- Indices are 1-based, ranges are `[startIndex, endIndex)`. Match `src/types.ts` `RangeParameters`.
- For complex composed schemas (text style, paragraph style, batch operations), import the shared object from `src/types.ts` rather than redefining it.

## Read vs write classification

The same boolean shows up in two places — `annotations.readOnlyHint` on the tool itself, and the array the tool name goes in inside `e2e/tools.ts`. Keep them in sync. The runbook depends on `WRITE_TOOLS` being the exact set of mutating tools — adding a read tool there causes it to be unchecked on the readonly connector for no reason; missing a write tool causes data corruption on the readonly fixture account.

If you're unsure: the test is "does this tool change state in the user's account?" Comments count. Exporting to PDF counts (it creates a file in Drive). Stylistic changes count. A pure list/get/search/inspect does not.

## Response formatting conventions

Look at `listCalendars` in `src/google-calendar/server.ts` for the canonical list-shaped response: a count line, blank line, then numbered items with indented fields. Match this when adding new list-flavored tools — the LLM-facing output stays consistent and users stop seeing the answer formatted differently from one tool to the next.

For single-item responses, prefer key-value lines with two-space indent under a short header:

```
Event:
  ID: <id>
  Summary: <title>
  Start: <iso>
  ...
```

For tools that mutate without much to report back, return a single confirmation sentence: `"Inserted text at index 1 in document <id>."`

## When the source SDK's response is huge

Don't dump it. Pick the fields a human would actually read and format those. Tools that returned 50KB of Google API JSON make the LLM hit token limits and produce broken summaries downstream. If the user truly needs the raw response, expose it through a follow-up tool with a narrower scope.
