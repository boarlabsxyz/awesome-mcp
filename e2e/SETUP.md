# E2E Tool Checks — Setup

Start-to-finish: from nothing to a green CI run. Follow it in order; each step
ends with something you can verify before moving on.

`accounts.md` is the reference (what every variable means, why the model is the
way it is). This is the procedure.

---

## Step 1 — Decide how many Google accounts

The checks act on whichever Google Drive a dashboard user has connected, so a
"test account" is a Google account signed in to the dashboard.

| Accounts | Verdict | Trade-off |
|---|---|---|
| 3 | Recommended | fixture stays frozen, rich stays busy, sandbox is disposable |
| 2 | Fine to start | fixture doubles as rich — the needle doc must never be edited, on an account someone actually uses |
| 1 | **No** | write checks would mutate the account the read checks assert against, and the zero-state checks would never see an empty result |

Two is a legitimate starting point. One is not a smaller version of this, it is a
different and broken thing.

> **Today:** the account behind the existing fixture doc has 100+ documents, so
> it already works as `rich`. Treat it as fixture+rich for now and add a
> dedicated frozen fixture account later.

---

## Step 2 — Connect the MCPs

Sign in to the dev dashboard as each account and connect:

| Account | Connect | Why |
|---|---|---|
| fixture | **Google Docs** | its catalog scope set already includes full `auth/drive` |
| rich | **Google Docs** | same |
| sandbox | **Google Docs** *and* **Google Drive** | `createDocument` / `deleteFile` are registered on the **drive** server only, so a docs-only connection cannot create or trash scratch files |

**If an account was connected before the current scopes were seeded**, press
**Reconnect** on that row. The button is always drawn on any row where
re-consent is possible, precisely because a newly added scope leaves the stored
token working for everything except the new calls — every probe reports healthy
while those calls fail. A token keeps the scopes it was minted with; nothing but
re-consent changes that.

You can tell this case apart in one call: `listGoogleDocs` with **no** query
succeeds while the same call **with** a query 403s. Queries use
`fullText contains`, which needs the full `auth/drive` scope.

---

## Step 3 — Get each account's API key

The dev deployment sets `DUAL_AUTH_MODE=false`, so `/api/config` reports
`authMode: 'jwt'` and the dashboard's **Copy URL** emits a bare
`…/mcp?instanceId=…` with no key. There is no UI toggle — it is server config.

For each account:

1. Sign in to the dashboard as that account.
2. In the **same tab**, open `https://website-development1.up.railway.app/api/me`
3. Copy the `apiKey` field.

Or from the console on the dashboard:

```js
(await (await fetch('/api/me', {credentials:'same-origin'})).json()).apiKey
```

`POST /api/regenerate-key` mints a new key and **invalidates the old one**,
breaking any connector already using it. Only for rotation.

Treat each key as a bearer credential: it authenticates as that user to every
MCP they have connected, not just Docs.

---

## Step 4 — Set your local environment

```bash
cd e2e
npm install

export E2E_BASE_URL=https://website-development1.up.railway.app
export E2E_FIXTURE_API_KEY=...
export E2E_RICH_API_KEY=...        # same as fixture if you are on 2 accounts
export E2E_SANDBOX_API_KEY=...
```

Verify each one before going further — this separates "the key is wrong" from
"the tool is broken", which otherwise look identical:

```bash
npm run check:auth -- fixture                 # expect: ~32 tools
npm run check:auth -- rich
npm run check:auth -- sandbox
npm run check:auth -- sandbox google-drive    # expect: the drive tool list
```

The last one is the check that catches a sandbox account with no Drive
connection, which would otherwise fail every write check at setup time.

> These variables are yours and CI's. **None of them go on a Railway service** —
> see [Deployment side](#deployment-side--what-goes-on-railway).

---

## Step 5 — Seed the fixtures

**Fixture** — already exists; no seeding needed:

```bash
export E2E_FIXTURE_DOC_ID=1nZ8Q1StnT0QDUcfZ9_Ihrzh3PZJjVpGC0Kvg4qTW688
export E2E_FIXTURE_DOC_NEEDLE=BANANA-PHONE-7714
export E2E_FIXTURE_DOC_TITLE="<the doc's exact title>"
```

Only if you build a fresh fixture account:
`E2E_SEED_CONFIRM=1 npm run seed:account -- fixture`

**Rich** — needs 50+ documents and one long enough to truncate:

```bash
export E2E_RICH_DOC_ID=1JIfO2GNA8t4U9PAKoWjw3d9Kkpi2MwAvz8Q7QuXzmIM
# or, on a fresh account:
E2E_SEED_CONFIRM=1 npm run seed:account -- rich
```

**Sandbox** — optional folder so scratch docs stay out of the account root:

```bash
E2E_SEED_CONFIRM=1 npm run seed:account -- sandbox
```

Every seed prints its variables in `export K="V"` form. `E2E_SEED_CONFIRM=1` is
required because seeding is the only thing that writes to fixture and rich — the
two accounts every check treats as immutable. It prints the target first and
refuses without the flag.

---

## Step 6 — Run everything locally

```bash
npm run test:unit      # no credentials — invariant engine + sweeper date logic
npm run check:needle
npm run check:volume
npm run check:zero
npm run check          # all three
```

A fully configured run is **10 pass, 1 todo, 0 fail**. The todo is deliberate:
`listGoogleDocs` does not report its scan extent yet, and that is a gap in the
tool, not a regression — flip it to a real assertion in the commit that fixes it.

Artifacts land in `.artifacts/local/direct-<account>/<tool>.<shape>/` as
`summary.json` + `response.txt`. Read `response.txt` before changing any
assertion: a surprising answer is a finding, not a broken check.

---

## Step 7 — Configure the repository

Settings → Secrets and variables → Actions.

**Secrets** (never variables — each authenticates as that user to every MCP they
have connected):

- `E2E_FIXTURE_API_KEY`
- `E2E_RICH_API_KEY`
- `E2E_SANDBOX_API_KEY`

**Variables:**

- `E2E_BASE_URL` — `https://website-development1.up.railway.app`
- `E2E_FIXTURE_DOC_ID`, `E2E_FIXTURE_DOC_NEEDLE`, `E2E_FIXTURE_DOC_TITLE`
- `E2E_RICH_DOC_ID`
- optional: `E2E_RICH_DOC_MIN_CHARS`, `E2E_RICH_MIN_DOCS`, `E2E_SANDBOX_FOLDER_ID`

`E2E_BASE_URL` is the master switch: the whole workflow is gated on it, so it
stays dormant — and silent — until you set it. Set it **last**, after the
secrets, or the first run fails on missing keys.

`e2e-smoke.yml` separately wants `E2E_FIXTURE_DOC_ID` and
`E2E_FIXTURE_DOC_NEEDLE`; the same two variables serve both workflows.

---

## Step 8 — Merge

Nothing runs from the branch. GitHub honours `schedule`, `workflow_run` and
`workflow_dispatch` only for workflows on the **default branch**, so the first
real run is after merge — which is the safe order anyway, since the secrets are
not set before Step 7.

Merge order against #144 does not matter; they are independent. Whichever lands
second takes a one-line conflict in `e2e/package.json`'s `scripts` object —
keep both sides.

---

## Step 9 — The first CI run

Trigger it by hand: Actions → **E2E Tool Checks (Direct MCP)** → Run workflow.

| Job | Expect |
|---|---|
| `harness` | green — typecheck + 7 unit tests, no credentials |
| `checks (needle)` | green |
| `checks (volume)` | green, 1 todo |
| `checks (zero)` | green |
| `sweep` | skipped — scheduled runs only |

A red matrix leg fails this workflow, which is the signal you want. It is still
advisory in the only sense that matters — nothing depends on it until
`tool-checks` is added to `create-tag.yml`'s required list (step 10). The job
deliberately does **not** use `continue-on-error`, which would report a failed
job as successful.

If a leg is red, download the `e2e-checks-<shape>-<sha>` artifact and open
`summary.json`, then `response.txt`. Same two files `runbook.md`'s triage starts
from; there is no screenshot, because there is no browser in this path.

---

## Step 10 — Gate the release on it

**Do not run these at tag-creation time.** Nothing new is deployed at that
moment, so they would test whatever dev happens to be running — which is not the
code being tagged. A green check that does not correspond to the tagged commit is
worse than no check.

`create-tag.yml` already does the right thing: `validate-ci` reads the check runs
**on the SHA being tagged** and requires each named one to be `success`. Gating
is therefore a one-line edit, not a new job:

```js
// .github/workflows/create-tag.yml, "Check CI passed on commit"
const required = ['lint', 'typecheck', 'test', 'build', 'tool-checks'];
```

`tool-checks` is the aggregator job in `e2e-tool-checks.yml`, and it exists
precisely for this. Do **not** name the matrix legs (`checks (needle)` and
friends) — those names change the moment a fourth shape is added, and a required
list naming them would either stop covering the new one or block every tag on a
name that no longer exists.

### The release protocol this implies

`Deploy → Dev` is `workflow_dispatch` only: it does not fire on every push to
main. Since the checks run on `workflow_run` of that deploy, a commit only has a
`tool-checks` result if someone deployed **that commit** to dev. So the release
sequence becomes:

1. Deploy the release candidate SHA to dev.
2. Let `E2E Tool Checks` finish green against it.
3. Create the tag on that SHA.

Skip step 1 and `validate-ci` fails with *Missing CI checks: tool-checks* — a
blocked release for a reason that is not a test failure.

### Before you add it to the list

- **10+ consecutive runs with no false-positive failures.**
- The rich account's content is stable enough that `E2E_RICH_MIN_DOCS` is not
  borderline.
- The sandbox sweeper has run a week without leaking.
- `E2E_BASE_URL` is set and stays set. Both `checks` and `tool-checks` are gated
  on it, so unsetting it makes the required check vanish and blocks every
  release.

Until then the workflow is advisory by the only mechanism that means anything:
nothing depends on it. Note it does **not** use `continue-on-error` — that flag
reports a failed job as successful, so a gate reading its conclusion would treat
a red run as a pass. An advisory job and a lying job are not the same thing.

---

## Deployment side — what goes on Railway

**Nothing.** None of the `E2E_*` variables belong on a Railway service. The
checks are *clients* of the deployment: they authenticate as ordinary dashboard
users over the same `/mcp` endpoint a connector uses. The variables live in your
shell and in GitHub Actions, and nowhere else. Putting the API keys on a service
would park a credential somewhere that has no use for it.

What Railway must already be true — all four are, verified:

| Requirement | Why | Check |
|---|---|---|
| `website-development1` up | serves `/api/v1/catalogs` (URL discovery) and `/api/me` (the keys) | `curl -s -o /dev/null -w '%{http_code}' $E2E_BASE_URL/health` &rarr; `200` |
| `google-docs-mcp-development` up | the tool under test | POST `/mcp` unauthenticated &rarr; `401` (up, enforcing auth) |
| `google-drive-mcp-development` up | scratch create/trash for every write and zero-state check | same &rarr; `401` |
| Google OAuth client configured | accounts cannot connect otherwise | an account shows a connected Google Docs row |

A `401` from those POSTs is the healthy answer. A `404`, a `502` or a hang means
the service is down, and every check will fail in a way that looks like a
credential problem.

### The one optional change, which I would skip

`DUAL_AUTH_MODE` on the website service. It is effectively `false` today, which
is why the dashboard's **Copy URL** emits `?instanceId=…` with no key and step 03
sends you to `/api/me`. Changing it would put the key back in Copy URL — a
one-time convenience during setup, in exchange for changing what every user's
dashboard emits from then on. Not a good trade.

### Two things not to be misled by

`GOOGLE_TOKEN` (and `token.json`) appear in `fixtures.md` and in `src/auth.ts`.
They belong to the **single-user stdio path** — `authorize()` is called from
`initializeGoogleClient()`, which the hosted server does not use. The deployment
stores per-user OAuth tokens in the database, one row per connection. Setting
`GOOGLE_TOKEN` will not give the checks an identity, and not setting it will not
take one away.

**Connect the accounts on the same deployment `E2E_BASE_URL` points at.** An
account connected through the prod dashboard has no connection on dev, so its key
resolves to a user with nothing attached and every tool call fails on a missing
connection rather than on auth.

### The one real coupling

The workflow fires on `workflow_run` of **Deploy → Dev**, so the Railway deploy
pipeline is what schedules the checks. If dev deploys are paused or failing, the
checks still run nightly and on demand, but they stop running per-change — and
they will be testing whatever is currently deployed, not the commit that
triggered them.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401 … API key was rejected` | wrong/rotated key | re-read `/api/me`, update the env var or secret |
| `Permission denied … granted Google Drive access` on a **queried** list, while an unqueried one works | token predates the `auth/drive` scope | **Reconnect** that account |
| same error on **every** Drive call | Drive genuinely not connected | connect Google Drive on that account |
| `Missing required env var: E2E_SANDBOX_API_KEY` | write/zero checks without a sandbox | Steps 2–4 for the sandbox account |
| `declares writes: true but resolved the 'rich' account` | a check's `account` was edited to a read-only one | revert it — this guard is the only thing protecting the rich account |
| `fixture too small — N chars is under maxLength` | `E2E_RICH_DOC_ID` points at a short document | point it at a longer one; the check refuses to pass vacuously |
| `only N docs — the rich account needs at least M` | rich account too thin | `seed:account -- rich`, or lower `E2E_RICH_MIN_DOCS` |
| `the response was not truncated` | same, for the JSON envelope check | use a document whose JSON exceeds `maxLength` |
| zero-state checks fail intermittently | leaked scratch docs | `npm run sweep:sandbox`; confirm the scheduled `sweep` job is running |
| `does not publish an MCP called '<slug>'` | wrong slug, or a service not deployed | the error lists the real slugs |

---

## Ongoing

- **Schedule matters.** The nightly `sweep` job is what keeps the sandbox
  account usable. Without it the zero-state checks eventually fail for reasons
  unrelated to the code under test, and the failure looks like a regression.
- **Never edit the fixture doc.** The needle check asserts its bytes. If you
  must change it, update `E2E_FIXTURE_DOC_NEEDLE` in the same change.
- **Rotating a key** breaks any connector using it, not just these checks.
- **Adding tools?** `e2e/tools.ts` is the inventory; its `kind` column is read
  off each `addTool`'s annotations rather than typed by hand, so extending it to
  the other 11 servers should be a generator, not more typing.
