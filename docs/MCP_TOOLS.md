# MCP tools

Generated from `src/<service>/server.ts` by `scripts/buildMcpToolsDoc.mjs`. Do not edit by hand.

Every tool the LLM can call via MCP, grouped by service. The **REST** column shows the matching `/api/v1/*` endpoint when the tool has a REST data-plane sibling — prefer the REST endpoint for bulk reads (see `docs/REST_ENDPOINTS.md`).

## Index

- [Shared (opt-in per server)](#shared-opt-in-per-server-) (2)
- [Google Docs](#google-docs) (30)
- [Google Sheets](#google-sheets) (12)
- [Google Calendar](#google-calendar) (6)
- [Google Drive](#google-drive) (15)
- [Gmail](#gmail) (14)
- [Google Slides](#google-slides) (6)
- [ClickUp](#clickup) (45)
- [Slack (bot)](#slack-bot-) (8)
- [Slack (user)](#slack-user-) (15)
- [Outline](#outline) (27)
- [PeopleForce](#peopleforce) (45)
- [HubSpot](#hubspot) (22)

## Shared (opt-in per server)

Source: `src/sharedTools/mintRestBearerForCurl.ts`, `src/sharedTools/listRestEndpoints.ts` — 2 tools (registered by 10 of 12 servers; not on Outline, HubSpot).

| Tool | Description | REST |
|---|---|---|
| `mintRestBearerForCurl` | ESCAPE HATCH — do NOT call this as a routine auth step. The regular MCP tools (readGoogleDoc, listGoogleDocs, listChannels, etc.) work without any token; you are already authenticated via the MCP session. Only call this if YOU (the client) can run shell commands like curl, and you specifically want to fetch a large/bulk response straight to disk instead of through the LLM context window. The minted bearer is valid 5 minutes against GET <base>/api/v1/* (see listRestEndpoints). If you cannot exec shell, this token is useless to you — skip it. | — |
| `listRestEndpoints` | ESCAPE HATCH companion to mintRestBearerForCurl — only useful if YOU (the client) can run shell commands like curl. The regular MCP tools work without any of this; do NOT call this as a routine discovery step. Lists REST data-plane endpoints under <base>/api/v1/* so a shell-capable client can move bulk payloads without them crossing the LLM context window: GET fetches large responses straight to disk, and POST sends a large request body (or chains a write into a curl \| jq pipeline) without pasting it through a tool call. Optional `service` narrows the result to one provider. | — |

## Google Docs

Source: `src/google-docs/server.ts` — 30 tools.

| Tool | Description | REST |
|---|---|---|
| `listGoogleDocs` | Lists Google Documents from your Google Drive and shared drives with optional filtering. | `GET /api/v1/docs` |
| `searchGoogleDocs` | Searches for Google Documents by name, content, or other criteria across My Drive and shared drives. | `GET /api/v1/docs?q={query}` |
| `getRecentGoogleDocs` | Gets the most recently modified Google Documents from My Drive and shared drives. | `GET /api/v1/docs/recent` |
| `exportDocToPdf` | Exports a Google Doc as a PDF file and saves it to Google Drive. Returns the PDF file ID, name, and link. | — |
| `readGoogleDoc` | Reads the content of a specific Google Document, optionally returning structured data. | `GET /api/v1/docs/{documentId}` |
| `listDocumentTabs` | Lists all tabs in a Google Document, including their hierarchy, IDs, and structure. | `GET /api/v1/docs/{documentId}/tabs` |
| `appendToGoogleDoc` | Appends text to the very end of a specific Google Document or tab. Equivalent to insertText at the document end; use this when you do not know the end index. | — |
| `insertText` | Inserts text at a specific 1-based index within the document body or a specific tab. For end-of-document inserts where you do not have an index, prefer appendToGoogleDoc. | — |
| `deleteRange` | Deletes content within a specified range (start index inclusive, end index exclusive) from the document or a specific tab. | — |
| `applyTextStyle` | Applies character-level formatting to a specific range or found text. Supported style keys: bold, italic, underline, strikethrough, fontSize, fontFamily, foregroundColor, backgroundColor, link. | — |
| `applyParagraphStyle` | Applies paragraph-level formatting (alignment, spacing, named styles like Heading 1) to the paragraph(s) containing specific text, an index, or a range. | — |
| `insertTable` | Inserts a new table with the specified dimensions at a given index. | — |
| `editTableCell` | NOT IMPLEMENTED — always throws. Editing table cells requires non-trivial index calculation that has not been built yet. Use batchUpdateDoc with raw insert/delete requests if you need to modify table contents. | — |
| `insertPageBreak` | Inserts a page break at the specified index. | — |
| `insertImageFromUrl` | Inserts an inline image into a Google Document from a publicly accessible URL. | — |
| `insertLocalImage` | Inserts an image into a Google Document. Provide one of: (1) imageUrl — a public HTTP(S) URL to fetch, (2) driveFileId — ID of an image already in Google Drive, (3) localImagePath — absolute path for local/stdio deployments, or (4) imageBase64 + fileName — base64-encoded content for small images. | — |
| `fixListFormatting` | EXPERIMENTAL: Attempts to detect paragraphs that look like lists (e.g., starting with -, *, 1.) and convert them to proper Google Docs bulleted or numbered lists. Best used on specific sections. | — |
| `listComments` | Lists all comments in a Google Document. | `GET /api/v1/docs/{documentId}/comments` |
| `getComment` | Gets a specific comment with its full thread of replies. | `GET /api/v1/docs/{documentId}/comments/{commentId}` |
| `addComment` | Adds a comment to a Google Document with quoted text context. NOTE: Due to Google Drive API limitations, comments cannot be anchored to specific text positions in Google Docs. The comment will appear in the Comments panel with the quoted text displayed, but won't highlight text in the document body. | — |
| `replyToComment` | Adds a reply to an existing comment. | — |
| `resolveComment` | Marks a comment as resolved. NOTE: Due to Google API limitations, the Drive API does not support resolving comments on Google Docs files. This operation will attempt to update the comment but the resolved status may not persist in the UI. Comments can be resolved manually in the Google Docs interface. | — |
| `deleteComment` | Deletes a comment from the document. | — |
| `findElement` | NOT IMPLEMENTED — always throws. For text search use findAndReplace or formatMatchingText; for structure exploration use inspectDocStructure. | — |
| `formatMatchingText` | Finds specific text within a Google Document and applies character formatting (bold, italics, color, etc.) to the specified instance. | — |
| `findAndReplace` | Finds all occurrences of a text string in a Google Doc and replaces them. Returns the number of replacements made. | — |
| `inspectDocStructure` | Analyzes and returns the structure of a Google Doc: paragraph/table/section counts, headers/footers presence, tab hierarchy. Use detailed mode for element-by-element listing. | `GET /api/v1/docs/{documentId}/structure` |
| `importDocx` | Converts a .docx file already in Google Drive into a Google Doc. Drive auto-converts the format. Returns the new Google Doc ID and link. | — |
| `batchUpdateDoc` | Executes multiple document operations in a single batch. Supports: insert_text, delete_text, replace_text, format_text, update_paragraph_style, insert_table, insert_page_break, find_replace, create_bullet_list. Index-based operations are automatically sorted in descending order to prevent index shifting. | — |
| `importToGoogleDoc` | Import content (text, HTML, or markdown) into a new Google Doc. Google Drive auto-converts the content to Google Docs format. | — |

## Google Sheets

Source: `src/google-sheets/server.ts` — 12 tools.

| Tool | Description | REST |
|---|---|---|
| `readSpreadsheet` | Reads data from a specific range in a Google Spreadsheet. | `GET /api/v1/sheets/{spreadsheetId}/ranges?range={range}` |
| `writeSpreadsheet` | Writes data to a specific range in a Google Spreadsheet. Overwrites existing data in the range. | — |
| `appendSpreadsheetRows` | Appends rows of data to the end of a sheet in a Google Spreadsheet. | — |
| `clearSpreadsheetRange` | Clears all values from a specific range in a Google Spreadsheet. | — |
| `getSpreadsheetInfo` | Gets detailed information about a Google Spreadsheet including all sheets/tabs. | `GET /api/v1/sheets/{spreadsheetId}` |
| `addSpreadsheetSheet` | Adds a new sheet/tab to an existing Google Spreadsheet. | — |
| `createSpreadsheet` | Creates a new Google Spreadsheet (works with shared drives). | — |
| `listGoogleSheets` | Lists Google Spreadsheets from your Google Drive and shared drives with optional filtering. | `GET /api/v1/sheets` |
| `findRowByValue` | Search a column for a specific value and return the 1-based row number where it was found. | `GET /api/v1/sheets/{spreadsheetId}/search` |
| `readRowByField` | Look up a row by searching a column for a value, then return the row as a named JSON object using header names from row 1. | `GET /api/v1/sheets/{spreadsheetId}/rows/{rowNumber}` |
| `updateCellByFieldName` | Find a row by searching a column for a value, then update a specific field (identified by header name) in that row. Assumes row 1 contains the header names. | — |
| `batchUpdateSpreadsheet` | Apply multiple formatting and sheet-lifecycle operations to a Google Spreadsheet in a single atomic batch. Supports number formats, text styling, background colors, borders, freezing, conditional formatting, cell merging, column/row sizing, and tab-level ops (rename/reorder/hide/recolor via updateSheetProperties, deleteSheet, duplicateSheet, addSheet). | — |

## Google Calendar

Source: `src/google-calendar/server.ts` — 6 tools.

| Tool | Description | REST |
|---|---|---|
| `listCalendars` | Lists all calendars accessible to the user. | `GET /api/v1/calendars` |
| `listEvents` | Lists events from a calendar within a specified date range. | `GET /api/v1/calendars/{calendarId}/events` |
| `getEvent` | Gets detailed information about a specific calendar event. | `GET /api/v1/calendars/{calendarId}/events/{eventId}` |
| `createEvent` | Creates a new calendar event. | — |
| `updateEvent` | Updates an existing calendar event. | — |
| `deleteEvent` | Deletes a calendar event. | — |

## Google Drive

Source: `src/google-drive/server.ts` — 15 tools.

| Tool | Description | REST |
|---|---|---|
| `getDocumentInfo` | Gets detailed information about a specific Google Document (works with shared drives). | `GET /api/v1/drive/files/{fileId}` |
| `createFolder` | Creates a new folder in Google Drive or a shared drive. | — |
| `listFolderContents` | Lists the contents of a specific folder in Google Drive or a shared drive. | `GET /api/v1/drive/folders/{folderId}/contents` |
| `getFolderInfo` | Gets detailed information about a specific folder in Google Drive or a shared drive. | `GET /api/v1/drive/folders/{folderId}` |
| `moveFile` | Moves a file or folder to a different location in Google Drive (works with shared drives). | — |
| `copyFile` | Creates a copy of an existing Google Drive file or document (works with shared drives). For a brand-new blank document, use createDocument instead. | — |
| `renameFile` | Renames a file or folder in Google Drive (works with shared drives). | — |
| `deleteFile` | Permanently deletes a file or folder from Google Drive (works with shared drives). | — |
| `createDocument` | Creates a new Google Document (works with shared drives). | — |
| `createFromTemplate` | Creates a new Google Document from an existing document template (works with shared drives). | — |
| `listSharedDrives` | Lists shared drives (Team Drives) the user has access to. | `GET /api/v1/drive/shared-drives` |
| `downloadDriveFile` | Download/export a Google Drive file. For Google Workspace files (Docs, Sheets, Slides), exports to a chosen format (PDF, DOCX, XLSX, PPTX, CSV) and saves the exported file to Drive. For binary files, returns the direct download link. | `GET /api/v1/drive/files/{fileId}/download` |
| `getFilePermissions` | Retrieve all permissions on a Google Drive file or folder. Shows who has access, their roles, and sharing status. | `GET /api/v1/drive/files/{fileId}/permissions` |
| `shareDriveFile` | Share a Google Drive file or folder by creating a permission. Required fields by type: type=user\|group → emailAddress; type=domain → domain; type=anyone → no extra field. | — |
| `checkPublicAccess` | List the file's direct permissions and report whether an "anyone with link" grant exists on the file itself. Does NOT follow folder-inherited, domain-wide, or shared-drive policies, so a file inside a public folder may report private here. | `GET /api/v1/drive/files/{fileId}/public` |

## Gmail

Source: `src/google-gmail/server.ts` — 14 tools.

| Tool | Description | REST |
|---|---|---|
| `sendEmail` | Send an email message. | — |
| `draftEmail` | Create a draft email without sending it. | — |
| `readEmail` | Read the full content of an email by its message ID. | `GET /api/v1/gmail/messages/{messageId}` |
| `searchEmails` | Search emails using Gmail query syntax (e.g., "from:user@example.com", "subject:hello", "is:unread", "newer_than:2d"). | `GET /api/v1/gmail/messages?q={query}` |
| `modifyEmail` | Modify labels on a single email message (add or remove labels). For more than one message, prefer batchModifyEmails. | — |
| `deleteEmail` | Move an email message to the trash. | — |
| `batchModifyEmails` | Modify labels on multiple email messages at once (single atomic request). For a single message, modifyEmail is simpler. Limit: 1000 message IDs per call. | — |
| `batchDeleteEmails` | Move multiple email messages to the trash. | — |
| `listLabels` | List all Gmail labels with their message and thread counts. | `GET /api/v1/gmail/labels` |
| `createLabel` | Create a new Gmail label. | — |
| `updateLabel` | Update an existing Gmail label name or visibility settings. | — |
| `deleteLabel` | Delete a Gmail label. System labels (INBOX, SENT, etc.) cannot be deleted. | — |
| `getOrCreateLabel` | Get a label by name, creating it if it does not exist. Returns the label ID. | — |
| `getAttachment` | Download an email attachment. Returns the content as base64-encoded data. | `GET /api/v1/gmail/messages/{messageId}/attachments/{attachmentId}` |

## Google Slides

Source: `src/google-slides/server.ts` — 6 tools.

| Tool | Description | REST |
|---|---|---|
| `createPresentation` | Create a new Google Slides presentation. | — |
| `getPresentation` | Get presentation metadata, slide IDs, and text content from all slides. | `GET /api/v1/slides/{presentationId}` |
| `getPage` | Get details of a specific slide including shapes, tables, and other elements. | `GET /api/v1/slides/{presentationId}/pages/{pageObjectId}` |
| `getPageThumbnail` | Get a PNG thumbnail URL for a specific slide. | `GET /api/v1/slides/{presentationId}/pages/{pageObjectId}/thumbnail` |
| `batchUpdatePresentation` | Apply multiple operations to a presentation (create slides, add shapes, insert text, delete objects, etc.). Pass an array of Google Slides API request objects. | — |
| `listPresentationComments` | List comments on a Google Slides presentation (via Drive API). | `GET /api/v1/slides/{presentationId}/comments` |

## ClickUp

Source: `src/clickup/server.ts` — 45 tools.

| Tool | Description | REST |
|---|---|---|
| `getAuthorizedUser` | Get information about the currently authenticated ClickUp user. Useful for debugging connections and getting your user ID. | `GET /api/v1/clickup/user` |
| `listWorkspaces` | List all accessible ClickUp workspaces (teams). Returns workspace IDs needed for other operations. | `GET /api/v1/clickup/workspaces` |
| `listSpaces` | List all spaces in a ClickUp workspace. | `GET /api/v1/clickup/workspaces/{workspaceId}/spaces` |
| `listFolders` | List all folders in a ClickUp space. | `GET /api/v1/clickup/spaces/{spaceId}/folders` |
| `listLists` | List all lists in a ClickUp folder, or folderless lists in a space. Provide either folderId or spaceId. | — |
| `getTask` | Get detailed information about a specific ClickUp task by its ID. Returns the FULL, untruncated description — use this (not the list tools, which show a bounded preview) when you need to read a ticket in full to summarize it, reuse it as a template, or check acceptance criteria. | `GET /api/v1/clickup/tasks/{taskId}` |
| `listTasks` | List tasks in a ClickUp list with optional filters. To query tasks closed within a window, set closedAfter and/or closedBefore — the tool then forces include_closed, auto-paginates up to 2000 tasks, and filters locally on date_closed (ClickUp's REST API has no server-side close-date filter). | `GET /api/v1/clickup/lists/{listId}/tasks` |
| `createTask` | Create a new task in a ClickUp list. | — |
| `updateTask` | Update an existing ClickUp task. Only provided fields will be changed. | — |
| `deleteTask` | Delete a ClickUp task permanently. | — |
| `moveTask` | Move a task to a different list. | — |
| `addTaskComment` | Add a comment to a ClickUp task. Supports markdown formatting: **bold**, *italic*, `inline code`. | — |
| `getTaskComments` | Get comments on a ClickUp task. | `GET /api/v1/clickup/tasks/{taskId}/comments` |
| `filterTeamTasks` | Query tasks across a ClickUp workspace using ClickUp's server-side "Get Filtered Team Tasks" endpoint (GET /api/v2/team/{team_id}/task). One paginated call replaces per-list enumeration for workspace-wide digests. Returns tasks the caller can access (naturally scoped by the OAuth identity), 100 per page — iterate `page` from 0 to fetch all. Supports assignees, statuses, tags, scope narrowing (spaceIds/projectIds/listIds), and date ranges on date_created / date_updated / due_date. IMPORTANT: ClickUp does NOT support date_closed / date_done filters or a close-date sort here — for "closed since T", query with `dateUpdatedGt=T` (closing bumps date_updated, so this is a superset) and partition on each task's `date_closed` client-side. | `GET /api/v1/clickup/workspaces/{workspaceId}/tasks/filter` |
| `searchTasks` | Search for tasks across a ClickUp workspace. Supports filtering by name (client-side substring match) and/or custom fields. By default excludes closed/completed tasks — set includeClosed=true to include them. To query tasks closed within a window, set closedAfter and/or closedBefore — the tool then forces include_closed, auto-paginates up to 2000 tasks, and filters locally on date_closed (ClickUp's REST API has no server-side close-date filter). | `GET /api/v1/clickup/workspaces/{workspaceId}/tasks/search` |
| `getAccessibleCustomFields` | List all custom fields available on a ClickUp list. Use this to discover field IDs for filtering or setting values. | `GET /api/v1/clickup/lists/{listId}/fields` |
| `setCustomFieldValue` | Set a custom field value on a ClickUp task. Use getAccessibleCustomFields first to find the field ID and type. Value shape depends on field type: text/email/phone → string; number → number; drop_down → option orderindex (int); users → array of user IDs; labels → array of label UUIDs; date → unix ms. NOTE: drop_down uses orderindex here, but searchTasks custom_fields filter uses the option UUID — getAccessibleCustomFields returns both. | — |
| `removeCustomFieldValue` | Remove/clear a custom field value from a ClickUp task. | — |
| `listSpaceTags` | List all tags defined in a ClickUp space. Use this to discover tag names available for addTagToTask / removeTagFromTask. | — |
| `addTagToTask` | Add a tag to a ClickUp task. If the tag does not already exist in the task's space, ClickUp auto-creates it on the fly — call listSpaceTags first when you want to reuse existing tags and avoid tag proliferation. ClickUp's updateTask endpoint does not accept tags; this is the correct way to tag an existing task. | — |
| `removeTagFromTask` | Remove a tag from a ClickUp task. Does not delete the tag from the space — only unassigns it from this task. | — |
| `getTaskMembers` | List all members assigned to a ClickUp task. | `GET /api/v1/clickup/tasks/{taskId}/members` |
| `subscribeToTaskEvents` | Subscribe this user's digest routine to ClickUp task events for a workspace. Creates a webhook on ClickUp's side and stores its shared secret so the ingestion endpoint can verify inbound POSTs. IDEMPOTENT: re-calling with the same (user, workspace) returns the existing subscription without hitting ClickUp again. Default event bundle is `taskCreated`, `taskStatusUpdated`, `taskAssigneeUpdated`, `taskMoved`, `taskDeleted` — deliberately excludes `taskUpdated` (firehose, redundant with the pull-side `date_updated_gt` filter on filterTeamTasks). Requires the BASE_URL env var so ClickUp can call back. Once subscribed, the event store accrues from this moment forward — history queries against events before this timestamp fall back to the `date_updated + current status` approximation. | — |
| `getTaskEventHistory` | Read from-status→to-status transitions (and other captured events) for a ClickUp workspace, sourced from the event store populated by subscribeToTaskEvents. Use this to answer "what moved to In Review since last report" exactly, instead of approximating from date_updated + current status. IMPORTANT: history accrues from the moment subscribeToTaskEvents was first called — events before that boundary are NOT in the store; the response includes `eventStoreStartedAt` so the caller can fall back to filterTeamTasks with dateUpdatedGt for any earlier window. If no subscription exists for the (user, workspace), the response is `kind: "no-subscription"` with a warning — not an error — so the digest can gracefully fall back to pull. | `GET /api/v1/clickup/workspaces/{workspaceId}/events` |
| `listTaskEventSubscriptions` | List task-event webhook subscriptions owned by the current user. Surfaces fail_count so operators can spot a dying webhook (ClickUp stops delivering after 5 consecutive failures). Optionally narrow to a single workspace. | `GET /api/v1/clickup/subscriptions` |
| `debugTaskEventSubscription` | Cross-reference the local task-event subscription against ClickUp's own view of the webhook and the event store, and surface anomalies. Use when subscribeToTaskEvents reports success but events aren't landing, or when local fail_count doesn't match reality. Detects: endpoint-URL drift (BASE_URL changed since subscribe), orphaned ClickUp webhook (local record points at a webhook ClickUp deleted), event-bundle mismatch, ClickUp fail_count > local fail_count (ClickUp seeing non-2xx/timeouts while our counter stays flat — NOT the silent-200 pattern), disabled webhook status, and the "zero events with zero failures" pattern (silent 200s: ingestion returning success without persisting). | `GET /api/v1/clickup/workspaces/{workspaceId}/subscription/debug` |
| `unsubscribeFromTaskEvents` | Delete the ClickUp task-event subscription for a workspace. Best-effort deletes both the ClickUp-side webhook and the local record; if ClickUp already deleted or disabled the webhook, still clears the local row so a fresh subscribeToTaskEvents can create a new one. Use this to recover from the "webhook disabled by ClickUp after 5 fails" state or after debugTaskEventSubscription flags an endpoint mismatch. | — |
| `createList` | Create a new list in a ClickUp folder, or a folderless list in a space. | — |
| `createFolder` | Create a new folder in a ClickUp space. | — |
| `createSpace` | Create a new space in a ClickUp workspace. | — |
| `updateList` | Update properties of an existing ClickUp list. | — |
| `deleteList` | Delete a ClickUp list permanently. | — |
| `listDocs` | List one page of ClickUp Docs in a workspace, in ClickUp's own order (oldest first). Returns a cursor when more pages exist. To find a doc by name, or to get every doc newest-first, use searchDocs instead — it pages through the whole workspace for you. | `GET /api/v1/clickup/workspaces/{workspaceId}/docs` |
| `getDoc` | Get a ClickUp Doc by ID, including its pages and their content (markdown). | `GET /api/v1/clickup/docs/{docId}?workspaceId={workspaceId}` |
| `searchDocs` | Find ClickUp Docs by name, newest first. Pages through the entire workspace, so a recently-created doc is found regardless of how many docs exist. Matching is case-insensitive and token-based: every word in the query must appear in the title, in any order, so "AWESOME Sync" matches "[AWESOME] Sync - 08/15/2026". Omit query to list every doc newest-first. Always reports how many docs were scanned, so an empty result means "not there" rather than "did not look". | `GET /api/v1/clickup/workspaces/{workspaceId}/docs/search` |
| `createDoc` | Create a new ClickUp Doc in a workspace. Optionally place it inside a Space, Folder, or List by providing parent ID and type. | — |
| `getPage` | Get a specific page from a ClickUp Doc, including its full content in markdown. | `GET /api/v1/clickup/docs/{docId}/pages/{pageId}?workspaceId={workspaceId}` |
| `createPage` | Create a new page in a ClickUp Doc. | — |
| `editPage` | Edit a page in a ClickUp Doc. Can replace, append, or prepend content. | — |
| `insertImageIntoPage` | Add an image to a ClickUp Doc page. Provide the image as EXACTLY ONE of imageUrl (a public http(s) URL — strongly preferred) or imageBase64 (base64 bytes, for SMALL images only — the payload consumes the calling model context, so use imageUrl whenever a public URL exists). The image is re-hosted (recompressed to WebP) and embedded as markdown (append by default). ClickUp has no image-upload API for docs, so the image is stored and served by this server — requires DATABASE_URL and IMAGE_PUBLIC_BASE_URL. If imageUrl is already on this server, re-hosting is skipped automatically; pass skipRehost:true to force embedding the given URL as-is. | — |
| `uploadClickUpDocImage` | Re-host an image on this server (recompressed to WebP) and return a public URL you can embed in a ClickUp Doc page as markdown (![](url)). Provide the image as EXACTLY ONE of imageUrl (a public http(s) URL — strongly preferred) or imageBase64 (base64 bytes, for SMALL images only — the payload consumes the calling model context, so use imageUrl whenever a public URL exists). Use this when you want the URL without immediately writing to a page; otherwise use insertImageIntoPage. Requires DATABASE_URL and IMAGE_PUBLIC_BASE_URL to be configured. | — |
| `listWorkspaceMembers` | List all members of a ClickUp workspace. Useful for looking up user IDs by name when assigning tasks. | `GET /api/v1/clickup/workspaces/{workspaceId}/members` |
| `startTimeEntry` | Start a time tracking entry for a task in ClickUp. | — |
| `stopTimeEntry` | Stop the currently running time tracking entry. | — |
| `getTimeEntries` | Get time tracking entries for a workspace. | `GET /api/v1/clickup/workspaces/{workspaceId}/time` |

## Slack (bot)

Source: `src/slack/server.ts` — 8 tools.

| Tool | Description | REST |
|---|---|---|
| `listChannels` | List Slack channels and DMs the bot is a member of. Includes public/private channels and 1-on-1 DMs. The bot only sees channels where it has been /invited. | `GET /api/v1/slack/channels` |
| `readChannelHistory` | Read recent messages from a Slack channel. Returns messages in chronological order. | `GET /api/v1/slack/channels/{channelId}/messages` |
| `readThreadReplies` | Read replies in a Slack thread. The first message is the thread parent. | `GET /api/v1/slack/channels/{channelId}/threads/{threadTs}` |
| `downloadFile` | Download a file attached to a Slack message. Get the fileId from the 📎 lines in readChannelHistory or readThreadReplies output, and pass the channel you read it from. Images: format "url" (default) re-hosts the image at a public URL suitable for tools that take an image URL (e.g. insertImageFromUrl), format "inline" returns the image itself so you can look at it. Text files are returned as text; other file types return metadata only. | — |
| `postMessage` | Post a message to a Slack channel. | — |
| `replyInThread` | Reply to a thread in a Slack channel. | — |
| `listUsers` | List workspace members. Use this to find a user by name and get their user ID for opening a DM. | `GET /api/v1/slack/users` |
| `openDm` | Open (or retrieve) a 1-on-1 DM channel with a user. Returns the DM channel ID that can be used with postMessage. | — |

## Slack (user)

Source: `src/slack-user/server.ts` — 15 tools.

| Tool | Description | REST |
|---|---|---|
| `listChannels` | List Slack channels and DMs you have access to, filtered by your access rules. Use the "search" parameter to find a specific channel by name without paginating. | — |
| `readChannelHistory` | Read recent messages from a Slack channel. Access rules are enforced. | — |
| `readThreadReplies` | Read replies in a Slack thread. Access rules are enforced. | — |
| `downloadFile` | Download a file attached to a Slack message. Get the fileId from the 📎 lines in readChannelHistory or readThreadReplies output, and pass the channel you read it from. Images: format "url" (default) re-hosts the image at a public URL suitable for tools that take an image URL (e.g. insertImageFromUrl), format "inline" returns the image itself so you can look at it. Text files are returned as text; other file types return metadata only. Access rules are enforced. | — |
| `searchMessages` | Search Slack messages across the workspace by keyword. Use this instead of paging readChannelHistory when looking for a specific message. Supports Slack search operators in the query: in:#channel, from:@user, before:YYYY-MM-DD, after:YYYY-MM-DD, has:link. Access rules are enforced — matches in channels you are not allowed to read are removed from the results. | — |
| `searchFiles` | Search files shared in Slack by name or content. Returns each file with its ID and the channels it is shared in — pass one of those channel IDs to downloadFile to fetch the content. Access rules are enforced: a file is shown only if at least one channel it is shared in is one you are allowed to read, and a file Slack reports no channel for is withheld (the response says how many, separately from rules denials). | — |
| `postMessage` | Post a message to a Slack channel. | — |
| `replyInThread` | Reply to a thread in a Slack channel. | — |
| `listUsers` | List workspace members. Use this to find a user by name and get their user ID for opening a DM. | — |
| `openDm` | Open (or retrieve) a 1-on-1 DM channel with a user. Returns the DM channel ID that can be used with postMessage. | — |
| `subscribeToChannelEvents` | Record interest in a Slack channel's events so they accrue in a durable store you can query later with getChannelEventHistory, instead of re-reading the channel and tracking your own watermark. IDEMPOTENT: re-calling for the same channel returns the existing subscription. Events are "message" (new messages and thread replies in public channels, private channels, DMs, and group DMs; join/leave noise is excluded) and "reaction_added". Slack delivers each of those channel types through a SEPARATE app-level toggle (message.channels / message.groups / message.im / message.mpim), so a workspace with only message.channels enabled records nothing for a DM — this tool names the one your channel needs. Optionally set matchPattern to record only messages whose text contains it (case-insensitive substring). History accrues from this moment forward — for anything earlier use readChannelHistory. Requires the operator to have configured the Slack app's Event Subscriptions Request URL and SLACK_SIGNING_SECRET; run debugChannelEventSubscription if events do not arrive. Access rules are enforced. | — |
| `listChannelEventSubscriptions` | List the Slack channel-event subscriptions you own, with their event types, match patterns and fail counts. Optionally narrow to one channel. | — |
| `getChannelEventHistory` | Read the Slack events captured for a channel since you subscribed to it — the exact record of what happened, instead of re-reading the channel and filtering client-side. IMPORTANT: history only accrues from the moment subscribeToChannelEvents was called; the response reports that boundary, and for earlier windows you should fall back to readChannelHistory. If no subscription exists this reports that as a warning rather than an error, so a routine can fall back cleanly. Access rules are enforced on every call, so a channel that has since been denied stops returning history. | — |
| `debugChannelEventSubscription` | Diagnose a channel-event subscription that reports success but is not accruing events. Reports the local record, whether SLACK_SIGNING_SECRET is configured, the Request URL the Slack app must be pointed at, which per-channel-type event subscription (message.channels / message.groups / message.im / message.mpim) this channel needs enabled on the Slack app, whether you are a member of the channel, event-store counts, and — decisively — whether Slack has ever POSTed to this deployment at all and how those deliveries ended. That last part separates "the Request URL is not configured" from "deliveries arrive but nothing matched". Use when getChannelEventHistory stays empty. | — |
| `unsubscribeFromChannelEvents` | Delete your channel-event subscription for a Slack channel. This also deletes the events captured for it, so history cannot be recovered by re-subscribing — a fresh subscription starts accruing from that moment. Nothing changes on Slack's side: event delivery is configured on the app, so other subscribers keep receiving events. | — |

## Outline

Source: `src/outline/server.ts` — 27 tools.

| Tool | Description | REST |
|---|---|---|
| `getDocument` | Retrieves an Outline document by ID and returns its title and markdown content. | — |
| `exportDocument` | Exports an Outline document as plain markdown text. | — |
| `searchDocuments` | Full-text search across Outline documents. Supports collection filter and status filter (draft/archived/published). | — |
| `getDocumentIdFromTitle` | Find an Outline document ID by title. Prefers exact matches, falls back to best partial match. | — |
| `listRecentlyUpdatedDocuments` | Lists Outline documents ordered by most recent change (newest first). Coarse time window: day/week/month/year. | — |
| `getDocumentBacklinks` | Lists all Outline documents that link to a given document. | — |
| `listArchivedDocuments` | Lists all archived Outline documents. | — |
| `listTrash` | Lists all Outline documents currently in the trash. | — |
| `createDocument` | Creates a new Outline document in a collection. Optionally publishes immediately, sets an icon, or nests under a parent. | — |
| `updateDocument` | Updates an Outline document. Replaces title/content unless append=true. | — |
| `moveDocument` | Moves an Outline document to a different collection and/or under a different parent. Must specify at least one destination. | — |
| `archiveDocument` | Archives an Outline document (removes from collections but keeps searchable). Reversible via unarchiveDocument. | — |
| `unarchiveDocument` | Unarchives a previously archived Outline document. | — |
| `restoreDocument` | Restores an Outline document from the trash back to active status. | — |
| `deleteDocument` | Moves an Outline document to trash. Set permanent=true to skip trash and delete immediately (irreversible). | — |
| `listCollections` | Lists all Outline collections in the workspace. | — |
| `getCollectionStructure` | Returns the hierarchical document tree for an Outline collection. | — |
| `createCollection` | Creates a new Outline collection. | — |
| `updateCollection` | Updates an Outline collection's name, description, or color. Provide at least one field. | — |
| `deleteCollection` | Permanently deletes an Outline collection AND all documents in it. This cannot be undone. | — |
| `exportCollection` | Starts an async export of an Outline collection. Returns a file operation ID and status. | — |
| `exportAllCollections` | Starts an async export of the entire Outline workspace. Returns a file operation ID and status. | — |
| `listDocumentComments` | Lists comments on an Outline document (paginated). | — |
| `getComment` | Retrieves a single Outline comment by ID. | — |
| `addComment` | Adds a comment on an Outline document, or replies to an existing comment. | — |
| `listDocumentAttachments` | Lists attachment IDs referenced in an Outline document by parsing its markdown for /api/attachments.redirect links. | — |
| `getAttachmentUrl` | Resolves an Outline attachment ID to a signed download URL by following the /api/attachments.redirect redirect. | — |

## PeopleForce

Source: `src/peopleforce/server.ts` — 45 tools.

| Tool | Description | REST |
|---|---|---|
| `listEmployees` | Lists PeopleForce employees, 50 per page (server-fixed). Use `page` to paginate. IMPORTANT: omitting `status` returns ACTIVE employees only, not everyone — there is no "all" option, so a full headcount means one pass with status=active plus one with status=inactive. Use status=probation to get just the employees currently on probation — a real server-side segment, so you get that cohort directly instead of filtering the whole directory. It is paginated like every other list: follow `metadata.pagination` and request further pages whenever more are reported. Each employee shows their probation end date and a derived probation state. Any tenant-defined custom fields are included per employee when the list payload carries them (field names and availability vary by tenant). | `GET /api/v1/peopleforce/employees` |
| `getEmployee` | Retrieves a single PeopleForce employee by ID. Returns full profile: contact, position, department, division, employment type, location, reporting line, and hiring dates. Any tenant-defined custom fields the profile carries are shown under a Custom Fields section (field names and availability vary by tenant; the section is omitted when the record has none). | `GET /api/v1/peopleforce/employees/{employeeId}` |
| `listDepartments` | Lists all PeopleForce departments, 50 per page (server-fixed). Use `page` to paginate. | `GET /api/v1/peopleforce/departments` |
| `listLeaveRequests` | Lists PeopleForce leave requests, 100 per page (server-fixed). Use `page` to paginate; `state` filters by lifecycle state (e.g. "pending", "approved", "declined"). PeopleForce's public API does NOT support server-side filtering by employee or date range — fetch pages and filter client-side if needed. | `GET /api/v1/peopleforce/leave-requests` |
| `createLeaveRequest` | Creates a new PeopleForce leave request (time off) for an employee against a specific leave-type ID. Call `listLeaveTypes` first if you need the ID. | `POST /api/v1/peopleforce/leave-requests` |
| `getLeaveRequest` | Retrieves a single PeopleForce leave request by ID (state, dates, amount, employee, comment). | `GET /api/v1/peopleforce/leave-requests/{leaveRequestId}` |
| `listLeaveTypes` | Lists PeopleForce leave types (Vacation, Sick, Sabbatical, etc.) with their IDs and time-tracking unit (days/hours). Call this to find the `leaveTypeId` needed for `createLeaveRequest`. | `GET /api/v1/peopleforce/leave-types` |
| `listPositions` | Lists all PeopleForce job positions with their IDs. Server-fixed 50 per page. | `GET /api/v1/peopleforce/positions` |
| `listDivisions` | Lists PeopleForce divisions (org-chart layer above departments) with their IDs. | `GET /api/v1/peopleforce/divisions` |
| `listLocations` | Lists PeopleForce office/remote locations with country code and time zone. Server-fixed 50 per page. | `GET /api/v1/peopleforce/locations` |
| `listEmploymentTypes` | Lists PeopleForce employment types (Employee, Contractor, Intern, etc.) with their IDs. | `GET /api/v1/peopleforce/employment-types` |
| `listJobLevels` | Lists PeopleForce job levels (Junior, Mid, Senior, Head of, etc.) with their IDs. | `GET /api/v1/peopleforce/job-levels` |
| `listSkills` | Lists the PeopleForce skills catalog (workspace-wide) with IDs. Server-fixed 50 per page. | `GET /api/v1/peopleforce/skills` |
| `listCompetencies` | Lists PeopleForce competencies (behavioral/performance dimensions used in reviews) with their IDs. | `GET /api/v1/peopleforce/competencies` |
| `listTasks` | Lists PeopleForce tasks (onboarding, applicant follow-ups, etc.) with assignee, dates, and completion state. Server-fixed 50 per page. | `GET /api/v1/peopleforce/tasks` |
| `listEmployeeLeaveBalances` | Lists a specific employee's current leave balances per leave type (e.g. "how many vacation days does this person have?"). | `GET /api/v1/peopleforce/employees/{employeeId}/leave-balances` |
| `listEmployeeSkills` | Lists the skills recorded on a specific employee's profile with proficiency level. | `GET /api/v1/peopleforce/employees/{employeeId}/skills` |
| `listEmployeeDocuments` | Lists documents attached to a specific employee's profile. Payload shape is dumped as JSON since the public API doesn't document a fixed schema for this endpoint. | `GET /api/v1/peopleforce/employees/{employeeId}/documents` |
| `listEmployeeNotes` | Lists HR notes on a specific employee's profile. Payload dumped as JSON (undocumented shape). | `GET /api/v1/peopleforce/employees/{employeeId}/notes` |
| `listEmployeeEmergencyContacts` | Lists emergency contacts on a specific employee's profile. Payload dumped as JSON (undocumented shape). | `GET /api/v1/peopleforce/employees/{employeeId}/emergency-contacts` |
| `listObjectives` | Lists performance objectives (OKRs) with owner, progress %, status, period, and key results. Use for development-goal analytics. Paginated (server-fixed page size). | `GET /api/v1/peopleforce/objectives` |
| `listKeyPerformanceIndicators` | Lists key performance indicators (KPIs) with owner/scope (individual, department, division, location, company), progress %, and status. Paginated (server-fixed page size). | `GET /api/v1/peopleforce/kpis` |
| `listKnowledgeBaseCategories` | Lists Knowledge Base ("Learning") categories with IDs. Call this to get the `categoryId` needed for listKnowledgeBaseArticles. Paginated (server-fixed page size). | `GET /api/v1/peopleforce/knowledge-base/categories` |
| `listKnowledgeBaseArticles` | Lists Knowledge Base ("Learning") articles within a category (title, category, author, timestamps). Needs a `categoryId` from listKnowledgeBaseCategories. Paginated. | `GET /api/v1/peopleforce/knowledge-base/articles?categoryId={categoryId}` |
| `listEmployeeTables` | Lists PeopleForce employee custom tables (repeating-row profile sections, e.g. "Dev Sprint participation") with their columns and — critically — each table's `internal_name`, which getEmployeeTable needs. Server-fixed page size. | `GET /api/v1/peopleforce/employee-tables` |
| `getEmployeeTable` | Retrieves the row-level data of one custom table for a specific employee — e.g. an employee's "Dev Sprint participation" rows (each row's columns and values). Needs the employee ID and the table's `internalName` (from listEmployeeTables). | `GET /api/v1/peopleforce/employees/{employeeId}/tables/{tableInternalName}` |
| `getKnowledgeBaseArticle` | Retrieves a single Knowledge Base ("Learning") article by ID, including its full body text. | `GET /api/v1/peopleforce/knowledge-base/articles/{articleId}` |
| `listVacancies` | Lists recruitment vacancies (job openings). Filter by `status` (drafting, opened, closed, held, cancelled, archived) and/or `tagIds`. Paginated (server-fixed page size). Use this to find the vacancy a candidate pipeline belongs to. | `GET /api/v1/peopleforce/recruitment/vacancies` |
| `getVacancy` | Retrieves a single recruitment vacancy by ID, including its internal job description and pipeline stages. Use the description to match a candidate against the role. | `GET /api/v1/peopleforce/recruitment/vacancies/{vacancyId}` |
| `listRecruitmentPipelines` | Lists recruitment pipelines and their stage definitions (with stage IDs). Call this to find the `pipelineStageId` needed for listCandidates or moveVacancyApplication. | `GET /api/v1/peopleforce/recruitment/pipelines` |
| `listCandidates` | Lists recruitment candidates. Filter by `vacancyIds` (candidates applied to those vacancies), `pipelineStageId` (candidates at a stage), `skills` (stack), `email`, and created/updated date ranges (YYYY-MM-DD or ISO). This is the entry point for pulling a role's pipeline excerpt. | `GET /api/v1/peopleforce/recruitment/candidates` |
| `getCandidate` | Retrieves a single recruitment candidate by ID: full profile (contact, location, source, skills, salary expectation, current stage/vacancy). | `GET /api/v1/peopleforce/recruitment/candidates/{candidateId}` |
| `listCandidateNotes` | Lists recruiter notes on a candidate — the main place free-text feedback (including technical-assessment comments) is recorded. The public API has no separate scorecard/test-result endpoint. | `GET /api/v1/peopleforce/recruitment/candidates/{candidateId}/notes` |
| `listCandidateExperiences` | Lists a candidate's work experience entries (company, role, dates) — used to assess years/stack. | `GET /api/v1/peopleforce/recruitment/candidates/{candidateId}/experiences` |
| `listCandidateEducations` | Lists a candidate's education entries (institution, degree, field, dates). | `GET /api/v1/peopleforce/recruitment/candidates/{candidateId}/educations` |
| `listCandidateMovements` | Lists candidate pipeline movements (stage transitions) across recruitment — the history of who moved where and when. Paginated. | `GET /api/v1/peopleforce/recruitment/candidate-movements` |
| `listVacancyApplications` | Lists the applications (candidates) on a specific vacancy with their current pipeline stage — i.e. the vacancy's pipeline excerpt. Paginated. | `GET /api/v1/peopleforce/recruitment/vacancies/{vacancyId}/applications` |
| `getVacancyApplication` | Retrieves a single vacancy application by vacancy ID + application ID (candidate, current stage, disqualification). | `GET /api/v1/peopleforce/recruitment/vacancies/{vacancyId}/applications/{applicationId}` |
| `listDisqualifyReasons` | Lists recruitment disqualify reasons with their IDs. Call this to find the `disqualifyReasonId` needed for disqualifyVacancyApplication. | `GET /api/v1/peopleforce/recruitment/disqualify-reasons` |
| `listRecruitmentSources` | Lists recruitment sources (where candidates came from) with their IDs. | `GET /api/v1/peopleforce/recruitment/sources` |
| `getCandidateDossier` | Assembles a single candidate dossier for assessment: profile + recruiter notes + work experience + education, plus the current application/stage when `vacancyId` is given. One call to gather everything the AI needs to evaluate a candidate against a role. Best-effort: parts that fail to load are noted, not fatal. | `GET /api/v1/peopleforce/recruitment/candidates/{candidateId}/dossier` |
| `getPublishedJobDescription` | Fetches the canonical public job description for a vacancy from the PeopleForce Careers API. Use this to get the exact JD text posted on your careers site for matching. Note: some tenants gate the Careers API behind a separate career-site token — if this returns not-authorized, use getVacancy's description instead. | `GET /api/v1/peopleforce/recruitment/published-vacancies/{vacancyId}` |
| `moveVacancyApplication` | Moves a candidate's vacancy application to a different pipeline stage. Needs the vacancy ID, application ID, and target `pipelineStageId` (from listRecruitmentPipelines or getVacancy). | `POST /api/v1/peopleforce/recruitment/vacancies/{vacancyId}/applications/{applicationId}/move` |
| `disqualifyVacancyApplication` | Disqualifies a vacancy application with a reason. Needs the vacancy ID, application ID (from listVacancyApplications), and a `disqualifyReasonId` (from listDisqualifyReasons); an optional comment is recorded. | `POST /api/v1/peopleforce/recruitment/vacancies/{vacancyId}/applications/{applicationId}/disqualify` |
| `addCandidateNote` | Adds a note to a candidate — e.g. to record the AI's assessment or interview feedback back into PeopleForce. The note appears on the candidate card. | `POST /api/v1/peopleforce/recruitment/candidates/{candidateId}/notes` |

## HubSpot

Source: `src/hubspot/server.ts` — 22 tools.

| Tool | Description | REST |
|---|---|---|
| `createCompany` | Create a new company in HubSpot (skips creation if a company with the same name already exists). | — |
| `getCompany` | Get a specific company by ID from HubSpot. | — |
| `updateCompany` | Update an existing company record in HubSpot. | — |
| `getCompanyActivity` | Get activity/engagement history (notes, emails, calls, meetings, tasks) for a specific company. | — |
| `createContact` | Create a new contact in HubSpot (skips creation if a matching contact already exists). | — |
| `getContact` | Get a specific contact by ID from HubSpot. | — |
| `updateContact` | Update an existing contact record in HubSpot. | — |
| `getDeal` | Get a specific deal by ID from HubSpot. | — |
| `createDeal` | Create a new deal in HubSpot. Set dealstage/pipeline via properties (use listPipelines to resolve stage IDs). | — |
| `updateDeal` | Update an existing deal record in HubSpot (e.g. move stage, change amount). | — |
| `listPipelines` | List HubSpot deal pipelines and their stages (with stage IDs), so deal stage IDs can be resolved to human-readable names. | — |
| `getRecentConversations` | Get recent conversation threads from HubSpot with their messages. | — |
| `getTickets` | Get tickets from HubSpot based on configurable selection criteria. | — |
| `getTicketConversationThreads` | Get conversation threads (and their messages) associated with a specific ticket. | — |
| `getProperty` | Get details of a specific HubSpot property definition. | — |
| `updateProperty` | Update a HubSpot property definition (e.g., add dropdown options). | — |
| `createProperty` | Create a new custom property in HubSpot. | — |
| `createNote` | Create a note and optionally attach it to a company, contact, or deal so it appears on that record's timeline. | — |
| `createTask` | Create a task and optionally attach it to a company, contact, or deal. | — |
| `logCall` | Log a call activity and optionally attach it to a company, contact, or deal. | — |
| `logMeeting` | Log a meeting activity and optionally attach it to a company, contact, or deal. | — |
| `deleteEngagement` | Delete a note, task, call, or meeting by ID — the cleanup counterpart to createNote/createTask/logCall/logMeeting. | — |

---

**Grand total: 247 tools across 13 sections.**
