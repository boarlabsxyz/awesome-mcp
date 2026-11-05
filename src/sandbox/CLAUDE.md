# Sandbox MCP — notes for Claude

A place for Claude to run code when the client has no shell: Python, JavaScript or bash in a hosted E2B sandbox, on this platform's `E2B_API_KEY` with per-user quotas. A script reaches the user's connected services over the REST plane and returns only what it prints, which is the pattern that already works for shell clients (a 50 MB spreadsheet processed without crossing Claude's context). UNVERIFIED live: no run has gone through a real E2B account or a deployed client yet. Check the egress allowlist first (see below), then that per-run `envs` reach the Python and JavaScript kernels.

## Rules and limitations

- **One sandbox per user, answered from the caller.** `resolveSession` treats `sandbox` like `storage` (`PER_USER_MCPS` in `src/mcpAuthenticate.ts`): no connection or credential is consulted, the instance id is kept only when it is the caller's own Sandbox connector, and a sandbox instance id replayed against another server answers 400. One connector per user is enforced by the partial unique index `idx_mcp_connections_one_sandbox`.
- **The user → sandbox mapping, the run lock and the quotas live in Redis** (`state.ts`), so every replica sees the same sandbox and spend. The vendor's own timeout (`SANDBOX_IDLE_MINUTES`, default 10, extended on every call) is what kills an idle sandbox, so nothing leaks if our process dies. A mapping whose sandbox is gone means a new one is created, and the response says `sandbox: "replaced"` with a note that files and variables are gone. That is never silent.
- **Every call that touches the sandbox takes the per-user lock; a second call is refused, not queued.** A queue would strand the caller's socket behind a 5-minute run. The lock also serializes creation, so two overlapping calls cannot start two sandboxes. Its TTL (run timeout + 60 s) frees a lock whose holder died.
- **The REST bearer is minted per run and revoked when the run ends, success or failure.** It is passed as `AWESOME_API_TOKEN` / `AWESOME_API_BASE` in the run's `envs`, never at sandbox creation, so an idle sandbox holds no working credential (a script that saved the token in a variable holds a dead one). The bearer reaches every `/api/v1/*` service the user has connected, since it is not service-scoped. That is the point, and the `runCode` description says so.
- **The run timeout is capped at 300 s** (`SANDBOX_MAX_TIMEOUT_SEC`, never above 300) because the bearer's TTL is the fixed 5 minutes of `REST_TOKEN_TTL_SECONDS`. Raising it means giving `mintRestToken` a TTL parameter first. The SDK's `requestTimeoutMs` is set to the run timeout plus a margin, or a long run would fail at its 30 s request default.
- **Egress is an allowlist:** the host of `BASE_URL`, `pypi.org`, `files.pythonhosted.org` and `registry.npmjs.org`, with everything else denied. UNVERIFIED: third-party pages say E2B's lower usage tiers restrict internet access, so confirm on the real account that the allowlist (and `pip install`) works.
- **Quotas fail closed.** `SANDBOX_MAX_RUNS_PER_DAY` (200) and `SANDBOX_MAX_SECONDS_PER_DAY` (3600) are counted per UTC day. With Redis unreachable, a run is refused with a reason: the opposite of `loginRateLimit.ts`, because an open counter spends our money. Runs are charged before the run, and seconds after it with the time actually used. Only taking the lock and charging fail closed: a vendor error inside the run passes through as itself.
- **Output is capped and says so:** 20,000 characters per stream (`truncated` gives the totals), up to 3 images of at most 1.5 MB, and tracebacks at 5,000 characters. A timeout returns what was printed up to that point, with `timedOut`.
- **`listFiles`/`readFile` never create a sandbox** (they answer "No sandbox is running"). `writeFile` and `runCode` do.
- **Argument names (`code`, `path`, `content`, `language`) stay out of `PREVIEW_KEYS`**, so code and data never reach `tool_call_events`.
- **No REST siblings, on purpose:** running code from curl gains nothing over a local shell. The server registers `listRestEndpoints` (scripts are written against those routes) but not `mintRestBearerForCurl`, because each run carries its own bearer.
- **Node 20 pin.** `@e2b/code-interpreter` is pinned to 2.8.3 and `e2b` to 2.55.0 (a `package.json` override): later versions require Node ≥ 22.19, and the image runs Node 20. Lift both when the Dockerfile moves to Node 22.
- **Deferred:** a JavaScript helper (the Python one is `/home/user/awesome.py`, written at creation), a global cap on concurrent sandboxes, and script backfills for Storage migrations.

## Deployment

A Railway service like the other connectors: `TRANSPORT=httpStream`, `MCP_MODE=mcp`, `MCP_SLUG=sandbox`, `DATABASE_URL`, `REDIS_URL` (the same Redis as the web service, which is where minted bearers are checked), `BASE_URL`, `E2B_API_KEY`, and optionally the `SANDBOX_*` limits. Set `SANDBOX_MCP_URL` on the web service. Without `E2B_API_KEY` or a database, `/connect/sandbox` answers 503 and every tool says which is missing.

## Source Files

| File | Contains |
|------|----------|
| `src/sandbox/server.ts` | Tool registrations; images go back as MCP image content |
| `src/sandbox/ops.ts` | Tool bodies: acquiring the sandbox, the per-run bearer, output caps |
| `src/sandbox/provider.ts` | `SandboxProvider` and the E2B implementation (the only file importing the SDK) |
| `src/sandbox/state.ts` | Redis: user → sandbox id, the run lock, daily quotas, `sandboxLimits()` |
| `src/sandbox/helper.ts` | `awesome.py`, the `api()` helper written into each new sandbox |
| `src/sandbox/schemas.ts` | Tool parameter schemas |
| `src/sandbox/connect.ts` | One-click connect (`src/util/firstPartyConnect.ts`, shared with Storage) |
