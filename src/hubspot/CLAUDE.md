# HubSpot — notes for Claude

REST-plane handlers for this service: see src/website/CLAUDE.md.

## Rules and limitations

### Auth & scopes
- **OAuth 2.0 is the only dashboard path** — `HUBSPOT_CLIENT_ID`/`HUBSPOT_CLIENT_SECRET` must be set on both the web and hubspot MCP services. Tokens expire ~30 min; refreshed at call time by `maybeRefreshHubSpotToken`. Paste-token (`connectToken.ts`, `/api/connect-token`) survives server-side as an escape hatch, without refresh.
- **New scopes need a reconnect** — the catalog seed (`mcpCatalogStore.ts`) updates on boot, but a token keeps its minted scopes and the connection still looks healthy. Deal tools and deal support in `getProperty`/`createProperty`/`updateProperty` need `crm.objects.deals.*` + `crm.schemas.deals.*`; `getCompanyActivity` email bodies need `sales-email-read`.
- **Missing-scope 403s name needed AND granted** — `parseHubSpotMissingScopes` reads `MISSING_SCOPES` from `context.requiredScopes` or the prose `requires any of [...]` (HubSpot sends one or the other); `withHubSpotClient` then calls `fetchHubSpotGrantedScopes` (`GET /oauth/v1/access-tokens/{token}`). If granted already includes it, don't tell the user to reconnect. Best-effort: lookup failure falls back to needed-only.
- **Do NOT add `crm.objects.{notes,tasks,calls,meetings}.*`** — they don't exist; an unknown scope breaks consent for every HubSpot connection. Engagement writes need only `crm.objects.contacts.read/write`.
- **Deal reads share one scope** — `getActiveDeals` and `getDeal` both need `crm.objects.deals.read`; if one works, a failing one is not a scope problem.

### Deals
- **Company → deals goes through `getCompanyDeals`** (associations v4 then `readDealsByIds`); `searchDeals` is by name (shared `opSearchObjects`). `getCompanyActivity` returns engagements only; `getActiveDeals` has no company filter.
- **Never truncate silently** — associations page 500 at a time up to `ASSOCIATION_MAX_PAGES` = 10 (5,000 IDs); batch reads chunk at 100. Hitting the bound returns `truncated`, rendered "of N+" (a floor).
- **`listPipelines`** returns pipelines with ordered stages; use it to map `dealstage` IDs to names.

### Engagements (`createNote`/`createTask`/`logCall`/`logMeeting`)
- **Create, then attach via the v4 default association** (`PUT /crm/v4/objects/{type}/{id}/associations/default/{toType}/{toId}`) — avoids direction-sensitive type IDs. Claim timeline attachment only after a 2xx; otherwise report an orphaned engagement.
- **`hs_timestamp` defaults to now** (the most common create failure). `deleteEngagement` archives (recycling bin) and uses the same contacts scopes.

### Read/write contract
- **Explicit `properties` reads flag keys HubSpot dropped** — `getCompany`/`getContact` and `formatObjectList` render unset ones as `(empty)` and add a ⚠ note for keys never returned.
- **`updateCompany`/`updateContact` re-read after PATCH** — the PATCH echo omits populated fields. Empty `{}` updates are rejected by Zod.
- **Dates** — `getCompanyActivity` outputs ISO-8601 (upstream epoch ms); `getTickets` filters `closedate`/`hs_lastmodifieddate` with epoch millis (search API 400s on ISO).
- **`searchData` is deliberately omitted** — the reference used a local FAISS index this repo doesn't have; `searchCompanies`/`searchContacts` cover CRM search.

## Source Files

| File | Contains |
|------|----------|
| `src/hubspot/server.ts` | Tool definitions (`HUBSPOT_BASE_URL`, default api.hubapi.com) |
| `src/hubspot/apiHelpers.ts` | `HubSpotClient` (CRM v3), scope-error parsing, OAuth refresh |
| `src/hubspot/connectToken.ts` | `validateHubSpotToken` for the paste-token path |
| `src/hubspot/oauthCallback.ts` | `exchangeHubSpotOauthCode`, `refreshHubSpotToken` |
