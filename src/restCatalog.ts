// Single source of truth for the REST data plane.
// Drives listRestEndpoints (MCP tool), the merged root OpenAPI spec, and the
// README translation table. Update one place when adding endpoints.
//
// Convention: every GET in this catalog is a passthrough for an MCP read tool.
// Write tools (create*, update*, delete*, send*, move*, apply*, format*, set*,
// batch*Update) stay MCP-only and are not listed here.

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
  | 'peopleforce';

export interface RestEndpoint {
  service: RestService;
  method: 'GET';
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

  // -------- Google Sheets --------
  { service: 'sheets', method: 'GET', path: '/api/v1/sheets', summary: 'List spreadsheets', mcpToolName: 'listGoogleSheets', openapiOperationId: 'listSpreadsheets', status: 'live' },
  { service: 'sheets', method: 'GET', path: '/api/v1/sheets/{spreadsheetId}', summary: 'Get spreadsheet metadata', mcpToolName: 'getSpreadsheetInfo', openapiOperationId: 'getSpreadsheetInfo', status: 'live' },
  { service: 'sheets', method: 'GET', path: '/api/v1/sheets/{spreadsheetId}/ranges?range={range}', summary: 'Read a range from a spreadsheet', mcpToolName: 'readSpreadsheet', openapiOperationId: 'readSpreadsheet', status: 'live', notes: 'GET sibling of the existing POST /api/v1/sheets/{id}/read.' },
  { service: 'sheets', method: 'GET', path: '/api/v1/sheets/{spreadsheetId}/rows/{rowNumber}', summary: 'Read a row by row number', mcpToolName: 'readRowByField', openapiOperationId: 'readRowByField', status: 'live' },
  { service: 'sheets', method: 'GET', path: '/api/v1/sheets/{spreadsheetId}/search', summary: 'Find a row by column value (?col=&val=)', mcpToolName: 'findRowByValue', openapiOperationId: 'findRowByValue', status: 'live' },

  // -------- Google Calendar --------
  { service: 'calendar', method: 'GET', path: '/api/v1/calendars', summary: 'List calendars', mcpToolName: 'listCalendars', openapiOperationId: 'listCalendars', status: 'live' },
  { service: 'calendar', method: 'GET', path: '/api/v1/calendars/{calendarId}/events', summary: 'List events in a calendar', mcpToolName: 'listEvents', openapiOperationId: 'listEvents', status: 'live' },
  { service: 'calendar', method: 'GET', path: '/api/v1/calendars/{calendarId}/events/{eventId}', summary: 'Get a single event', mcpToolName: 'getEvent', openapiOperationId: 'getEvent', status: 'live' },

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
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/workspaces/{workspaceId}/docs', summary: 'List docs in a workspace', mcpToolName: 'listDocs', openapiOperationId: 'listDocs', status: 'live' },
  { service: 'clickup', method: 'GET', path: '/api/v1/clickup/workspaces/{workspaceId}/docs/search', summary: 'Search docs in a workspace', mcpToolName: 'searchDocs', openapiOperationId: 'searchDocs', status: 'live' },
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
  // Catalog-only for now: MCP tools ship in src/peopleforce/server.ts, but the
  // /api/v1/peopleforce/* REST siblings are not yet wired in webServer.ts.
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/employees', summary: 'List PeopleForce employees', mcpToolName: 'listEmployees', openapiOperationId: 'listPeopleForceEmployees', status: 'planned' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/employees/{employeeId}', summary: 'Get a single PeopleForce employee', mcpToolName: 'getEmployee', openapiOperationId: 'getPeopleForceEmployee', status: 'planned' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/departments', summary: 'List PeopleForce departments', mcpToolName: 'listDepartments', openapiOperationId: 'listPeopleForceDepartments', status: 'planned' },
  { service: 'peopleforce', method: 'GET', path: '/api/v1/peopleforce/absences', summary: 'List PeopleForce absences', mcpToolName: 'listAbsences', openapiOperationId: 'listPeopleForceAbsences', status: 'planned' },
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
