# Usage analytics — notes for Claude

## Rules and limitations

- **Analytics record tool calls, NOT prompts.** MCP never carries the user's message: a server sees only the tool name, the arguments the model wrote and the client's `clientInfo`. No protocol field can recover the prompt; query-like arguments are the closest stand-in for intent.
- **Every call lands in `tool_call_events`** (DDL in `src/db.ts`), from two chokepoints.
  - **MCP:** `instrumentServer` replaces `addTool`/`addTools` and wraps each `execute`. FastMCP has no per-call hook and keeps tools in a private `#tools`, so the wrap must happen **at construction**, before the first tool registers (tools register at import time, `src/sharedTools` included). Hence every server is `instrumentServer(new FastMCP(...), '<catalog slug>')`, guarded by `src/__tests__/usage/instrumentRegistration.test.ts` — an untracked server would read as "nobody uses it".
  - **REST:** `restUsageMiddleware`, mounted at the top of `registerRestApiRoutes` so all three app factories get it. It records **authenticated** calls only (an anonymous probe would bury real usage), under the route **template**, never the raw path.
- **Never change a call's outcome.** The result is returned and the error rethrown untouched; recording sits in its own try/catch.
- **Store as little as possible.**
  - Every argument's NAME and the call's byte size are kept, but a VALUE only for the `PREVIEW_KEYS` allowlist in `argSummary.ts` (`query`, `textToFind`, `title`, …). Kept values are cut to 200 chars with `sliceSafe` and run through `redactSecrets`.
  - Arrays and objects become `{type, length}`. Person-name fields and `subject` are excluded.
  - **REST bodies are never summarised.** Error messages are redacted and capped at 500 chars.
- **Analytics must never fail or slow a call.** Writes are buffered (5 s / 200 rows, capped at 5,000 by dropping the OLDEST), and a failed flush drops its batch, so a crash costs at most one flush interval.
- **Config:** `USAGE_TRACKING=off` disables recording. `USAGE_RETENTION_DAYS` defaults to 30 (`0` = forever) and is pruned every 6 h.
- **`session.instanceId` is set in every `create*Session`**, so two connectors of one service stay apart.
- **`user_id` has no FK**, so deleting a user never fails on analytics rows. The operator's privacy policy should mention this logging.

## Source Files

| File | Contains |
|------|----------|
| `src/usage/instrumentServer.ts` | Wraps a FastMCP server's `addTool` at construction so every tool call is recorded |
| `src/usage/argSummary.ts` | What a call's arguments are reduced to before storage — key names, size, allowlisted values, secret redaction |
| `src/usage/usageStore.ts` | Buffered writer + retention for `tool_call_events`; never throws into a tool call |
| `src/usage/restUsageMiddleware.ts` | Records authenticated `/api/v1/*` calls under their route template |
