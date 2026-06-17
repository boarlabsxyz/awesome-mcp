---
name: ui-helper
description: Build and modify the frontend of this repo using the existing design tokens and components rather than inventing new ones. Covers both visual variants in the project — the marketing pages (light theme, Google blue #4285F4, system fonts) and the app dashboard (dark theme, Vercel blue #0070f3, Inter font) — plus the small inline error pages served from webServer.ts. Use this skill whenever the user wants to add, modify, or restyle anything in public/*.html or the inline HTML strings in src/website/webServer.ts — adding a new page, dropping in a button or card, building a modal or form, fixing inconsistent styling, or matching the dashboard look on a new surface. Also use when invoked as `/ui-helper <what to build>`.
metadata:
  argument-hint: <what to build or change>
---

# UI Helper

Help the user build frontend in this repo without drifting from the styles already there. The project ships two visual systems (marketing + app), and the most common failure mode for AI-written UI is inventing a third — slightly off colors, slightly wrong spacing, components that look adjacent to the rest but not quite the same. This skill exists to prevent that.

## The two variants

| | Marketing | App |
|---|---|---|
| **Used on** | Public unauthenticated pages | Authenticated dashboard / admin surfaces |
| **Files** | `public/index.html`, `public/success.html`, inline pages in `webServer.ts` | `public/dashboard.html`, `public/integrations.html`, `public/admin.html`, `public/updates.html` |
| **Theme** | Light | Dark |
| **Background** | `#f5f5f5` | `#000` |
| **Primary** | `#4285F4` (Google blue) | `#0070f3` (Vercel blue) |
| **Font** | System stack | Inter (Google Fonts) |
| **Container** | `.container`, max-w 1000px | `.page-container`, max-w 1200px |

Pick by **purpose**, not by aesthetic preference. A signed-in dashboard page in the marketing variant will look wrong next to the real dashboard; the reverse is also true. When the user's intent is ambiguous, ask before committing.

Full token reference is in `references/tokens.md` — read it when you need exact values for colors, spacing, type scales, or shadows. Don't paste hex codes from memory.

## Source-of-truth components

The canonical implementation of every UI component already lives in `public/*.html`. Copy from there rather than reinventing. `references/components-map.md` is the index — it tells you "for X, look at public/Y.html lines L–M".

For the highest-frequency components, `assets/components/<variant>/<name>.html` has ready-to-paste snippets with the HTML structure and the CSS together. These are convenience copies; the canonical source remains the `public/*.html` file referenced in `references/components-map.md`. If you change the source, expect to update the snippet too.

| Variant | Snippet | Purpose |
|---|---|---|
| marketing | `nav.html` | Top nav (brand + CTA) |
| marketing | `btn-cta.html` | Hero CTA button |
| marketing | `step-card.html` | Numbered step grid (How It Works pattern) |
| app | `header.html` | Sticky blurred header with brand + nav |
| app | `btn-primary.html` | Primary button (link or button) |
| app | `alert.html` | Success / error alerts |
| app | `section-header.html` | Section with uppercase #888 h2 + action button |
| app | `integration-card.html` | Grid item with icon, badge, tagline |
| app | `modal.html` | Overlay + dialog scaffold |
| app | `form-input.html` | Labeled text input with hint |
| app | `empty-state.html` | Zero-items placeholder with dashed border |

For anything not in this list — sidebars, instance rows, button variants like `btn-copy`/`btn-delete`, the multi-step modal pattern, MCP type selector — go to `references/components-map.md` and copy from the cited line range in the source file.

## Full-page templates

When the user is creating a brand new page rather than modifying an existing one, start from a template instead of writing the boilerplate by hand. The boilerplate is roughly 100 lines of a11y scaffolding + nav + body shell.

- `assets/templates/marketing-page.html` — new marketing/landing page.
- `assets/templates/app-page.html` — new dashboard surface.
- `assets/templates/minimal-error-page.html` — for inline `res.send(...)` responses in `webServer.ts`; small, no Inter dependency.

## Procedure

### 1. Identify the variant

Three signals, in order of strength:

1. **The file the user is editing.** `public/dashboard.html` and friends → app. `public/index.html`, `success.html`, or any inline HTML inside `src/website/webServer.ts` → marketing.
2. **The user's intent.** Words like "dashboard", "admin", "settings", "signed-in" → app. Words like "landing", "marketing", "registration", "homepage" → marketing.
3. **Surrounding context.** Look at the page's `<meta name="theme-color">` and the `body` rule. `#000`/dark → app. `#f5f5f5`/light → marketing.

If the user is editing inline HTML inside `webServer.ts` for what's clearly a brief error/redirect page, use `assets/templates/minimal-error-page.html` — full marketing chrome (nav, footer, Inter) would be heavy for a 5-line page.

If signals conflict — ask. Don't guess.

### 2. Reach for what already exists

Before writing CSS, check:
- Is there a component for this in `references/components-map.md`? If yes, copy from the cited source file or use a snippet from `assets/components/`.
- Does an existing page already do this thing? If yes, mirror that page's approach rather than starting fresh.
- Are you about to invent a new class name? Re-read the naming conventions in `references/components-map.md`. New names are a yellow flag — the existing pattern probably covers the case.

Only write net-new CSS when none of the above applies. New tokens (colors, radii, shadows) are an even stronger yellow flag — propose adding to `references/tokens.md` rather than scattering one-off values.

### 3. Preserve the a11y baseline

Both variants ship the same accessibility scaffolding (`:focus-visible`, `.skip-link`, `.sr-only`, `prefers-reduced-motion`, `touch-action: manipulation` on interactive elements). New pages start from a template, which includes all of this. When inserting a component into an existing page, don't accidentally remove these blocks. They're not decorative — keyboard and reduced-motion users depend on them.

### 4. Don't mix tokens across variants

The two variants' primary colors (`#4285F4` vs `#0070f3`) are visually close but the rest of the palette is incompatible. Symptoms of accidental mixing:
- A focus ring in the wrong shade of blue.
- `rgba(255,255,255,...)` borders on a light background (or `rgba(0,0,0,...)` on dark).
- Inter font loaded on a marketing page (or system fonts on the dashboard).
- A success/error alert with `#fff` background on the dashboard.

If you catch any of these, stop and switch variants explicitly.

### 5. Verify

Open the file the user changed and skim the result. Concrete checks:
- New CSS classes follow the naming conventions in `references/components-map.md` (`btn-*`, `*-card`, `section`, etc.).
- No new hex colors introduced; if any, they appear in `references/tokens.md`.
- The page's `<meta name="theme-color">` still matches the variant.
- Interactive elements have `touch-action: manipulation` and a hover state.

There's no build step for these static files, so reload the page in a browser to actually see the result when possible.

## When the user wants something we don't have

The default move is to compose existing components — most "new" UI needs are recombinations. When the user genuinely wants something new (a chart, a table, a date picker, a dropdown), surface that explicitly: "the project doesn't have a pattern for this yet; here's what I'd add — does the styling look right before I propagate it?" Adding to the design system is a deliberate decision, not a side effect of one task.

## File layout

```
ui-helper/
├── SKILL.md
├── references/
│   ├── tokens.md             ← canonical palettes, type, spacing, a11y baseline
│   └── components-map.md     ← which existing file to copy each component from
└── assets/
    ├── templates/
    │   ├── marketing-page.html
    │   ├── app-page.html
    │   └── minimal-error-page.html
    └── components/
        ├── marketing/        ← nav, btn-cta, step-card
        └── app/              ← header, btn-primary, alert, section-header,
                                integration-card, modal, form-input, empty-state
```
