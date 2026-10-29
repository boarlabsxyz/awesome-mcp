# Supabase — notes for Claude

**Status: NOT yet exercised live.** Every behaviour below is read off Supabase's published server and docs. On the first live run, check two things first: a 400 on every call (the protocol shape), and whether `confirm_cost_id` is really required for a client that cannot show forms.

## Rules and limitations

### Proxy shape

- **All 30 tools proxy Supabase's hosted MCP server** (`https://mcp.supabase.com/mcp`, published as `supabase-community/supabase-mcp`) under their upstream snake_case names. They cover Supabase's default feature groups minus `feedback`; storage, notebooks and edge-function secrets are not mirrored.
- **Register each tool with `supabaseTool({...})`, using a literal name and description** — `scripts/buildMcpToolsDoc.mjs` reads them from source text (`supabaseTool` is in its `REGISTRATION_OPENERS`). A computed name or description drops out of `docs/MCP_TOOLS.md`.
- **The target is `protocol: 'modern'`.** Supabase's handler uses the v2 SDK with `legacy: 'reject'` and answers the 2025 `initialize` handshake with **400**. So `src/util/mcpProxyClient.ts` sends one stateless `tools/call` carrying the 2026-07-28 `_meta` envelope (`io.modelcontextprotocol/{protocolVersion,clientInfo,clientCapabilities}`) plus `mcp-method`/`mcp-name` headers.
- **Fall back to the legacy `initialize` trio only when the server says it is legacy-only** — `-32022` without the modern version in `data.supported`, or "not initialized". Any other 400 is a real error and is not retried. Browserbase and Pinecone stay on the legacy path.

### Confirmations

- **Supabase's destructive-SQL confirmation form does not run through this proxy.** The proxy declares empty capabilities, so DROP / DELETE / TRUNCATE / UPDATE-without-WHERE takes the `capability_missing` path and **runs without asking**. That is why `execute_sql` and `apply_migration` carry `destructiveHint` and their descriptions say so, instead of upstream's "may require the user to confirm".
- **Cost confirmation still works**, via `get_cost` → `confirm_cost` → `confirm_cost_id`.
- **An `input_required` answer is reported as *not performed*, never as an empty success.**

### Credential

- **Auth is env-gated dual mode, like GitHub.**
  - With `SUPABASE_CLIENT_ID` + `SUPABASE_CLIENT_SECRET` set, the dashboard shows "Connect with Supabase". These come from an OAuth app an organization owner registers in Supabase, with redirect `<BASE_URL>/connect/supabase/callback`.
  - Without them, the user pastes a personal access token (`sbp_…`), validated against `GET /v1/organizations`.
- **OAuth scopes are set on the Supabase app**, so the catalog seeds none and the authorize request sends none.
- **The client credentials must be on BOTH the web service and the supabase MCP service.** The web service needs them for the code exchange; the MCP service needs them for call-time refresh.
- **Persist whatever refresh token comes back.** Tokens expire and are refreshed single-flight at call time, and Supabase does not document whether it rotates the refresh token.
- **Reach differs by credential:** a PAT reaches every organization the account can; an OAuth grant reaches only the one organization chosen at consent.
- **No base URL field.** The Supabase platform is one API host, and self-hosted Supabase has no hosted MCP server.

### Output, catalog, REST

- **Results are capped at 200k characters.** SQL results arrive inside an `<untrusted-data-…>` boundary, and the cap note says the cut text is still untrusted.
- **Hidden behind `SUPABASE_ENABLED`** (strict `=== 'true'`; a restart, not a deploy), like Browserbase and Pinecone.
- **The 18 read tools have `planned` REST entries only — no routes yet.** Wiring them is a separate `/add-rest-endpoint supabase` pass.

## Source Files

| File | Contains |
|------|----------|
| `src/supabase/server.ts` | Tool definitions — each a `supabaseTool({...})` proxy registration mirroring the upstream hosted server |
| `src/supabase/schemas.ts` | Zod parameter schemas for the proxied tools |
| `src/supabase/hostedProxy.ts` | The hosted-MCP target (`protocol: 'modern'`), the 401/403 wording, the `input_required` refusal and the result cap |
| `src/supabase/apiHelpers.ts` | Call-time OAuth refresh (single-flight) |
| `src/supabase/oauthCallback.ts` | Code exchange + refresh grant; `SUPABASE_AUTHORIZE_URL` / `SUPABASE_TOKEN_URL` |
| `src/supabase/connectToken.ts` | PAT validation, organization summary, instance naming |
