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
- **HubSpot auth is OAuth 2.0 by default:** the catalog always advertises the OAuth endpoints, so the dashboard always shows "Connect with HubSpot" (the paste-token form is not shown). The client_id/secret come from `HUBSPOT_CLIENT_ID`/`HUBSPOT_CLIENT_SECRET` (a registered HubSpot app) and MUST be set on both the web service and the hubspot MCP service, or the connect flow has no client and fails. OAuth access tokens expire (~30 min) and are refreshed at tool-call time via `maybeRefreshHubSpotToken`. The paste-token path (`connectToken.ts`, the `/api/connect-token` hubspot branch) still exists server-side as an API-level escape hatch and skips refresh, but the dashboard no longer surfaces it.
- **HubSpot `searchData` not registered:** the reference's 16th tool did semantic search over a local FAISS vector index; this codebase has no vector store, so the tool is intentionally omitted rather than advertised as a throwing stub. The 15 registered HubSpot tools are implemented against the official HubSpot REST API.
- **HubSpot read/write contract:** reads that request explicit `properties` flag unknown keys HubSpot silently drops (`getCompany`/`getContact`); `updateCompany`/`updateContact` re-read the record after PATCH so the response matches a fresh read (HubSpot's PATCH echo omits populated fields); `getCompanyActivity` emits ISO-8601 (engagement timestamps are epoch millis upstream). `getTickets` filters datetime props (`closedate`/`hs_lastmodifieddate`) with **epoch millis** — the search API 400s on ISO. Empty `{}` update payloads are rejected by the Zod schema before any API call. Email bodies in `getCompanyActivity` need the `sales-email-read` scope (in the OAuth scope list).

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
| `src/website/webServer.ts` | Express app, proxy routes, registration/OAuth pages |
| `src/website/oauthServer.ts` | MCP OAuth 2.1 authorization server |
| `src/website/sessionStore.ts` | Session management (cookie/Redis) |

## See Also

- `README.md` - Setup instructions and usage examples
- `SAMPLE_TASKS.md` - 15 example workflows
