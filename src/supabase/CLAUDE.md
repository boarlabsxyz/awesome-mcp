# Supabase — notes for Claude

**Status: NOT yet exercised live.** Every behaviour below is read off Supabase's published server and docs. On the first live run, check these first: a 400 on every call (the protocol shape, or a `features` group the hosted platform rejects — `features` is now always sent with all ten groups), and whether `confirm_cost_id` is really required for a client that cannot show forms.

## Rules and limitations

### Proxy shape

- **Every tool proxies Supabase's hosted MCP server** (`https://mcp.supabase.com/mcp`, published as `supabase-community/supabase-mcp`) under its upstream snake_case name. Together they cover every feature group, including storage, feedback and notebooks. Two things are not mirrored: edge-function secrets, which need URL elicitation, and `delete_notebook`, which always asks for a form this proxy cannot show.
- **Register each tool with `supabaseTool({...})`, using a literal name and description** — `scripts/buildMcpToolsDoc.mjs` reads them from source text (`supabaseTool` is in its `REGISTRATION_OPENERS`). A computed name or description drops out of `docs/MCP_TOOLS.md`.
- **The target is `protocol: 'modern'`.** Supabase's handler uses the v2 SDK with `legacy: 'reject'` and answers the 2025 `initialize` handshake with **400**. So `src/util/mcpProxyClient.ts` sends one stateless `tools/call` carrying the 2026-07-28 `_meta` envelope (`io.modelcontextprotocol/{protocolVersion,clientInfo,clientCapabilities}`) plus `mcp-method`/`mcp-name` headers.
- **Fall back to the legacy `initialize` trio only when the server says it is legacy-only** — `-32022` without the modern version in `data.supported`, or "not initialized". Any other 400 is a real error and is not retried. Browserbase and Pinecone stay on the legacy path.

### Connection settings (`settings.ts`; NOT exercised live)

- **Project limit, read-only and feature groups are per connection** (`providerTokens.supabaseSettings`), set from the dashboard's Settings dialog, and re-read on every call (`getSupabaseSettings`). The re-read **fails closed**: these are restrictions the user chose.
- **Sent upstream as query parameters** on the constant origin (`hostedUrlFor`): `project_ref`, `read_only`, `features`. `features` is ALWAYS sent, because upstream leaves storage off unless it is named.
- **Also enforced locally** (`argsForSettings`), because the tool list is fixed at registration. An off group, an account tool under a project limit, or a write under read-only is refused with the setting named. `execute_sql`/`run_notebook` stay available under read-only (upstream runs them read-only).
- **A matching `project_id` is dropped** under a project limit, because upstream injects it; a different one is refused.
- **Under a project limit, `delete_branch`/`merge_branch`/`reset_branch`/`rebase_branch` are refused** — they take only a `branch_id`, which Supabase does not tie to the limited project.
- **`create_notebook` cells are loosely typed here** (`record`); Supabase validates the strict cell union and its log-dialect hint is not mirrored, so a bad cell fails upstream with Supabase's message.
- **Preserved across reconnects:** listed in `PRESERVED_ON_RECONNECT` and `PRESERVED_ON_PASTE`, which the store carries inside the UPDATE (`keepIfAbsent`), so a setting saved mid-reconnect survives. An empty setting deletes the key rather than storing `{}`.
- **Write settings and refreshed tokens with `patchMcpInstanceProviderTokens`**, never read, spread and replace: a refresh that read before a settings save would put the old settings back and lift a read-only or project limit.

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

### REST plane (`restRoutes.ts` table, `restOps.ts` handler; NOT exercised live)

- **Each route runs the MCP tool itself.** The handler finds the tool in `SUPABASE_TOOLS`, validates with its `parameters`, and calls `runSupabaseToolUncapped` — the tool body minus the cap — so `argsForSettings` sees the same name, group and annotations. Never restate a group, annotation or schema in the route table; `restOps.test.ts` checks the table against the tools and the catalog.
- **Settings are enforced exactly as on the tools, re-read per request, failing closed.** A refusal is 403 with `setting` (`readOnly` / `projectRef` / `features`); an unreadable store is 503 (`SupabaseSettingDenied` / `SupabaseSettingsUnavailable`, matched by name). Pinned with real connections by `src/__tests__/restRoutes.supabase.test.ts`.
- **JSON answers are an envelope `{ tool, truncated, untrustedData, result }`** — upstream answers text, and SQL-shaped results sit inside an `<untrusted-data-…>` boundary that does not parse. `result` is parsed JSON when the text is JSON, the text otherwise. `?format=text` is exactly the MCP output.
- **Same 200k cap as the tools** (`MAX_RESULT_CHARS`), reported as `truncated: true` + `totalChars` + `note`, with `result` the cut text.
- **`untrustedData` is true on the upstream boundary marker, and always for tools returning free text others can write** (`UNTRUSTED_RESULT_TOOLS`: notebooks, logs, function source, migrations, advisors, table comments, generated types) — upstream does not wrap those. Metadata-only tools and Supabase-authored text stay `false`.
- **Upstream outcomes by `SupabaseCallError.kind`:** `input_required` → 409 with `performed: false`, transport 403 → 403, 429 → 429, everything else → 502.
- **Every `tool_error` is 422, including a Supabase-side failure the caller did not cause** — an `isError` result carries no status to tell them apart, so this is a documented choice, not a classification.
- **An upstream 401 is a 502 with no `upstreamStatus`** (the stored credential failed, not the caller's bearer; a "401" anywhere in the body would read as theirs).
- **Exposed writes are the non-destructive ones, on owner request** (catalog notes). `create_project`/`create_branch` cost money and `pause_project` takes the database offline, reachable with the permanent dashboard API key. `confirm_cost` is a POST although it stores nothing — its answer is assent to a charge. Every `destructiveHint` tool stays MCP-only (`MCP_ONLY` in `mcpToolsRestCoverage.test.ts`).

## Source Files

| File | Contains |
|------|----------|
| `src/supabase/server.ts` | Tool definitions — each a `supabaseTool({...})` proxy registration mirroring the upstream hosted server |
| `src/supabase/schemas.ts` | Zod parameter schemas for the proxied tools |
| `src/supabase/hostedProxy.ts` | The hosted-MCP target (`protocol: 'modern'`), the 401/403 wording, the `input_required` refusal, `SupabaseCallError` and the result cap |
| `src/supabase/restRoutes.ts` | REST route table: path/query/body → tool arguments, one row per endpoint |
| `src/supabase/restOps.ts` | REST handler: tool lookup, validation, the envelope, failure → status |
| `src/supabase/apiHelpers.ts` | Call-time OAuth refresh (single-flight) |
| `src/supabase/oauthCallback.ts` | Code exchange + refresh grant; `SUPABASE_AUTHORIZE_URL` / `SUPABASE_TOKEN_URL` |
| `src/supabase/connectToken.ts` | PAT validation, organization summary, instance naming |
