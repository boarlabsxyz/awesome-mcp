# E2E Fixtures

Smoke tests need stable, read-only fixtures owned by a dedicated Google account so assertions can be deterministic. The dev MCP server must be OAuth-connected to this Google account.

## Required Google account

- Account: `mcp-e2e-google@…` (or a dedicated workspace user)
- Must have a long-lived OAuth refresh token registered on the **dev** Railway service (`GOOGLE_TOKEN` env var or `token.json`).
- Re-authorization procedure: see `runbook.md`.

## Required fixture documents

Create the following before enabling the e2e workflow. Once created, do **not** edit them — assertions match exact substrings.

### Doc: smoke fixture

| Field | Value |
|---|---|
| Title | `E2E Smoke Fixture Doc` |
| Doc ID | _record here after creation_ |
| Sharing | Owned by the e2e Google account; not shared further |
| Content | A short plain-text body containing the marker token `BANANA-PHONE-7714` on its own line. No formatting. |

The marker is intentionally unique and unlikely to appear by chance — assertions look for it verbatim.

### Spreadsheet: smoke fixture (reserved for future tests)

| Field | Value |
|---|---|
| Title | `E2E Smoke Fixture Sheet` |
| Sheet ID | _record here after creation_ |
| Tab 1 | `Smoke` — single cell A1 with value `BANANA-SHEET-7714` |

## Required GHA repository variables

Set under **Settings → Secrets and variables → Actions → Variables**:

| Variable | Example value |
|---|---|
| `E2E_FIXTURE_DOC_TITLE` | `E2E Smoke Fixture Doc` |
| `E2E_FIXTURE_DOC_NEEDLE` | `BANANA-PHONE-7714` |

These are referenced by `.github/workflows/e2e-smoke.yml`.

## Required client-side accounts

The Claude and ChatGPT accounts on the Mac Studio (e.g. `mcp-e2e@boarlabs.xyz`) must:

1. Be on a plan tier that supports MCP/Connectors (verify current requirement at smoke-test setup time).
2. Have the **dev Railway MCP URL** registered as a connector.
3. Have "Always allow" set for the connector in account settings (or the harness's first-call permission prompt handler must be confirmed working).

Do **not** add the prod or staging MCP URL to this account — the routing model assumes one-environment-per-account.

## Rotation triggers

Rotate fixture content and update this doc whenever:

- The MCP server's tool surface for `readGoogleDoc` changes its output shape.
- A smoke test starts succeeding by accident on stale content (the needle is too generic).
- The fixture marker appears anywhere outside the fixture (search the repo before changing the needle).
