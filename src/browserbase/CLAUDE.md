# Browserbase — notes for Claude

## Rules and limitations

- **Proxy to the hosted MCP at `https://mcp.browserbase.com/mcp`** — the 6 browser tools are forwarded, so no model key is needed. Auth is `Authorization: Bearer` (`x-bb-api-key` also works; the `browserbaseApiKey` query param is deprecated — keep keys out of URLs).
- **Fresh transport per call; never cache `Mcp-Session-Id`** — the caller threads `sessionId` through every call (Browserbase's documented pattern; a stale id errors). A cached id breaks across replicas. `No active session` is rewritten to point at `start`.
- **Hosted-only: no CLI flags** — `--contextId`, `--persist`, `--proxies`, `--verified`, `--browserWidth/Height`, `--experimental` do not exist hosted; do not add parameters for them.
- **Sessions bill until released or timed out** — `listBrowserSessions`/`getBrowserSession`/`forceEndBrowserSession` (REST) find orphans; `end` falls back to REST `REQUEST_RELEASE` rather than report a close that did not happen. Backstop is the project's `defaultTimeout` (ops).
- **No `timeoutSeconds` parameter** — UNVERIFIED whether hosted `start({sessionId})` adopts a session created via `POST /v1/sessions`; a parameter that silently does nothing is worse than none.
- **Domain rules bind `navigate` only — a guardrail, not a security boundary** (`providerTokens.accessRules`, dashboard → Domain Rules). `act` can click anywhere and `start` can reattach off-list; the `act` description says so.
- **Absent rules = unrestricted, never written back as empty defaults** — `{}` would survive reconnect merges and reset rules (`PRESERVED_ON_RECONNECT`). `persistPasteConnectionFor` must preserve `accessRules` like the OAuth path.
- **Matching is label-boundary hostname suffix, never glob** — `example.com` covers `app.example.com`, not `notexample.com`.
- **Env:** owns only `BROWSERBASE_MCP_URL` and `BROWSERBASE_ENABLED`. `BROWSERBASE_API_KEY`/`BROWSERBASE_PROJECT_ID` belong to the unrelated e2e transport (`.github/workflows/e2e-smoke.yml`); the key here is per-connection.
- **Hidden behind `BROWSERBASE_ENABLED`** — seeded with `isActive: false`, strict `=== 'true'` (verified), restart not deploy. While hidden, existing connections keep working (`mcp:browserbase` stays in `scopeMap.ts`) but the dashboard row degrades: raw slug, fallback icon, `getMcpUrl` returns `''`.
- **No `act` on REST** — it submits forms on third-party sites, the plane accepts the permanent dashboard API key, and curl has no confirmation.

### Response safety (`responseSafety.ts`) — verified live
- **Never forward upstream output verbatim.** `navigate` returns a ~15 KB CDP object with the connect websocket URL, `signingKey` JWTs and internal `*.svc.cluster.local` hosts, so it is **allowlisted** to `url` (echoed from the request), `status`, `title` — not redacted. Redaction is the backstop for `extract`/`observe`.
- **Error text capped at 1 KB; degenerate character runs collapsed before truncating** — `extract` can echo ~214 KB of newlines in `AI_NoObjectGeneratedError`. There is no hosted knob to cap upstream model output.
- **Sanitise at both the proxy and op layer** — one choke point is easy to bypass.
- **Unwrap `{"success":true,"data":…}`** for consistent rendering.

## Source Files

| File | Contains |
|------|----------|
| `src/browserbase/server.ts` | 9 tools: 6 hosted browser tools (via `responseSafety`) + 3 REST session-cost tools |
| `src/browserbase/mcpProxyClient.ts` | Per-call Streamable-HTTP client, SSE reader, `No active session` rewrite |
| `src/browserbase/apiHelpers.ts` | `BrowserbaseClient` (`x-bb-api-key`, REST sessions/projects/usage); sets `.status` for `sendUpstreamError` |
| `src/browserbase/responseSafety.ts` | `navigate` allowlist, redaction, run collapse, size caps; shared by both surfaces |
| `src/browserbase/accessRules.ts` | `assertDomainAllowed`, `BrowserbaseAccessDenied`, `validateDomainPattern` |
| `src/browserbase/ops.ts` / `restOps.ts` | `op*` per tool (strings) and `perform*` per route (data); shared field objects in `schemas.ts` |
