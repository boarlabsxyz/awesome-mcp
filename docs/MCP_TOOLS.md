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
- [ClickUp](#clickup) (37)
- [Slack (bot)](#slack-bot-) (7)
- [Slack (user)](#slack-user-) (7)

## Shared (every server)

Source: `src/sharedTools/getSecurityToken.ts`, `src/sharedTools/listRestEndpoints.ts` — 2 tools (registered on every FastMCP server).

| Tool | Description | REST |
|---|---|---|
| `getSecurityToken` | Mint a 5-minute bearer token for the REST data plane. Use it as `Authorization: Bearer <token>` against the GET endpoints under <base>/api/v1/* so bulk responses can be saved directly to disk with curl/jq instead of flowing through the LLM context window. Call listRestEndpoints for the catalog of available URLs. | — |
| `listRestEndpoints` | List REST data-plane endpoints under <base>/api/v1/*. Use to discover the GET URL for a given MCP read tool when you want to fetch bulk data via curl + a bearer from getSecurityToken instead of an MCP tool result. Optional `service` narrows the result to one provider. | — |

## Google Docs

Source: `src/google-docs/server.ts` — 30 tools.

| Tool | Description | REST |
|---|---|---|
| `listGoogleDocs` | Lists Google Documents from your Google Drive and shared drives with optional filtering. | `GET /api/v1/docs` |
| `searchGoogleDocs` | Searches for Google Documents by name, content, or other criteria across My Drive and shared drives. | `GET /api/v1/docs?q={query}` |
| `getRecentGoogleDocs` | Gets the most recently modified Google Documents from My Drive and shared drives. | `GET /api/v1/docs/recent` |
| `exportDocToPdf` | Exports a Google Doc as a PDF file and saves it to Google Drive. Returns the PDF file ID, name, and link. | — |
| `readGoogleDoc` | Reads the content of a specific Google Document, optionally returning structured data. For large docs prefer REST: GET /api/v1/docs/{documentId} (mint a bearer with getSecurityToken). | `GET /api/v1/docs/{documentId}` |
| `listDocumentTabs` | Lists all tabs in a Google Document, including their hierarchy, IDs, and structure. | `GET /api/v1/docs/{documentId}/tabs` |
| `appendToGoogleDoc` | Appends text to the very end of a specific Google Document or tab. Equivalent to insertText at the document end; use this when you do not know the end index. | — |
| `insertText` | Inserts text at a specific 1-based index within the document body or a specific tab. For end-of-document inserts where you do not have an index, prefer appendToGoogleDoc. | — |
| `deleteRange` | Deletes content within a specified range (start index inclusive, end index exclusive) from the document or a specific tab. | — |
| `applyTextStyle` | Applies character-level formatting to a specific range or found text. Supported style keys: bold, italic, underline, strikethrough, fontSize, fontFamily, foregroundColor, backgroundColor, link. | — |
| `applyParagraphStyle` | Applies paragraph-level formatting (alignment, spacing, named styles like Heading 1) to the paragraph(s) containing specific text, an index, or a range. | — |
| `insertTable` | Inserts a new table with the specified dimensions at a given index. | — |
| `editTableCell` | Edits the content and/or basic style of a specific table cell. Requires knowing table start index. | — |
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
| `findElement` | Finds elements (paragraphs, tables, etc.) based on various criteria. (Not Implemented) | — |
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
| `readSpreadsheet` | Reads data from a specific range in a Google Spreadsheet. For large ranges prefer REST: GET /api/v1/sheets/{spreadsheetId}/ranges?range={range}. | `GET /api/v1/sheets/{spreadsheetId}/ranges?range={range}` |
| `writeSpreadsheet` | Writes data to a specific range in a Google Spreadsheet. Overwrites existing data in the range. | — |
| `appendSpreadsheetRows` | Appends rows of data to the end of a sheet in a Google Spreadsheet. | — |
| `clearSpreadsheetRange` | Clears all values from a specific range in a Google Spreadsheet. | — |
| `getSpreadsheetInfo` | Gets detailed information about a Google Spreadsheet including all sheets/tabs. | `GET /api/v1/sheets/{spreadsheetId}` |
| `addSpreadsheetSheet` | Adds a new sheet/tab to an existing Google Spreadsheet. | — |
| `createSpreadsheet` | Creates a new Google Spreadsheet (works with shared drives). | — |
| `listGoogleSheets` | Lists Google Spreadsheets from your Google Drive and shared drives with optional filtering. | `GET /api/v1/sheets` |
| `findRowByValue` | Search a column for a specific value and return the 1-based row number where it was found. | `GET /api/v1/sheets/{spreadsheetId}/search` |
| `readRowByField` | Look up a row by searching a column for a value, then return the row as a named JSON object using header names from row 1. | `GET /api/v1/sheets/{spreadsheetId}/rows/{rowNumber}` |
| `updateCellByFieldName` | Find a row by searching a column for a value, then update a specific field (identified by header name) in that row. | — |
| `batchUpdateSpreadsheet` | Apply multiple formatting operations to a Google Spreadsheet in a single atomic batch. Supports number formats, text styling, background colors, borders, freezing, conditional formatting, cell merging, and column/row sizing. | — |

## Google Calendar

Source: `src/google-calendar/server.ts` — 6 tools.

| Tool | Description | REST |
|---|---|---|
| `listCalendars` | Lists all calendars accessible to the user. | `GET /api/v1/calendars` |
| `listEvents` | Lists events from a calendar within a specified date range. For multi-calendar / multi-week bulk reads prefer REST: GET /api/v1/calendars/{calendarId}/events. | `GET /api/v1/calendars/{calendarId}/events` |
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
| `listFolderContents` | Lists the contents of a specific folder in Google Drive or a shared drive. For large folders prefer REST: GET /api/v1/drive/folders/{folderId}/contents. | `GET /api/v1/drive/folders/{folderId}/contents` |
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
| `checkPublicAccess` | Check whether a Google Drive file is publicly accessible ("anyone with the link"). Returns public/private status, file info, and permissions summary. | `GET /api/v1/drive/files/{fileId}/public` |

## Gmail

Source: `src/google-gmail/server.ts` — 14 tools.

| Tool | Description | REST |
|---|---|---|
| `sendEmail` | Send an email message. | — |
| `draftEmail` | Create a draft email without sending it. | — |
| `readEmail` | Read the full content of an email by its message ID. For bulk reads prefer REST: GET /api/v1/gmail/messages/{messageId} (mint a bearer with getSecurityToken). | `GET /api/v1/gmail/messages/{messageId}` |
| `searchEmails` | Search emails using Gmail query syntax (e.g., "from:user@example.com", "subject:hello", "is:unread", "newer_than:2d"). For large result sets prefer REST: GET /api/v1/gmail/messages?q={query}. | `GET /api/v1/gmail/messages?q={query}` |
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

Source: `src/clickup/server.ts` — 37 tools.

| Tool | Description | REST |
|---|---|---|
| `getAuthorizedUser` | Get information about the currently authenticated ClickUp user. Useful for debugging connections and getting your user ID. | `GET /api/v1/clickup/user` |
| `listWorkspaces` | List all accessible ClickUp workspaces (teams). Returns workspace IDs needed for other operations. | `GET /api/v1/clickup/workspaces` |
| `listSpaces` | List all spaces in a ClickUp workspace. | `GET /api/v1/clickup/workspaces/{workspaceId}/spaces` |
| `listFolders` | List all folders in a ClickUp space. | `GET /api/v1/clickup/spaces/{spaceId}/folders` |
| `listLists` | List all lists in a ClickUp folder, or folderless lists in a space. Provide either folderId or spaceId. | — |
| `getTask` | Get detailed information about a specific ClickUp task by its ID. | `GET /api/v1/clickup/tasks/{taskId}` |
| `listTasks` | List tasks in a ClickUp list with optional filters. | `GET /api/v1/clickup/lists/{listId}/tasks` |
| `createTask` | Create a new task in a ClickUp list. | — |
| `updateTask` | Update an existing ClickUp task. Only provided fields will be changed. | — |
| `deleteTask` | Delete a ClickUp task permanently. | — |
| `moveTask` | Move a task to a different list. | — |
| `addTaskComment` | Add a comment to a ClickUp task. Supports markdown formatting: **bold**, *italic*, `inline code`. | — |
| `getTaskComments` | Get comments on a ClickUp task. | `GET /api/v1/clickup/tasks/{taskId}/comments` |
| `searchTasks` | Search for tasks across a ClickUp workspace. Supports filtering by name (client-side substring match) and/or custom fields. By default excludes closed/completed tasks — set includeClosed=true to include them. | `GET /api/v1/clickup/workspaces/{workspaceId}/tasks/search` |
| `getAccessibleCustomFields` | List all custom fields available on a ClickUp list. Use this to discover field IDs for filtering or setting values. | `GET /api/v1/clickup/lists/{listId}/fields` |
| `setCustomFieldValue` | Set a custom field value on a ClickUp task. Use getAccessibleCustomFields first to find the field ID and type. Value shape depends on field type: text/email/phone → string; number → number; drop_down → option orderindex (int) or option ID; users → array of user IDs; labels → array of label UUIDs; date → unix ms. | — |
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
| `readChannelHistory` | Read recent messages from a Slack channel. Returns messages in chronological order. For long histories prefer REST: GET /api/v1/slack/channels/{channelId}/messages. | `GET /api/v1/slack/channels/{channelId}/messages` |
| `readThreadReplies` | Read replies in a Slack thread. The first message is the thread parent. | `GET /api/v1/slack/channels/{channelId}/threads/{threadTs}` |
| `postMessage` | Post a message to a Slack channel. Requires SLACK_WRITES_ENABLED=true. | — |
| `replyInThread` | Reply to a thread in a Slack channel. Requires SLACK_WRITES_ENABLED=true. | — |
| `listUsers` | List workspace members. Use this to find a user by name and get their user ID for opening a DM. | `GET /api/v1/slack/users` |
| `openDm` | Open (or retrieve) a 1-on-1 DM channel with a user. Returns the DM channel ID that can be used with postMessage. | — |

## Slack (user)

Source: `src/slack-user/server.ts` — 7 tools.

| Tool | Description | REST |
|---|---|---|
| `listChannels` | List Slack channels and DMs you have access to, filtered by your access rules. Use the "search" parameter to find a specific channel by name without paginating. | — |
| `readChannelHistory` | Read recent messages from a Slack channel. Access rules are enforced. | — |
| `readThreadReplies` | Read replies in a Slack thread. Access rules are enforced. | — |
| `postMessage` | Post a message to a Slack channel. Requires SLACK_WRITES_ENABLED=true. Access rules enforced. | — |
| `replyInThread` | Reply to a thread in a Slack channel. Requires SLACK_WRITES_ENABLED=true. Access rules enforced. | — |
| `listUsers` | List workspace members. Use this to find a user by name and get their user ID for opening a DM. | — |
| `openDm` | Open (or retrieve) a 1-on-1 DM channel with a user. Returns the DM channel ID that can be used with postMessage. | — |

---

**Grand total: 136 tools across 10 sections.**
