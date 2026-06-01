# Write fixtures (write Google account)

Write-tool smoke tests use a **dedicated empty Google account** (`mcp-e2e-write@…`) plus a known scratch folder. Every test creates its own scratch resource via the direct Google API (see `e2e/setup/scratchFactory.ts`), runs the MCP tool against it, asserts the resulting state, and trashes the resource in teardown. A safety-net `cleanupScratchFolder()` runs after each test file to nuke anything teardown missed.

The write account is bound to the `awesome-mcp-full` MCP connector via a separate dashboard-side OAuth flow. The e2e harness ALSO holds a refresh token for direct API setup/teardown — that token's scopes are full (`documents`, `drive`, `spreadsheets`), and it never touches the readonly account.

## Write account requirements

- Account: `mcp-e2e-write@…`
- Empty Drive at provisioning time.
- Create one folder named `e2e-scratch/` at the root of Drive. Record its ID — it goes into the `E2E_SCRATCH_FOLDER_ID` GHA repo variable.

## One-time OAuth grant for direct-API setup/teardown

The harness uses `google-auth-library` directly (mirrors `src/userSession.ts:42-50`). To get a refresh token:

1. Use the same Google Cloud OAuth client as the dev MCP server (recommended) OR create a new desktop client.
2. From a local helper (or `gcloud auth application-default login --scopes=...`), run an OAuth flow as `mcp-e2e-write@…` requesting:
   - `https://www.googleapis.com/auth/documents`
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/spreadsheets`
3. Capture the refresh token. Store as GHA secret `E2E_WRITE_GOOGLE_REFRESH_TOKEN`.

## Required GHA secrets

| Secret | Source |
|---|---|
| `E2E_WRITE_GOOGLE_REFRESH_TOKEN` | One-time OAuth grant against `mcp-e2e-write@…` |
| `E2E_GOOGLE_CLIENT_ID` | Google Cloud OAuth client ID used for the grant |
| `E2E_GOOGLE_CLIENT_SECRET` | Matching client secret |
| `E2E_SLACK_WEBHOOK_URL` | Incoming webhook for nightly regression failure notifications |

## Required GHA repo variables

| Variable | Example | Source |
|---|---|---|
| `E2E_SCRATCH_FOLDER_ID` | `0AbCdEfGh...` | Drive folder ID of `e2e-scratch/` in the write account |

## Scratch resource naming convention

Every resource created by `scratchFactory.ts` is named `[e2e] <label> <ISO timestamp>` (e.g. `[e2e] append smoke 2026-06-01T03:14:15.000Z`). Stray resources are recognizable in the Drive UI by the `[e2e]` prefix. The cleanup helper trashes everything inside `e2e-scratch/` regardless of name, so manual cleanup is rarely needed.

## Health checks

- **Scratch folder size**: should hover near zero between runs. If it ever exceeds ~10 files, the teardown layer is broken. Manually `cleanupScratchFolder()` and investigate the most recent failed run.
- **OAuth token**: Google refresh tokens issued for desktop clients can expire if unused for ~6 months. The harness's `googleClient.ts` logs token refreshes; if the token fails entirely, re-run the one-time grant and update the GHA secret.
