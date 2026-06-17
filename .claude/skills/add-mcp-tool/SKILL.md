---
name: add-mcp-tool
description: Add a single tool to one of this repo's existing MCP servers (google-docs, google-sheets, google-calendar, google-gmail, google-drive, clickup, slack, etc.). Wires the addTool block into src/<provider>/server.ts using the canonical pattern (Zod params, UserError handling, log.info breadcrumb, getXClient helper), classifies the tool as read or write in e2e/tools.ts, bumps the CLAUDE.md tool count, and optionally chains to /add-e2e-test to scaffold the smoke test. This skill is the single source of truth for the tool shape used across the codebase — use it whenever the user wants to add, create, or wire up a new MCP tool, action, endpoint, or operation, even when phrased indirectly ("expose X to Claude", "I want a tool that does Y"). Also use when invoked as `/add-mcp-tool <toolName> [provider]`.
metadata:
  argument-hint: <toolName> [provider]
---

# Add MCP Tool

Add one tool to an existing MCP server. The skill exists because tool addition is the most common ongoing change in this repo (43+ tools across the providers) and the work touches several files that need to stay in sync.

For the tool's actual shape, the canonical pattern lives in `references/tool-pattern.md`. That document explains why each part is there; this SKILL.md is the procedure for inserting it.

## Inputs

- `<toolName>` (required): camelCase, verb-first, e.g. `archiveEvent`, `listFiles`. Should not collide with an existing tool in the target server.
- `[provider]` (optional): which MCP server to add to. One of `google-docs`, `google-sheets`, `google-calendar`, `google-gmail`, `google-drive`, `clickup`, `slack`, etc. If omitted, ask. If the user is currently editing one of the server files, default to that provider.

If `<toolName>` is missing, ask.

## Procedure

### 1. Identify the target server

If the provider wasn't given:
- If the user's recent edits or current selection point at a `src/<provider>/server.ts`, use that.
- Otherwise ask via AskUserQuestion with the available providers as options.

Confirm the file exists at `src/<provider>/server.ts`. If not, abort and suggest the user run `/add-mcp-server` first to scaffold the server.

### 2. Check for name collision

Grep `src/<provider>/server.ts` for `name: '<toolName>'`. If present, abort — silently shadowing an existing tool is the worst-case outcome; both addTool blocks register and the second wins, but the first stays in source as dead code that future readers will edit by accident.

### 3. Gather metadata

Use one AskUserQuestion call to collect:

- **Description**: one-line, action-first. The LLM uses it to pick the tool, so be concrete.
- **Read or write**: read-only tools get `annotations: { readOnlyHint: true }` and go in `READ_TOOLS`; write tools omit the annotation and go in `WRITE_TOOLS`. The rule of thumb from `references/tool-pattern.md`: anything that changes state in the user's account is write. When unsure, ask the user; getting this wrong has runbook consequences (the e2e readonly connector unchecks `WRITE_TOOLS`).
- **Parameters**: name + type + required/optional + one-line description for each. Reuse shared Zod fragments from `src/types.ts` where they exist (`DocumentIdParameter`, `RangeParameters`, `TextStyleParameters`, etc.).

For Google providers also confirm which `session.google<X>` client this tool needs (usually obvious from the SDK call). For third-party providers, the client is whatever `get<X>Client` returns in that server file.

### 4. Read the canonical pattern

Read `references/tool-pattern.md` before generating. The non-obvious conventions live there — `log.info` breadcrumb shape, the `UserError` mapping for 403, response formatting style. Don't skip this step even if the tool feels simple — the value of the skill is consistency with the existing 40+ tools.

### 5. Generate the addTool block

Use one of:

- `assets/templates/google-tool.ts.tmpl` for Google-API tools.
- `assets/templates/third-party-tool.ts.tmpl` for clickup / slack / future third-party servers.

Substitute the placeholders (`{{toolName}}`, `{{description}}`, `{{zodFields}}`, `{{executeBody}}`, `{{readOnlyAnnotationLine}}`, etc.). For `{{executeBody}}`, write the actual API call; pattern-match against an existing tool in the same server file to get the SDK call right.

For read-only tools, `{{readOnlyAnnotationLine}}` is `annotations: { readOnlyHint: true },`. For write tools, leave the line empty (remove it from the substituted output — don't leave `annotations: undefined`).

### 6. Insert at the right location

Tools tend to be grouped by category in each server file (read tools together, write tools together; sometimes tiered as in clickup's `Tier 1: Core Navigation` block). Drop the new tool at the end of the matching group, not at the bottom of the file — keeping related tools adjacent makes future readers' job easier.

If the file has no obvious grouping, append at the end of the existing `addTool` calls, right before the module exports.

### 7. Update `e2e/tools.ts`

Push the tool name into either `READ_TOOLS` or `WRITE_TOOLS` depending on the classification from step 3. The arrays are `as const` tuples — order doesn't change behavior but match the alphabetical-ish grouping that's already there.

If the new tool isn't fully implemented (e.g. you scaffolded params + executes a placeholder), also add it to the `NOT_IMPLEMENTED` set so the e2e harness skips it.

### 8. Update `CLAUDE.md`

Bump the count in the Tool Categories table for the relevant row. If the tool introduces a new category (e.g. first comment tool ever), add the row.

### 9. Offer the two follow-ups

End the procedure with:

> The tool is wired in. Want me to follow up with:
>   1. Smoke test — `/add-e2e-test <toolName>`
>   2. OpenAPI spec — `/update-openapi <provider>`
>   3. Both
>   4. Neither (do later)

If the user picks the smoke test, follow `../add-e2e-test/SKILL.md` with `<toolName>` as the input. If they pick the OpenAPI update, follow `../update-openapi/SKILL.md` with `<provider>` as the input. Both → do the smoke test first (more interactive, asks more questions), then OpenAPI (more mechanical, mostly auto-scaffolds).

Skip the OpenAPI option entirely when the provider has no OpenAPI file (currently Slack). In that case revert to the single offer:

> The tool is wired in. Want me to scaffold the smoke test now? I'll invoke `/add-e2e-test <toolName>`.

Both are soft chains rather than auto-execution because each surfaces its own questions — the e2e test scaffold asks about fixtures and special cases, the OpenAPI update asks the user to confirm HTTP method and path for non-obvious cases. Better to handle them deliberately than rush at the tail of adding a tool.

### 10. Verify

Run `npm run typecheck`. Surface any errors. Common failure modes:
- Missing import (most often `UserError` or a type from `googleapis`).
- Zod schema doesn't match what the execute body destructures from `args`.
- `getXClient` doesn't exist on the server file yet — the user is adding the first tool that needs a new helper, which means they should add the helper too (see `references/tool-pattern.md` for the shape).

### 11. Report

```
Added <toolName> to src/<provider>/server.ts
  Read/write: <read | write>
  Parameters: <count>

Updated:
  e2e/tools.ts (added to <READ_TOOLS | WRITE_TOOLS>)
  CLAUDE.md (bumped <category> count)

Typecheck: <pass | N errors>

Next:
  /add-e2e-test <toolName>       ← scaffolds the smoke test
  /update-openapi <provider>     ← syncs the REST surface (omit if no OpenAPI file)
  npm run typecheck              ← if not run automatically
```

## Failure modes

- **Tool name collision** — abort. Two addTool blocks with the same name compile but only one registers.
- **Target server doesn't exist** — abort. Direct the user to `/add-mcp-server <slug>` first.
- **Description longer than ~120 chars** — trim. Long descriptions cost tokens on every LLM call that sees the tool list.
- **Required param has no `.describe()`** — fail loudly; the LLM uses descriptions to fill arguments and a missing description silently degrades quality.
- **Read/write classification looks wrong** (e.g. tool named `delete*` registered as read-only) — flag with one question before continuing. Better to interrupt than misclassify.

## File layout

```
add-mcp-tool/
├── SKILL.md
├── references/
│   └── tool-pattern.md       ← canonical FastMCP tool shape; shared with add-mcp-server
└── assets/
    └── templates/
        ├── google-tool.ts.tmpl
        └── third-party-tool.ts.tmpl
```

## Relationship to other skills

- **`add-mcp-server`** scaffolds the server file with one example tool. It references `references/tool-pattern.md` from this skill as the canonical shape for that example, so both skills produce identical tool shapes.
- **`add-e2e-test`** scaffolds the smoke test. Step 9 above offers to chain into it.
- **`update-openapi`** syncs the REST/OpenAPI surface. Step 9 above offers to chain into it for providers that have an OpenAPI file. Skip the offer for providers that don't (Slack today; new third-party MCPs until someone deliberately creates the spec).
