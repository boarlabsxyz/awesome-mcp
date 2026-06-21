# Read fixtures (readonly Google account)

Read-tool smoke tests assert against deterministic content in a **dedicated readonly Google account** (`mcp-e2e-readonly@…`). The account is pre-populated once and **never modified**. Assertions match exact substrings, so any drift in fixture content surfaces as a test failure.

The readonly account is bound to the `awesome-mcp-readonly` MCP connector via the dashboard-side OAuth flow (separate connection from the write account). See `e2e/runbook.md` for the connection setup procedure.

## Readonly account requirements

- Account: `mcp-e2e-readonly@…` (or a dedicated workspace user)
- Fixtures are owned by this account; do not share externally.
- All write tools must be **manually unchecked** on the `awesome-mcp-readonly` connector in Claude Desktop (and in ChatGPT if the UI supports per-tool toggles). See `e2e/tools.ts` `WRITE_TOOLS` for the list.

## Required fixture documents

Create these once, record their IDs. **Do not edit after creation.**

### Doc: smoke fixture

| Field | Value |
|---|---|
| Title | `E2E Smoke Fixture Doc` (human-readable only — the test uses the doc ID) |
| Doc ID | _record after creation — from `docs.google.com/document/d/<ID>/edit`_ |
| Content | Plain text body containing `BANANA-PHONE-7714` on its own line. No formatting. |

### Additional read fixtures (for Phase 3 regression suite — create them now)

Provision once so adding more read smokes later doesn't block on fixture creation.

| Purpose | Title | Notes |
|---|---|---|
| `searchGoogleDocs` target | `E2E Search Target — Frog` | Body contains the rare phrase `BANANA-FROG-MEADOW`. Ensures search returns exactly one match. |
| `getRecentGoogleDocs` baseline | 3 docs named `E2E Recent A/B/C` | Edit each one at least once after creation so they show up in recent. |
| `listDocumentTabs` target | `E2E Multi-Tab Doc` | Manually add 3 tabs named `Alpha`, `Beta`, `Gamma`. |
| `listComments`/`getComment` target | `E2E Comment Anchor` | Add 2 comments with bodies `BANANA-COMMENT-1` and `BANANA-COMMENT-2`. |
| `inspectDocStructure` target | `E2E Structured Doc` | Heading 1 `BANANA-H1`, paragraph, table, page break, second heading `BANANA-H2`. |

Phase 3 smokes will reference these by ID via additional `E2E_FIXTURE_*_ID` env vars.

## Required GHA repository variables (Phase 2)

Set under **Settings → Secrets and variables → Actions → Variables**:

| Variable | Example | Used by |
|---|---|---|
| `E2E_FIXTURE_DOC_ID` | `1AbCdEfGh...` | `readGoogleDoc.smoke.ts` prompt |
| `E2E_FIXTURE_DOC_NEEDLE` | `BANANA-PHONE-7714` | `readGoogleDoc.smoke.ts` assertion |

## Required client-side accounts

The Claude and ChatGPT accounts on the Mac Studio (e.g. `mcp-e2e@boarlabs.xyz`) must:

1. Be on a plan tier that supports MCP/Connectors.
2. Have **two** connectors registered: `awesome-mcp-readonly` and `awesome-mcp-full`, each with its own dashboard-generated URL (different `instanceId` query params). See `runbook.md`.
3. Have "Always allow" set on both connectors.
4. Have `awesome-mcp-readonly`'s write tools manually unchecked. See `tools.ts` `WRITE_TOOLS` for the canonical list.

## Rotation triggers

Rotate fixture content and update this doc whenever:

- The first read smoke test starts failing with an assertion shift (the readonly account's content was modified). Investigate: was a write tool left enabled on the readonly connector?
- A read fixture's needle starts appearing in unrelated test responses (needle isn't unique enough).
- A new read tool is added to `src/google-docs/server.ts` that needs its own fixture.
