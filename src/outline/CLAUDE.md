# Outline — notes for Claude

## Rules and limitations

- **No `documents.unarchive` endpoint** — `unarchiveDocument` and `restoreDocument` both POST `/api/documents.restore` (verified live); a test pins both, so don't "fix" the asymmetry.
- **REST routes must not use `withOutlineClient`** — `mapOutlineError` strips the status, so a 404 becomes 500. Call `maybeRefreshOutlineToken` then `getOutlineClient` (refresh mutates the session) and let `sendUpstreamError` read `.status`.
- **Refresh is mandatory and single-flight** — Outline rotates the refresh token on every use.
- **`deleteDocument`/`deleteCollection` have no REST route on purpose** — collection delete destroys every document, no undo.

## Source Files

| File | Contains |
|------|----------|
| `src/outline/server.ts` | Tool definitions (`OUTLINE_BASE_URL`, defaults to dev wiki) |
| `src/outline/apiHelpers.ts` | `OutlineClient` — Bearer-token API client |
| `src/outline/restOps.ts` | Each write's camelCase fields (`createDocumentFields`, …) + op, shared by `server.ts` and `webServer.ts` |
