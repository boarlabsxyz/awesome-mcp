# Write fixtures — Google (`google-docs`, `google-drive`, `google-sheets`, `google-slides`, `google-gmail`, `google-calendar`)

All six Google services share **one** write account, **one** OAuth grant, and
**one** direct-API client (`setup/googleClient.ts` — the OAuth plumbing is
written once; each service just adds a `googleapis` namespace). What differs per
service is the scratch container.

The write account is bound to each service's `awesome-mcp-<service>-full`
connector via a separate dashboard-side OAuth flow. The harness ALSO holds a
refresh token for direct API setup/teardown; that token never touches a readonly
identity.

## Write account requirements

- Account: `mcp-e2e-write@…`
- Empty Drive at provisioning time.
- Create the scratch containers below and record their ids.

| Container | What it is | Env var | Used by |
|---|---|---|---|
| `e2e-scratch/` | Folder at the root of Drive | `E2E_SCRATCH_FOLDER_ID` | docs, drive, sheets, slides |
| Scratch calendar | A dedicated secondary calendar, **not** `primary` | `E2E_CALENDAR_SCRATCH_ID` | calendar |
| `e2e-scratch` label | A Gmail label | `E2E_GMAIL_SCRATCH_LABEL` (optional, defaults to `e2e-scratch`) | gmail |

Gmail additionally accepts `E2E_GMAIL_SCRATCH_RECIPIENT` (optional) — the address
drafts are addressed to. Unset means the write account drafts to itself, which
is what you want.

> The calendar **must** be a dedicated secondary calendar. `cleanupScratchCalendar()`
> deletes every `[e2e]`-prefixed event on whatever `E2E_CALENDAR_SCRATCH_ID`
> points at; pointing it at `primary` makes a typo destructive.

## One-time OAuth grant for direct-API setup/teardown

The harness uses `google-auth-library` directly (mirrors `src/userSession.ts:42-50`).
To get a refresh token:

1. Use the same Google Cloud OAuth client as the dev MCP server (recommended) OR
   create a new desktop client.
2. Run an OAuth flow as `mcp-e2e-write@…` requesting:
   - `https://www.googleapis.com/auth/documents`
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/spreadsheets`
   - `https://www.googleapis.com/auth/presentations`
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/calendar`
3. Capture the refresh token. Store as GHA secret `E2E_WRITE_GOOGLE_REFRESH_TOKEN`.

The last three scopes are new in this phase — an existing Phase 2 token only
carries the first two and will fail Slides/Gmail/Calendar setup with
`insufficient scopes`. Re-run the grant when adding them.

## Required GHA secrets

| Secret | Source |
|---|---|
| `E2E_WRITE_GOOGLE_REFRESH_TOKEN` | One-time OAuth grant against `mcp-e2e-write@…` |
| `E2E_GOOGLE_CLIENT_ID` | Google Cloud OAuth client ID used for the grant |
| `E2E_GOOGLE_CLIENT_SECRET` | Matching client secret |

## Required GHA repo variables

| Variable | Example | Source |
|---|---|---|
| `E2E_SCRATCH_FOLDER_ID` | `0AbCdEfGh...` | Drive folder id of `e2e-scratch/` |
| `E2E_CALENDAR_SCRATCH_ID` | `c_ab12…@group.calendar.google.com` | Calendar settings → Integrate calendar → Calendar ID |
| `E2E_GMAIL_SCRATCH_LABEL` | `e2e-scratch` | Optional; the factory creates the label if absent |
| `E2E_GMAIL_SCRATCH_RECIPIENT` | `mcp-e2e-write@…` | Optional; defaults to the authenticated account |

## What each write smoke does

| Service | Tool under test | Scratch resource | Teardown |
|---|---|---|---|
| `google-docs` | `appendToGoogleDoc` | Doc in `e2e-scratch/` | trash the doc |
| `google-drive` | `createFolder` | Parent folder in `e2e-scratch/`; the MCP creates a child inside it | trash the parent (takes the child with it) |
| `google-sheets` | `appendSpreadsheetRows` | Seeded sheet in `e2e-scratch/` | trash the sheet |
| `google-slides` | `batchUpdatePresentation` | Deck in `e2e-scratch/`; the MCP adds a slide with a caller-supplied `objectId` | trash the deck |
| `google-gmail` | `draftEmail` | A draft, not a sent message — fully reversible | delete drafts matching the marker |
| `google-calendar` | `createEvent` | Event on the scratch calendar, created by the MCP a day out | sweep `[e2e]` events off the scratch calendar |

Gmail and Calendar have no id to trash (the MCP creates the resource, and
parsing its id back out of the model's reply would couple the assertion to the
reply format), so the prefix sweep *is* the teardown. That's why the prompt asks
for a `[e2e]`-prefixed name.

## Health checks

- **`e2e-scratch/` size**: should hover near zero between runs. Above ~10 files,
  the teardown layer is broken — run `cleanupScratchFolder()` and investigate.
- **Scratch calendar**: same, via `cleanupScratchCalendar()`.
- **Drafts**: `cleanupScratchMail()` deletes every `[e2e]`-subject draft.
- **OAuth token**: refresh tokens for desktop clients can expire if unused for
  ~6 months. `googleClient.ts` logs refreshes; if the token fails entirely,
  re-run the grant and update the GHA secret.
