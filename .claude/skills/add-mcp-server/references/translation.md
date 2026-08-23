# Tool Translation Reference

Read this only when porting tools from a reference repo. Each reference repo brings its own schema, auth, and error conventions; this doc maps them onto this codebase's FastMCP + Zod + UserSession + UserError shape.

## Tool discovery

Different MCP frameworks declare tools differently. Grep the source for these patterns to find the tool list.

### TypeScript source

| Pattern | Framework |
|---------|-----------|
| `.addTool({` | FastMCP |
| `server.tool(` / `.tool(` | MCP SDK high-level |
| `setRequestHandler('tools/list'` + `setRequestHandler('tools/call'` | MCP SDK low-level — tools usually live in a list constant nearby |
| `tools: [{ name: ..., ... }]` inside a server constructor | declarative |

### Python source

| Pattern | Framework |
|---------|-----------|
| `@server.tool()` / `@app.tool()` / `@mcp.tool()` | MCP Python SDK + FastMCP-py |
| `Tool(name=...)` instances | declarative MCP SDK |
| `list_tools` / `call_tool` handlers | low-level MCP SDK |

For each tool, extract: `name`, `description` (docstring is fine when there is no explicit description), parameters, and the body.

## Schema translation

Source schema → Zod. Aim for one-to-one shape where possible; flag with TODO when the source uses a custom validator that doesn't have a Zod equivalent.

| Source | Zod |
|--------|-----|
| `str` / `string` | `z.string()` |
| `int` / `float` / `number` | `z.number()` |
| `bool` / `boolean` | `z.boolean()` |
| `list[T]` / `T[]` | `z.array(...)` |
| `dict[str, T]` / `Record<string, T>` | `z.record(z.string(), ...)` |
| `Optional[T]` / `T \| None` / `T?` | `.optional()` |
| `Field(default=x)` / `= x` | `.default(x)` |
| Pydantic `Field(description="...")` / JSDoc | `.describe('...')` |
| `Literal["a", "b"]` / `'a' \| 'b'` | `z.enum(['a', 'b'])` |
| Pydantic `BaseModel` | nested `z.object({...})` |

## Auth and client wiring

This codebase injects clients through `session: UserSession`. Don't carry over the source's auth pattern verbatim — translate.

| Source pattern | This repo |
|---------------|-----------|
| `os.environ['API_KEY']` / `process.env.API_KEY` | `session.<tokenField>` — accessed via a small `get<X>Client(session)` helper at the top of `server.ts` |
| Bearer token in headers | `apiHelpers.ts` client constructor takes the token |
| Constructor-injected SDK client | Build the client per-call from `session.<tokenField>` |
| Google SDK client init | Reuse `session.google<X>` — never re-instantiate |

## Errors

User-facing failures use `UserError` from `fastmcp` so they surface cleanly through the MCP protocol. Unexpected errors (5xx, network) should be logged via `log.error(...)` and then thrown as `UserError` too — the caller does not need the stack.

| Source pattern | This repo |
|---------------|-----------|
| `raise ValueError(msg)` / `throw new Error(msg)` | `throw new UserError(msg)` |
| HTTP 4xx the user can fix | `throw new UserError(msg)` |
| HTTP 5xx / unexpected | `log.error(...)` then `throw new UserError(...)` |

## Tool naming

Keep the source name if it's already camelCase. Convert snake_case → camelCase. Preserve the description verbatim (just trim whitespace).

## Resources, prompts, and other MCP primitives

The MCP spec also defines resources, prompts, and other primitives. The skill ports tools only — porting the rest correctly requires context we don't have. If the source uses heavy resource/prompt machinery, mention it in the final report so the user knows what was skipped.

## When to stub instead of translate

A full translation is honest only when the source body is straightforward. Pick TODO-stub when any of these are true:

- Source body > ~30 lines.
- Multi-step orchestration (e.g. paginate → filter → fetch detail).
- Custom retry / backoff / rate-limit logic.
- Token refresh handled inline.
- File I/O or local state.
- Anything you'd have to guess at.

The stub template lives at `assets/ported-tool-todo.ts.tmpl`. It pastes the original body inside a block comment and throws `UserError('Not yet implemented')` so the build still compiles.
