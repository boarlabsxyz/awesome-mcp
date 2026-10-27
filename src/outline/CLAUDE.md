# Outline — notes for Claude

## Known Limitations

- **Outline has NO `documents.unarchive` endpoint, and its REST plane must not reuse `mapOutlineError`:** `OutlineClient.unarchiveDocument` and `restoreDocument` both POST to **`/api/documents.restore`** (verified against wiki.gluzdov.com and matching the reference implementation); hitting a `documents.unarchive` would 404. The two REST paths are kept separate because the caller's *intent* differs, not the call, and a test asserts both land on `documents.restore` so a future tidy-up that "fixes" the asymmetry gets caught. Separately, the REST routes deliberately do **not** wrap calls in `withOutlineClient`: its `mapOutlineError` flattens Outline's 404 and 403 into a `UserError` carrying **no status**, so a document that simply does not exist would be reported as 500 — or, once a handler branches on the `UserError` name, as 400. The raw client error carries `.status`, which `sendUpstreamError` reads, so the REST path keeps refresh-then-client (`maybeRefreshOutlineToken` → `getOutlineClient`, in that order, since the refresh mutates the session in place) and maps errors itself. That refresh is mandatory, not defensive: Outline **rotates the refresh token on every use**, and the helper is single-flight per connection so two concurrent REST calls cannot race to spend the same one and kill the connection on the call after next.

## Source Files

| File | Contains |
|------|----------|
| `src/outline/server.ts` | Outline wiki tool definitions (self-hosted at wiki.gluzdov.com; base URL via `OUTLINE_BASE_URL`, defaults to dev wiki) |
| `src/outline/apiHelpers.ts` | `OutlineClient` — Bearer-token HTTP client for Outline REST API |
| `src/outline/restOps.ts` | The ONE definition of each Outline write's camelCase fields (`createDocumentFields`, …) plus its op; `outline/server.ts` and `webServer.ts` both compose from it |
