# REST Data Plane — Endpoint Catalog

Generated from `src/restCatalog.ts` by `scripts/buildRestEndpointsDoc.mjs`. Do not edit by hand.

## Why this exists

Every MCP tool response flows through the LLM's tool-result channel — every byte counts against context and output tokens. For bulk reads (calendar weeks, search results, full doc bodies, channel history), the REST data plane lets the LLM orchestrate the fetch via curl + jq while keeping the bytes off-context.

## Auth

1. From any MCP session, call the `mintRestBearerForCurl` MCP tool — it returns a 5-minute bearer.
2. Pass it as `Authorization: Bearer <token>` against the URLs below.

The same endpoints also accept the permanent dashboard API key (for ChatGPT Custom Actions backward compatibility).

## Content negotiation

| Header / query | Behavior |
|---|---|
| `Accept: application/json` (default) | Raw upstream JSON from Google/Slack/ClickUp, untransformed |
| `Accept: text/plain` or `?format=text` | Markdown rendering matching the MCP tool's output (where supported) |

## Base URL

```text
https://awesome-mcp.xyz/api/v1
```

OpenAPI spec: `https://awesome-mcp.xyz/openapi.json`

## Endpoints by service

### Google Docs (`docs`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `listGoogleDocs` | `GET /api/v1/docs` | live | List Google Docs |
| `searchGoogleDocs` | `GET /api/v1/docs?q={query}` | live | Search Google Docs — _Same path as listGoogleDocs; presence of ?q triggers search._ |
| `getRecentGoogleDocs` | `GET /api/v1/docs/recent` | live | Recent Google Docs |
| `readGoogleDoc` | `GET /api/v1/docs/{documentId}` | live | Read a Google Doc (JSON or text via Accept) — _GET sibling of the existing POST /api/v1/docs/read. Default returns raw upstream Docs JSON; Accept: text/plain returns extracted body text._ |
| `listDocumentTabs` | `GET /api/v1/docs/{documentId}/tabs` | live | List tabs in a Google Doc |
| `listComments` | `GET /api/v1/docs/{documentId}/comments` | live | List comments on a Google Doc |
| `getComment` | `GET /api/v1/docs/{documentId}/comments/{commentId}` | live | Get a single comment with its replies |
| `inspectDocStructure` | `GET /api/v1/docs/{documentId}/structure` | live | Inspect the structure of a Google Doc — _Paragraph/table/section counts, headers and footers presence, tab hierarchy. Pass ?detailed=true for an element-by-element listing, ?tabId= to scope to one tab._ |
| `importToGoogleDoc` | `POST /api/v1/docs/import` | live | Create a doc from text, HTML or markdown content — _Body limit 5mb: content carries the whole document. Not idempotent: each call creates another doc._ |
| `importDocx` | `POST /api/v1/docs/import/docx` | live | Convert a .docx already in Drive into a Google Doc — _Takes a Drive file ID, not file bytes. Refuses anything whose mimeType is not .docx, since Drive would convert it into an unreadable doc._ |
| `appendToGoogleDoc` | `POST /api/v1/docs/{documentId}/append` | live | Append text to the end of a doc or tab — _Body limit 5mb. Resolves the end index itself, so no index is needed._ |
| `insertText` | `POST /api/v1/docs/{documentId}/text` | live | Insert text at a 1-based index — _Body limit 5mb. Indices shift as the doc changes; for several edits at once use batchUpdate, which orders them safely._ |
| `batchUpdateDoc` | `POST /api/v1/docs/{documentId}/batchUpdate` | live | Apply up to 50 document operations in one batch — _Body limit 5mb. Index-based operations are applied in descending index order so they do not shift each other. Mixing global replacements with index-based operations is refused, not reordered. Includes delete_text, so it can remove content._ |
| `findAndReplace` | `POST /api/v1/docs/{documentId}/find-replace` | live | Replace every occurrence of a string — _Reports occurrencesChanged, which is 0 when nothing matched — that is a successful call, not an error._ |
| `applyTextStyle` | `POST /api/v1/docs/{documentId}/text-style` | live | Apply character formatting to a range or found text — _Answers with the range it resolved, which matters when the target was given as text to find rather than indices._ |
| `applyParagraphStyle` | `POST /api/v1/docs/{documentId}/paragraph-style` | live | Apply paragraph formatting by text, index or range — _A text target is widened to the paragraph containing it, so the resolved range in the response is wider than the text matched._ |
| `formatMatchingText` | `POST /api/v1/docs/{documentId}/format-matching-text` | live | Format the Nth instance of a string — _Flat-parameter alternative to text-style; same engine underneath._ |
| `insertTable` | `POST /api/v1/docs/{documentId}/tables` | live | Insert a table of the given dimensions |
| `insertPageBreak` | `POST /api/v1/docs/{documentId}/page-breaks` | live | Insert a page break at an index |
| `insertImageFromUrl` | `POST /api/v1/docs/{documentId}/images/from-url` | live | Insert an inline image from a public URL — _Google fetches the URL server-side, so it must be publicly reachable._ |
| `insertLocalImage` | `POST /api/v1/docs/{documentId}/images` | live | Insert an image from a URL, Drive file, local path or base64 — _Body limit 5mb for the base64 path (hard cap 20mb decoded). Every path except driveFileId UPLOADS a new file to the user Drive and returns its URL._ |
| `exportDocToPdf` | `POST /api/v1/docs/{documentId}/export/pdf` | live | Export a doc to PDF and save it to Drive — _Writes a new PDF file to Drive; it is an export that mutates. Refuses anything that is not a Google Doc._ |
| `addComment` | `POST /api/v1/docs/{documentId}/comments` | live | Add a comment quoting a text range — _Was an uncatalogued ChatGPT-compat route; path and response unchanged, now validated with the MCP tool schema. The Drive API ignores anchors on Google Docs, so the quoted text is the only record of which range the comment is about._ |
| `replyToComment` | `POST /api/v1/docs/{documentId}/comments/{commentId}/replies` | live | Reply to a comment |
| `resolveComment` | `POST /api/v1/docs/{documentId}/comments/{commentId}/resolve` | live | Mark a comment resolved — _The response reports the resolved flag Google returned on a re-read, not what was requested: the Drive API accepts this on a Google Doc and often does not persist it._ |
| `deleteRange` | `POST /api/v1/docs/{documentId}/ranges/delete` | live | Delete a character range — _DESTRUCTIVE and irreversible through this API. Exposed with explicit sign-off. POST to an action path rather than DELETE on the range, so the call site reads as deliberate._ |
| `deleteComment` | `POST /api/v1/docs/{documentId}/comments/{commentId}/delete` | live | Delete a comment thread — _DESTRUCTIVE. Exposed with explicit sign-off. POST to an action path rather than DELETE on the resource._ |

### Google Sheets (`sheets`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `listGoogleSheets` | `GET /api/v1/sheets` | live | List spreadsheets |
| `getSpreadsheetInfo` | `GET /api/v1/sheets/{spreadsheetId}` | live | Get spreadsheet metadata |
| `readSpreadsheet` | `GET /api/v1/sheets/{spreadsheetId}/ranges?range={range}` | live | Read a range from a spreadsheet — _GET sibling of the existing POST /api/v1/sheets/{id}/read._ |
| `readRowByField` | `GET /api/v1/sheets/{spreadsheetId}/rows/{rowNumber}` | live | Read a row by row number |
| `findRowByValue` | `GET /api/v1/sheets/{spreadsheetId}/search` | live | Find a row by column value (?col=&val=) |
| `createSpreadsheet` | `POST /api/v1/sheets` | live | Create a spreadsheet, optionally seeded with rows — _Body limit 5mb so initialData can carry a bulk seed. Not idempotent: each call creates another spreadsheet. A seed that fails still answers 201 with initialDataWritten false, because the file exists by then._ |
| `writeSpreadsheet` | `POST /api/v1/sheets/{spreadsheetId}/write` | live | Overwrite a range with a 2D array of values — _Body limit 5mb. Overwrites whatever occupies the range. Was an uncatalogued ChatGPT-compat route; the path is unchanged and it now validates with the MCP tool schema._ |
| `appendSpreadsheetRows` | `POST /api/v1/sheets/{spreadsheetId}/append` | live | Append rows to the end of a sheet — _Body limit 5mb. Not idempotent: repeating the call appends the rows a second time. Was an uncatalogued ChatGPT-compat route; path unchanged._ |
| `batchUpdateSpreadsheet` | `POST /api/v1/sheets/{spreadsheetId}/batchUpdate` | live | Apply formatting and sheet-lifecycle operations atomically — _Body limit 5mb. WARNING: the operation list includes deleteSheet, which destroys a tab and every value on it, and a curl has no confirmation step. Reviewed and accepted when this endpoint was added. The whole batch is atomic, so one rejected operation applies none of them._ |
| `clearSpreadsheetRange` | `POST /api/v1/sheets/{spreadsheetId}/ranges/clear` | live | Clear every value in a range — _DESTRUCTIVE and irreversible through this API. Exposed with explicit sign-off. POST to an action path rather than DELETE on the range, so the call site reads as deliberate._ |

### Google Calendar (`calendar`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `listCalendars` | `GET /api/v1/calendars` | live | List calendars |
| `listEvents` | `GET /api/v1/calendars/{calendarId}/events` | live | List events in a calendar |
| `getEvent` | `GET /api/v1/calendars/{calendarId}/events/{eventId}` | live | Get a single event |
| `createEvent` | `POST /api/v1/calendars/{calendarId}/events` | live | Create an event — _sendUpdates defaults to none, so attendees are NOT emailed unless the body asks. Not idempotent: each call creates another event. Was an uncatalogued ChatGPT-compat route; path unchanged and it now validates with the MCP tool schema._ |
| `updateEvent` | `POST /api/v1/calendars/{calendarId}/events/{eventId}` | live | Update an event, merging the fields given — _POST because the catalog method union is GET or POST. The uncatalogued legacy PATCH on this same path stays for ChatGPT compat and shares this handler. Omitted fields are preserved, not cleared._ |
| `deleteEvent` | `POST /api/v1/calendars/{calendarId}/events/{eventId}/cancel` | live | Delete an event — _DESTRUCTIVE. Exposed with explicit sign-off. POST to an action path rather than DELETE on the resource. Pass sendUpdates all to notify attendees; the default none deletes silently._ |

### Google Drive (`drive`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `getDocumentInfo` | `GET /api/v1/drive/files/{fileId}` | live | Get file metadata |
| `getFilePermissions` | `GET /api/v1/drive/files/{fileId}/permissions` | live | List permissions on a file |
| `checkPublicAccess` | `GET /api/v1/drive/files/{fileId}/public` | live | Check if a file is publicly accessible |
| `downloadDriveFile` | `GET /api/v1/drive/files/{fileId}/download` | live | Download or export a file — _Streams binary. Google native types are exported (default: PDF for docs/slides, CSV for sheets, PNG for drawings); override with ?exportMime=._ |
| `getFolderInfo` | `GET /api/v1/drive/folders/{folderId}` | live | Get folder metadata |
| `listFolderContents` | `GET /api/v1/drive/folders/{folderId}/contents` | live | List the contents of a folder |
| `listSharedDrives` | `GET /api/v1/drive/shared-drives` | live | List shared drives |

### Gmail (`gmail`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `searchEmails` | `GET /api/v1/gmail/messages?q={query}` | live | Search emails |
| `readEmail` | `GET /api/v1/gmail/messages/{messageId}` | live | Read an email (JSON or markdown via Accept) |
| `getAttachment` | `GET /api/v1/gmail/messages/{messageId}/attachments/{attachmentId}` | live | Download an email attachment — _Returns Gmail base64url-encoded payload as JSON {size, data}; caller decodes._ |
| `listLabels` | `GET /api/v1/gmail/labels` | live | List Gmail labels |

### Google Slides (`slides`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `getPresentation` | `GET /api/v1/slides/{presentationId}` | live | Get presentation metadata |
| `getPage` | `GET /api/v1/slides/{presentationId}/pages/{pageObjectId}` | live | Get a slide page |
| `getPageThumbnail` | `GET /api/v1/slides/{presentationId}/pages/{pageObjectId}/thumbnail` | live | Get a slide thumbnail (PNG URL) |
| `listPresentationComments` | `GET /api/v1/slides/{presentationId}/comments` | live | List comments on a presentation |

### ClickUp (`clickup`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `getAuthorizedUser` | `GET /api/v1/clickup/user` | live | Get the authorized ClickUp user |
| `listWorkspaces` | `GET /api/v1/clickup/workspaces` | live | List ClickUp workspaces |
| `listSpaces` | `GET /api/v1/clickup/workspaces/{workspaceId}/spaces` | live | List spaces in a workspace |
| `listFolders` | `GET /api/v1/clickup/spaces/{spaceId}/folders` | live | List folders in a space |
| `listListsInFolder` | `GET /api/v1/clickup/folders/{folderId}/lists` | live | List lists in a folder |
| `listFolderlessLists` | `GET /api/v1/clickup/spaces/{spaceId}/lists` | live | List folderless lists in a space |
| `listTasks` | `GET /api/v1/clickup/lists/{listId}/tasks` | live | List tasks in a list |
| `getTask` | `GET /api/v1/clickup/tasks/{taskId}` | live | Get a ClickUp task (JSON or markdown via Accept) |
| `getAccessibleCustomFields` | `GET /api/v1/clickup/lists/{listId}/fields` | live | List accessible custom fields on a list |
| `getTaskMembers` | `GET /api/v1/clickup/tasks/{taskId}/members` | live | List members of a task |
| `getTaskComments` | `GET /api/v1/clickup/tasks/{taskId}/comments` | live | List comments on a task |
| `searchTasks` | `GET /api/v1/clickup/workspaces/{workspaceId}/tasks/search` | live | Search tasks across a workspace |
| `filterTeamTasks` | `GET /api/v1/clickup/workspaces/{workspaceId}/tasks/filter` | live | Filter tasks across a workspace with server-side filters (assignees, statuses, date ranges, etc.) |
| `getTaskEventHistory` | `GET /api/v1/clickup/workspaces/{workspaceId}/events` | live | Read task-event transitions (status/assignee/moves) from the webhook store |
| `listTaskEventSubscriptions` | `GET /api/v1/clickup/subscriptions` | live | List task-event webhook subscriptions owned by the caller |
| `debugTaskEventSubscription` | `GET /api/v1/clickup/workspaces/{workspaceId}/subscription/debug` | live | Diagnostic report cross-referencing local subscription vs the ClickUp-side webhook vs the event store |
| `listDocs` | `GET /api/v1/clickup/workspaces/{workspaceId}/docs` | live | List docs in a workspace — _One page in ClickUp order. Optional limit (10-100, default 100) and cursor; response carries nextCursor._ |
| `searchDocs` | `GET /api/v1/clickup/workspaces/{workspaceId}/docs/search` | live | Search docs in a workspace — _Pages the whole workspace, token-matches the title, returns newest-first. Response includes totalScanned/pagesScanned/hitCap/rateLimited._ |
| `getDoc` | `GET /api/v1/clickup/docs/{docId}?workspaceId={workspaceId}` | live | Get a ClickUp doc with its pages — _Required query param: workspaceId._ |
| `getPage` | `GET /api/v1/clickup/docs/{docId}/pages/{pageId}?workspaceId={workspaceId}` | live | Get a page within a ClickUp doc — _Required query param: workspaceId._ |
| `listWorkspaceMembers` | `GET /api/v1/clickup/workspaces/{workspaceId}/members` | live | List members of a workspace — _No dedicated ClickUp endpoint; derived from getWorkspaces team.members[]._ |
| `getTimeEntries` | `GET /api/v1/clickup/workspaces/{workspaceId}/time` | live | List time entries |
| `listTaskTypes` | `GET /api/v1/clickup/workspaces/{workspaceId}/task-types` | live | List task types (custom item types) in a workspace — _ClickUp returns only the CUSTOM types; the two built-ins (0 = Task, 1 = Milestone) are prepended here, so builtIn and custom are reported separately._ |
| `listSpaceTags` | `GET /api/v1/clickup/spaces/{spaceId}/tags` | live | List tags defined in a space |
| `createSpace` | `POST /api/v1/clickup/spaces/{spaceId}` | live | Create a space in a workspace — _Pre-existing ChatGPT-compat route. WARNING the path parameter is named spaceId but ClickUp requires the WORKSPACE (team) ID here -- the name is kept because the published spec uses it. Native body: name, multiple_assignees, features._ |
| `createFolder` | `POST /api/v1/clickup/spaces/{spaceId}/folders` | live | Create a folder in a space — _Pre-existing ChatGPT-compat route. Native body forwarded verbatim: name._ |
| `createList` | `POST /api/v1/clickup/folders/{folderId}/lists` | live | Create a list in a folder — _Pre-existing ChatGPT-compat route. Native body forwarded verbatim: name, content, markdown_content, due_date, priority, assignee, status. For a FOLDERLESS list use the MCP createList tool with spaceId -- there is no REST route for it._ |
| `createTask` | `POST /api/v1/clickup/lists/{listId}/tasks` | live | Create a task in a list — _Pre-existing ChatGPT-compat route. Native body forwarded verbatim: name, description, markdown_content, assignees, status, priority, due_date, start_date, tags, time_estimate, parent, custom_item_id._ |
| `moveTask` | `POST /api/v1/clickup/tasks/{taskId}/move` | live | Move a task to a different list — _Pre-existing ChatGPT-compat route. Body: listId. Changes the task LIST only, never its parent task._ |
| `addTaskComment` | `POST /api/v1/clickup/tasks/{taskId}/comments` | live | Add a comment to a task — _Pre-existing ChatGPT-compat route. Native body forwarded verbatim: comment_text, assignee, notify_all._ |
| `setCustomFieldValue` | `POST /api/v1/clickup/tasks/{taskId}/fields/{fieldId}` | live | Set a custom field value on a task — _Pre-existing route, not in the published spec. Body: value, forwarded as-is. Unlike the MCP tool it does NOT resolve option names or revive a stringified array, so send array-valued types (labels, users, relationships) as real JSON arrays or ClickUp answers FIELD_144._ |
| `startTimeEntry` | `POST /api/v1/clickup/workspaces/{workspaceId}/time/start` | live | Start a time entry — _Pre-existing ChatGPT-compat route. Native body forwarded verbatim: tid is the task ID, plus description and billable._ |
| `stopTimeEntry` | `POST /api/v1/clickup/workspaces/{workspaceId}/time/stop` | live | Stop the running time entry — _Pre-existing ChatGPT-compat route. No body._ |
| `uploadClickUpDocImage` | `POST /api/v1/images` | live | Re-host an image and return a public URL to embed in a ClickUp Doc — _Pre-existing ChatGPT-compat route, shared with any service that needs a hosted image. Two body shapes: raw image bytes, or JSON with imageUrl. The URL is fetched BY THIS SERVER with a per-redirect-hop SSRF guard. Requires DATABASE_URL and IMAGE_PUBLIC_BASE_URL. The served URL is public and unauthenticated._ |
| `updateTask` | `POST /api/v1/clickup/tasks/{taskId}/update` | live | Update a task, or re-parent it — _camelCase body (markdownContent, dueDate, addAssignees, taskTypeId, parentTaskId). On the re-parent path the change is VERIFIED by a re-read: reparentConfirmed is true, false (ClickUp accepted the call and silently ignored it -- do not treat the move as done), or null (unverified). ClickUp cannot clear a parent, so parentTaskId null is refused. An uncatalogued legacy PATCH on /api/v1/clickup/tasks/{taskId} takes native keys instead and applies none of these guards._ |
| `deleteTask` | `POST /api/v1/clickup/tasks/{taskId}/delete` | live | Delete a task permanently — _DESTRUCTIVE and permanent -- ClickUp has no recycle bin for this. Exposed with explicit user sign-off. A curl has no confirmation affordance and the permanent dashboard API key is accepted here. An uncatalogued legacy DELETE on /api/v1/clickup/tasks/{taskId} has served the same operation all along._ |
| `updateList` | `POST /api/v1/clickup/lists/{listId}/update` | live | Update a list — _camelCase body (name, content, dueDate, priority); at least one field required. An uncatalogued legacy PATCH on /api/v1/clickup/lists/{listId} takes native keys instead._ |
| `deleteList` | `POST /api/v1/clickup/lists/{listId}/delete` | live | Delete a list permanently — _DESTRUCTIVE and permanent, and it takes every task in the list with it. Exposed with explicit user sign-off. An uncatalogued legacy DELETE on /api/v1/clickup/lists/{listId} has served the same operation all along._ |
| `removeCustomFieldValue` | `POST /api/v1/clickup/tasks/{taskId}/fields/{fieldId}/remove` | live | Clear a custom field value on a task — _DESTRUCTIVE: clears the stored VALUE, exposed with explicit user sign-off. The field itself and its drop-down or label options are untouched and cannot be deleted through ClickUp API at all. An uncatalogued legacy DELETE on the same path without /remove has served this all along._ |
| `addTaskToList` | `POST /api/v1/clickup/tasks/{taskId}/lists/{listId}` | live | Share a task into an additional list — _Needs the Tasks in Multiple Lists ClickApp; ClickUp answers a disabled ClickApp with 401, the same status as a bad credential. ClickUp answers 200 with an EMPTY body, so the task is re-read: confirmed is true, false, or null when ClickUp sent no locations array (its absence is not evidence of absence). Unlike the MCP tool this route runs no pre-flight, so it cannot tell a disabled ClickApp from a bad ID._ |
| `removeTaskFromList` | `POST /api/v1/clickup/tasks/{taskId}/lists/{listId}/remove` | live | Remove a task from an additional list — _DESTRUCTIVE, exposed with explicit user sign-off, though the task itself is not deleted. ClickUp refuses to remove a task from its HOME list. Same empty-body re-read and three-valued confirmed as the add direction._ |
| `addTagToTask` | `POST /api/v1/clickup/tasks/{taskId}/tags/{tagName}` | live | Add a tag to a task — _ClickUp AUTO-CREATES the tag in the task space if it does not exist, so a typo silently makes a new tag -- call the space tags endpoint first to reuse existing ones. ClickUp updateTask does not accept tags; this is the only way to tag an existing task._ |
| `removeTagFromTask` | `POST /api/v1/clickup/tasks/{taskId}/tags/{tagName}/remove` | live | Remove a tag from a task — _DESTRUCTIVE, exposed with explicit user sign-off. Unassigns the tag from this task only; the tag stays defined in the space._ |
| `createDoc` | `POST /api/v1/clickup/workspaces/{workspaceId}/docs` | live | Create a doc in a workspace — _ClickUp createDoc endpoint IGNORES content, so content is written to the doc first page in a second call. contentWritten reports that second step: the doc exists either way, so a failure there is 201 with contentWritten false rather than an error that would invite a retry and make a second doc._ |
| `createPage` | `POST /api/v1/clickup/workspaces/{workspaceId}/docs/{docId}/pages` | live | Create a page in a doc — _Body: name, content (markdown), parentPageId._ |
| `editPage` | `POST /api/v1/clickup/workspaces/{workspaceId}/docs/{docId}/pages/{pageId}` | live | Edit a page in a doc — _editMode replace (default), append, or prepend. replace overwrites the whole page body, so it is destructive to existing content even though the tool carries no destructive annotation._ |
| `insertImageIntoPage` | `POST /api/v1/clickup/workspaces/{workspaceId}/docs/{docId}/pages/{pageId}/images` | live | Re-host an image and embed it in a doc page — _Exactly one of imageUrl or imageBase64. imageUrl is fetched BY THIS SERVER, so it goes through the per-redirect-hop SSRF guard; there is deliberately no filesystem-path parameter. Requires DATABASE_URL and IMAGE_PUBLIC_BASE_URL; a deployment without them answers 503, not 500, because an unconfigured feature is not a fault. The hosted image URL is public and unauthenticated. Body limit raised to 5 MB for imageBase64._ |

### Slack (`slack`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `listChannels` | `GET /api/v1/slack/channels` | live | List Slack channels — _Requires a slack-bot connection (slack-user not supported on REST)._ |
| `readChannelHistory` | `GET /api/v1/slack/channels/{channelId}/messages` | live | Read recent messages in a channel |
| `readThreadReplies` | `GET /api/v1/slack/channels/{channelId}/threads/{threadTs}` | live | Read replies in a thread |
| `listUsers` | `GET /api/v1/slack/users` | live | List Slack workspace users |

### Outline (`outline`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `searchDocuments` | `GET /api/v1/outline/documents/search?q={query}` | live | Search Outline documents — _Required query param: q. Optional collectionId, limit (max 100), offset, statusFilter (repeatable: draft, archived, published). Defaults to published only._ |
| `listRecentlyUpdatedDocuments` | `GET /api/v1/outline/documents/recent` | live | List recently updated Outline documents — _dateFilter is a coarse window: day, week (default), month, or year._ |
| `listArchivedDocuments` | `GET /api/v1/outline/documents/archived` | live | List archived Outline documents |
| `listTrash` | `GET /api/v1/outline/documents/trash` | live | List Outline documents in the trash |
| `getDocumentIdFromTitle` | `GET /api/v1/outline/documents/by-title?q={query}` | live | Resolve an Outline document title to its ID — _Required query param: q. Prefers an exact title match and falls back to the best partial one, so exactMatch reports which you got -- a partial match is a guess, not an answer._ |
| `getDocument` | `GET /api/v1/outline/documents/{documentId}` | live | Read an Outline document |
| `exportDocument` | `GET /api/v1/outline/documents/{documentId}/export` | live | Export an Outline document as plain markdown — _Answers text/markdown, not JSON -- the markdown body is the whole response._ |
| `getDocumentBacklinks` | `GET /api/v1/outline/documents/{documentId}/backlinks` | live | List documents that link to a given Outline document |
| `listDocumentComments` | `GET /api/v1/outline/documents/{documentId}/comments` | live | List comments on an Outline document — _Optional includeAnchorText returns the document text each comment refers to._ |
| `listDocumentAttachments` | `GET /api/v1/outline/documents/{documentId}/attachments` | live | List attachments referenced in an Outline document — _Outline has no attachments-by-document endpoint, so this parses the document markdown for /api/attachments.redirect links. An attachment linked any other way is not found._ |
| `getComment` | `GET /api/v1/outline/comments/{commentId}` | live | Get a single Outline comment |
| `getAttachmentUrl` | `GET /api/v1/outline/attachments/{attachmentId}/url` | live | Resolve an Outline attachment ID to a signed download URL — _Follows the redirect to a pre-signed storage URL. That URL is time-limited and grants whoever holds it access to the file, so treat it as a credential._ |
| `listCollections` | `GET /api/v1/outline/collections` | live | List Outline collections |
| `getCollectionStructure` | `GET /api/v1/outline/collections/{collectionId}/structure` | live | Get the hierarchical document tree for an Outline collection |
| `exportCollection` | `POST /api/v1/outline/collections/{collectionId}/export` | live | Start an async export of an Outline collection — _POST even though the MCP tool is annotated read-only: this QUEUES a server-side job and each call queues another. A GET would be retried by proxies and retry middleware after a timeout, queueing a second export nobody asked for. Returns a fileOperation id plus state, not the export itself -- poll Outline for completion._ |
| `exportAllCollections` | `POST /api/v1/outline/exports` | live | Start an async export of the whole Outline workspace — _POST for the same reason as the per-collection export, and it matters more here: a retried GET would queue a second WHOLE-WORKSPACE export. Returns a fileOperation id and state, not the export itself._ |
| `createDocument` | `POST /api/v1/outline/documents` | live | Create an Outline document — _Answers 201. Body: title, collectionId, text (markdown), parentDocumentId, publish (default true), template, icon. Body limit raised to 5 MB -- a document body is the large payload this plane exists for._ |
| `updateDocument` | `POST /api/v1/outline/documents/{documentId}` | live | Update an Outline document — _REPLACES title and text unless append is true, so an update that omits nothing still overwrites the body. append is ignored unless text is supplied. An empty-string icon clears the icon; omitting it leaves it alone._ |
| `moveDocument` | `POST /api/v1/outline/documents/{documentId}/move` | live | Move an Outline document to another collection or parent — _At least one of collectionId or parentDocumentId is required._ |
| `archiveDocument` | `POST /api/v1/outline/documents/{documentId}/archive` | live | Archive an Outline document — _Reversible via the unarchive route. Removes the document from its collection but keeps it searchable._ |
| `unarchiveDocument` | `POST /api/v1/outline/documents/{documentId}/unarchive` | live | Unarchive an Outline document — _Shares Outline /api/documents.restore with the restore route: there is NO documents.unarchive endpoint, and calling one would 404. The two paths are kept separate because the intent differs, not the call._ |
| `restoreDocument` | `POST /api/v1/outline/documents/{documentId}/restore` | live | Restore an Outline document from the trash |
| `addComment` | `POST /api/v1/outline/documents/{documentId}/comments` | live | Add a comment to an Outline document, or reply to one — _Answers 201. Pass parentCommentId to reply to an existing comment._ |
| `createCollection` | `POST /api/v1/outline/collections` | live | Create an Outline collection — _Answers 201. Body: name, description, color as a hex like #RRGGBB._ |
| `updateCollection` | `POST /api/v1/outline/collections/{collectionId}` | live | Update an Outline collection — _At least one of name, description, or color is required._ |

### PeopleForce (`peopleforce`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `listEmployees` | `GET /api/v1/peopleforce/employees` | live | List PeopleForce employees |
| `getEmployee` | `GET /api/v1/peopleforce/employees/{employeeId}` | live | Get a single PeopleForce employee |
| `listDepartments` | `GET /api/v1/peopleforce/departments` | live | List PeopleForce departments |
| `listLeaveRequests` | `GET /api/v1/peopleforce/leave-requests` | live | List PeopleForce leave requests |
| `getLeaveRequest` | `GET /api/v1/peopleforce/leave-requests/{leaveRequestId}` | live | Get a single PeopleForce leave request |
| `listLeaveTypes` | `GET /api/v1/peopleforce/leave-types` | live | List PeopleForce leave types with their IDs |
| `listPositions` | `GET /api/v1/peopleforce/positions` | live | List PeopleForce job positions |
| `listDivisions` | `GET /api/v1/peopleforce/divisions` | live | List PeopleForce divisions |
| `listLocations` | `GET /api/v1/peopleforce/locations` | live | List PeopleForce locations |
| `listEmploymentTypes` | `GET /api/v1/peopleforce/employment-types` | live | List PeopleForce employment types |
| `listJobLevels` | `GET /api/v1/peopleforce/job-levels` | live | List PeopleForce job levels |
| `listSkills` | `GET /api/v1/peopleforce/skills` | live | List the PeopleForce workspace skills catalog |
| `listCompetencies` | `GET /api/v1/peopleforce/competencies` | live | List PeopleForce competencies |
| `listTasks` | `GET /api/v1/peopleforce/tasks` | live | List PeopleForce tasks |
| `listEmployeeLeaveBalances` | `GET /api/v1/peopleforce/employees/{employeeId}/leave-balances` | live | List an employee current leave balances per leave type |
| `listEmployeeSkills` | `GET /api/v1/peopleforce/employees/{employeeId}/skills` | live | List the skills recorded on an employee profile — _No bulk endpoint upstream - a company-wide skills portfolio is one call per employee._ |
| `listEmployeeDocuments` | `GET /api/v1/peopleforce/employees/{employeeId}/documents` | live | List documents attached to an employee profile |
| `listEmployeeNotes` | `GET /api/v1/peopleforce/employees/{employeeId}/notes` | live | List HR notes on an employee profile |
| `listEmployeeEmergencyContacts` | `GET /api/v1/peopleforce/employees/{employeeId}/emergency-contacts` | live | List emergency contacts on an employee profile |
| `listEmployeeTables` | `GET /api/v1/peopleforce/employee-tables` | live | List PeopleForce employee custom-table definitions — _Returns each table internal_name - the value the per-employee table read requires._ |
| `getEmployeeTable` | `GET /api/v1/peopleforce/employees/{employeeId}/tables/{tableInternalName}` | live | Get one employee custom-table row data — _tableInternalName is a system slug from the employee-tables list - never guess it from the display name._ |
| `listObjectives` | `GET /api/v1/peopleforce/objectives` | live | List PeopleForce performance objectives (OKRs) — _No server-side date filter upstream - filter by period client-side._ |
| `listKeyPerformanceIndicators` | `GET /api/v1/peopleforce/kpis` | live | List PeopleForce key performance indicators |
| `listKnowledgeBaseCategories` | `GET /api/v1/peopleforce/knowledge-base/categories` | live | List PeopleForce knowledge base categories |
| `listKnowledgeBaseArticles` | `GET /api/v1/peopleforce/knowledge-base/articles?categoryId={categoryId}` | live | List knowledge base articles in a category — _categoryId is required - upstream only exposes articles nested under a category._ |
| `getKnowledgeBaseArticle` | `GET /api/v1/peopleforce/knowledge-base/articles/{articleId}` | live | Get a single knowledge base article with its body |
| `listVacancies` | `GET /api/v1/peopleforce/recruitment/vacancies` | live | List PeopleForce recruitment vacancies — _status and tagIds are repeatable or comma-separated query params._ |
| `getVacancy` | `GET /api/v1/peopleforce/recruitment/vacancies/{vacancyId}` | live | Get a single recruitment vacancy with its pipeline stages |
| `listVacancyApplications` | `GET /api/v1/peopleforce/recruitment/vacancies/{vacancyId}/applications` | live | List the applications on a recruitment vacancy |
| `getVacancyApplication` | `GET /api/v1/peopleforce/recruitment/vacancies/{vacancyId}/applications/{applicationId}` | live | Get a single vacancy application |
| `listRecruitmentPipelines` | `GET /api/v1/peopleforce/recruitment/pipelines` | live | List recruitment pipelines and their stage definitions |
| `listCandidates` | `GET /api/v1/peopleforce/recruitment/candidates` | live | List recruitment candidates with filters — _vacancyIds and skills are repeatable or comma-separated query params._ |
| `getCandidate` | `GET /api/v1/peopleforce/recruitment/candidates/{candidateId}` | live | Get a single recruitment candidate profile |
| `listCandidateNotes` | `GET /api/v1/peopleforce/recruitment/candidates/{candidateId}/notes` | live | List recruiter notes on a candidate — _Notes are the only free-text feedback surface - upstream has no scorecard endpoint._ |
| `listCandidateExperiences` | `GET /api/v1/peopleforce/recruitment/candidates/{candidateId}/experiences` | live | List a candidate work experience entries |
| `listCandidateEducations` | `GET /api/v1/peopleforce/recruitment/candidates/{candidateId}/educations` | live | List a candidate education entries |
| `getCandidateDossier` | `GET /api/v1/peopleforce/recruitment/candidates/{candidateId}/dossier` | live | Assemble a candidate dossier for assessment in one call — _Best-effort bundle - parts that fail to load are reported in the payload rather than failing the request._ |
| `listCandidateMovements` | `GET /api/v1/peopleforce/recruitment/candidate-movements` | live | List candidate pipeline stage transitions |
| `listDisqualifyReasons` | `GET /api/v1/peopleforce/recruitment/disqualify-reasons` | live | List recruitment disqualify reasons with their IDs |
| `listRecruitmentSources` | `GET /api/v1/peopleforce/recruitment/sources` | live | List recruitment sources with their IDs |
| `getPublishedJobDescription` | `GET /api/v1/peopleforce/recruitment/published-vacancies/{vacancyId}` | live | Get the public careers-site job description for a vacancy — _Some tenants gate the Careers API behind a separate token - fall back to the vacancy description on a not-authorized error._ |
| `createLeaveRequest` | `POST /api/v1/peopleforce/leave-requests` | live | Create a PeopleForce leave request — _Returns 201 with the created request. leaveTypeId comes from the leave-types endpoint, not the type name._ |
| `addCandidateNote` | `POST /api/v1/peopleforce/recruitment/candidates/{candidateId}/notes` | live | Add a note to a recruitment candidate — _Returns 201. The note body is free text and can be long - this is the write the data plane most clearly earns._ |
| `moveVacancyApplication` | `POST /api/v1/peopleforce/recruitment/vacancies/{vacancyId}/applications/{applicationId}/move` | live | Move a vacancy application to another pipeline stage — _Returns 200 with the application re-read after the move. performAutomations defaults to PeopleForce behaviour (true) when omitted._ |
| `disqualifyVacancyApplication` | `POST /api/v1/peopleforce/recruitment/vacancies/{vacancyId}/applications/{applicationId}/disqualify` | live | Disqualify a vacancy application with a reason — _Returns 200 with the application re-read. Consequential and not idempotent - repeating it re-disqualifies. disqualifyReasonId comes from the disqualify-reasons endpoint._ |

### HubSpot (`hubspot`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `getActiveCompanies` | `GET /api/v1/hubspot/companies` | live | Get most recently active HubSpot companies — _Sorted by last-modified. ?limit caps at 100. Accept: text/plain renders the same list the MCP tool returns._ |
| `getCompany` | `GET /api/v1/hubspot/companies/{companyId}` | live | Get a single HubSpot company — _Pass ?properties=a,b for specific properties. HubSpot silently drops unknown keys, so the text rendering flags any it never returned._ |
| `getCompanyActivity` | `GET /api/v1/hubspot/companies/{companyId}/activity` | live | Get activity history for a HubSpot company — _Notes, calls, meetings and tasks - never deals. Capped at 100 engagement details; the overflow count is reported._ |
| `getCompanyDeals` | `GET /api/v1/hubspot/companies/{companyId}/deals` | live | List the deals associated with a HubSpot company — _Association scan is bounded at 5000 IDs; truncated:true means the total is a floor, not a count. Needs the crm.objects.deals.read scope._ |
| `getActiveContacts` | `GET /api/v1/hubspot/contacts` | live | Get most recently active HubSpot contacts |
| `getContact` | `GET /api/v1/hubspot/contacts/{contactId}` | live | Get a single HubSpot contact — _Pass ?properties=a,b for specific properties._ |
| `getActiveDeals` | `GET /api/v1/hubspot/deals` | live | Get most recently active HubSpot deals — _Needs the crm.objects.deals.read scope - already-connected users must reconnect before any deal endpoint answers._ |
| `getDeal` | `GET /api/v1/hubspot/deals/{dealId}` | live | Get a single HubSpot deal — _Deal IDs come from the deals list, the company-deals endpoint, or the searchDeals MCP tool._ |
| `listPipelines` | `GET /api/v1/hubspot/pipelines` | live | List HubSpot deal pipelines with their ordered stages — _Use it to resolve a dealstage ID to a stage name._ |
| `getRecentConversations` | `GET /api/v1/hubspot/conversations` | live | Get recent HubSpot conversation threads — _Each thread is fetched with its messages, so this is N+1 upstream calls - keep ?limit modest. ?after pages._ |
| `getTickets` | `GET /api/v1/hubspot/tickets` | live | Get HubSpot tickets by criteria — _criteria=default (closed or modified in the last day) or criteria=Closed. Datetime filters go out as epoch millis; ISO-8601 400s upstream._ |
| `getTicketConversationThreads` | `GET /api/v1/hubspot/tickets/{ticketId}/conversation-threads` | live | Get conversation threads for a HubSpot ticket |
| `getProperty` | `GET /api/v1/hubspot/properties/{objectType}/{propertyName}` | live | Get a HubSpot property definition — _objectType is companies, contacts or deals._ |
| `createCompany` | `POST /api/v1/hubspot/companies` | live | Create a HubSpot company — _Deduped by name like the MCP tool: 201 with created:true when it was written, 200 with created:false and the existing record when a company of that name already existed._ |
| `createContact` | `POST /api/v1/hubspot/contacts` | live | Create a HubSpot contact — _Deduped by first and last name plus company: 201 created:true, or 200 created:false with the existing record._ |
| `createDeal` | `POST /api/v1/hubspot/deals` | live | Create a HubSpot deal — _Deals are not uniquely named, so there is no dedupe step - every call creates a new deal. Always 201._ |
| `createNote` | `POST /api/v1/hubspot/notes` | live | Create a HubSpot note and optionally attach it to a record — _Body limit 5mb. hs_timestamp defaults to now. The response reports whether the timeline association succeeded - a failed association is an orphaned note, not a silent success._ |
| `logCall` | `POST /api/v1/hubspot/calls` | live | Log a HubSpot call activity — _Body limit 5mb - the point is posting a transcript without it crossing the LLM context. Same association reporting as notes._ |
| `logMeeting` | `POST /api/v1/hubspot/meetings` | live | Log a HubSpot meeting activity — _Body limit 5mb for full minutes. Same association reporting as notes._ |

### Redmine (`redmine`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `listIssues` | `GET /api/v1/redmine/issues` | live | Search and filter Redmine issues — _Multi-valued filters are one comma-joined parameter (issueIds=1,2,3); repeated keys are silently ignored upstream. Custom-field filters must be cf_<digits> or they are dropped rather than sent._ |
| `getIssue` | `GET /api/v1/redmine/issues/{issueId}` | live | Get a single Redmine issue — _Pass ?include=journals,relations,watchers,allowed_statuses to embed associations. journals is the comment history._ |
| `listIssueRelations` | `GET /api/v1/redmine/issues/{issueId}/relations` | live | List the relations on a Redmine issue |
| `listProjects` | `GET /api/v1/redmine/projects` | live | List Redmine projects |
| `getProject` | `GET /api/v1/redmine/projects/{projectId}` | live | Get a single Redmine project — _projectId accepts the numeric ID or the URL identifier._ |
| `listUsers` | `GET /api/v1/redmine/users` | live | List Redmine users (admin only) — _Administrator-only upstream - 403 for an ordinary account. Use the project memberships endpoint to resolve user IDs without admin rights._ |
| `getCurrentUser` | `GET /api/v1/redmine/users/current` | live | Get the Redmine account this connection authenticates as — _Registered before /users/{userId} so current is not read as a user ID._ |
| `getUser` | `GET /api/v1/redmine/users/{userId}` | live | Get a single Redmine user |
| `listTimeEntries` | `GET /api/v1/redmine/time-entries` | live | List Redmine time entries — _Set ?allPages=true before summing hours: Redmine caps limit at 100, so a total over one response is wrong by whatever did not fit. That mode answers { items, scan } with no page window, and scan says whether the number is a total or a floor. It also reaches the per-project fallback for instances where the workspace-wide /time_entries.json route alone is broken. Without the flag you get one page and must follow the reported offset to the end yourself._ |
| `getTimeEntry` | `GET /api/v1/redmine/time-entries/{timeEntryId}` | live | Get a single Redmine time entry |
| `listWikiPages` | `GET /api/v1/redmine/projects/{projectId}/wiki` | live | List the wiki page titles of a Redmine project — _Titles only - fetch each page for its text._ |
| `getWikiPage` | `GET /api/v1/redmine/projects/{projectId}/wiki/{title}` | live | Get one Redmine wiki page with its text — _title is the page title exactly as listed, not a slug. ?version fetches a specific revision._ |
| `listVersions` | `GET /api/v1/redmine/projects/{projectId}/versions` | live | List the versions of a Redmine project |
| `getVersion` | `GET /api/v1/redmine/versions/{versionId}` | live | Get a single Redmine version |
| `listIssueCategories` | `GET /api/v1/redmine/projects/{projectId}/issue-categories` | live | List the issue categories of a Redmine project |
| `listMemberships` | `GET /api/v1/redmine/projects/{projectId}/memberships` | live | List the members of a Redmine project with their roles — _The non-admin way to resolve user IDs for assignment and watchers._ |
| `listTrackers` | `GET /api/v1/redmine/trackers` | live | List Redmine trackers with their IDs |
| `listIssueStatuses` | `GET /api/v1/redmine/issue-statuses` | live | List Redmine issue statuses with their IDs |
| `listIssuePriorities` | `GET /api/v1/redmine/issue-priorities` | live | List Redmine issue priorities with their IDs |
| `listTimeEntryActivities` | `GET /api/v1/redmine/time-entry-activities` | live | List Redmine time entry activities with their IDs |
| `listCustomFields` | `GET /api/v1/redmine/custom-fields` | live | List Redmine custom fields and their cf_id filter keys — _Administrator-only upstream, same as the users list._ |
| `searchRedmine` | `GET /api/v1/redmine/search?q={query}` | live | Full text search across Redmine — _q is required. Pass ?issues=true&wikiPages=true etc. to restrict which record types are searched._ |
| `createIssue` | `POST /api/v1/redmine/issues` | live | Create a Redmine issue — _Body limit 5mb. 201 with the created issue. Only projectId and subject are required; everything else falls back to the project or tracker default._ |
| `updateIssue` | `POST /api/v1/redmine/issues/{issueId}` | live | Update a Redmine issue or append a comment — _POST rather than PUT because the catalog scope is GET and POST; Redmine itself takes a PUT here. Body limit 5mb. notes appends a comment, description REPLACES the body. Returns 200 with the issue re-read, since Redmine answers the write with 204 and no body._ |
| `createTimeEntry` | `POST /api/v1/redmine/time-entries` | live | Log time against a Redmine issue or project — _201 with the created entry. Provide issueId or projectId, not neither. Not idempotent - repeating the call logs the hours twice._ |
| `updateWikiPage` | `POST /api/v1/redmine/projects/{projectId}/wiki/{title}` | live | Create or replace a Redmine wiki page — _Body limit 5mb - the clearest large-body case here, since text replaces the whole page. A title that does not exist yet is created. Pass version for optimistic locking so a concurrent edit is rejected rather than clobbered. Returns 200 with the page re-read._ |

### Browserbase (`browserbase`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `listBrowserSessions` | `GET /api/v1/browserbase/sessions` | live | List Browserbase sessions and flag which are still running — _Optional query param: status, one of RUNNING, ERROR, TIMED_OUT, COMPLETED. Omit it to see everything, including sessions left running by an earlier conversation. Also takes ?format=text._ |
| `getBrowserSession` | `GET /api/v1/browserbase/sessions/{sessionId}` | live | Get one Browserbase session with its status and expiry — _Also takes ?format=text. A session that has already been reaped answers 404._ |
| `start` | `POST /api/v1/browserbase/sessions/start` | live | Start a cloud browser session (or reattach to one) and return its id — _Returns the sessionId every later call must pass. The session bills until it is released or hits the project timeout, so pair it with a release._ |
| `navigate` | `POST /api/v1/browserbase/sessions/{sessionId}/navigate` | live | Open a URL in a browser session — _Body: { url }. Answers { sessionId, url, status, title } - an allowlist, because the upstream payload is a serialized CDP connection carrying credentials and internal hostnames that must never be returned. Enforces the domain rules configured on the connection, the only endpoint that can since it is the only one naming a destination, and answers 403 when a rule denies the URL._ |
| `observe` | `POST /api/v1/browserbase/sessions/{sessionId}/observe` | live | Find actionable elements on the current page — _Body: { instruction }._ |
| `extract` | `POST /api/v1/browserbase/sessions/{sessionId}/extract` | live | Extract data or text from the current page — _Body: { instruction } - optional; omit it for the page text._ |
| `forceEndBrowserSession` | `POST /api/v1/browserbase/sessions/{sessionId}/release` | live | Force a Browserbase session to close so it stops billing — _DESTRUCTIVE - anything in progress in that browser is lost, and there is no undo. Exposed with explicit user sign-off: a curl has no confirmation affordance and the permanent dashboard API key is accepted here. It is also the only way to stop a session whose id outlived the conversation that made it, which is why withholding it would cost more than it saves._ |

## Status legend

- **live** — endpoint is currently wired and reachable.
- **planned** — endpoint is in the catalog and on the roadmap; not yet served by the Express app. Calls return 404 until shipped.

Catalog size: 231 endpoints.
