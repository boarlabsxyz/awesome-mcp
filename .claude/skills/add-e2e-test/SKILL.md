---
name: add-e2e-test
description: Scaffold live-client e2e smoke tests for MCP tools in this repo's e2e/ harness. Accepts either a single tool name (e.g. `insertText`) or a freeform scope phrase that expands to many tools (e.g. "make tests for the whole google docs service", "all read tools", "everything for sheets except batchUpdateSpreadsheet"). Use this skill whenever the user wants to add, write, generate, or scaffold e2e tests, smoke tests, integration tests, or live-client tests for the MCP tools in this repo — even when phrased indirectly ("cover the new endpoint", "test the sheets tools"). Also use when invoked as `/add-e2e-test <args>`.
metadata:
  argument-hint: <toolName | scope-phrase>
---

# Add E2E Test

Scaffolds `runSmokeTest`-based test files that mirror the patterns in `e2e/tests/read/readGoogleDoc.smoke.ts` and `e2e/tests/write/appendToGoogleDoc.smoke.ts`.

The e2e harness is a thin wrapper around `node:test` plus an Appium-driven client (Claude Desktop or ChatGPT-web). The harness handles driver lifecycle, forensics, and teardown; each test file's job is just to declare a mode, set up fixtures, write a prompt, and assert on the response. That makes test files highly repetitive, which is what this skill exploits.

## Inputs

The args after the slash command are freeform. The skill maps them to a tool list:

- A single tool name from `e2e/tools.ts` → just that tool. Example: `/add-e2e-test insertText`.
- A scope phrase → all matching tools. Examples:
  - `/add-e2e-test make tests for the whole google docs service`
  - `/add-e2e-test all docs read tools`
  - `/add-e2e-test google-sheets`
  - `/add-e2e-test everything for calendar except deleteEvent`
- Empty args → ask the user.

Service names are matched liberally — `docs`, `google docs`, `google-docs`, `the docs service`, `google-docs-mcp` all resolve to the docs server. Same liberal aliasing for sheets / calendar / gmail / drive / clickup.

If the phrase is ambiguous (`tests`, `everything`, `all tools`) ask the user to narrow before resolving — guessing here produces a wrong batch that wastes their review attention.

## Scope resolution

1. **Parse service** from the phrase. If no service name appears and the phrase isn't a tool name, ask.
2. **Parse kind filter** — `read` / `write` / both. Default: both.
3. **Parse exclusions** from `except X, Y` or `excluding X` clauses.
4. **Build the candidate set**: read `e2e/tools.ts` (`READ_TOOLS`, `WRITE_TOOLS`, `NOT_IMPLEMENTED`). For services other than docs (which `tools.ts` doesn't list yet), grep `src/<service>/server.ts` for `addTool({ name: '...'` to discover the surface, and ask the user before generating whether to extend `tools.ts` — `tools.ts` is the runbook's source of truth for which tools are write-tools, and adding entries silently changes operational guidance.
5. **Filter**: drop `NOT_IMPLEMENTED`, drop tools that already have a test file, apply user exclusions.
6. **Print the plan** before writing anything when the batch has more than one tool:

   ```
   Will generate <N> tests for <service>:
     read:  <count> — <first 8 names, then "...and K more">
     write: <count> — <first 8 names, then "...and K more">
   Skipping:
     <count> NOT_IMPLEMENTED — <names>
     <count> already have tests — <names>
     <count> excluded by user — <names>
   ```

7. **Confirm with the user** when N > 1. Single-tool invocations skip the confirm.
8. **Cap with explicit confirm** when N > 30 — that's a large diff and worth pausing for.

## Procedure

### 1. Resolve the tool list

Run scope resolution above and tag each remaining tool as `read` or `write` with its destination path. Single-tool invocations end up with a list of length 1.

### 2. Locate each tool in source

For each tool, find the `addTool({ ... })` block in `src/<provider>/server.ts`. On bulk runs, read each server file once and match multiple tools in memory rather than re-grepping per tool — much faster on a 20-tool batch.

Extract the Zod parameter schema and the tool description. If a tool listed in `tools.ts` isn't found in source, flag it in the report and skip — don't abort the batch over one missing tool.

### 3. Determine required parameters

For each tool, walk the Zod schema:

- `.optional()` fields → omit from the prompt.
- Required `documentId` / `spreadsheetId` / `fileId` → fixture env var (read) or scratch resource (write).
- Required indices, tab ids, range params → `<TODO: ...>` placeholder. These are doc-specific; the skill cannot pick a sensible value.
- Other required strings/numbers/enums → an obvious literal default (e.g. `format: "text"`) when there is one, otherwise a TODO placeholder.

In bulk mode the skill never asks per-tool questions — defaults plus TODO placeholders. Every TODO ends up in the final report so the user knows what to fill in. See `references/param-rendering.md` for how each Zod type renders into the natural-language prompt.

If the tool doesn't fit the default write-and-read-back pattern (range-targeted writes, comment tools, result-returning tools), see `references/special-cases.md` before generating.

### 4. Ask shared questions ONCE

A single AskUserQuestion call at the start of the batch. Defaults are strong; in most cases the user just accepts them.

For batches that include read tests, confirm:
- Fixture id env var (default `E2E_FIXTURE_DOC_ID` for docs, `E2E_FIXTURE_SHEET_ID` for sheets).
- Fixture needle env var (default `E2E_FIXTURE_DOC_NEEDLE`).

For batches that include write tests, confirm:
- Marker prefix (default `BANANA-<UPPERCASE_TOOL>` per tool, derived automatically).
- Readback on/off (default on; readback tool picked per provider — `readGoogleDoc` for docs, `readSpreadsheet` for sheets).

Single-tool invocations may additionally need tool-specific literals (e.g. what to insert for `insertText`). Don't prompt for these in bulk — substituting BANANA-markers everywhere is the right behavior.

### 5. Generate the test files

Templates live in `assets/`:

- `assets/read.smoke.ts.tmpl` → `e2e/tests/read/<toolName>.smoke.ts`
- `assets/write.smoke.ts.tmpl` → `e2e/tests/write/<toolName>.smoke.ts`

Substitute placeholders: `{{toolName}}`, `{{FIXTURE_ID_ENV}}`, `{{FIXTURE_NEEDLE_ENV}}`, `{{paramCallSpec}}`, `{{scratchFactoryFn}}`, `{{resourceIdField}}`, `{{initialContent}}`, `{{markerPrefix}}`, `{{readbackTool}}`, `{{readbackParamSpec}}`, `{{writeParamCallSpec}}`, `{{behaviorLine}}`.

A note on imports: the e2e/ folder uses TS imports with explicit `.ts` extensions, not `.js`. Match the existing files — the typechecker is strict about this.

### 6. Verify

Run once at the end of the batch, not per file:

```
cd e2e && npx tsc --noEmit
```

Group errors by file. The most common failure modes are listed in the report section below.

Don't try to run the smoke tests themselves — they need the Mac Studio runner, Appium, and live connector login per `e2e/runbook.md`.

### 7. Report

Single template, regardless of single vs bulk:

```
Generated <N> test files:
  read:  <count> at e2e/tests/read/
  write: <count> at e2e/tests/write/

Skipped:
  <count> NOT_IMPLEMENTED: <names>
  <count> already had tests: <names>
  <count> not found in source: <names>

TODO placeholders in <K> files (need values before they'll pass):
  <file>: <param1>, <param2>
  ...

Env vars to set before running locally:
  - E2E_FIXTURE_DOC_ID (see e2e/fixtures/read.md)
  - E2E_FIXTURE_DOC_NEEDLE
  - <write account vars if any write tests — see fixtures/write.md>

tools.ts: <unchanged | added X to READ_TOOLS | added Y to WRITE_TOOLS>

Typecheck: <pass | N errors — see above>
```

## Failure modes

These cases each abort a single-tool run but soft-skip in bulk and surface in the final report — that way one bad tool doesn't waste a 20-tool batch.

- **Tool not found in any server file** — skip / abort. Inventing parameters from imagination produces a green test against a phantom contract.
- **Tool is in `NOT_IMPLEMENTED`** — skip / abort. The runbook treats these as not-real-tools.
- **Destination file exists** — skip / abort. Overwriting a passing test is worse than refusing to scaffold.
- **Required params can't be derived** — write with TODO placeholders and list the tool + missing params in the report. The scaffold is still useful: setup, teardown, and prompt shape are locked in.
- **`tools.ts` lists the tool in the wrong array** — flag the inconsistency in the report; don't silently move it. That's a runbook-level decision.
- **Scope phrase ambiguous** — ask before guessing. A wrong service guess produces a 20-file diff in the wrong directory.
- **Batch resolves to more than 30 tools** — confirm explicitly with the count.

## File layout

```
add-e2e-test/
├── SKILL.md
├── assets/
│   ├── read.smoke.ts.tmpl
│   └── write.smoke.ts.tmpl
└── references/
    ├── param-rendering.md   ← Zod-type → prompt rendering rules
    └── special-cases.md     ← when the default write template doesn't fit
```
