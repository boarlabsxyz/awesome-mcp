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
- **Larger files go through `createDriveUploadSession`** — a resumable session opened with the client's own `OAuth2Client.request` (no token copied out); the caller PUTs the bytes straight to Google. The returned URL alone authorizes that one upload for about a week: return it, never log it. UNVERIFIED live: the Location header and the `X-Upload-Content-Length` check.

### REST plane writes (`restRoutes.ts`; NOT exercised live)
- **Sign-off on record for two writes:** `POST /files/:id/trash` and `POST /files/:id/permissions` (share, including `type: anyone`) are callable with the permanent dashboard API key — the user approved both.
- **The trash route never deletes permanently** — `skipTrash: true` is a 400 (`trashFileRestSchema`), not dropped. The legacy uncatalogued `DELETE /files/:id?permanent=true` still deletes outright; it predates the catalog and is kept for ChatGPT compat.
- **`moveFile` copies unless `removeFromAllParents` is true** — Drive allows one parent per item, so "keep the old parents" can only be a copy. REST answers 201 `action: copied` for that, 200 `moved` otherwise.
- **`/folders` and `/files/:id/copy` keep their legacy 200 and response keys** — they were ChatGPT Custom Actions routes before the catalog.
- **`createFromTemplate` answers 201 even when the replacements fail** — the copy exists either way; `replacements` reports `applied` and `occurrencesChanged` per placeholder (0 = not in the template).

## Source Files

| File | Contains |
|------|----------|
| `src/google-drive/server.ts` | Tool definitions |
| `src/google-drive/toolHandlers.ts` | Handlers for the original tools, shared-drive params, query escaping |
| `src/google-drive/filesOps.ts` | Schemas + ops shared by tools and REST: search, change feed, upload |
| `src/google-drive/schemas.ts` | Schemas of the other write tools, shared with REST |
| `src/google-drive/restRoutes.ts` | `DRIVE_WRITE_ROUTES`: the REST writes as descriptors over the `perform*` ops in `toolHandlers.ts` |
