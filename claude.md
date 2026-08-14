# Google Docs MCP Server

FastMCP server with 43 tools for Google Docs, Sheets, and Drive.

## Tool Categories

| Category | Count | Examples |
|----------|-------|----------|
| Docs | 5 | `readGoogleDoc`, `appendToGoogleDoc`, `insertText`, `deleteRange`, `listDocumentTabs` |
| Formatting | 3 | `applyTextStyle`, `applyParagraphStyle`, `formatMatchingText` |
| Structure | 7 | `insertTable`, `insertPageBreak`, `insertImageFromUrl`, `insertLocalImage`, `editTableCell`*, `findElement`*, `fixListFormatting`* |
| Comments | 6 | `listComments`, `getComment`, `addComment`, `replyToComment`, `resolveComment`, `deleteComment` |
| Sheets | 9 | `readSpreadsheet`, `writeSpreadsheet`, `appendSpreadsheetRows`, `clearSpreadsheetRange`, `createSpreadsheet`, `listGoogleSheets`, `batchUpdateSpreadsheet` |
| Drive | 13 | `listGoogleDocs`, `searchGoogleDocs`, `getDocumentInfo`, `createFolder`, `moveFile`, `copyFile`, `createDocument` |

*Not fully implemented

## Known Limitations

- **Comment anchoring:** Programmatically created comments appear in "All Comments" but aren't visibly anchored to text in the UI
- **Resolved status:** May not persist in Google Docs UI (Drive API limitation)
- **editTableCell:** Not implemented (complex cell index calculation)
- **fixListFormatting:** Experimental, may not work reliably
- **ClickUp Doc images are self-hosted:** ClickUp has no image-upload API for Docs, and its SPA `/v1/attachment` route needs a browser session JWT this server doesn't have (ClickUp auth here is a per-user OAuth token). So `insertImageIntoPage`/`uploadClickUpDocImage` re-host the image themselves: fetch a public image URL (SSRF-guarded, 20 MB cap), store the bytes in Postgres (`clickup_doc_images`, `src/clickup/docImageStore.ts`), and embed `![](BASE_URL/images/clickup-doc/<id>)` via the existing markdown `editPage`. The serve route (`registerClickUpDocImageRoutes` in `webServer.ts`) is public/unauthenticated (ClickUp's renderer must fetch it; ids are unguessable UUIDs). Requires `DATABASE_URL` + `BASE_URL`; without Postgres the tools return a clear error. Input is a remote URL only (no base64 yet).
- **HubSpot auth is OAuth 2.0 by default:** the catalog always advertises the OAuth endpoints, so the dashboard always shows "Connect with HubSpot" (the paste-token form is not shown). The client_id/secret come from `HUBSPOT_CLIENT_ID`/`HUBSPOT_CLIENT_SECRET` (a registered HubSpot app) and MUST be set on both the web service and the hubspot MCP service, or the connect flow has no client and fails. OAuth access tokens expire (~30 min) and are refreshed at tool-call time via `maybeRefreshHubSpotToken`. The paste-token path (`connectToken.ts`, the `/api/connect-token` hubspot branch) still exists server-side as an API-level escape hatch and skips refresh, but the dashboard no longer surfaces it.
- **HubSpot `searchData` not registered:** the reference's 16th tool did semantic search over a local FAISS vector index; this codebase has no vector store, so the tool is intentionally omitted rather than advertised as a throwing stub. The 17 registered HubSpot tools are implemented against the official HubSpot REST API. (`searchCompanies`/`searchContacts` cover the CRM search endpoint — the free-text/property lookup the omitted FAISS tool was reaching for.)
- **HubSpot read/write contract:** reads that request explicit `properties` flag unknown keys HubSpot silently drops (`getCompany`/`getContact`, and `searchCompanies`/`searchContacts` via `formatObjectList`, which renders every requested property — unset ones as `(empty)` — and appends a ⚠ note listing keys HubSpot never returned, so "no value on this record" is never confused with "the tool doesn't return that"); `updateCompany`/`updateContact` re-read the record after PATCH so the response matches a fresh read (HubSpot's PATCH echo omits populated fields); `getCompanyActivity` emits ISO-8601 (engagement timestamps are epoch millis upstream). `getTickets` filters datetime props (`closedate`/`hs_lastmodifieddate`) with **epoch millis** — the search API 400s on ISO. Empty `{}` update payloads are rejected by the Zod schema before any API call. Email bodies in `getCompanyActivity` need the `sales-email-read` scope (in the OAuth scope list).
- **PeopleForce employee custom tables ARE exposed (v3):** repeating-row profile sections like "Dev Sprint participation" are readable via `listEmployeeTables` (definitions + each table's `internal_name`) and `getEmployeeTable(employeeId, internalName)` (a specific employee's rows). This partially lifts the "no participation" ceiling below — attendance/participation data a tenant models as an employee table (not a flat custom field) is now reachable per employee. Cells are typed (text/date/single_select `{id,value}`/multi_select `[]`/number/`hr_manager`/boolean); `formatEmployeeTable` renders them. Gotchas: the row-data GET is wrapped in `{ data: {...} }` (docs omit it — `getEmployeeTable` unwraps, else every table reads as empty); a table's `internal_name` is a **system slug**, often unrelated to the display name (e.g. "Dev Sprint participation" → `timeline`), so always get it from `listEmployeeTables` — never guess. `formatEmployeeTable` **dumps the raw payload** if it finds no `rows` array rather than falsely reporting "no rows" (a silent 0 would read as 0 participants downstream).
- **PeopleForce L&D analytics ceiling (verified live 2026-08-08):** the public API has **no** first-class entities for courses, enrollments, participation/attendance, completions, or L&D cost/hours — so "course completions", "participation counts", and "overall L&D investment" are **not answerable** from the connector *as dedicated objects* (but see employee custom tables above — a tenant may model participation there). In practice these live only as free text: Dev Sprints and courses show up as *objective titles / key-result prose* (e.g. "Dev Sprint complete…", "Professional Scrum Master course"), countable only by fragile string-matching. `listSkills`/`listEmployeeSkills` carry **no timestamps**, so skills-over-time needs you to snapshot into your own time-series store on a schedule (no retroactive history). `listObjectives`/`listKeyPerformanceIndicators` have **no date filter** (only `page`) — filter by `Period` client-side. There is **no bulk employee-skills endpoint** — a company-wide skills portfolio is one `listEmployeeSkills` call per employee (cache aggressively). Employee **custom fields are tenant-dependent** — do not promise specific field names (e.g. "Dev Sprint") in tool descriptions; many tenants have none. Objective/KPI `owner` may arrive name-only — `formatObjectiveList`/`formatKpiList` surface owner `id`+`email` when present to give a stable join key. KB article `body` can be a structured object, not a string (`formatKnowledgeArticle` serializes it); custom-field values can contain raw HTML (`formatCustomFields` strips tags/entities).
- **PeopleForce trend dashboards → snapshot collector, not the MCP:** because the API has no history/date-filtering, time-series analytics (Grafana) are built by the **snapshot collector** (`src/peopleforce/snapshot/`, `npm run snapshot:peopleforce`), which periodically writes the current state into append-only `pf_*_snapshot` Postgres tables stamped with `captured_at`. Querying across stamps reconstructs trends. It needs `PEOPLEFORCE_API_KEY` + `DATABASE_URL`, is single-tenant (one API key), and history is **forward-only** — start it early. Grafana reads the Postgres tables directly (see `src/peopleforce/snapshot/README.md` for schema, scheduling, and per-dashboard SQL). The MCP tools remain the path for ad-hoc/LLM queries. The collector also captures **employee custom-table cells** into `pf_employee_table_cell_snapshot` (participation — e.g. Dev Sprint attendance, multi-select expanded to one row per value), which powers participation counts + team trends over time; set `PEOPLEFORCE_SNAPSHOT_TABLES` (comma-separated `internal_name`s) to scope which tables, else all discovered tables are captured (`employees × tables` calls).

## Parameter Patterns

- **Document ID:** Extract from URL: `docs.google.com/document/d/DOCUMENT_ID/edit`
- **Text targeting:** Use `textToFind` + `matchInstance` OR `startIndex`/`endIndex`
- **Colors:** Hex format `#RRGGBB` or `#RGB`
- **Alignment:** `START`, `END`, `CENTER`, `JUSTIFIED` (not LEFT/RIGHT)
- **Indices:** 1-based, ranges are [start, end)
- **Tabs:** Optional `tabId` parameter (defaults to first tab)

## Source Files (for implementation details)

| File | Contains |
|------|----------|
| `src/types.ts` | Zod schemas, hex color validation, style parameter definitions |
| `src/google-docs/apiHelpers.ts` | `findTextRange`, `executeBatchUpdate`, style request builders |
| `src/google-docs/server.ts` | Google Docs tool definitions, main entry point |
| `src/google-sheets/apiHelpers.ts` | A1 notation parsing, range operations |
| `src/google-sheets/server.ts` | Google Sheets tool definitions |
| `src/google-calendar/server.ts` | Google Calendar tool definitions |
| `src/outline/server.ts` | Outline wiki tool definitions (self-hosted at wiki.gluzdov.com; base URL via `OUTLINE_BASE_URL`, defaults to dev wiki) |
| `src/outline/apiHelpers.ts` | `OutlineClient` — Bearer-token HTTP client for Outline REST API |
| `src/peopleforce/server.ts` | PeopleForce HRIS tool definitions (base URL via `PEOPLEFORCE_BASE_URL`, defaults to app.peopleforce.io/api/public/v2) |
| `src/hubspot/server.ts` | HubSpot CRM tool definitions (base URL via `HUBSPOT_BASE_URL`, defaults to api.hubapi.com) |
| `src/hubspot/apiHelpers.ts` | `HubSpotClient` — bearer-token HTTP client for the HubSpot CRM v3 REST API; OAuth token-refresh plumbing |
| `src/hubspot/connectToken.ts` | Paste-token validation (`validateHubSpotToken`) for the private-app access-token connect flow |
| `src/hubspot/oauthCallback.ts` | HubSpot OAuth 2.0 code exchange + refresh grant (`exchangeHubSpotOauthCode`, `refreshHubSpotToken`) |
| `src/peopleforce/apiHelpers.ts` | `PeopleForceClient` — API-key/Bearer HTTP client for PeopleForce REST API |
| `src/peopleforce/snapshot/` | L&D time-series snapshot collector (Postgres `pf_*_snapshot` tables) for Grafana trend dashboards; `npm run snapshot:peopleforce`. Also: `pf_employee_dim` + `pf_owner_resolution` (owner→team join, `resolve.ts`), `pf_kb_article_snapshot` (content-authored), and an LLM objective classifier (`classify.ts`, `npm run classify:peopleforce-objectives`, versioned + confidence-gated). See its `README.md`. |
| `src/website/webServer.ts` | Express app, proxy routes, registration/OAuth pages |
| `src/website/oauthServer.ts` | MCP OAuth 2.1 authorization server |
| `src/website/sessionStore.ts` | Session management (cookie/Redis) |

## See Also

- `README.md` - Setup instructions and usage examples
- `SAMPLE_TASKS.md` - 15 example workflows
