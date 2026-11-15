# Outline — notes for Claude

## Rules and limitations

- **No `documents.unarchive` endpoint** — `unarchiveDocument` and `restoreDocument` both POST `/api/documents.restore` (verified live); a test pins both, so don't "fix" the asymmetry.
- **REST routes must not use `withOutlineClient`** — `mapOutlineError` strips the status, so a 404 becomes 500. Call `maybeRefreshOutlineToken` then `getOutlineClient` (refresh mutates the session) and let `sendUpstreamError` read `.status`.
- **Refresh is mandatory and single-flight** — Outline rotates the refresh token on every use.
- **`deleteDocument`/`deleteCollection`/`deleteComment` have no REST route on purpose** — collection delete destroys every document, no undo. `archiveCollection` does have one: it is undone by `restoreCollection` and deletes nothing.
- **Write tools call the `perform*` ops in `restOps.ts`; never map fields to Outline's body in `server.ts`** — a second copy is how a new field reaches one surface and not the other.
- **Passage edits (`findText`) are guarded** — Outline before `editMode` ignores it and replaces the WHOLE body with the passage. `performUpdateDocument` reads first (400 if the passage is absent, nothing written), and if the answer is exactly the replacement it writes the original markdown back and fails with 502. Non-markdown formatting may then need restoring from history; the message says so.
- **Newer endpoints may 404 on older self-hosted Outline** — templates, `editMode`, comment anchors, `collections.archive`. Descriptions say "needs a recent Outline"; fields that come back missing are named (`notReflected`, anchor not echoed) rather than reported done.
- **Attachment bytes: bearer only to Outline itself** — a relative `uploadUrl` is local storage (`/api/files.create`, takes our bearer); an absolute one is presigned storage and gets no bearer, must be https and not a private host, and redirects are refused.
- **Revision diffs are computed here** (`diffLines`, LCS over lines, summarised past 4M cells, 400 lines printed). Outline has no diff endpoint, and listed revisions carry no body.
- **Verification:** the new endpoints follow `outline/openapi` spec3.yml; none was exercised live. Check `editMode: 'patch'` and the attachment upload modes first.

## Source Files

| File | Contains |
|------|----------|
| `src/outline/server.ts` | Tool definitions (`OUTLINE_BASE_URL`, defaults to dev wiki) |
| `src/outline/apiHelpers.ts` | `OutlineClient` — Bearer-token API client |
| `src/outline/restOps.ts` | Each write's camelCase fields (`createDocumentFields`, …) + op, shared by `server.ts` and `webServer.ts`; passage-edit guard, attachment upload, HTML import, revision compare |
