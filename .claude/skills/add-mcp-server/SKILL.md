---
name: add-mcp-server
description: Scaffold and wire a brand-new MCP server into this google-docs-mcp hosting platform. Creates the server file, registers it in scopeMap + dispatch router + UserSession + catalog, and optionally clones a reference GitHub MCP repo and ports its tools into this codebase's FastMCP + Zod + UserSession pattern. Use this skill whenever the user mentions adding, creating, or wiring up a new MCP server, integration, or provider in this repo — even when phrased indirectly ("plug in Notion", "expose a new service", "stand up a server for X"). Also use when invoked as `/add-mcp-server <slug> [github-url]`.
metadata:
  argument-hint: <slug> [github-url]
---

# Add MCP Server

Scaffolds a new MCP server end-to-end: server file, registration, catalog, docs, optional adaptation of tools from a reference repo.

This repo is a multi-MCP hosting platform — each MCP runs as its own process selected by `MCP_SLUG`, dispatched by a router inside `src/google-docs/server.ts`. Adding a server is mechanical but touches several files; the value of this skill is hitting all of them and getting the cross-file invariants right.

## Inputs

- `<slug>` (required): kebab-case identifier, e.g. `notion`, `linear`, `google-photos`.
- `[github-url]` (optional): a reference MCP repo whose tools should be ported.

If `<slug>` is missing, ask. Reject slugs that don't match `^[a-z][a-z0-9-]*$` — the slug is used as a directory name, a route segment, a scope key, and a catalog primary key, and stray characters break all of those.

## Procedure

### 1. Check uniqueness

A duplicate slug silently overwrites catalog entries and clobbers the dispatch router, so abort early:

- Grep `src/auth/scopeMap.ts` for the slug.
- Read `data/mcp-catalog.json` and look for the slug.
- Check `src/<slug>/` does not exist.

Stop with a clear message if any of these hit.

### 2. Gather metadata

Use a single AskUserQuestion call to collect:

- **Provider type**: Google API or third-party. This drives whether you generate `apiHelpers.ts` and how `UserSession` gets extended.
- **Display name** (e.g. `"Notion MCP Server"`).
- **Description** — one line, used in the catalog.
- **Route path** — defaults to slug, e.g. `notion` becomes `/notion` and `/notion-sse`.

For third-party, also ask:
- **Session token field** — name of the field on `UserSession` that holds the token. Default: `<camelCaseSlug>AccessToken`.
- **OAuth authorize / token URLs** — optional, stored in the catalog for the OAuth proxy.

For Google, ask:
- **Which `session.google<X>` client to reuse**, OR a new API + version (e.g. `photos/v1`). If a new client is needed, the skill must also extend `UserSession` and instantiate the client in the three factory functions in `src/userSession.ts`.

Icon URL is optional; default `null`.

### 3. (Optional) Clone and analyze the reference repo

If a github-url was given:

1. Shallow clone: `git clone --depth 1 <url> /tmp/mcp-source-<slug>`.
2. Capture commit sha (`git -C /tmp/mcp-source-<slug> rev-parse HEAD`) for attribution.
3. Detect language: `package.json` → TypeScript; `pyproject.toml` or `requirements.txt` → Python; else stop adaptation and tell the user.
4. Read `references/translation.md` for tool discovery patterns and schema/auth/error translation tables.
5. Port every discovered tool. Don't ask per-tool — the user picked "all".
6. Delete the temp clone after the scaffold is written.

Every ported tool gets a one-line attribution comment: `// Adapted from <url>@<sha> <relative-path>:<line>`. This is the only way to audit ports later, so don't skip it.

When a source body is non-trivial, prefer a TODO stub over an approximate translation. Silent approximations are the worst-case outcome: the tool compiles, looks ported, and is wrong. The TODO template (`assets/ported-tool-todo.ts.tmpl`) pastes the original body inside a block comment so the user can finish it deliberately.

### 4. Generate the server files

Templates live in `assets/` so they can be edited without touching SKILL.md. Substitute the placeholders (`{{slug}}`, `{{slugCamel}}`, `{{displayName}}`, etc.) and write:

- `src/<slug>/server.ts` — from `assets/server-google.ts.tmpl` or `assets/server-third-party.ts.tmpl`.
- `src/<slug>/apiHelpers.ts` — from `assets/apiHelpers.ts.tmpl` (third-party only).
- `src/__tests__/<slug>.test.ts` — from `assets/test-stub.ts.tmpl`.

If tools were ported in step 3, replace the placeholder `ping` tool with the ported ones. Otherwise the `ping` tool stays as a working starting point.

The `ping` tool in both server templates is intentionally minimal; for the canonical shape of real tools (Zod conventions, `UserError` mapping, `log.info` breadcrumb, response formatting), see `../add-mcp-tool/references/tool-pattern.md`. Both skills point at the same document so the tool shape stays consistent across the codebase.

### 5. Wire registration

This is the part future contributors are most likely to miss, so do it in this order:

**a. `src/auth/scopeMap.ts`** — add an entry to both `ROUTE_SCOPE_MAP` (route → scope) and `SLUG_SCOPE_MAP` (slug → scope). The scope value is `mcp:<slug>` — except for slugs prefixed `google-`, where the convention is to drop the prefix (`google-sheets` → `mcp:sheets`). Match the existing entries.

**b. `src/google-docs/server.ts`** — this file holds the dispatch ternary that picks which MCP server boots when `MCP_SLUG` is set (around line 1852). Two edits:
- Add `import { <slugCamel>Server } from '../<slug>/server.js';` near the other server imports at the top.
- Add a branch to the ternary: `: MCP_SLUG === "<slug>" ? <slugCamel>Server`.

Without this, the new server compiles but never runs — the symptom is the wrong MCP responding on the route.

**c. `src/userSession.ts`** — third-party only:
- Add the token field to the `UserSession` interface (group with the existing third-party fields).
- Default the field to `undefined` in the three session factory functions. The factories appear in roughly three places — look for blocks already initializing `clickUpAccessToken` or `slackBotToken` and mirror them.

If the user picked a new Google API, also add the client field to `UserSession`, instantiate it via `google.<api>({ version: '<v>', auth: oauthClient })` in the two real-session factories, and null-default it in the third-party-only factory.

**d. `data/mcp-catalog.json`** — append a new entry. Compute the next id by reading the file (`max(id) + 1`). Both timestamps use `new Date().toISOString()`. Use the shapes below.

Google entry:
```json
{
  "id": <next-id>,
  "slug": "<slug>",
  "name": "<display-name>",
  "description": "<description>",
  "iconUrl": null,
  "mcpUrl": "/<route>",
  "scopes": ["<google-api-scope-url>"],
  "googleClientId": null,
  "googleClientSecret": null,
  "oauthScopes": [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "<google-api-scope-url>"
  ],
  "isLocal": true,
  "isActive": true,
  "createdAt": "<iso>",
  "updatedAt": "<iso>"
}
```

Third-party entry — same shape plus `provider`, `oauthAuthorizationUrl`, `oauthTokenUrl`, and empty `oauthScopes`:
```json
{
  ...common fields...,
  "scopes": [],
  "oauthScopes": [],
  "provider": "<slug>",
  "oauthAuthorizationUrl": "<authorize-url-or-empty>",
  "oauthTokenUrl": "<token-url-or-empty>"
}
```

### 6. Update `CLAUDE.md`

- Add a row to the Tool Categories table.
- Add a row to the Source Files table pointing at `src/<slug>/server.ts`.
- If the source repo flagged any tools as unimplemented or had known limitations, surface them under Known Limitations so the user doesn't get bitten later.

### 7. Verify

Run `npm run typecheck`. Surface failures verbatim. Don't reach for `as any` or `// @ts-ignore` — the typechecker is catching the kind of cross-file slip this skill exists to prevent.

### 8. Report and offer the next step

End with a tight summary:
- Files created and patched (one bullet each, with path).
- Number of tools generated, split into fully translated vs TODO-stubbed.
- Source repo + commit sha if used.
- Anything the user still has to do manually (set env vars, add OAuth scopes in the provider console, register a new route in `webServer.ts` if a new Google API was introduced).

Then offer the soft chain:

> The server is scaffolded with a `ping` tool. Want me to add real tools now? Tell me the tool names and I'll invoke `/add-mcp-tool <name>` for each, using the same patterns.

If the user lists tools, follow `../add-mcp-tool/SKILL.md` for each one in turn — its procedure handles the addTool block, tools.ts classification, CLAUDE.md bump, and the optional e2e test chain. If the user says no, just mention they can run `/add-mcp-tool <name>` later.

This is a soft chain (suggestion, not auto-execution) because the user often wants to review the scaffold, run typecheck, and look at the diff before adding tools — not be rushed into more decisions while their attention is still on the server wiring.

Finally, delete `/tmp/mcp-source-<slug>` if it exists.

## Failure modes

Each of these is here because we've seen the failure mode in the wild or it produces a subtle broken state that the user won't notice immediately.

- **Source repo private or 404** — tell the user, ask for a different URL, don't proceed. Tools you invented from imagination are worse than no tools.
- **Source language unsupported** — only TS and Python are covered. Ask whether to scaffold without adaptation.
- **Slug already exists** — abort before any writes. Overwriting a working server is far worse than asking the user to pick another name.
- **Typecheck fails after scaffolding** — surface errors. Don't delete the new files; the user will likely fix them in place.
- **Tool name collisions between ported tools** — rename the second occurrence with a numeric suffix and flag in the report. Two tools with the same name silently shadow each other.
- **More than ~30 tools in the source** — confirm with the user before generating. This is a big diff and worth pausing for.

## Conventions reference

| Input | Form |
|-------|------|
| slug | `notion`, `google-photos` |
| camelCase export | `notionServer`, `googlePhotosServer` |
| display name (default) | `<Title Case> MCP Server` |
| route | same as slug unless user overrides |
| scope | `mcp:<slug>` (Google prefix stripped: `google-sheets` → `mcp:sheets`) |

## File layout

```
add-mcp-server/
├── SKILL.md
├── assets/
│   ├── server-google.ts.tmpl
│   ├── server-third-party.ts.tmpl
│   ├── apiHelpers.ts.tmpl
│   ├── test-stub.ts.tmpl
│   └── ported-tool-todo.ts.tmpl
└── references/
    └── translation.md     ← read only when porting from a github-url
```

## Relationship to other skills

- **`add-mcp-tool`** owns the canonical tool shape (`references/tool-pattern.md` over there). This skill's `ping` example deliberately stays minimal — for real tools, the user follows up with `/add-mcp-tool <name>` (offered as a soft chain in step 8).
- **`add-e2e-test`** scaffolds smoke tests. Not chained from here directly — the chain goes via `/add-mcp-tool`, which offers it for the tool the user just added.
