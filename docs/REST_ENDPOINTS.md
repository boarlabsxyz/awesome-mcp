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
| `listTimeEntries` | `GET /api/v1/redmine/time-entries` | live | List Redmine time entries — _Any hours total you compute from this is per page, not per project - follow the reported offset to the end before summing._ |
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

## Status legend

- **live** — endpoint is currently wired and reachable.
- **planned** — endpoint is in the catalog and on the roadmap; not yet served by the Express app. Calls return 404 until shipped.

Catalog size: 168 endpoints.
