# Read fixtures (readonly identities)

Read-tool smoke tests assert against deterministic content held by a **dedicated
readonly identity per service**. Each identity is pre-populated once and **never
modified**. Assertions match exact substrings, so any drift in fixture content
surfaces as a test failure.

Each readonly identity is bound to that service's `awesome-mcp-<service>-readonly`
connector via its own dashboard-side Connect. See `e2e/runbook.md` § Two-connector
model for the registration procedure, and for the per-service connector names.

## Ground rules (all services)

- Fixtures are owned by the readonly identity; do not share externally.
- **Never edit a fixture after creation.** The needle is the assertion.
- Every service's write tools must be **manually unchecked** on its
  `-readonly` connector. The canonical per-service list is
  `e2e/tools/<service>.ts` `WRITE_TOOLS` — read it from code, not from here.
- Needles use the `BANANA-<WORD>-<N>` shape so they never collide with real
  content and are greppable across forensics bundles.

## Fixture + env var per service

Every read smoke takes exactly two required env vars: a **locator** (which
resource to read) and a **needle** (the string that must come back). Both are
GHA **repository variables**, not secrets.

| Service | Test file | Locator var | Needle var | Fixture to provision |
|---|---|---|---|---|
| `google-docs` | `tests/read/readGoogleDoc.smoke.ts` | `E2E_FIXTURE_DOC_ID` | `E2E_FIXTURE_DOC_NEEDLE` | Doc `E2E Smoke Fixture Doc`, plain-text body containing `BANANA-PHONE-7714` on its own line |
| `google-drive` | `tests/read/listFolderContents.smoke.ts` | `E2E_FIXTURE_DRIVE_FOLDER_ID` | `E2E_FIXTURE_DRIVE_NEEDLE` | Folder `E2E Read Fixtures` holding a file literally named `BANANA-DRIVE-FILE` |
| `google-gmail` | `tests/read/searchEmails.smoke.ts` | `E2E_FIXTURE_GMAIL_QUERY` | `E2E_FIXTURE_GMAIL_NEEDLE` | One message with subject `E2E Read Fixture BANANA-MAIL-3301`. Locator is a Gmail query, e.g. `subject:"BANANA-MAIL-3301"` |
| `google-calendar` | `tests/read/listEvents.smoke.ts` | `E2E_FIXTURE_CALENDAR_ID` | `E2E_FIXTURE_CALENDAR_NEEDLE` | A dedicated calendar holding one **yearly recurring** all-day event titled `E2E Fixture BANANA-CAL-5150` |
| `google-sheets` | `tests/read/readSpreadsheet.smoke.ts` | `E2E_FIXTURE_SHEET_ID` | `E2E_FIXTURE_SHEET_NEEDLE` | Sheet with `BANANA-CELL-8842` in a cell inside `A1:C10` |
| `google-slides` | `tests/read/getPresentation.smoke.ts` | `E2E_FIXTURE_SLIDES_ID` | `E2E_FIXTURE_SLIDES_NEEDLE` | Deck whose first slide's title text is `BANANA-SLIDE-2205` |
| `clickup` | `tests/read/listTasks.smoke.ts` | `E2E_FIXTURE_CLICKUP_LIST_ID` | `E2E_FIXTURE_CLICKUP_NEEDLE` | A **read-only** list (not the scratch list) holding a task named `E2E Fixture BANANA-TASK-6677` |
| `slack` | `tests/read/readChannelHistory.slack.smoke.ts` | `E2E_FIXTURE_SLACK_CHANNEL_ID` | `E2E_FIXTURE_SLACK_NEEDLE` | A channel the **bot** is `/invite`d to, with a pinned message containing `BANANA-SLACK-9110` |
| `slack-user` | `tests/read/readChannelHistory.slack-user.smoke.ts` | `E2E_FIXTURE_SLACK_USER_CHANNEL_ID` | `E2E_FIXTURE_SLACK_USER_NEEDLE` | A channel the **user token** can read and that the access rules allow, with a message containing `BANANA-SLACKU-4404` |

### Optional overrides

Unset is fine — the test falls back to the default. (Actions passes `''` for an
unconfigured variable, so the tests use `||`, not `??`.)

| Variable | Default | Used by |
|---|---|---|
| `E2E_FIXTURE_SHEET_RANGE` | `A1:C10` | `readSpreadsheet.smoke.ts` |
| `E2E_FIXTURE_CALENDAR_TIME_MIN` | `2020-01-01T00:00:00Z` | `listEvents.smoke.ts` |
| `E2E_FIXTURE_CALENDAR_TIME_MAX` | `2040-01-01T00:00:00Z` | `listEvents.smoke.ts` |

The calendar window is deliberately wide and fixed: the fixture event recurs
yearly, so any window this size contains an instance no matter when the suite runs.

## Slack: two servers, two fixtures

`src/slack/` (bot token, catalog slug `slack-bot`) and `src/slack-user/` (user
OAuth, catalog slug `slack`) expose the same tool names against different
identities. They get separate connectors, separate fixture channels, and
separate needles — a shared channel would let one server's test pass on the
other's access. See `e2e/runbook.md` for the slug/directory mapping.

## Additional read fixtures (for the per-tool regression suite)

Provision once so adding more read smokes later doesn't block on fixture
creation. These are Google Docs specific; extend per service as regression
coverage grows.

| Purpose | Title | Notes |
|---|---|---|
| `searchGoogleDocs` target | `E2E Search Target — Frog` | Body contains the rare phrase `BANANA-FROG-MEADOW`. Ensures search returns exactly one match. |
| `getRecentGoogleDocs` baseline | 3 docs named `E2E Recent A/B/C` | Edit each one at least once after creation so they show up in recent. |
| `listDocumentTabs` target | `E2E Multi-Tab Doc` | Manually add 3 tabs named `Alpha`, `Beta`, `Gamma`. |
| `listComments`/`getComment` target | `E2E Comment Anchor` | Add 2 comments with bodies `BANANA-COMMENT-1` and `BANANA-COMMENT-2`. |
| `inspectDocStructure` target | `E2E Structured Doc` | Heading 1 `BANANA-H1`, paragraph, table, page break, second heading `BANANA-H2`. |

## Required client-side accounts

The Claude and ChatGPT accounts on the Mac Studio (e.g. `mcp-e2e@boarlabs.xyz`) must:

1. Be on a plan tier that supports MCP/Connectors.
2. Have **both** connectors registered for every service under test — 18 in
   total, named per the table in `runbook.md`, each with its own
   dashboard-generated URL (different `instanceId` query params).
3. Have "Always allow" set on every connector.
4. Have each `-readonly` connector's write tools manually unchecked.

## Rotation triggers

Rotate fixture content and update this doc whenever:

- A read smoke starts failing with an assertion shift (the readonly identity's
  content was modified). Investigate: was a write tool left enabled on that
  service's readonly connector?
- A needle starts appearing in unrelated test responses (it isn't unique enough).
- A new read tool is added to `src/<service>/server.ts` that needs its own fixture.
