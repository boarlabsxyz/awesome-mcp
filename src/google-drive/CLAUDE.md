# Google Drive — notes for Claude

## Rules and limitations

### Search, change feed, upload (`filesOps.ts`; NOT exercised live)
- **Never send `orderBy` with a `fullText` term** — Drive answers 403. `searchDriveFiles` sorts only name-only and query-less listings and reports `sortedBy`.
- **Report `nextPageToken` and `incompleteSearch`** — a full page with no token shown reads as the whole folder (`listFolderContents` used to drop it).
- **The change feed starts empty** — a first call (no token) only returns `startPageToken`; changes are recorded from then on. `nextPageToken` = more now, `newStartPageToken` = poll later.
- **Check `about.importFormats` before converting** — Drive silently stores an unconvertible upload as the original type; `converted` reports what Drive stored.
- **REST answers Drive's own 400 (bad pageToken, malformed modifiedAfter) and local refusals with 400** (`driveRestErrorResponse`); `includeTrashed` must be true/false/1/0, not silently false.
- **Invalid base64 is refused** — `Buffer.from` would skip bad characters and upload a different file.
- **Upload caps:** 20 MB decoded on MCP; REST is bounded by the 5 MB body limit (`/api/v1/drive/files` is in `REST_LARGE_BODY_PREFIXES`, a prefix mount that also covers `/files/:id/copy`).

## Source Files

| File | Contains |
|------|----------|
| `src/google-drive/server.ts` | Tool definitions |
| `src/google-drive/toolHandlers.ts` | Handlers for the original tools, shared-drive params, query escaping |
| `src/google-drive/filesOps.ts` | Schemas + ops shared by tools and REST: search, change feed, upload |
