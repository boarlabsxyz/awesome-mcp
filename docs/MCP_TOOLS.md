# MCP tools

Generated from `src/<service>/server.ts` by `scripts/buildMcpToolsDoc.mjs`. Do not edit by hand.

Every tool the LLM can call via MCP, grouped by service. The **REST** column shows the matching `/api/v1/*` endpoint when the tool has a REST data-plane sibling — prefer the REST endpoint for bulk reads (see `docs/REST_ENDPOINTS.md`).

## Index

- [Shared (every server)](#shared-every-server-) (2)
- [Google Docs](#google-docs) (30)
- [Google Sheets](#google-sheets) (12)
- [Google Calendar](#google-calendar) (6)
- [Google Drive](#google-drive) (15)
- [Gmail](#gmail) (14)
- [Google Slides](#google-slides) (6)
- [ClickUp](#clickup) (38)
- [Slack (bot)](#slack-bot-) (7)
- [Slack (user)](#slack-user-) (7)
- [Outline](#outline) (27)

## Shared (every server)

Source: `src/sharedTools/mintRestBearerForCurl.ts`, `src/sharedTools/listRestEndpoints.ts` — 2 tools (registered on every FastMCP server).

| Tool | Description | REST |
|---|---|---|
| `mintRestBearerForCurl` | ESCAPE HATCH — do NOT call this as a routine auth step. The regular MCP tools (readGoogleDoc, listGoogleDocs, listChannels, etc.) work without any token; you are already authenticated via the MCP session. Only call this if YOU (the client) can run shell commands like curl, and you specifically want to fetch a large/bulk response straight to disk instead of through the LLM context window. The minted bearer is valid 5 minutes against GET <base>/api/v1/* (see listRestEndpoints). If you cannot exec shell, this token is useless to you — skip it. | — |
| `listRestEndpoints` | ESCAPE HATCH companion to mintRestBearerForCurl — only useful if YOU (the client) can run shell commands like curl. The regular MCP tools work without any of this; do NOT call this as a routine discovery step. Lists REST data-plane endpoints under <base>/api/v1/* so a shell-capable client can fetch bulk responses straight to disk instead of through the LLM context window. Optional `service` narrows the result to one provider. | — |

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
| `getComment` | Gets a specific comment with its full thread of replies. | — |
| `addComment` | Adds a comment to a Google Document with quoted text context. NOTE: Due to Google Drive API limitations, comments cannot be anchored to specific text positions in Google Docs. The comment will appear in the Comments panel with the quoted text displayed, but won't highlight text in the document body. | — |
| `replyToComment` | Adds a reply to an existing comment. | — |
| `resolveComment` | Marks a comment as resolved. NOTE: Due to Google API limitations, the Drive API does not support resolving comments on Google Docs files. This operation will attempt to update the comment but the resolved status may not persist in the UI. Comments can be resolved manually in the Google Docs interface. | — |
| `deleteComment` | Deletes a comment from the document. | — |
| `findElement` | NOT IMPLEMENTED — always throws. For text search use findAndReplace or formatMatchingText; for structure exploration use inspectDocStructure. | — |
| `formatMatchingText` | Finds specific text within a Google Document and applies character formatting (bold, italics, color, etc.) to the specified instance. | — |
| `findAndReplace` | Finds all occurrences of a text string in a Google Doc and replaces them. Returns the number of replacements made. | — |
| `inspectDocStructure` | Analyzes and returns the structure of a Google Doc: paragraph/table/section counts, headers/footers presence, tab hierarchy. Use detailed mode for element-by-element listing. | — |
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

Source: `src/clickup/server.ts` — 38 tools.

| Tool | Description | REST |
|---|---|---|
| `getAuthorizedUser` | Get information about the currently authenticated ClickUp user. Useful for debugging connections and getting your user ID. | `GET /api/v1/clickup/user` |
| `listWorkspaces` | List all accessible ClickUp workspaces (teams). Returns workspace IDs needed for other operations. | `GET /api/v1/clickup/workspaces` |
| `listSpaces` | List all spaces in a ClickUp workspace. | `GET /api/v1/clickup/workspaces/{workspaceId}/spaces` |
| `listFolders` | List all folders in a ClickUp space. | `GET /api/v1/clickup/spaces/{spaceId}/folders` |
| `listLists` | List all lists in a ClickUp folder, or folderless lists in a space. Provide either folderId or spaceId. | — |
| `getTask` | Get detailed information about a specific ClickUp task by its ID. | `GET /api/v1/clickup/tasks/{taskId}` |
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
| `createList` | Create a new list in a ClickUp folder, or a folderless list in a space. | — |
| `createFolder` | Create a new folder in a ClickUp space. | — |
| `createSpace` | Create a new space in a ClickUp workspace. | — |
| `updateList` | Update properties of an existing ClickUp list. | — |
| `deleteList` | Delete a ClickUp list permanently. | — |
| `listDocs` | List ClickUp Docs in a workspace. | `GET /api/v1/clickup/workspaces/{workspaceId}/docs` |
| `getDoc` | Get a ClickUp Doc by ID, including its pages and their content (markdown). | `GET /api/v1/clickup/docs/{docId}?workspaceId={workspaceId}` |
| `searchDocs` | Search ClickUp Docs in a workspace by name. Optionally filter by creator, parent, or status. | `GET /api/v1/clickup/workspaces/{workspaceId}/docs/search` |
| `createDoc` | Create a new ClickUp Doc in a workspace. Optionally place it inside a Space, Folder, or List by providing parent ID and type. | — |
| `getPage` | Get a specific page from a ClickUp Doc, including its full content in markdown. | `GET /api/v1/clickup/docs/{docId}/pages/{pageId}?workspaceId={workspaceId}` |
| `createPage` | Create a new page in a ClickUp Doc. | — |
| `editPage` | Edit a page in a ClickUp Doc. Can replace, append, or prepend content. | — |
| `listWorkspaceMembers` | List all members of a ClickUp workspace. Useful for looking up user IDs by name when assigning tasks. | `GET /api/v1/clickup/workspaces/{workspaceId}/members` |
| `startTimeEntry` | Start a time tracking entry for a task in ClickUp. | — |
| `stopTimeEntry` | Stop the currently running time tracking entry. | — |
| `getTimeEntries` | Get time tracking entries for a workspace. | `GET /api/v1/clickup/workspaces/{workspaceId}/time` |

## Slack (bot)

Source: `src/slack/server.ts` — 7 tools.

| Tool | Description | REST |
|---|---|---|
| `listChannels` | List Slack channels and DMs the bot is a member of. Includes public/private channels and 1-on-1 DMs. The bot only sees channels where it has been /invited. | `GET /api/v1/slack/channels` |
| `readChannelHistory` | Read recent messages from a Slack channel. Returns messages in chronological order. | `GET /api/v1/slack/channels/{channelId}/messages` |
| `readThreadReplies` | Read replies in a Slack thread. The first message is the thread parent. | `GET /api/v1/slack/channels/{channelId}/threads/{threadTs}` |
| `postMessage` | Post a message to a Slack channel. | — |
| `replyInThread` | Reply to a thread in a Slack channel. | — |
| `listUsers` | List workspace members. Use this to find a user by name and get their user ID for opening a DM. | `GET /api/v1/slack/users` |
| `openDm` | Open (or retrieve) a 1-on-1 DM channel with a user. Returns the DM channel ID that can be used with postMessage. | — |

## Slack (user)

Source: `src/slack-user/server.ts` — 7 tools.

| Tool | Description | REST |
|---|---|---|
| `listChannels` | List Slack channels and DMs you have access to, filtered by your access rules. Use the "search" parameter to find a specific channel by name without paginating. | — |
| `readChannelHistory` | Read recent messages from a Slack channel. Access rules are enforced. | — |
| `readThreadReplies` | Read replies in a Slack thread. Access rules are enforced. | — |
| `postMessage` | Post a message to a Slack channel. | — |
| `replyInThread` | Reply to a thread in a Slack channel. | — |
| `listUsers` | List workspace members. Use this to find a user by name and get their user ID for opening a DM. | — |
| `openDm` | Open (or retrieve) a 1-on-1 DM channel with a user. Returns the DM channel ID that can be used with postMessage. | — |

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
| `archiveDocument` | Archives an Outline document (removes from collections but keeps searchable). | — |
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

---

**Grand total: 164 tools across 11 sections.**
