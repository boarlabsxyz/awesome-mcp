---
name: add-e2e-test
description: Scaffold e2e tests for MCP tools in this repo's e2e/ harness. Accepts a single tool name (e.g. `insertText`) or a freeform scope phrase that expands to many tools ("make tests for the whole google docs service", "all read tools", "everything for sheets except batchUpdateSpreadsheet"). Use this skill whenever the user wants to add, write, generate, or scaffold e2e tests, smoke tests, integration tests, or live-client tests for the MCP tools in this repo — even when phrased indirectly ("cover the new endpoint", "test the sheets tools"). Also use when invoked as `/add-e2e-test <args>`.
metadata:
  argument-hint: <toolName | scope-phrase>
---

# Add E2E Test

## Pick the tier first

The harness has three tiers. Choosing wrong is the most expensive mistake here,
because a test in the wrong tier is slow, flaky, or asserts nothing.

| Tier | Path | Transport | For |
|---|---|---|---|
| **Tool check** | `e2e/tests/tools/<shape>/<tool>.check.ts` | direct MCP over HTTPS | **per-tool coverage — the default** |
| **Task test** | `e2e/tests/tasks/<name>.task.ts` | real client in a browser | a handful per service, never per tool |
| **Harness unit** | `e2e/tests/unit/<name>.unit.ts` | none | the harness's own logic — **not generated here** |

**Default to a tool check.** A direct check runs in about a second, passes exact
arguments, and asserts exact output. A task test costs a full LLM conversation
and a browser session: at ~2 minutes each, one per tool across the repo's 227
tools is **~7.6 hours per client** — and the three shapes a tool check gives you
for free would be **~23 hours**. The same coverage on the direct transport takes
minutes. That is the arithmetic behind the split.

Write a **task test** only when the thing under test is *how a model uses the
tools*, not what a tool returns. See `references/task-tests.md`; the bar is high
and the existing three are close to sufficient for Docs.

If the user explicitly asks for a live-client or browser test, give them a task
test and say why it is not per-tool.

**This skill does not scaffold harness units.** They test the harness's own
logic — an invariant, a sweeper's date arithmetic, a driver's error handling —
which has no tool to resolve, no shape to choose and no account to reach, so
none of the procedure below applies. Write them by hand next to the code they
cover, as `e2e/tests/unit/*.unit.ts`. They are listed above so the tier is
visible when you are deciding, not because this skill produces them.

They are worth writing whenever the harness gains logic that can silently
succeed: an assertion that matches nothing passes every test it guards.

## Inputs

Freeform args, mapped to a tool list:

- A single tool name → just that tool. `/add-e2e-test insertText`
- A scope phrase → all matching tools. `/add-e2e-test all docs read tools`
- Empty → ask.

Service names match liberally: `docs`, `google docs`, `google-docs` all resolve
to the docs server. Same for sheets / calendar / gmail / drive / clickup / slack.

If the phrase is ambiguous (`tests`, `everything`), ask before resolving — a
wrong service guess produces a large diff in the wrong directory.

## Procedure

### 1. Resolve the tool list

Read `e2e/tools.ts` for the docs surface. For other services, grep
`src/<service>/server.ts` for `addTool({ name: '...'` — and note that `tools.ts`
currently covers docs only, so extending it is part of the job when you scaffold
another service. Its `kind` column is **read off each tool's `annotations`**
(`readOnlyHint` / `destructiveHint`), not hand-decided; keep it that way, and
prefer a generator over typing 227 entries.

Drop anything in `NOT_IMPLEMENTED` — CLAUDE.md's "Known Limitations" lists tools
that are registered but unusable, and scaffolding those produces red nobody can
fix.

**Reclassify result-returning tools here, before shapes are chosen.** A tool that
computes an answer rather than mutating — `findElement`, `findAndReplace` in
count mode — is **read-flavoured whatever its annotations say**. Left as a write
it gets sandbox scaffolding, a scratch resource it does not need, and a read-back
assertion on a document it never changed. Classify it as a read and it takes all
three shapes against a fixture, asserting on its own response. See
`references/special-cases.md`.

Print the plan and confirm when N > 1. Confirm explicitly when N > 30.

### 2. Read the tool in source

Find the `addTool({ ... })` block in `src/<provider>/server.ts`. Extract the Zod
schema and the description. On bulk runs read each server file once and match in
memory.

**Read the handler too, not just the schema.** Checks assert on real output, so
you need the actual strings: `handleListGoogleDocs` returns
`"Found N Google Document(s):"` and `"No Google Docs found matching your
criteria."`, and a check asserting a paraphrase of those will fail. Follow the
`execute:` line to its handler and read what it returns.

### 3. Choose shapes

Shapes describe **the data**, not the account:

| Shape | Account | Asserts |
|---|---|---|
| `needle` | `fixture` | frozen content, exact substring |
| `volume` | `rich` (read-only) | caps, paging, truncation are observable |
| `zero` | `sandbox` | the empty-state answer |

- **Read tools** → all three.
- **Write tools** → `volume` and `zero` only, both in the sandbox. A write has no
  frozen output to match; its needle is the marker it writes.

`references/shapes.md` covers what to assert in each. The zero shape is the one
people skip and the one that finds things — "no results" is the half of the
contract that silently reads as "that thing does not exist".

### 4. Ask once, at the start of the batch

One `AskUserQuestion` for the whole run, not per tool. Defaults are strong:

- fixture env vars (`E2E_FIXTURE_DOC_ID`, `E2E_FIXTURE_DOC_NEEDLE`)
- for write batches: readback tool (`readGoogleDoc` for docs, `readSpreadsheet`
  for sheets)

In bulk mode never ask per tool — use defaults and `<TODO:>` placeholders, and
list every TODO in the final report.

### 5. Generate

| Template | Destination |
|---|---|
| `assets/read.check.ts.tmpl` | `e2e/tests/tools/<shape>/<tool>.check.ts` |
| `assets/write.check.ts.tmpl` | `e2e/tests/tools/<shape>/<tool>.check.ts` |
| `assets/task.ts.tmpl` | `e2e/tests/tasks/<name>.task.ts` |

Arguments are a **JSON object**, not prose — `runToolCheck` calls the tool
directly. There is no natural-language rendering to get right and no model to
misinterpret them.

Imports use explicit `.ts` extensions. Match the existing files.

### 6. Verify

```bash
cd e2e && npm run typecheck && npm run test:unit
```

Run the generated checks only if that shape's account is reachable. Each shape
uses a **different** account, so preflight the one you are about to run:

```bash
npm run check:auth -- fixture    # needle
npm run check:auth -- rich       # volume
npm run check:auth -- sandbox    # zero, and every write check
npm run check:auth -- sandbox google-drive   # write checks create scratch docs
```

That last one catches a sandbox account connected to Docs but not Drive, which
passes every other preflight and then fails every write check at setup.

Never run task tests in a scaffolding pass — they need a browser and a seeded
context.

### 7. Report

```
Generated <N> checks:
  needle: <n>   volume: <n>   zero: <n>
Skipped:
  <count> NOT_IMPLEMENTED: <names>
  <count> already had tests: <names>
TODO placeholders in <K> files: <file>: <params>
tools.ts: <unchanged | added X>
Typecheck: <pass | N errors>
```

## Rules that exist because they were broken

Each of these cost real debugging time in this harness.

**Never let a check pass vacuously.** An invariant satisfied by an empty or
trivial response asserts nothing while reporting green. `parsesAsJson` passes on
any document too small to truncate; `containsBetween` passes on an empty
envelope. Assert the *precondition* too — that truncation happened, that the
account has enough data — and fail with a message naming the fixture to fix.

**Assert on a read-back, not on the write's own reply.** A write tool's response
is its own claim that it worked. `runToolCheck`'s `readback` exists for this.

**Reach for each tool on the server that registers it.** `listGoogleDocs` is on
the docs server; `createDocument` and `deleteFile` are on **drive**. They are
separate deployed hosts, so one client cannot serve both — use
`c.service('google-drive')` via `setup/clients.ts`. Getting this wrong fails with
`Unknown tool`, which reads like a broken deployment.

**A write check must declare `writes: true`.** `accounts.ts` then refuses to hand
it fixture or rich credentials. That guard is the only thing protecting the rich
account, whose corruption is silent and surfaces weeks later.

**Teardown always runs, including after a failed assertion.** Trash scratch
resources in `teardown`; the scheduled sweeper is a backstop, not the plan.

**A gap in the tool is a `todo`, not a red assertion.** If a check documents
something the tool does not do yet (`listGoogleDocs` not reporting its scan
extent), write `test('...', { todo: '<why>' }, () => {})` and flip it to a real
assertion in the commit that fixes the tool. A permanently red check trains
people to ignore the suite.

## Failure modes

Single-tool runs abort; bulk runs soft-skip and surface it in the report.

- **Tool not found in source** — skip. Inventing parameters produces a green test
  against a phantom contract.
- **In `NOT_IMPLEMENTED`** — skip.
- **Destination exists** — skip. Overwriting a passing test is worse than
  refusing.
- **Required params underivable** — write with `<TODO:>` and report. The scaffold
  still locks in setup, teardown and shape.
- **Scope ambiguous** — ask.
- **More than 30 tools** — confirm with the count.

## Layout

```
add-e2e-test/
├── SKILL.md
├── assets/
│   ├── read.check.ts.tmpl
│   ├── write.check.ts.tmpl
│   └── task.ts.tmpl
└── references/
    ├── shapes.md         ← what to assert per shape
    ├── task-tests.md     ← when a live-client test is justified
    └── special-cases.md  ← when the default write pattern does not fit
```

Background on the tiers and accounts: `e2e/accounts.md`, `e2e/SETUP.md`,
`e2e/runbook.md`.
