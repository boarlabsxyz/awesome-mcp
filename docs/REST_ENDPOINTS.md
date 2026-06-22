# REST Data Plane — Endpoint Catalog

Generated from `src/restCatalog.ts` by `scripts/buildRestEndpointsDoc.mjs`. Do not edit by hand.

## Why this exists

Every MCP tool response flows through the LLM's tool-result channel — every byte counts against context and output tokens. For bulk reads (calendar weeks, search results, full doc bodies, channel history), the REST data plane lets the LLM orchestrate the fetch via curl + jq while keeping the bytes off-context.

## Auth

1. From any MCP session, call the `getSecurityToken` MCP tool — it returns a 5-minute bearer.
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

### Google Sheets (`sheets`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `listGoogleSheets` | `GET /api/v1/sheets` | live | List spreadsheets |
| `getSpreadsheetInfo` | `GET /api/v1/sheets/{spreadsheetId}` | live | Get spreadsheet metadata |
| `readSpreadsheet` | `GET /api/v1/sheets/{spreadsheetId}/ranges?range={range}` | live | Read a range from a spreadsheet — _GET sibling of the existing POST /api/v1/sheets/{id}/read._ |
| `readRowByField` | `GET /api/v1/sheets/{spreadsheetId}/rows/{rowNumber}` | live | Read a row by row number |
| `findRowByValue` | `GET /api/v1/sheets/{spreadsheetId}/search` | live | Find a row by column value (?col=&val=) |

### Google Calendar (`calendar`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `listCalendars` | `GET /api/v1/calendars` | live | List calendars |
| `listEvents` | `GET /api/v1/calendars/{calendarId}/events` | live | List events in a calendar |
| `getEvent` | `GET /api/v1/calendars/{calendarId}/events/{eventId}` | live | Get a single event |

### Google Drive (`drive`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `getDocumentInfo` | `GET /api/v1/drive/files/{fileId}` | live | Get file metadata |
| `getFilePermissions` | `GET /api/v1/drive/files/{fileId}/permissions` | live | List permissions on a file |
| `checkPublicAccess` | `GET /api/v1/drive/files/{fileId}/public` | live | Check if a file is publicly accessible |
| `downloadDriveFile` | `GET /api/v1/drive/files/{fileId}/download` | planned | Download or export a file — _Binary; supports ?exportMimeType= for Google native types._ |
| `getFolderInfo` | `GET /api/v1/drive/folders/{folderId}` | live | Get folder metadata |
| `listFolderContents` | `GET /api/v1/drive/folders/{folderId}/contents` | live | List the contents of a folder |
| `listSharedDrives` | `GET /api/v1/drive/shared-drives` | live | List shared drives |

### Gmail (`gmail`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `searchEmails` | `GET /api/v1/gmail/messages?q={query}` | live | Search emails |
| `readEmail` | `GET /api/v1/gmail/messages/{messageId}` | live | Read an email (JSON or markdown via Accept) |
| `getAttachment` | `GET /api/v1/gmail/messages/{messageId}/attachments/{attachmentId}` | planned | Download an email attachment |
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
| `listDocs` | `GET /api/v1/clickup/workspaces/{workspaceId}/docs` | live | List docs in a workspace |
| `searchDocs` | `GET /api/v1/clickup/workspaces/{workspaceId}/docs/search` | live | Search docs in a workspace |
| `getDoc` | `GET /api/v1/clickup/docs/{docId}?workspaceId={workspaceId}` | live | Get a ClickUp doc with its pages — _Required query param: workspaceId._ |
| `getPage` | `GET /api/v1/clickup/docs/{docId}/pages/{pageId}?workspaceId={workspaceId}` | live | Get a page within a ClickUp doc — _Required query param: workspaceId._ |
| `listWorkspaceMembers` | `GET /api/v1/clickup/workspaces/{workspaceId}/members` | planned | List members of a workspace |
| `getTimeEntries` | `GET /api/v1/clickup/workspaces/{workspaceId}/time` | live | List time entries |

### Slack (`slack`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `listChannels` | `GET /api/v1/slack/channels` | live | List Slack channels — _Requires a slack-bot connection (slack-user not supported on REST)._ |
| `readChannelHistory` | `GET /api/v1/slack/channels/{channelId}/messages` | live | Read recent messages in a channel |
| `readThreadReplies` | `GET /api/v1/slack/channels/{channelId}/threads/{threadTs}` | live | Read replies in a thread |
| `listUsers` | `GET /api/v1/slack/users` | live | List Slack workspace users |

## Status legend

- **live** — endpoint is currently wired and reachable.
- **planned** — endpoint is in the catalog and on the roadmap; not yet served by the Express app. Calls return 404 until shipped.

Catalog size: 51 endpoints.
