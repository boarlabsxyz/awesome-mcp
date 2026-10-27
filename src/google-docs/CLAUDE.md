# Google Docs — notes for Claude

## Rules and limitations

### Comments and suggestions (Docs API `batchUpdate`; NOT exercised live)
- **No Drive API** — all comment/suggestion tools use `documents.batchUpdate` (`insertComment` with `range`, `addCommentReply`, `updateCommentPost`, `deleteComment`, `deleteCommentReply`, `accept/reject/deleteSuggestion`, `writeControl.writeMode: 'SUGGEST'`). Never set Drive's `anchor`: Docs renders it as "Original content deleted".
- **Resolve/reopen is a reply action** — `post.commentAction: 'RESOLVE' | 'REOPEN'`; `content` is optional only for those.
- **Confirm from `commentUpdateState`** — only `ALL_SAVED` means applied; `ALL_FAILED_UNKNOWN_REASON` throws; anything else is `confirmed: false`. Suggestions confirm by the id appearing in `suggestionResponses[].accepted/rejected/deletedSuggestionIds`.
- **Reads need three params together** — `commentsViewMode: COMMENTS_VIEW_MODE_INCLUDED` + `suggestionsViewMode: SUGGESTIONS_INLINE` + `includeTabsContent: true`; without the first, `comments` is absent (reads as "no comments").
- **No per-comment GET** — `getComment` = list + find in `commentReads.ts` (shared by tools and REST); its 404 is ours.
- **Anchors live on `DocumentTab.commentAnchors`** — `collectCommentAnchors` must recurse child tabs, and a `fields` mask cannot recurse, so `tabAnchorFields` writes grouped `tabs(...)` out to 4 levels (Google limit: 3). Stubs ignore `fields`, so unit tests don't prove the mask.
- **Assignment is create-only** — `insertComment.assigneeEmailAddress` assigns; reply `assigneeEmail` 400s on an unassigned thread, so `assignComment` only reassigns. That 400 is rewritten to list all four documented causes.
- **`addComment`** reports `assigneeEmail` only as Google recorded it, the request as `requestedAssigneeEmail`.
- **Bodies cap at 2048 UTF-8 bytes** — refused locally, measured in bytes, not `String.length`.
- **Dependencies** — `googleapis` 186 needs `google-auth-library` ^11; ^9 installs two incompatible `OAuth2Client` types and breaks the build. No reconnect needed (`auth/documents` + `auth/drive`).
- **No REST sibling** for `rejectSuggestion`/`deleteSuggestion` (irrecoverable); suggestion-thread posts can't be edited/deleted over REST (one path = one thread kind).
- **Check first on a live run:** a 400 on the mask, a nested-tab comment with no range, an absent `plainTextQuote`.

### Text safety (`textSafety.ts`)
- On every `readGoogleDoc` path, `parseDocStructure` `textPreview`, and `GET /api/v1/docs/:documentId`.
- **`format: 'json'` truncation** — the partial is a string field inside a valid envelope, never sliced JSON.
- **Use `sliceSafe`, never `substring`** — `substring` can split a surrogate pair.
- **`U+000B` → `\n`** (soft break, not dropped); private-use placeholder chars are removed. `assertTransportSafe` is the backstop, naming offset and code point.
- **`format: 'text'`'s `fields` projection must name tables**, or table text is dropped.

### REST writes (19 POSTs)
- **`server.ts` is the app entry point** (imports `createWebApp`), so `webServer.ts` must never import it, even dynamically; shared schemas/ops live in `writeSchemas.ts`/`writeOps.ts`. Ops return data; tool renders text, route emits JSON.
- **Entry point boots unless `NODE_TEST_CONTEXT` is set** — "start unless testing", since a wrong argv check would stop production booting.
- **Omitted:** `editTableCell`, `fixListFormatting`, `findElement` (`NOT_IMPLEMENTED`, they throw).
- **Single-purpose endpoints duplicate `batchUpdateDoc` on purpose** — generated clients drive named ops better.
- **Destructive, with sign-off:** `deleteRange` (`/ranges/delete`), `deleteComment` (`/comments/{commentId}/delete`); `batchUpdateDoc` reaches `delete_text` too.
- **Contracts:** `findAndReplace` returns `occurrencesChanged: 0` as success; comment routes confirm from `commentUpdateState`. Legacy `POST /api/v1/docs/{id}/comments` keeps its path and keys. `/api/v1/docs` is in `REST_LARGE_BODY_PREFIXES`.
- **Duplicate `operationId`s** `readGoogleDoc` and `createFolder` are kept — renaming breaks published clients.

## Source Files

| File | Contains |
|------|----------|
| `src/google-docs/apiHelpers.ts` | `findTextRange`, `executeBatchUpdate` (optional `writeControl` for SUGGEST), style builders |
| `src/google-docs/server.ts` | Tool definitions; main entry point |
| `src/google-docs/commentReads.ts` | The one comment/suggestion read path (params, recursive anchor walk, renderers, REST projection) |

## Parameter Patterns

- **Document ID:** Extract from URL: `docs.google.com/document/d/DOCUMENT_ID/edit`
- **Text targeting:** Use `textToFind` + `matchInstance` OR `startIndex`/`endIndex`
- **Colors:** Hex format `#RRGGBB` or `#RGB`
- **Alignment:** `START`, `END`, `CENTER`, `JUSTIFIED` (not LEFT/RIGHT)
- **Indices:** 1-based, ranges are [start, end)
- **Tabs:** Optional `tabId` parameter (defaults to first tab)
