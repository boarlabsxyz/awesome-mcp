// Single source of truth for the REST data plane.
// Drives listRestEndpoints (MCP tool), the merged root OpenAPI spec, and the
// README translation table. Update one place when adding endpoints.
//
// Convention: every GET in this catalog is a passthrough for an MCP read tool.
//
// POST entries are allowed but gated: a write earns a REST sibling only when its
// request body is large (bulk rows, a long document body) or when it belongs in a
// shell pipeline. A one-field update is cheaper and safer as an MCP tool call, and
// every write endpoint widens what the permanent dashboard API key can mutate.
// Scope is deliberately 'GET' | 'POST' — PATCH/DELETE are a separate decision, and
// the legacy PATCH/DELETE routes in webServer.ts are ChatGPT Custom Actions compat
// and are not catalogued.

export type RestService =
  | 'docs'
  | 'sheets'
  | 'calendar'
  | 'drive'
  | 'gmail'
  | 'slides'
  | 'clickup'
  | 'slack'
  | 'outline'
  | 'peopleforce'
  | 'hubspot'
  | 'redmine';

/**
 * Which `src/<dir>/server.ts` implements each service's MCP tools.
 *
 * The catalog's service keys are short ('docs', 'sheets') while the source
 * directories are not ('src/google-docs', 'src/google-sheets'), so anything
 * reasoning from a catalog entry back to a server needs this bridge.
 *
 * Typed as a total Record on purpose: adding a service to RestService fails
 * typecheck here until it is mapped, rather than being silently skipped by the
 * checks that walk it (see src/__tests__/sharedToolsRegistration.test.ts).
 */
export const SERVICE_SERVER_PATH: Record<RestService, string> = {
  docs: 'src/google-docs/server.ts',
  sheets: 'src/google-sheets/server.ts',
  calendar: 'src/google-calendar/server.ts',
  drive: 'src/google-drive/server.ts',
  gmail: 'src/google-gmail/server.ts',
  slides: 'src/google-slides/server.ts',
  clickup: 'src/clickup/server.ts',
  slack: 'src/slack/server.ts',
  outline: 'src/outline/server.ts',
  peopleforce: 'src/peopleforce/server.ts',
  hubspot: 'src/hubspot/server.ts',
  redmine: 'src/redmine/server.ts',
};

export interface RestEndpoint {
  service: RestService;
  method: 'GET' | 'POST';
  path: string;
  summary: string;
  mcpToolName: string;
  openapiOperationId: string;
  status: 'live' | 'planned';
  notes?: string;
}

export const REST_CATALOG: ReadonlyArray<RestEndpoint> = [
  // -------- Google Docs --------
  { service: 'docs', method: 'GET', path: '/api/v1/docs', summary: 'List Google Docs', mcpToolName: 'listGoogleDocs', openapiOperationId: 'listGoogleDocs', status: 'live' },
  { service: 'docs', method: 'GET', path: '/api/v1/docs?q={query}', summary: 'Search Google Docs', mcpToolName: 'searchGoogleDocs', openapiOperationId: 'searchGoogleDocs', status: 'live', notes: 'Same path as listGoogleDocs; presence of ?q triggers search.' },
  { service: 'docs', method: 'GET', path: '/api/v1/docs/recent', summary: 'Recent Google Docs', mcpToolName: 'getRecentGoogleDocs', openapiOperationId: 'getRecentGoogleDocs', status: 'live' },
  { service: 'docs', method: 'GET', path: '/api/v1/docs/{documentId}', summary: 'Read a Google Doc (JSON or text via Accept)', mcpToolName: 'readGoogleDoc', openapiOperationId: 'readGoogleDoc', status: 'live', notes: 'GET sibling of the existing POST /api/v1/docs/read. Default returns raw upstream Docs JSON; Accept: text/plain returns extracted body text.' },
  { service: 'docs', method: 'GET', path: '/api/v1/docs/{documentId}/tabs', summary: 'List tabs in a Google Doc', mcpToolName: 'listDocumentTabs', openapiOperationId: 'listDocumentTabs', status: 'live' },
  { service: 'docs', method: 'GET', path: '/api/v1/docs/{documentId}/comments', summary: 'List comments on a Google Doc', mcpToolName: 'listComments', openapiOperationId: 'listComments', status: 'live' },
  { service: 'docs', method: 'GET', path: '/api/v1/docs/{documentId}/comments/{commentId}', summary: 'Get a single comment with its replies', mcpToolName: 'getComment', openapiOperationId: 'getDocsComment', status: 'live' },
  { service: 'docs', method: 'GET', path: '/api/v1/docs/{documentId}/structure', summary: 'Inspect the structure of a Google Doc', mcpToolName: 'inspectDocStructure', openapiOperationId: 'inspectDocStructure', status: 'live', notes: 'Paragraph/table/section counts, headers and footers presence, tab hierarchy. Pass ?detailed=true for an element-by-element listing, ?tabId= to scope to one tab.' },

  // Docs writes. Every body is validated with the MCP tool schema exported from
  // src/google-docs/writeSchemas.ts, and every handler calls the op from
  // src/google-docs/writeOps.ts, so neither surface can drift from the other.
  { service: 'docs', method: 'POST', path: '/api/v1/docs/import', summary: 'Create a doc from text, HTML or markdown content', mcpToolName: 'importToGoogleDoc', openapiOperationId: 'importToGoogleDoc', status: 'live', notes: 'Body limit 5mb: content carries the whole document. Not idempotent: each call creates another doc.' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/import/docx', summary: 'Convert a .docx already in Drive into a Google Doc', mcpToolName: 'importDocx', openapiOperationId: 'importDocx', status: 'live', notes: 'Takes a Drive file ID, not file bytes. Refuses anything whose mimeType is not .docx, since Drive would convert it into an unreadable doc.' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/append', summary: 'Append text to the end of a doc or tab', mcpToolName: 'appendToGoogleDoc', openapiOperationId: 'appendToGoogleDoc', status: 'live', notes: 'Body limit 5mb. Resolves the end index itself, so no index is needed.' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/text', summary: 'Insert text at a 1-based index', mcpToolName: 'insertText', openapiOperationId: 'insertText', status: 'live', notes: 'Body limit 5mb. Indices shift as the doc changes; for several edits at once use batchUpdate, which orders them safely.' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/batchUpdate', summary: 'Apply up to 50 document operations in one batch', mcpToolName: 'batchUpdateDoc', openapiOperationId: 'batchUpdateDoc', status: 'live', notes: 'Body limit 5mb. Index-based operations are applied in descending index order so they do not shift each other. Mixing global replacements with index-based operations is refused, not reordered. Includes delete_text, so it can remove content.' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/find-replace', summary: 'Replace every occurrence of a string', mcpToolName: 'findAndReplace', openapiOperationId: 'findAndReplace', status: 'live', notes: 'Reports occurrencesChanged, which is 0 when nothing matched — that is a successful call, not an error.' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/text-style', summary: 'Apply character formatting to a range or found text', mcpToolName: 'applyTextStyle', openapiOperationId: 'applyTextStyle', status: 'live', notes: 'Answers with the range it resolved, which matters when the target was given as text to find rather than indices.' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/paragraph-style', summary: 'Apply paragraph formatting by text, index or range', mcpToolName: 'applyParagraphStyle', openapiOperationId: 'applyParagraphStyle', status: 'live', notes: 'A text target is widened to the paragraph containing it, so the resolved range in the response is wider than the text matched.' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/format-matching-text', summary: 'Format the Nth instance of a string', mcpToolName: 'formatMatchingText', openapiOperationId: 'formatMatchingText', status: 'live', notes: 'Flat-parameter alternative to text-style; same engine underneath.' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/tables', summary: 'Insert a table of the given dimensions', mcpToolName: 'insertTable', openapiOperationId: 'insertDocTable', status: 'live' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/page-breaks', summary: 'Insert a page break at an index', mcpToolName: 'insertPageBreak', openapiOperationId: 'insertPageBreak', status: 'live' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/images/from-url', summary: 'Insert an inline image from a public URL', mcpToolName: 'insertImageFromUrl', openapiOperationId: 'insertImageFromUrl', status: 'live', notes: 'Google fetches the URL server-side, so it must be publicly reachable.' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/images', summary: 'Insert an image from a URL, Drive file, local path or base64', mcpToolName: 'insertLocalImage', openapiOperationId: 'insertDocImage', status: 'live', notes: 'Body limit 5mb for the base64 path (hard cap 20mb decoded). Every path except driveFileId UPLOADS a new file to the user Drive and returns its URL.' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/export/pdf', summary: 'Export a doc to PDF and save it to Drive', mcpToolName: 'exportDocToPdf', openapiOperationId: 'exportDocToPdf', status: 'live', notes: 'Writes a new PDF file to Drive; it is an export that mutates. Refuses anything that is not a Google Doc.' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/comments', summary: 'Add a comment quoting a text range', mcpToolName: 'addComment', openapiOperationId: 'addComment', status: 'live', notes: 'Was an uncatalogued ChatGPT-compat route; path and response unchanged, now validated with the MCP tool schema. The Drive API ignores anchors on Google Docs, so the quoted text is the only record of which range the comment is about.' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/comments/{commentId}/replies', summary: 'Reply to a comment', mcpToolName: 'replyToComment', openapiOperationId: 'replyToDocComment', status: 'live' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/comments/{commentId}/resolve', summary: 'Mark a comment resolved', mcpToolName: 'resolveComment', openapiOperationId: 'resolveDocComment', status: 'live', notes: 'The response reports the resolved flag Google returned on a re-read, not what was requested: the Drive API accepts this on a Google Doc and often does not persist it.' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/ranges/delete', summary: 'Delete a character range', mcpToolName: 'deleteRange', openapiOperationId: 'deleteDocRange', status: 'live', notes: 'DESTRUCTIVE and irreversible through this API. Exposed with explicit sign-off. POST to an action path rather than DELETE on the range, so the call site reads as deliberate.' },
  { service: 'docs', method: 'POST', path: '/api/v1/docs/{documentId}/comments/{commentId}/delete', summary: 'Delete a comment thread', mcpToolName: 'deleteComment', openapiOperationId: 'deleteDocComment', status: 'live', notes: 'DESTRUCTIVE. Exposed with explicit sign-off. POST to an action path rather than DELETE on the resource.' },

  // -------- Google Sheets --------
  { service: 'sheets', method: 'GET', path: '/api/v1/sheets', summary: 'List spreadsheets', mcpToolName: 'listGoogleSheets', openapiOperationId: 'listSpreadsheets', status: 'live' },
  { service: 'sheets', method: 'GET', path: '/api/v1/sheets/{spreadsheetId}', summary: 'Get spreadsheet metadata', mcpToolName: 'getSpreadsheetInfo', openapiOperationId: 'getSpreadsheetInfo', status: 'live' },
  { service: 'sheets', method: 'GET', path: '/api/v1/sheets/{spreadsheetId}/ranges?range={range}', summary: 'Read a range from a spreadsheet', mcpToolName: 'readSpreadsheet', openapiOperationId: 'readSpreadsheet', status: 'live', notes: 'GET sibling of the existing POST /api/v1/sheets/{id}/read.' },
  { service: 'sheets', method: 'GET', path: '/api/v1/sheets/{spreadsheetId}/rows/{rowNumber}', summary: 'Read a row by row number', mcpToolName: 'readRowByField', openapiOperationId: 'readRowByField', status: 'live' },
  { service: 'sheets', method: 'GET', path: '/api/v1/sheets/{spreadsheetId}/search', summary: 'Find a row by column value (?col=&val=)', mcpToolName: 'findRowByValue', openapiOperationId: 'findRowByValue', status: 'live' },

  { service: 'sheets', method: 'POST', path: '/api/v1/sheets', summary: 'Create a spreadsheet, optionally seeded with rows', mcpToolName: 'createSpreadsheet', openapiOperationId: 'createSpreadsheet', status: 'live', notes: 'Body limit 5mb so initialData can carry a bulk seed. Not idempotent: each call creates another spreadsheet. A seed that fails still answers 201 with initialDataWritten false, because the file exists by then.' },
  { service: 'sheets', method: 'POST', path: '/api/v1/sheets/{spreadsheetId}/write', summary: 'Overwrite a range with a 2D array of values', mcpToolName: 'writeSpreadsheet', openapiOperationId: 'writeRange', status: 'live', notes: 'Body limit 5mb. Overwrites whatever occupies the range. Was an uncatalogued ChatGPT-compat route; the path is unchanged and it now validates with the MCP tool schema.' },
  { service: 'sheets', method: 'POST', path: '/api/v1/sheets/{spreadsheetId}/append', summary: 'Append rows to the end of a sheet', mcpToolName: 'appendSpreadsheetRows', openapiOperationId: 'appendRows', status: 'live', notes: 'Body limit 5mb. Not idempotent: repeating the call appends the rows a second time. Was an uncatalogued ChatGPT-compat route; path unchanged.' },
  { service: 'sheets', method: 'POST', path: '/api/v1/sheets/{spreadsheetId}/batchUpdate', summary: 'Apply formatting and sheet-lifecycle operations atomically', mcpToolName: 'batchUpdateSpreadsheet', openapiOperationId: 'batchUpdateSpreadsheet', status: 'live', notes: 'Body limit 5mb. WARNING: the operation list includes deleteSheet, which destroys a tab and every value on it, and a curl has no confirmation step. Reviewed and accepted when this endpoint was added. The whole batch is atomic, so one rejected operation applies none of them.' },
  { service: 'sheets', method: 'POST', path: '/api/v1/sheets/{spreadsheetId}/ranges/clear', summary: 'Clear every value in a range', mcpToolName: 'clearSpreadsheetRange', openapiOperationId: 'clearSpreadsheetRange', status: 'live', notes: 'DESTRUCTIVE and irreversible through this API. Exposed with explicit sign-off. POST to an action path rather than DELETE on the range, so the call site reads as deliberate.' },

  // -------- Google Calendar --------
  { service: 'calendar', method: 'GET', path: '/api/v1/calendars', summary: 'List calendars', mcpToolName: 'listCalendars', openapiOperationId: 'listCalendars', status: 'live' },
  { service: 'calendar', method: 'GET', path: '/api/v1/calendars/{calendarId}/events', summary: 'List events in a calendar', mcpToolName: 'listEvents', openapiOperationId: 'listEvents', status: 'live' },
  { service: 'calendar', method: 'GET', path: '/api/v1/calendars/{calendarId}/events/{eventId}', summary: 'Get a single event', mcpToolName: 'getEvent', openapiOperationId: 'getEvent', status: 'live' },

  { service: 'calendar', method: 'POST', path: '/api/v1/calendars/{calendarId}/events', summary: 'Create an event', mcpToolName: 'createEvent', openapiOperationId: 'createEvent', status: 'live', notes: 'sendUpdates defaults to none, so attendees are NOT emailed unless the body asks. Not idempotent: each call creates another event. Was an uncatalogued ChatGPT-compat route; path unchanged and it now validates with the MCP tool schema.' },
  { service: 'calendar', method: 'POST', path: '/api/v1/calendars/{calendarId}/events/{eventId}', summary: 'Update an event, merging the fields given', mcpToolName: 'updateEvent', openapiOperationId: 'updateCalendarEvent', status: 'live', notes: 'POST because the catalog method union is GET or POST. The uncatalogued legacy PATCH on this same path stays for ChatGPT compat and shares this handler. Omitted fields are preserved, not cleared.' },
  { service: 'calendar', method: 'POST', path: '/api/v1/calendars/{calendarId}/events/{eventId}/cancel', summary: 'Delete an event', mcpToolName: 'deleteEvent', openapiOperationId: 'cancelCalendarEvent', status: 'live', notes: 'DESTRUCTIVE. Exposed with explicit sign-off. POST to an action path rather than DELETE on the resource. Pass sendUpdates all to notify attendees; the default none deletes silently.' },

  // -------- Google Drive --------
  { service: 'drive', method: 'GET', path: '/api/v1/drive/files/{fileId}', summary: 'Get file metadata', mcpToolName: 'getDocumentInfo', openapiOperationId: 'getDocumentInfo', status: 'live' },
  { service: 'drive', method: 'GET', path: '/api/v1/drive/files/{fileId}/permissions', summary: 'List permissions on a file', mcpToolName: 'getFilePermissions', openapiOperationId: 'getFilePermissions', status: 'live' },
  { service: 'drive', method: 'GET', path: '/api/v1/drive/files/{fileId}/public', summary: 'Check if a file is publicly accessible', mcpToolName: 'checkPublicAccess', openapiOperationId: 'checkPublicAccess', status: 'live' },
  { service: 'drive', method: 'GET', path: '/api/v1/drive/files/{fileId}/download', summary: 'Download or export a file', mcpToolName: 'downloadDriveFile', openapiOperationId: 'downloadDriveFile', status: 'live', notes: 'Streams binary. Google native types are exported (default: PDF for docs/slides, CSV for sheets, PNG for drawings); override with ?exportMime=.' },
  { service: 'drive', method: 'GET', path: '/api/v1/drive/folders/{folderId}', summary: 'Get folder metadata', mcpToolName: 'getFolderInfo', openapiOperationId: 'getFolderInfo', status: 'live' },
  { service: 'drive', method: 'GET', path: '/api/v1/drive/folders/{folderId}/contents', summary: 'List the contents of a folder', mcpToolName: 'listFolderContents', openapiOperationId: 'listFolderContents', status: 'live' },
  { service: 'drive', method: 'GET', path: '/api/v1/drive/shared-drives', summary: 'List shared drives', mcpToolName: 'listSharedDrives', openapiOperationId: 'listSharedDrives', status: 'live' },

  // -------- Gmail --------
  { service: 'gmail', method: 'GET', path: '/api/v1/gmail/messages?q={query}', summary: 'Search emails', mcpToolName: 'searchEmails', openapiOperationId: 'searchEmails', status: 'live' },
  { service: 'gmail', method: 'GET', path: '/api/v1/gmail/messages/{messageId}', summary: 'Read an email (JSON or markdown via Accept)', mcpToolName: 'readEmail', openapiOperationId: 'readEmail', status: 'live' },
  { service: 'gmail', method: 'GET', path: '/api/v1/gmail/messages/{messageId}/attachments/{attachmentId}', summary: 'Download an email attachment', mcpToolName: 'getAttachment', openapiOperationId: 'getAttachment', status: 'live', notes: 'Returns Gmail base64url-encoded payload as JSON {size, data}; caller decodes.' },
  { service: 'gmail', method: 'GET', path: '/api/v1/gmail/labels', summary: 'List Gmail labels', mcpToolName: 'listLabels', openapiOperationId: 'listLabels', status: 'live' },

  // -------- Google Slides --------
  { service: 'slides', method: 'GET', path: '/api/v1/slides/{presentationId}', summary: 'Get presentation metadata', mcpToolName: 'getPresentation', openapiOperationId: 'getPresentation', status: 'live' },
  { service: 'slides', method: 'GET', path: '/api/v1/slides/{presentationId}/pages/{pageObjectId}', summary: 'Get a slide page', mcpToolName: 'getPage', openapiOperationId: 'getPage', status: 'live' },
  { service: 'slides', method: 'GET', path: '/api/v1/slides/{presentationId}/pages/{pageObjectId}/thumbnail', summary: 'Get a slide thumbnail (PNG URL)', mcpToolName: 'getPageThumbnail', openapiOperationId: 'getPageThumbnail', status: 'live' },
  { service: 'slides', method: 'GET', path: '/api/v1/slides/{presentationId}/comments', summary: 'List comments on a presentation', mcpToolName: 'listPresentationComments', openapiOperationId: 'listPresentationComments', status: 'live' },

  // -------- ClickUp --------
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/user', summary: 'Get the authorized ClickUp user', mcpToolName: 'getAuthorizedUser', openapiOperationId: 'getAuthorizedUser', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/workspaces', summary: 'List ClickUp workspaces', mcpToolName: 'listWorkspaces', openapiOperationId: 'listWorkspaces', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/workspaces/{workspaceId}/spaces', summary: 'List spaces in a workspace', mcpToolName: 'listSpaces', openapiOperationId: 'listSpaces', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/spaces/{spaceId}/folders', summary: 'List folders in a space', mcpToolName: 'listFolders', openapiOperationId: 'listFolders', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/folders/{folderId}/lists', summary: 'List lists in a folder', mcpToolName: 'listListsInFolder', openapiOperationId: 'listListsInFolder', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/spaces/{spaceId}/lists', summary: 'List folderless lists in a space', mcpToolName: 'listFolderlessLists', openapiOperationId: 'listFolderlessLists', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/lists/{listId}/tasks', summary: 'List tasks in a list', mcpToolName: 'listTasks', openapiOperationId: 'listTasks', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/tasks/{taskId}', summary: 'Get a ClickUp task (JSON or markdown via Accept)', mcpToolName: 'getTask', openapiOperationId: 'getTask', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/lists/{listId}/fields', summary: 'List accessible custom fields on a list', mcpToolName: 'getAccessibleCustomFields', openapiOperationId: 'getAccessibleCustomFields', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/tasks/{taskId}/members', summary: 'List members of a task', mcpToolName: 'getTaskMembers', openapiOperationId: 'getTaskMembers', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/tasks/{taskId}/comments', summary: 'List comments on a task', mcpToolName: 'getTaskComments', openapiOperationId: 'getTaskComments', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/workspaces/{workspaceId}/tasks/search', summary: 'Search tasks across a workspace', mcpToolName: 'searchTasks', openapiOperationId: 'searchTasks', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/workspaces/{workspaceId}/tasks/filter', summary: 'Filter tasks across a workspace with server-side filters (assignees, statuses, date ranges, etc.)', mcpToolName: 'filterTeamTasks', openapiOperationId: 'filterTeamTasks', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/workspaces/{workspaceId}/events', summary: 'Read task-event transitions (status/assignee/moves) from the webhook store', mcpToolName: 'getTaskEventHistory', openapiOperationId: 'getTaskEventHistory', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/subscriptions', summary: 'List task-event webhook subscriptions owned by the caller', mcpToolName: 'listTaskEventSubscriptions', openapiOperationId: 'listTaskEventSubscriptions', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/workspaces/{workspaceId}/subscription/debug', summary: 'Diagnostic report cross-referencing local subscription vs the ClickUp-side webhook vs the event store', mcpToolName: 'debugTaskEventSubscription', openapiOperationId: 'debugTaskEventSubscription', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/workspaces/{workspaceId}/docs', summary: 'List docs in a workspace', mcpToolName: 'listDocs', openapiOperationId: 'listDocs', status: 'live', notes: 'One page in ClickUp order. Optional limit (10-100, default 100) and cursor; response carries nextCursor.' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/workspaces/{workspaceId}/docs/search', summary: 'Search docs in a workspace', mcpToolName: 'searchDocs', openapiOperationId: 'searchDocs', status: 'live', notes: 'Pages the whole workspace, token-matches the title, returns newest-first. Response includes totalScanned/pagesScanned/hitCap/rateLimited.' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/docs/{docId}?workspaceId={workspaceId}', summary: 'Get a ClickUp doc with its pages', mcpToolName: 'getDoc', openapiOperationId: 'getDoc', status: 'live', notes: 'Required query param: workspaceId.' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/docs/{docId}/pages/{pageId}?workspaceId={workspaceId}', summary: 'Get a page within a ClickUp doc', mcpToolName: 'getPage', openapiOperationId: 'getClickUpDocPage', status: 'live', notes: 'Required query param: workspaceId.' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/workspaces/{workspaceId}/members', summary: 'List members of a workspace', mcpToolName: 'listWorkspaceMembers', openapiOperationId: 'listWorkspaceMembers', status: 'live', notes: 'No dedicated ClickUp endpoint; derived from getWorkspaces team.members[].' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/workspaces/{workspaceId}/time', summary: 'List time entries', mcpToolName: 'getTimeEntries', openapiOperationId: 'getTimeEntries', status: 'live' },

  // -------- Slack --------
  { service: 'slack', method: 'GET', path: '/api/v1/slack/channels', summary: 'List Slack channels', mcpToolName: 'listChannels', openapiOperationId: 'listChannels', status: 'live', notes: 'Requires a slack-bot connection (slack-user not supported on REST).' },
  { service: 'slack', method: 'GET', path: '/api/v1/slack/channels/{channelId}/messages', summary: 'Read recent messages in a channel', mcpToolName: 'readChannelHistory', openapiOperationId: 'readChannelHistory', status: 'live' },
  { service: 'slack', method: 'GET', path: '/api/v1/slack/channels/{channelId}/threads/{threadTs}', summary: 'Read replies in a thread', mcpToolName: 'readThreadReplies', openapiOperationId: 'readThreadReplies', status: 'live' },
  { service: 'slack', method: 'GET', path: '/api/v1/slack/users', summary: 'List Slack workspace users', mcpToolName: 'listUsers', openapiOperationId: 'listSlackUsers', status: 'live' },

  // -------- Outline --------
  // Catalog-only for now: the MCP tools are shipping in src/outline/server.ts, but
  // the /api/v1/outline/* REST siblings are not yet wired in webServer.ts. Flip
  // to status: 'live' as each route lands.
  { service: 'outline', method: 'GET', path: '/api/v1/outline/documents/{documentId}', summary: 'Read an Outline document', mcpToolName: 'getDocument', openapiOperationId: 'getOutlineDocument', status: 'planned' },
  { service: 'outline', method: 'GET', path: '/api/v1/outline/documents/{documentId}/export', summary: 'Export an Outline document as plain markdown', mcpToolName: 'exportDocument', openapiOperationId: 'exportOutlineDocument', status: 'planned' },
  { service: 'outline', method: 'GET', path: '/api/v1/outline/documents/search?q={query}', summary: 'Search Outline documents', mcpToolName: 'searchDocuments', openapiOperationId: 'searchOutlineDocuments', status: 'planned' },
  { service: 'outline', method: 'GET', path: '/api/v1/outline/documents/recent', summary: 'List recently updated Outline documents', mcpToolName: 'listRecentlyUpdatedDocuments', openapiOperationId: 'listRecentlyUpdatedOutlineDocuments', status: 'planned' },
  { service: 'outline', method: 'GET', path: '/api/v1/outline/documents/{documentId}/backlinks', summary: 'List documents that link to a given Outline document', mcpToolName: 'getDocumentBacklinks', openapiOperationId: 'getOutlineDocumentBacklinks', status: 'planned' },
  { service: 'outline', method: 'GET', path: '/api/v1/outline/documents/archived', summary: 'List archived Outline documents', mcpToolName: 'listArchivedDocuments', openapiOperationId: 'listArchivedOutlineDocuments', status: 'planned' },
  { service: 'outline', method: 'GET', path: '/api/v1/outline/documents/trash', summary: 'List Outline documents in the trash', mcpToolName: 'listTrash', openapiOperationId: 'listOutlineTrash', status: 'planned' },
  { service: 'outline', method: 'GET', path: '/api/v1/outline/collections', summary: 'List Outline collections', mcpToolName: 'listCollections', openapiOperationId: 'listOutlineCollections', status: 'planned' },
  { service: 'outline', method: 'GET', path: '/api/v1/outline/collections/{collectionId}/structure', summary: 'Get the hierarchical document tree for an Outline collection', mcpToolName: 'getCollectionStructure', openapiOperationId: 'getOutlineCollectionStructure', status: 'planned' },
  { service: 'outline', method: 'GET', path: '/api/v1/outline/documents/{documentId}/comments', summary: 'List comments on an Outline document', mcpToolName: 'listDocumentComments', openapiOperationId: 'listOutlineDocumentComments', status: 'planned' },
  { service: 'outline', method: 'GET', path: '/api/v1/outline/comments/{commentId}', summary: 'Get a single Outline comment', mcpToolName: 'getComment', openapiOperationId: 'getOutlineComment', status: 'planned' },
  { service: 'outline', method: 'GET', path: '/api/v1/outline/documents/{documentId}/attachments', summary: 'List attachments referenced in an Outline document', mcpToolName: 'listDocumentAttachments', openapiOperationId: 'listOutlineDocumentAttachments', status: 'planned' },
  { service: 'outline', method: 'GET', path: '/api/v1/outline/attachments/{attachmentId}/url', summary: 'Resolve an Outline attachment ID to a signed download URL', mcpToolName: 'getAttachmentUrl', openapiOperationId: 'getOutlineAttachmentUrl', status: 'planned' },

  // -------- PeopleForce --------
  // Wired in webServer.ts against requirePeopleForceApiKey. Every one supports
  // ?format=text for the same markdown the MCP tools render — the formatters are
  // imported from peopleforce/apiHelpers.js so the two surfaces cannot drift.
  // This covers all 41 read tools; the four write tools (createLeaveRequest,
  // moveVacancyApplication, disqualifyVacancyApplication, addCandidateNote) stay
  // MCP-only — their request bodies are a handful of scalars, so they fail the
  // bulk-payload/shell-pipeline test the data plane exists to serve.
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/employees', summary: 'List PeopleForce employees', mcpToolName: 'listEmployees', openapiOperationId: 'listPeopleForceEmployees', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/employees/{employeeId}', summary: 'Get a single PeopleForce employee', mcpToolName: 'getEmployee', openapiOperationId: 'getPeopleForceEmployee', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/departments', summary: 'List PeopleForce departments', mcpToolName: 'listDepartments', openapiOperationId: 'listPeopleForceDepartments', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/leave-requests', summary: 'List PeopleForce leave requests', mcpToolName: 'listLeaveRequests', openapiOperationId: 'listPeopleForceLeaveRequests', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/leave-requests/{leaveRequestId}', summary: 'Get a single PeopleForce leave request', mcpToolName: 'getLeaveRequest', openapiOperationId: 'getPeopleForceLeaveRequest', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/leave-types', summary: 'List PeopleForce leave types with their IDs', mcpToolName: 'listLeaveTypes', openapiOperationId: 'listPeopleForceLeaveTypes', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/positions', summary: 'List PeopleForce job positions', mcpToolName: 'listPositions', openapiOperationId: 'listPeopleForcePositions', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/divisions', summary: 'List PeopleForce divisions', mcpToolName: 'listDivisions', openapiOperationId: 'listPeopleForceDivisions', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/locations', summary: 'List PeopleForce locations', mcpToolName: 'listLocations', openapiOperationId: 'listPeopleForceLocations', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/employment-types', summary: 'List PeopleForce employment types', mcpToolName: 'listEmploymentTypes', openapiOperationId: 'listPeopleForceEmploymentTypes', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/job-levels', summary: 'List PeopleForce job levels', mcpToolName: 'listJobLevels', openapiOperationId: 'listPeopleForceJobLevels', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/skills', summary: 'List the PeopleForce workspace skills catalog', mcpToolName: 'listSkills', openapiOperationId: 'listPeopleForceSkills', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/competencies', summary: 'List PeopleForce competencies', mcpToolName: 'listCompetencies', openapiOperationId: 'listPeopleForceCompetencies', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/tasks', summary: 'List PeopleForce tasks', mcpToolName: 'listTasks', openapiOperationId: 'listPeopleForceTasks', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/employees/{employeeId}/leave-balances', summary: 'List an employee current leave balances per leave type', mcpToolName: 'listEmployeeLeaveBalances', openapiOperationId: 'listPeopleForceEmployeeLeaveBalances', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/employees/{employeeId}/skills', summary: 'List the skills recorded on an employee profile', mcpToolName: 'listEmployeeSkills', openapiOperationId: 'listPeopleForceEmployeeSkills', status: 'live', notes: 'No bulk endpoint upstream - a company-wide skills portfolio is one call per employee.' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/employees/{employeeId}/documents', summary: 'List documents attached to an employee profile', mcpToolName: 'listEmployeeDocuments', openapiOperationId: 'listPeopleForceEmployeeDocuments', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/employees/{employeeId}/notes', summary: 'List HR notes on an employee profile', mcpToolName: 'listEmployeeNotes', openapiOperationId: 'listPeopleForceEmployeeNotes', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/employees/{employeeId}/emergency-contacts', summary: 'List emergency contacts on an employee profile', mcpToolName: 'listEmployeeEmergencyContacts', openapiOperationId: 'listPeopleForceEmployeeEmergencyContacts', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/employee-tables', summary: 'List PeopleForce employee custom-table definitions', mcpToolName: 'listEmployeeTables', openapiOperationId: 'listPeopleForceEmployeeTables', status: 'live', notes: 'Returns each table internal_name - the value the per-employee table read requires.' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/employees/{employeeId}/tables/{tableInternalName}', summary: 'Get one employee custom-table row data', mcpToolName: 'getEmployeeTable', openapiOperationId: 'getPeopleForceEmployeeTable', status: 'live', notes: 'tableInternalName is a system slug from the employee-tables list - never guess it from the display name.' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/objectives', summary: 'List PeopleForce performance objectives (OKRs)', mcpToolName: 'listObjectives', openapiOperationId: 'listPeopleForceObjectives', status: 'live', notes: 'No server-side date filter upstream - filter by period client-side.' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/kpis', summary: 'List PeopleForce key performance indicators', mcpToolName: 'listKeyPerformanceIndicators', openapiOperationId: 'listPeopleForceKpis', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/knowledge-base/categories', summary: 'List PeopleForce knowledge base categories', mcpToolName: 'listKnowledgeBaseCategories', openapiOperationId: 'listPeopleForceKnowledgeBaseCategories', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/knowledge-base/articles?categoryId={categoryId}', summary: 'List knowledge base articles in a category', mcpToolName: 'listKnowledgeBaseArticles', openapiOperationId: 'listPeopleForceKnowledgeBaseArticles', status: 'live', notes: 'categoryId is required - upstream only exposes articles nested under a category.' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/knowledge-base/articles/{articleId}', summary: 'Get a single knowledge base article with its body', mcpToolName: 'getKnowledgeBaseArticle', openapiOperationId: 'getPeopleForceKnowledgeBaseArticle', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/recruitment/vacancies', summary: 'List PeopleForce recruitment vacancies', mcpToolName: 'listVacancies', openapiOperationId: 'listPeopleForceVacancies', status: 'live', notes: 'status and tagIds are repeatable or comma-separated query params.' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/recruitment/vacancies/{vacancyId}', summary: 'Get a single recruitment vacancy with its pipeline stages', mcpToolName: 'getVacancy', openapiOperationId: 'getPeopleForceVacancy', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/recruitment/vacancies/{vacancyId}/applications', summary: 'List the applications on a recruitment vacancy', mcpToolName: 'listVacancyApplications', openapiOperationId: 'listPeopleForceVacancyApplications', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/recruitment/vacancies/{vacancyId}/applications/{applicationId}', summary: 'Get a single vacancy application', mcpToolName: 'getVacancyApplication', openapiOperationId: 'getPeopleForceVacancyApplication', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/recruitment/pipelines', summary: 'List recruitment pipelines and their stage definitions', mcpToolName: 'listRecruitmentPipelines', openapiOperationId: 'listPeopleForceRecruitmentPipelines', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/recruitment/candidates', summary: 'List recruitment candidates with filters', mcpToolName: 'listCandidates', openapiOperationId: 'listPeopleForceCandidates', status: 'live', notes: 'vacancyIds and skills are repeatable or comma-separated query params.' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/recruitment/candidates/{candidateId}', summary: 'Get a single recruitment candidate profile', mcpToolName: 'getCandidate', openapiOperationId: 'getPeopleForceCandidate', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/recruitment/candidates/{candidateId}/notes', summary: 'List recruiter notes on a candidate', mcpToolName: 'listCandidateNotes', openapiOperationId: 'listPeopleForceCandidateNotes', status: 'live', notes: 'Notes are the only free-text feedback surface - upstream has no scorecard endpoint.' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/recruitment/candidates/{candidateId}/experiences', summary: 'List a candidate work experience entries', mcpToolName: 'listCandidateExperiences', openapiOperationId: 'listPeopleForceCandidateExperiences', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/recruitment/candidates/{candidateId}/educations', summary: 'List a candidate education entries', mcpToolName: 'listCandidateEducations', openapiOperationId: 'listPeopleForceCandidateEducations', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/recruitment/candidates/{candidateId}/dossier', summary: 'Assemble a candidate dossier for assessment in one call', mcpToolName: 'getCandidateDossier', openapiOperationId: 'getPeopleForceCandidateDossier', status: 'live', notes: 'Best-effort bundle - parts that fail to load are reported in the payload rather than failing the request.' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/recruitment/candidate-movements', summary: 'List candidate pipeline stage transitions', mcpToolName: 'listCandidateMovements', openapiOperationId: 'listPeopleForceCandidateMovements', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/recruitment/disqualify-reasons', summary: 'List recruitment disqualify reasons with their IDs', mcpToolName: 'listDisqualifyReasons', openapiOperationId: 'listPeopleForceDisqualifyReasons', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/recruitment/sources', summary: 'List recruitment sources with their IDs', mcpToolName: 'listRecruitmentSources', openapiOperationId: 'listPeopleForceRecruitmentSources', status: 'live' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/recruitment/published-vacancies/{vacancyId}', summary: 'Get the public careers-site job description for a vacancy', mcpToolName: 'getPublishedJobDescription', openapiOperationId: 'getPeopleForcePublishedJobDescription', status: 'live', notes: 'Some tenants gate the Careers API behind a separate token - fall back to the vacancy description on a not-authorized error.' },
  // Writes. Bodies are validated with the MCP tools own Zod schemas, so the two
  // surfaces cannot drift. Path params win over the same key in the body.
  { service: 'peopleforce', method: 'POST', path: '/api/v1/peopleforce/leave-requests', summary: 'Create a PeopleForce leave request', mcpToolName: 'createLeaveRequest', openapiOperationId: 'createPeopleForceLeaveRequest', status: 'live', notes: 'Returns 201 with the created request. leaveTypeId comes from the leave-types endpoint, not the type name.' },
  { service: 'peopleforce', method: 'POST', path: '/api/v1/peopleforce/recruitment/candidates/{candidateId}/notes', summary: 'Add a note to a recruitment candidate', mcpToolName: 'addCandidateNote', openapiOperationId: 'addPeopleForceCandidateNote', status: 'live', notes: 'Returns 201. The note body is free text and can be long - this is the write the data plane most clearly earns.' },
  { service: 'peopleforce', method: 'POST', path: '/api/v1/peopleforce/recruitment/vacancies/{vacancyId}/applications/{applicationId}/move', summary: 'Move a vacancy application to another pipeline stage', mcpToolName: 'moveVacancyApplication', openapiOperationId: 'movePeopleForceVacancyApplication', status: 'live', notes: 'Returns 200 with the application re-read after the move. performAutomations defaults to PeopleForce behaviour (true) when omitted.' },
  { service: 'peopleforce', method: 'POST', path: '/api/v1/peopleforce/recruitment/vacancies/{vacancyId}/applications/{applicationId}/disqualify', summary: 'Disqualify a vacancy application with a reason', mcpToolName: 'disqualifyVacancyApplication', openapiOperationId: 'disqualifyPeopleForceVacancyApplication', status: 'live', notes: 'Returns 200 with the application re-read. Consequential and not idempotent - repeating it re-disqualifies. disqualifyReasonId comes from the disqualify-reasons endpoint.' },

  // -------- HubSpot --------
  // Reads, then the gated writes. The four deal reads were added alongside the
  // routes rather than left out: a company record carries num_associated_deals
  // as a plain company property, so without companies/{id}/deals the plane
  // could show THAT a company had deals and offer no route to their IDs.
  { service: 'hubspot', method: 'GET', path: '/api/v1/hubspot/companies', summary: 'Get most recently active HubSpot companies', mcpToolName: 'getActiveCompanies', openapiOperationId: 'getHubSpotActiveCompanies', status: 'live', notes: 'Sorted by last-modified. ?limit caps at 100. Accept: text/plain renders the same list the MCP tool returns.' },
  { service: 'hubspot', method: 'GET', path: '/api/v1/hubspot/companies/{companyId}', summary: 'Get a single HubSpot company', mcpToolName: 'getCompany', openapiOperationId: 'getHubSpotCompany', status: 'live', notes: 'Pass ?properties=a,b for specific properties. HubSpot silently drops unknown keys, so the text rendering flags any it never returned.' },
  { service: 'hubspot', method: 'GET', path: '/api/v1/hubspot/companies/{companyId}/activity', summary: 'Get activity history for a HubSpot company', mcpToolName: 'getCompanyActivity', openapiOperationId: 'getHubSpotCompanyActivity', status: 'live', notes: 'Notes, calls, meetings and tasks - never deals. Capped at 100 engagement details; the overflow count is reported.' },
  { service: 'hubspot', method: 'GET', path: '/api/v1/hubspot/companies/{companyId}/deals', summary: 'List the deals associated with a HubSpot company', mcpToolName: 'getCompanyDeals', openapiOperationId: 'getHubSpotCompanyDeals', status: 'live', notes: 'Association scan is bounded at 5000 IDs; truncated:true means the total is a floor, not a count. Needs the crm.objects.deals.read scope.' },
  { service: 'hubspot', method: 'GET', path: '/api/v1/hubspot/contacts', summary: 'Get most recently active HubSpot contacts', mcpToolName: 'getActiveContacts', openapiOperationId: 'getHubSpotActiveContacts', status: 'live' },
  { service: 'hubspot', method: 'GET', path: '/api/v1/hubspot/contacts/{contactId}', summary: 'Get a single HubSpot contact', mcpToolName: 'getContact', openapiOperationId: 'getHubSpotContact', status: 'live', notes: 'Pass ?properties=a,b for specific properties.' },
  { service: 'hubspot', method: 'GET', path: '/api/v1/hubspot/deals', summary: 'Get most recently active HubSpot deals', mcpToolName: 'getActiveDeals', openapiOperationId: 'getHubSpotActiveDeals', status: 'live', notes: 'Needs the crm.objects.deals.read scope - already-connected users must reconnect before any deal endpoint answers.' },
  { service: 'hubspot', method: 'GET', path: '/api/v1/hubspot/deals/{dealId}', summary: 'Get a single HubSpot deal', mcpToolName: 'getDeal', openapiOperationId: 'getHubSpotDeal', status: 'live', notes: 'Deal IDs come from the deals list, the company-deals endpoint, or the searchDeals MCP tool.' },
  { service: 'hubspot', method: 'GET', path: '/api/v1/hubspot/pipelines', summary: 'List HubSpot deal pipelines with their ordered stages', mcpToolName: 'listPipelines', openapiOperationId: 'listHubSpotPipelines', status: 'live', notes: 'Use it to resolve a dealstage ID to a stage name.' },
  { service: 'hubspot', method: 'GET', path: '/api/v1/hubspot/conversations', summary: 'Get recent HubSpot conversation threads', mcpToolName: 'getRecentConversations', openapiOperationId: 'getHubSpotRecentConversations', status: 'live', notes: 'Each thread is fetched with its messages, so this is N+1 upstream calls - keep ?limit modest. ?after pages.' },
  { service: 'hubspot', method: 'GET', path: '/api/v1/hubspot/tickets', summary: 'Get HubSpot tickets by criteria', mcpToolName: 'getTickets', openapiOperationId: 'getHubSpotTickets', status: 'live', notes: 'criteria=default (closed or modified in the last day) or criteria=Closed. Datetime filters go out as epoch millis; ISO-8601 400s upstream.' },
  { service: 'hubspot', method: 'GET', path: '/api/v1/hubspot/tickets/{ticketId}/conversation-threads', summary: 'Get conversation threads for a HubSpot ticket', mcpToolName: 'getTicketConversationThreads', openapiOperationId: 'getHubSpotTicketConversationThreads', status: 'live' },
  { service: 'hubspot', method: 'GET', path: '/api/v1/hubspot/properties/{objectType}/{propertyName}', summary: 'Get a HubSpot property definition', mcpToolName: 'getProperty', openapiOperationId: 'getHubSpotProperty', status: 'live', notes: 'objectType is companies, contacts or deals.' },
  // HubSpot writes. Gated on the two limbs in the header note: a long free-text
  // body (notes, call transcripts, meeting minutes) or bulk import through a
  // shell pipeline (one curl per record, no LLM round-trip each). The one-field
  // updates, the property-schema writes and deleteEngagement are deliberately
  // MCP-only - see docs/REST_ENDPOINTS.md.
  { service: 'hubspot', method: 'POST', path: '/api/v1/hubspot/companies', summary: 'Create a HubSpot company', mcpToolName: 'createCompany', openapiOperationId: 'createHubSpotCompany', status: 'live', notes: 'Deduped by name like the MCP tool: 201 with created:true when it was written, 200 with created:false and the existing record when a company of that name already existed.' },
  { service: 'hubspot', method: 'POST', path: '/api/v1/hubspot/contacts', summary: 'Create a HubSpot contact', mcpToolName: 'createContact', openapiOperationId: 'createHubSpotContact', status: 'live', notes: 'Deduped by first and last name plus company: 201 created:true, or 200 created:false with the existing record.' },
  { service: 'hubspot', method: 'POST', path: '/api/v1/hubspot/deals', summary: 'Create a HubSpot deal', mcpToolName: 'createDeal', openapiOperationId: 'createHubSpotDeal', status: 'live', notes: 'Deals are not uniquely named, so there is no dedupe step - every call creates a new deal. Always 201.' },
  { service: 'hubspot', method: 'POST', path: '/api/v1/hubspot/notes', summary: 'Create a HubSpot note and optionally attach it to a record', mcpToolName: 'createNote', openapiOperationId: 'createHubSpotNote', status: 'live', notes: 'Body limit 5mb. hs_timestamp defaults to now. The response reports whether the timeline association succeeded - a failed association is an orphaned note, not a silent success.' },
  { service: 'hubspot', method: 'POST', path: '/api/v1/hubspot/calls', summary: 'Log a HubSpot call activity', mcpToolName: 'logCall', openapiOperationId: 'logHubSpotCall', status: 'live', notes: 'Body limit 5mb - the point is posting a transcript without it crossing the LLM context. Same association reporting as notes.' },
  { service: 'hubspot', method: 'POST', path: '/api/v1/hubspot/meetings', summary: 'Log a HubSpot meeting activity', mcpToolName: 'logMeeting', openapiOperationId: 'logHubSpotMeeting', status: 'live', notes: 'Body limit 5mb for full minutes. Same association reporting as notes.' },

  // -------- Redmine --------
  // Most of these sit on endpoints Redmine itself marks Alpha (wiki, versions,
  // memberships, relations, categories, enumerations, search) and may change
  // between releases. Lists cap at limit=100 server-side, so every list
  // response carries the window it returned plus the next offset.
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/issues', summary: 'Search and filter Redmine issues', mcpToolName: 'listIssues', openapiOperationId: 'listRedmineIssues', status: 'live', notes: 'Multi-valued filters are one comma-joined parameter (issueIds=1,2,3); repeated keys are silently ignored upstream. Custom-field filters must be cf_<digits> or they are dropped rather than sent.' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/issues/{issueId}', summary: 'Get a single Redmine issue', mcpToolName: 'getIssue', openapiOperationId: 'getRedmineIssue', status: 'live', notes: 'Pass ?include=journals,relations,watchers,allowed_statuses to embed associations. journals is the comment history.' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/issues/{issueId}/relations', summary: 'List the relations on a Redmine issue', mcpToolName: 'listIssueRelations', openapiOperationId: 'listRedmineIssueRelations', status: 'live' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/projects', summary: 'List Redmine projects', mcpToolName: 'listProjects', openapiOperationId: 'listRedmineProjects', status: 'live' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/projects/{projectId}', summary: 'Get a single Redmine project', mcpToolName: 'getProject', openapiOperationId: 'getRedmineProject', status: 'live', notes: 'projectId accepts the numeric ID or the URL identifier.' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/users', summary: 'List Redmine users (admin only)', mcpToolName: 'listUsers', openapiOperationId: 'listRedmineUsers', status: 'live', notes: 'Administrator-only upstream - 403 for an ordinary account. Use the project memberships endpoint to resolve user IDs without admin rights.' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/users/current', summary: 'Get the Redmine account this connection authenticates as', mcpToolName: 'getCurrentUser', openapiOperationId: 'getRedmineCurrentUser', status: 'live', notes: 'Registered before /users/{userId} so current is not read as a user ID.' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/users/{userId}', summary: 'Get a single Redmine user', mcpToolName: 'getUser', openapiOperationId: 'getRedmineUser', status: 'live' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/time-entries', summary: 'List Redmine time entries', mcpToolName: 'listTimeEntries', openapiOperationId: 'listRedmineTimeEntries', status: 'live', notes: 'Any hours total you compute from this is per page, not per project - follow the reported offset to the end before summing.' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/time-entries/{timeEntryId}', summary: 'Get a single Redmine time entry', mcpToolName: 'getTimeEntry', openapiOperationId: 'getRedmineTimeEntry', status: 'live' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/projects/{projectId}/wiki', summary: 'List the wiki page titles of a Redmine project', mcpToolName: 'listWikiPages', openapiOperationId: 'listRedmineWikiPages', status: 'live', notes: 'Titles only - fetch each page for its text.' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/projects/{projectId}/wiki/{title}', summary: 'Get one Redmine wiki page with its text', mcpToolName: 'getWikiPage', openapiOperationId: 'getRedmineWikiPage', status: 'live', notes: 'title is the page title exactly as listed, not a slug. ?version fetches a specific revision.' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/projects/{projectId}/versions', summary: 'List the versions of a Redmine project', mcpToolName: 'listVersions', openapiOperationId: 'listRedmineVersions', status: 'live' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/versions/{versionId}', summary: 'Get a single Redmine version', mcpToolName: 'getVersion', openapiOperationId: 'getRedmineVersion', status: 'live' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/projects/{projectId}/issue-categories', summary: 'List the issue categories of a Redmine project', mcpToolName: 'listIssueCategories', openapiOperationId: 'listRedmineIssueCategories', status: 'live' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/projects/{projectId}/memberships', summary: 'List the members of a Redmine project with their roles', mcpToolName: 'listMemberships', openapiOperationId: 'listRedmineMemberships', status: 'live', notes: 'The non-admin way to resolve user IDs for assignment and watchers.' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/trackers', summary: 'List Redmine trackers with their IDs', mcpToolName: 'listTrackers', openapiOperationId: 'listRedmineTrackers', status: 'live' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/issue-statuses', summary: 'List Redmine issue statuses with their IDs', mcpToolName: 'listIssueStatuses', openapiOperationId: 'listRedmineIssueStatuses', status: 'live' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/issue-priorities', summary: 'List Redmine issue priorities with their IDs', mcpToolName: 'listIssuePriorities', openapiOperationId: 'listRedmineIssuePriorities', status: 'live' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/time-entry-activities', summary: 'List Redmine time entry activities with their IDs', mcpToolName: 'listTimeEntryActivities', openapiOperationId: 'listRedmineTimeEntryActivities', status: 'live' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/custom-fields', summary: 'List Redmine custom fields and their cf_id filter keys', mcpToolName: 'listCustomFields', openapiOperationId: 'listRedmineCustomFields', status: 'live', notes: 'Administrator-only upstream, same as the users list.' },
  { service: 'redmine', method: 'GET', path: '/api/v1/redmine/search?q={query}', summary: 'Full text search across Redmine', mcpToolName: 'searchRedmine', openapiOperationId: 'searchRedmine', status: 'live', notes: 'q is required. Pass ?issues=true&wikiPages=true etc. to restrict which record types are searched.' },
  // Redmine writes. Same gate as HubSpot: an issue description, an issue note
  // and a wiki page body are all large free text, and bulk issue or timesheet
  // import is the shell-pipeline case. Every delete tool, archiveProject and
  // the project/version/category/membership admin creates stay MCP-only -
  // Redmine has no recycle bin and deleteProject cascades into subprojects.
  { service: 'redmine', method: 'POST', path: '/api/v1/redmine/issues', summary: 'Create a Redmine issue', mcpToolName: 'createIssue', openapiOperationId: 'createRedmineIssue', status: 'live', notes: 'Body limit 5mb. 201 with the created issue. Only projectId and subject are required; everything else falls back to the project or tracker default.' },
  { service: 'redmine', method: 'POST', path: '/api/v1/redmine/issues/{issueId}', summary: 'Update a Redmine issue or append a comment', mcpToolName: 'updateIssue', openapiOperationId: 'updateRedmineIssue', status: 'live', notes: 'POST rather than PUT because the catalog scope is GET and POST; Redmine itself takes a PUT here. Body limit 5mb. notes appends a comment, description REPLACES the body. Returns 200 with the issue re-read, since Redmine answers the write with 204 and no body.' },
  { service: 'redmine', method: 'POST', path: '/api/v1/redmine/time-entries', summary: 'Log time against a Redmine issue or project', mcpToolName: 'createTimeEntry', openapiOperationId: 'createRedmineTimeEntry', status: 'live', notes: '201 with the created entry. Provide issueId or projectId, not neither. Not idempotent - repeating the call logs the hours twice.' },
  { service: 'redmine', method: 'POST', path: '/api/v1/redmine/projects/{projectId}/wiki/{title}', summary: 'Create or replace a Redmine wiki page', mcpToolName: 'updateWikiPage', openapiOperationId: 'updateRedmineWikiPage', status: 'live', notes: 'Body limit 5mb - the clearest large-body case here, since text replaces the whole page. A title that does not exist yet is created. Pass version for optimistic locking so a concurrent edit is rejected rather than clobbered. Returns 200 with the page re-read.' },
];

export function endpointsForTool(mcpToolName: string): RestEndpoint[] {
  return REST_CATALOG.filter(e => e.mcpToolName === mcpToolName);
}

export function endpointsForService(service: RestService): RestEndpoint[] {
  return REST_CATALOG.filter(e => e.service === service);
}

export function restHintForTool(mcpToolName: string): string | null {
  const eps = endpointsForTool(mcpToolName);
  if (eps.length === 0) return null;
  const ep = eps[0];
  return `REST: ${ep.method} ${ep.path} (call mintRestBearerForCurl for a 5-min bearer).`;
}
