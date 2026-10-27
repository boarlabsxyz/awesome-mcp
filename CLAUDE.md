# Google Docs MCP Server

Multi-service FastMCP hosting platform: one MCP server per provider under `src/<provider>/server.ts` — Google Docs, Sheets, Calendar, Drive, Gmail and Slides, ClickUp, Slack (bot + user), Outline, PeopleForce (v2/v3 and v4), HubSpot, Redmine, Browserbase, GitHub and Pinecone — plus a curl-able REST data plane under `/api/v1/*`.

## Tool Inventory

Do not keep tool counts here; they drift. The generated lists are the source of truth:

- `docs/MCP_TOOLS.md` — every MCP tool, grouped by service (`scripts/buildMcpToolsDoc.mjs`)
- `docs/REST_ENDPOINTS.md` — every REST endpoint, generated from `src/restCatalog.ts`

Google Docs tools that throw rather than work (`NOT_IMPLEMENTED` in `e2e/tools.ts`): `editTableCell`, `fixListFormatting`, `findElement`.

## Per-service notes

Service-specific limitations live next to the code and load only when you work in that directory:

- `src/browserbase/CLAUDE.md` — Browserbase
- `src/clickup/CLAUDE.md` — ClickUp
- `src/github/CLAUDE.md` — GitHub
- `src/google-calendar/CLAUDE.md` — Google Calendar
- `src/google-docs/CLAUDE.md` — Google Docs
- `src/google-sheets/CLAUDE.md` — Google Sheets
- `src/hubspot/CLAUDE.md` — HubSpot
- `src/outline/CLAUDE.md` — Outline
- `src/peopleforce/CLAUDE.md` — PeopleForce (v2/v3)
- `src/peopleforce-v4/CLAUDE.md` — PeopleForce v4
- `src/pinecone/CLAUDE.md` — Pinecone
- `src/redmine/CLAUDE.md` — Redmine
- `src/slack/CLAUDE.md` — Slack (shared + slack-bot)
- `src/slack-user/CLAUDE.md` — Slack user server (slack-user)
- `src/website/CLAUDE.md` — Web server, dashboard auth and the REST plane

## Cross-cutting notes

- **A `//` comment containing the two characters that open a block comment broke `sharedToolsRegistration.test.ts`, and the fix is in the guard.** The natural way to write these endpoints in prose ends a line comment with `/` + `*`, and the guard stripped block comments *first* with a regex — so it swallowed everything from that line to the next `*/`, registration calls included, and reported a server that registers both shared tools as registering neither. `serverSource` now strips whole-line `//` comments **before** block comments; the order is load-bearing, and anchoring at the line start still deletes a commented-out `// registerX(server)` so it cannot satisfy the check.

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
| `src/util/mcpProxyClient.ts` | The Streamable-HTTP MCP transport shared by Browserbase and Pinecone: per-call transport, SSE frames, and the rule that a replica-affine session is never cached |
| `src/util/baseUrlGuard.ts` | `isPrivateHost` + `checkBaseUrl` — the SSRF range table shared by the self-hosted connectors (Outline, Redmine) |
| `src/util/oauthTokenGrant.ts` | `postTokenGrant` — the shared OAuth token-endpoint POST (HubSpot + Redmine) |
| `src/website/webServer.ts` | Express app, proxy routes, registration/OAuth pages |
| `src/website/oauthServer.ts` | MCP OAuth 2.1 authorization server |
| `src/website/sessionStore.ts` | Session management (cookie/Redis) |

## See Also

- `README.md` - Setup instructions and usage examples
