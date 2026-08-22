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
| `getComment` | `GET /api/v1/docs/{documentId}/comments/{commentId}` | live | Get a single comment with its replies |
| `inspectDocStructure` | `GET /api/v1/docs/{documentId}/structure` | live | Inspect the structure of a Google Doc — _Paragraph/table/section counts, headers and footers presence, tab hierarchy. Pass ?detailed=true for an element-by-element listing, ?tabId= to scope to one tab._ |

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
| `listDocs` | `GET /api/v1/clickup/workspaces/{workspaceId}/docs` | live | List docs in a workspace |
| `searchDocs` | `GET /api/v1/clickup/workspaces/{workspaceId}/docs/search` | live | Search docs in a workspace |
| `getDoc` | `GET /api/v1/clickup/docs/{docId}?workspaceId={workspaceId}` | live | Get a ClickUp doc with its pages — _Required query param: workspaceId._ |
| `getPage` | `GET /api/v1/clickup/docs/{docId}/pages/{pageId}?workspaceId={workspaceId}` | live | Get a page within a ClickUp doc — _Required query param: workspaceId._ |
| `listWorkspaceMembers` | `GET /api/v1/clickup/workspaces/{workspaceId}/members` | live | List members of a workspace — _No dedicated ClickUp endpoint; derived from getWorkspaces team.members[]._ |
| `getTimeEntries` | `GET /api/v1/clickup/workspaces/{workspaceId}/time` | live | List time entries |

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
| `getDocument` | `GET /api/v1/outline/documents/{documentId}` | planned | Read an Outline document |
| `exportDocument` | `GET /api/v1/outline/documents/{documentId}/export` | planned | Export an Outline document as plain markdown |
| `searchDocuments` | `GET /api/v1/outline/documents/search?q={query}` | planned | Search Outline documents |
| `listRecentlyUpdatedDocuments` | `GET /api/v1/outline/documents/recent` | planned | List recently updated Outline documents |
| `getDocumentBacklinks` | `GET /api/v1/outline/documents/{documentId}/backlinks` | planned | List documents that link to a given Outline document |
| `listArchivedDocuments` | `GET /api/v1/outline/documents/archived` | planned | List archived Outline documents |
| `listTrash` | `GET /api/v1/outline/documents/trash` | planned | List Outline documents in the trash |
| `listCollections` | `GET /api/v1/outline/collections` | planned | List Outline collections |
| `getCollectionStructure` | `GET /api/v1/outline/collections/{collectionId}/structure` | planned | Get the hierarchical document tree for an Outline collection |
| `listDocumentComments` | `GET /api/v1/outline/documents/{documentId}/comments` | planned | List comments on an Outline document |
| `getComment` | `GET /api/v1/outline/comments/{commentId}` | planned | Get a single Outline comment |
| `listDocumentAttachments` | `GET /api/v1/outline/documents/{documentId}/attachments` | planned | List attachments referenced in an Outline document |
| `getAttachmentUrl` | `GET /api/v1/outline/attachments/{attachmentId}/url` | planned | Resolve an Outline attachment ID to a signed download URL |

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

### HubSpot (`hubspot`)

| MCP tool | REST endpoint | Status | Summary |
|---|---|---|---|
| `getActiveCompanies` | `GET /api/v1/hubspot/companies` | planned | Get most recently active HubSpot companies |
| `getCompany` | `GET /api/v1/hubspot/companies/{companyId}` | planned | Get a single HubSpot company |
| `getCompanyActivity` | `GET /api/v1/hubspot/companies/{companyId}/activity` | planned | Get activity history for a HubSpot company |
| `getActiveContacts` | `GET /api/v1/hubspot/contacts` | planned | Get most recently active HubSpot contacts |
| `getContact` | `GET /api/v1/hubspot/contacts/{contactId}` | planned | Get a single HubSpot contact |
| `getRecentConversations` | `GET /api/v1/hubspot/conversations` | planned | Get recent HubSpot conversation threads |
| `getTickets` | `GET /api/v1/hubspot/tickets` | planned | Get HubSpot tickets by criteria |
| `getTicketConversationThreads` | `GET /api/v1/hubspot/tickets/{ticketId}/conversation-threads` | planned | Get conversation threads for a HubSpot ticket |
| `getProperty` | `GET /api/v1/hubspot/properties/{objectType}/{propertyName}` | planned | Get a HubSpot property definition |

## Status legend

- **live** — endpoint is currently wired and reachable.
- **planned** — endpoint is in the catalog and on the roadmap; not yet served by the Express app. Calls return 404 until shipped.

Catalog size: 120 endpoints.
