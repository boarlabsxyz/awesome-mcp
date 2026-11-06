# E2E Accounts

Three accounts, because one cannot answer the three questions worth asking about
a tool. Every error message in the harness that mentions a missing env var points
here.

**Setting this up for the first time? Follow [SETUP.md](SETUP.md)** -- an ordered
procedure from nothing to a green CI run. This file is the reference behind it:
what each variable means, and why the model is shaped this way.

| Account | Contents | Written to? | Answers |
|---|---|---|---|
| `fixture` | a few frozen docs with unique marker tokens | never | "does this tool still return the bytes it used to" |
| `rich` | a realistic amount of real data | **never** (policy, enforced in code) | "does it page, cap, truncate, and say so" |
| `sandbox` | nothing durable | constantly | writes, deletes, and every empty-state answer |

All three are **dashboard users on the dev deployment**, not separate servers. A
check authenticates with the account's permanent dashboard API key, which
`/mcp` accepts directly (`mcpOnlyMiddleware` falls back to `getUserByApiKey`
when the Auth0 JWT check fails). That is what lets these checks run with no
browser, no OAuth dance, and no Mac Studio.

**Service URLs are discovered, not configured.** Each MCP is deployed as its own
Railway service on its own host (`google-docs-mcp-development.up.railway.app/mcp`,
`google-drive-mcp-development.up.railway.app/mcp`, ...), so `accounts.ts` reads
`GET <E2E_BASE_URL>/api/v1/catalogs` -- the same unauthenticated list the
dashboard renders -- and looks the slug up there. A service moving hosts needs no
env change. Note the other layout also exists in the code: in single-service
"all" mode, `addMcpProxy` mounts every MCP as a path prefix on one host. Nothing
may hard-code either; the catalog decides.

`accounts.ts` refuses to hand a check declaring `writes: true` anything but
sandbox credentials. This is not defence in depth, it is the only defence: a
write that reached the rich account would corrupt it silently, and the damage
surfaces weeks later as another check's "Found 341 documents" quietly becoming
342.

## Environment

Shared:

| Variable | Notes |
|---|---|
| `E2E_BASE_URL` | dev deployment origin, e.g. `https://dev.awesome-mcp.xyz`. Per-account overrides below win. |

Per account (`FIXTURE`, `RICH`, `SANDBOX`):

| Variable | Required | Notes |
|---|---|---|
| `E2E_<ACCOUNT>_API_KEY` | yes | Dashboard → API key. Rotating it invalidates the checks, not the other way round. |
| `E2E_<ACCOUNT>_BASE_URL` | no | Only if that account lives on a different deployment. |

Fixture content:

| Variable | Used by |
|---|---|
| `E2E_FIXTURE_DOC_ID` | `needle/readGoogleDoc`, and the existing live-client smoke |
| `E2E_FIXTURE_DOC_NEEDLE` | same — the marker token, e.g. `BANANA-PHONE-7714` |
| `E2E_FIXTURE_DOC_TITLE` | `needle/listGoogleDocs` |

Rich content:

| Variable | Default | Used by |
|---|---|---|
| `E2E_RICH_DOC_ID` | — | a document of at least ~20k characters |
| `E2E_RICH_DOC_MIN_CHARS` | `20000` | floor for the full-read check |
| `E2E_RICH_MIN_DOCS` | `50` | floor for the list check; below this the volume tier proves nothing |

Sandbox:

| Variable | Default | Notes |
|---|---|---|
| `E2E_SANDBOX_FOLDER_ID` | Drive root | Optional. A folder keeps scratch docs out of the root and makes manual cleanup one click. |

## Services beyond Docs

Google Docs and Drive are the baseline every account connects (SETUP.md). The
other services are seeded one tenant at a time, so their checks **skip** — with
a reason naming what to set — until two things hold (`serviceEnv` in `env.ts`):

1. the catalog slug is listed in `E2E_SERVICES` (comma-separated, or `all`),
   e.g. `E2E_SERVICES=google-sheets,slack`. Matching is exact: `slack-bot` does
   not enable `slack`.
2. every fixture variable the check reads is set.

The listing is a separate switch on purpose: a zero check with an impossible
query reads no fixture variable, and without it would run, and fail, against an
account that never connected the service. Once a service is listed, its zero
checks need only the sandbox account to be connected to it.

The tools covered are the most-used ones per service from the Admin MCP's
`listToolUsage` (30 days, November 2026); `tools.ts` lists them. Each
read has a `needle` (fixture) and a `zero` (sandbox) check; each write a `zero`.

Fixture values. Every NEEDLE is a frozen marker string that appears nowhere else
in that tenant — the same rule as `E2E_FIXTURE_DOC_NEEDLE`.

| Variable | Must point at / contain |
|---|---|
| **google-drive** | |
| `E2E_FIXTURE_DRIVE_FOLDER_ID` | the folder directly containing the fixture doc; fewer than 100 items |
| **google-slides** | |
| `E2E_FIXTURE_SLIDES_ID` | a deck with at least one slide |
| `E2E_FIXTURE_SLIDES_NEEDLE` | in a text box on a slide, not in the deck title |
| **google-sheets** | |
| `E2E_FIXTURE_SHEET_ID` | the fixture spreadsheet |
| `E2E_FIXTURE_SHEET_TITLE` | its exact title |
| `E2E_FIXTURE_SHEET_TAB` | a tab whose name contains a space and no apostrophe, e.g. `Smoke Data` — the needle read quotes it |
| `E2E_FIXTURE_SHEET_NEEDLE` | the plain-text value of A1 on that tab (not a number or date: it is read back formatted) |
| **google-gmail** | |
| `E2E_FIXTURE_GMAIL_MESSAGE_ID` | one frozen email (16 hex) |
| `E2E_FIXTURE_GMAIL_NEEDLE` | in that email's subject **and** text body, matching exactly one message for `subject:"<needle>"` (a reply counts as a second); no `"`. The mailbox needs at least 2 messages in total |
| **google-calendar** | |
| `E2E_FIXTURE_CAL_EVENT_ID` | a timed (not all-day), non-recurring event |
| `E2E_FIXTURE_CAL_NEEDLE` | in that event's summary |
| `E2E_FIXTURE_CAL_EVENT_START` | the event's start, ISO 8601 with any offset |
| `E2E_FIXTURE_CAL_ID` | optional, default `primary` — the calendar holding it |
| `E2E_SANDBOX_CAL_ID` | optional, default `primary` — where createEvent writes |
| **slack** (user token) | |
| `E2E_FIXTURE_SLACK_CHANNEL_ID` | a frozen channel the fixture account's access rules allow — a denied channel fails reads and hides search matches |
| `E2E_FIXTURE_SLACK_THREAD_TS` | a top-level message there with at least one reply |
| `E2E_FIXTURE_SLACK_NEEDLE` | single line, in that message **and** a reply, findable by `search.messages` |
| `E2E_SANDBOX_SLACK_CHANNEL_ID` | any channel the sandbox account's rules allow |
| **slack-bot** | |
| `E2E_FIXTURE_SLACKBOT_CHANNEL_ID` | a **public** channel the bot was invited to |
| `E2E_FIXTURE_SLACKBOT_MESSAGE_TS` | a message there containing the bot needle |
| `E2E_FIXTURE_SLACKBOT_NEEDLE` | single line, in that message |
| `E2E_FIXTURE_SLACKBOT_USER_ID` | an active non-bot member on the first `users.list` page (200) |
| `E2E_SANDBOX_SLACKBOT_CHANNEL_ID` | a public channel the sandbox bot is in |
| **clickup** | |
| `E2E_FIXTURE_CLICKUP_TASK_ID` | a frozen task |
| `E2E_FIXTURE_CLICKUP_NEEDLE` | in that task's name |
| `E2E_FIXTURE_CLICKUP_LIST_ID` | the task's **home** list (not via Tasks in Multiple Lists), under 100 tasks |
| `E2E_FIXTURE_CLICKUP_WORKSPACE_ID` | the workspace holding that list |
| `E2E_SANDBOX_CLICKUP_WORKSPACE_ID` | the sandbox workspace |
| `E2E_SANDBOX_CLICKUP_EMPTY_LIST_ID` | a list that stays **permanently empty**, open and closed — no write check may use it |
| **redmine** | must be a public https instance: `checkBaseUrl` refuses loopback, private IPs and http at connect |
| `E2E_FIXTURE_REDMINE_PROJECT_ID` | numeric id or identifier; time tracking enabled, fixture account has `view_time_entries` |
| `E2E_FIXTURE_REDMINE_NEEDLE` | in the project's name or description **and** in one time entry's comment |
| `E2E_FIXTURE_REDMINE_TIME_ENTRY_ID` | that time entry |
| `E2E_FIXTURE_REDMINE_TIME_ENTRY_DATE` | its `spent_on`, `YYYY-MM-DD` |
| **peopleforce** | a designated test employee, never a real person |
| `E2E_FIXTURE_PF_EMPLOYEE_ID` | active, on page 1 of listEmployees (a tenant of ≤50 active employees) |
| `E2E_FIXTURE_PF_EMPLOYEE_NEEDLE` | that employee's work email, exactly as stored |
| `E2E_FIXTURE_PF_LEAVE_REQUEST_ID` | an **approved** leave request of that employee, on page 1 of state=approved |
| `E2E_FIXTURE_PF_LEAVE_NEEDLE` | that request's comment, exactly; not `-` (the formatter hides it) |
| **outline** | |
| `E2E_FIXTURE_OUTLINE_DOC_ID` | the published doc's UUID, not its URL slug |
| `E2E_FIXTURE_OUTLINE_NEEDLE` | a **single token** in its body — Outline bolds each matched word, splitting a multi-word needle |
| **hubspot** | |
| `E2E_FIXTURE_HUBSPOT_COMPANY_ID` | the fixture company |
| `E2E_FIXTURE_HUBSPOT_COMPANY_NEEDLE` | one alphanumeric token in its name |
| `E2E_FIXTURE_HUBSPOT_COMPANY_DEAL_COUNT` | its exact deal count, 2–100 |
| `E2E_FIXTURE_HUBSPOT_DEAL_ID` | one of those deals |
| `E2E_FIXTURE_HUBSPOT_DEAL_NEEDLE` | a token in that deal's name |
| `E2E_SANDBOX_HUBSPOT_EMPTY_COMPANY_ID` | a real company with no deals |

**Not swept:** `sweepScratch` lists Google Docs only, so scratch spreadsheets
(`setup/sheetsScratch.ts`), folders (`setup/driveScratch.ts`) and calendar events
(`setup/calendarScratch.ts`) leaked by a run killed before teardown stay in the
sandbox. They are self-dating, so extending the sweeper is mechanical.

## Why "empty account" is not the sandbox's contract

It cannot be maintained. The first write makes it non-empty, and one failed
teardown leaks forever. What holds instead:

- every scratch resource is titled `e2e-<epochMs>-<run>-<tool>`, so it is
  self-dating and traceable to the run that made it;
- each check trashes its own resource in `teardown`, which runs even when the
  assertion failed;
- `npm run sweep:sandbox` trashes anything older than 24h, for runs killed
  before teardown (CI timeout, cancelled job). **Schedule this.** Without it the
  zero-state checks — the ones asserting the account has nothing matching a query
  — eventually fail for reasons unrelated to the code under test, and the failure
  looks like a regression in the tool.

Delete tools need the opposite of an empty account: something to delete. They
seed first, then delete, then assert it is gone.

## Running

```bash
cd e2e
npm install

# No accounts needed — the invariant engine and the sweeper's date logic.
npm run test:unit

# Per shape. Each needs that shape's account credentials.
npm run check:needle
npm run check:volume
npm run check:zero

# Everything
npm run check

# Cleanup (schedule this)
npm run sweep:sandbox
SWEEP_DRY_RUN=1 npm run sweep:sandbox
```

Artifacts land in `.artifacts/<sha|local>/direct-<account>/<service>.<tool>.<shape>/` —
`summary.json` plus `response.txt`, the same two files `runbook.md`'s triage
starts from. There is no screenshot or accessibility snapshot: there is no
browser in this path.

## Relationship to the live-client smokes

`npm test` is unchanged and still runs the live-client smokes through Appium or
Browserbase. These checks do **not** replace it — they cannot tell you whether a
real client can reach a tool, only what the tool returns.

Division of labour:

- **tasks, live client** (`tests/tasks/*.task.ts`): a handful of prompts per
  service, phrased the way a person asks — no tool named, no parameters given.
  These are not per-tool coverage and should never grow that way. They exist for
  two things nothing else can see: the argument combinations a *model* picks,
  and whether a tool failure surfaces as a model politely explaining itself.
  Both were live for months in `listGoogleDocs`, whose every search 403'd while
  the assistant said "I don't have permission to search your Drive".
- **needle / volume / zero, direct** (`tests/tools/*/*.check.ts`): the per-tool
  sweep. 227 tools at ~2 min of live conversation each is ~17 hours per client;
  the same coverage here runs in minutes on `ubuntu-latest`, and consumes no
  Browserbase minutes.

The dividing line: a direct check asserts the arguments someone thought to write
down, exactly. A task test asserts an outcome and lets the model choose the
route. The sorting bug lived in the gap — the failing combination was the
*default* one, which is why no hand-written check had it until the task tier
went looking.

## Where each value comes from

### `E2E_BASE_URL`

`https://website-development1.up.railway.app` — the repo Actions variable
`DEV_APP_URL`. Never point these at prod: the sandbox checks create and trash
documents, and the seeder writes to the fixture and rich accounts.

### `E2E_<ACCOUNT>_API_KEY`

The three accounts are **three Google accounts**, because the docs tools act on
whichever Google Drive the dashboard user has connected. For each one:

1. Sign in to the dev dashboard with that Google account.
2. Connect the **Google Docs** and **Google Drive** MCPs (the drive connection is
   what `createDocument` / `deleteFile` / the sweeper go through).
3. Press **Copy URL** on a connector row. The URL carries the key:
   `…/mcp/<instanceId>?apiKey=<key>.<instanceId>`.

Take the `apiKey` query value; `E2E_<ACCOUNT>_API_KEY` is the part **before the
last dot**.

**If the copied URL looks like `…/mcp/xxxx` with no `apiKey`**, that
deployment sets `DUAL_AUTH_MODE=false`, so `/api/config` reports `authMode: 'jwt'`
and the dashboard emits a bare URL for Auth0 clients. There is **no UI toggle** —
it is server config. Read the key from `/api/me` instead:

1. Sign in to the dashboard as that account.
2. In the same browser tab, open `<E2E_BASE_URL>/api/me`.
3. Copy the `apiKey` field out of the JSON.

Nothing about this changes the deployment; `/api/me` is a plain session-
authenticated read. (Setting `DUAL_AUTH_MODE` back on the website service would
also put the key in Copy URL, but that changes what every user's dashboard emits.)

Then verify it before running anything that asserts:

```bash
npm run check:auth -- fixture      # resolves the URL, authenticates, lists tools
```

Treat the key as a bearer credential: it authenticates as that user to every MCP
they have connected. Keep it in your shell or a GitHub **secret** — never an
Actions variable, and never committed. `POST /api/regenerate-key` mints a new one
and invalidates the old, which breaks any connector already using it.

A bare key is enough. With no instance in the token and none in the query,
`mcpAuthenticate` resolves the user's connection for that slug. Pass the compound
`<key>.<instanceId>` form only when one account holds more than one connection to
the same MCP; the same is true of the `E2E_MCP_URL_<SLUG>` override, which may
carry `?instanceId=`.

Regenerating a key on the dashboard invalidates the checks, not the reverse.

### Fixture, rich and sandbox content

Do not build these by hand — the rich account needs enough documents for a page
cap to be observable, and one document long enough to truncate:

```bash
E2E_SEED_CONFIRM=1 npm run seed:account -- fixture   # prints DOC_ID / TITLE / NEEDLE
E2E_SEED_CONFIRM=1 npm run seed:account -- rich      # prints RICH_DOC_ID / MIN_DOCS
E2E_SEED_CONFIRM=1 npm run seed:account -- sandbox   # prints SANDBOX_FOLDER_ID
```

Each prints its variables in `export K="V"` form. The fixture seed is idempotent
by title: running it twice reuses the existing doc rather than leaving two with
the same name, which would make the needle check assert against whichever copy
Drive listed first.

`E2E_SEED_CONFIRM=1` is required because this is the only part of the harness
that writes to the fixture and rich accounts — the two every check treats as
immutable. It prints the target URL and account before it asks.

### Already-set values

None. `e2e-smoke.yml` reads `vars.E2E_FIXTURE_DOC_ID` and
`vars.E2E_FIXTURE_DOC_NEEDLE`, and **neither is set** in the repo's Actions
variables; the workflow has never run. Seeding the fixture account produces both,
and they belong in Settings → Secrets and variables → Actions → Variables as well
as in your shell.

## CI

`.github/workflows/e2e-tool-checks.yml` runs these on `ubuntu-latest` — after
each dev deploy, nightly, and on demand. No Mac Studio, no Appium, no
Browserbase minutes.

- **`harness`** — typecheck plus the credential-free unit tests. Blocking: a
  broken invariant does not fail loudly, it passes silently.
- **`checks`** — needle / volume / zero in parallel, each preceded by
  `check:auth` so "the key is wrong" is separated from "the tool is broken"
  before any assertion runs. Advisory (`continue-on-error`) in v1, same as
  `e2e-smoke.yml`'s chatgpt-web job; promote once it has a flake rate.
- **`sweep`** — scheduled runs only, trashes orphaned scratch docs.

The whole workflow stays dormant until `E2E_BASE_URL` is set, so it does not
spam failures before the accounts exist. Runs are serialised through a
`concurrency` group and never cancelled mid-flight: two concurrent sandbox runs
would see each other's scratch docs, and a cancelled run skips its teardown.

Settings → Secrets and variables → Actions:

| Kind | Name |
|---|---|
| Secret | `E2E_FIXTURE_API_KEY`, `E2E_RICH_API_KEY`, `E2E_SANDBOX_API_KEY` |
| Variable | `E2E_BASE_URL`, `E2E_FIXTURE_DOC_ID`, `E2E_FIXTURE_DOC_NEEDLE`, `E2E_FIXTURE_DOC_TITLE`, `E2E_RICH_DOC_ID` |
| Variable (optional) | `E2E_RICH_DOC_MIN_CHARS`, `E2E_RICH_MIN_DOCS`, `E2E_SANDBOX_FOLDER_ID` |
| Variable (per service) | `E2E_SERVICES`, plus that service's rows under "Services beyond Docs" — the workflow already forwards all of them |

API keys are **secrets**, never variables: each one authenticates as that user to
every MCP they have connected. The doc IDs and the needle are fine as variables —
`e2e-smoke.yml` already reads two of them that way.
