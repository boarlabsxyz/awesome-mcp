# Components map

Pointer to where each existing component lives in source. Copy from the file referenced — these are the canonical implementations. Updating them in source is the right way to evolve the design; the snippets in `assets/components/` are convenience copies for the most-used ones, so if you change the source make sure the snippet still tracks.

## Marketing variant (`#4285F4`, light)

| Component | Source | Notes |
|---|---|---|
| Page shell + a11y baseline | `public/index.html:1-205` | Container max-width 1000px |
| Centered card layout | `public/success.html:53-63` | Container max-width 600px |
| Top nav (brand + CTA) | `public/index.html:46-82` | `.nav`, `.nav-brand`, `.nav-link`, `.nav-inline` |
| Hero | `public/index.html:85-128` | `.hero`, `.btn-cta`, `.hero-secondary` |
| Step cards (numbered) | `public/index.html:130-172` | `.steps`, `.step`, `.step-number` |
| Footer | `public/index.html:187-194` | `.footer` |
| API-key + config blocks | `public/success.html:86-` | `.api-key-section`, `.config-section` |
| Inline 50-line error page | `src/website/webServer.ts:242` | Use `assets/templates/minimal-error-page.html.tmpl` |

## App variant (`#0070f3`, dark)

| Component | Source | Notes |
|---|---|---|
| Page shell + a11y baseline | `public/dashboard.html:1-53` | Container `.page-container`, max-w 1200px |
| Sticky blurred header | `public/dashboard.html:60-105` | `.header`, `.header-right`, `.nav-link`, `.nav-separator` |
| Primary button | `public/integrations.html:96-107` | `.btn-primary` — use this name on new pages |
| Add/CTA button (icon + text) | `public/dashboard.html:178-195` | `.btn-add` |
| Logout / secondary button | `public/dashboard.html:114-128` | `.btn-logout` |
| Alert (success / error) | `public/dashboard.html:131-146` | `.alert`, `.alert-success`, `.alert-error` |
| Section header w/ button | `public/dashboard.html:162-195` | `.section`, `.section-header` — h2 uppercase #888 |
| Instance row (avatar + text + actions) | `public/dashboard.html:198-355` | `.instance-row` family — copy the whole block |
| Integration card (grid item) | `public/integrations.html:127-200` | `.integration-card`, `.integration-head`, etc. |
| Provider badge | `public/integrations.html:182-194` | `.provider-badge` — pill, uppercase 0.68rem |
| Sidebar info card | `public/dashboard.html:357-403` | `.sidebar-card`, `.sidebar-steps` |
| Empty state | `public/dashboard.html:405-415` | `.empty-state` — dashed 2px border |
| Loading state | `public/dashboard.html:417-421` | `.loading` |
| Modal (overlay + dialog) | `public/dashboard.html:432-487` | `.modal-overlay`, `.modal`, `.modal-header`, `.btn-close` |
| Form input (label + text) | `public/dashboard.html:540-565` | `.name-input-section` |
| Choice list (modal step) | `public/dashboard.html:489-537` | `.mcp-type-list`, `.mcp-type-item` |

## What's in `assets/components/`

Curated snippets for the components touched most often when adding new pages. If you don't see what you need there, copy from the source file in the table above.

- `assets/components/marketing/`: `btn-cta`, `nav`, `step-card`
- `assets/components/app/`: `header`, `btn-primary`, `alert`, `section-header`, `integration-card`, `modal`, `form-input`, `empty-state`

## Naming convention for new components

Match what's already there. Don't introduce a new naming style:

- Buttons: `btn-<purpose>` — `btn-primary`, `btn-logout`, `btn-copy`, `btn-delete`.
- Cards: `<noun>-card` — `integration-card`, `sidebar-card`.
- Modal pieces: `modal`, `modal-overlay`, `modal-header`, `modal-step`.
- Sections: `section`, `section-header`.
- Page wrappers: `page-container` (app), `container` (marketing).

If you'd use a different name on a new feature than the table above suggests, that's a yellow flag — the existing pattern probably already covers your case.
