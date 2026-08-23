---
name: update-integrations
description: Sync the public integrations page (`public/integrations.html`) with the MCP servers this platform actually exposes. The page is 100% dynamic — it renders whatever `/api/v1/catalogs` returns — so there is nothing per-MCP to edit in the HTML itself. The two committed sources that drive it are `seedDefaultCatalogs()` in `src/mcpCatalogStore.ts` (which MCPs appear) and the `SAMPLE_PROMPTS` map in `src/website/webServer.ts` (the "Sample Prompts" section on each card). This skill diffs the catalog against `SAMPLE_PROMPTS`, adds prompts for any MCP that's missing them (so its card stops showing "Sample prompts coming soon."), and flags catalog/icon gaps. Use whenever the user wants to update, sync, or audit the integrations page after adding or changing an MCP server, or invokes `/update-integrations [slug]`. Chained as a soft follow-up from `add-mcp-server`.
metadata:
  argument-hint: <slug | all>
---

# Update Integrations Page

Keep the public **Integrations** page (`public/integrations.html`, served at `/integrations`) in sync with the MCP servers this platform exposes.

## The key fact: the page is dynamic

`public/integrations.html` fetches `/api/v1/catalogs` on load and renders one card per entry. **You do not edit the HTML to add an MCP.** A card appears automatically once the MCP is in the catalog. The only thing that is *not* automatic is the per-card **Sample Prompts** section, which comes from a hand-maintained map on the server.

So the integrations page is driven by exactly two committed sources:

| Source | Controls | Owned by |
|--------|----------|----------|
| `seedDefaultCatalogs()` in `src/mcpCatalogStore.ts` | **whether an MCP appears** at all (name, description, icon, provider, scopes) | `add-mcp-server` step 5d |
| `SAMPLE_PROMPTS` in `src/website/webServer.ts` (~line 2192) | the **Sample Prompts** list on each card | **this skill** |

A third source, `data/mcp-catalog.json`, is the local (no-`DATABASE_URL`) fallback backend. It is **gitignored and self-healing** — `seedDefaultCatalogs()` upserts every slug into it on each boot (`fileCreateMcpCatalog` updates-by-slug). Do **not** hand-edit it; a stale copy fixes itself on the next `npm run dev`.

The practical consequence: if an MCP is wired correctly by `add-mcp-server` but its card shows *"Sample prompts coming soon."*, the fix is a `SAMPLE_PROMPTS` entry here — nothing else.

## Inputs

- `[slug]` — a single MCP slug (`clickup`, `peopleforce`, `hubspot`, …) or `all`. Default: `all`.

If a slug is given that isn't in the catalog, say so and stop — an MCP with no catalog entry never renders a card, so sample prompts for it are dead data. Point the user at `/add-mcp-server` first.

## Procedure

### 1. Enumerate the catalog slugs

Read `seedDefaultCatalogs()` in `src/mcpCatalogStore.ts` and collect every `slug:` passed to a `createMcpCatalog({...})` call. This is the authoritative list of MCPs that render on the page (Postgres and the JSON fallback are both seeded from it). Do **not** rely on `data/mcp-catalog.json` — it may be stale.

### 2. Read the current `SAMPLE_PROMPTS`

Open `src/website/webServer.ts`, find `const SAMPLE_PROMPTS: Record<string, string[]> = {` (~line 2192), and collect the keys already present.

### 3. Compute the diff

- **Missing** — catalog slugs with no `SAMPLE_PROMPTS` key. These render *"Sample prompts coming soon."* on their card → fill them (step 4).
- **Orphaned** — `SAMPLE_PROMPTS` keys not in the catalog. Flag; do not delete blindly (could be a renamed slug or a not-yet-seeded MCP). Mention in the report.
- **Icon gaps** (report-only) — catalog entries whose `iconUrl` is `null` show the 🔌 fallback. Not this skill's job to fix, but worth a one-line note so the user can supply a logo URL if they care.

If a single `[slug]` was requested, narrow the diff to just that slug.

### 4. Write sample prompts for each missing slug

Add a `'<slug>': [ ... ]` block to the `SAMPLE_PROMPTS` object. Keep it consistent with the existing entries — that house style is the spec:

- **Exactly 3 prompts.** The card layout is tuned for three.
- **First-person, imperative, concrete.** "Who's out on leave next week?", not "Query the absence API." They read like something a user would actually type to their assistant.
- **Grounded in the MCP's real tools.** Skim `src/<slug>/server.ts` tool names/descriptions (or the CLAUDE.md limitations section) and pick three that map to real, implemented capabilities — one read, one write, one search/summarize is a good spread. Don't promise a capability the server doesn't have.
- **No fake specifics that look real.** Placeholder names (`jane@acme.com`, `#eng-platform`, `Acme Corp`) are fine; a plausible-but-fake internal doc ID is not — it reads as a broken example.
- Escape apostrophes in single-quoted strings (`'Who\'s out…'`) or use the existing quoting style.

Insert the new block just before the closing `};` of the map, mirroring the indentation of the surrounding entries.

### 5. Verify

```
npx tsc --noEmit
```

`SAMPLE_PROMPTS` is plain TS, so a typo (missing comma, unclosed bracket) is caught here. There is no count assertion to bump — `src/__tests__/routes.test.ts` only checks that every catalog entry exposes a `samplePrompts` *array*, which an empty list already satisfies. Run `npm test` only if you touched anything beyond the map.

Optionally confirm the render locally: `npm run dev`, open `/integrations`, and check the target card now lists prompts instead of the "coming soon" placeholder.

### 6. Report

- Slugs that gained prompts (with the 3 lines each, so the user can tweak wording).
- Any orphaned `SAMPLE_PROMPTS` keys and any `iconUrl: null` catalog entries.
- **Redeploy note:** `SAMPLE_PROMPTS` lives in `src/website/webServer.ts` (server code, not `public/`), so the **web** service must be redeployed for the change to reach production — a `public/` rebuild alone won't ship it.

## Failure modes

- **Editing the HTML to "add a card"** — the page is dynamic; hand-adding markup is wrong and gets overwritten by the render. The card comes from the catalog; the prompts come from `SAMPLE_PROMPTS`. Nothing else.
- **Hand-editing `data/mcp-catalog.json`** — gitignored, local-only, and self-healing on boot. Editing it is churn that never reaches the PR or prod. If a slug is genuinely absent everywhere, the gap is in `seedDefaultCatalogs()` (an `add-mcp-server` step 5d miss), not here.
- **Prompts for an MCP with no catalog entry** — dead data. No card ever renders it. Confirm the slug is in `seedDefaultCatalogs()` first.
- **Over-promising capabilities** — a sample prompt implying a tool the server doesn't have misleads users at the first click. Cross-check against `src/<slug>/server.ts`.

## Relationship to other skills

- **`add-mcp-server`** wires the catalog entry (step 5d/5e) so the card renders. It offers this skill as a soft chain so the new card ships with real sample prompts instead of the placeholder. That's the intended trigger for most runs of this skill.
- **`update-openapi`** is the sibling "sync a generated/derived surface after adding an MCP" skill for the ChatGPT Custom Actions specs; same spirit, different surface.
