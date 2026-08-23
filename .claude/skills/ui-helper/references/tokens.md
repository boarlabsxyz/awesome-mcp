# Design tokens

The project has two distinct visual systems. Pick by **purpose**, not by personal preference — the wrong choice produces visually broken pages because the surrounding chrome (nav, footer, sticky header) won't match.

## Variant: Marketing

Use for public-facing, unauthenticated pages — landing, registration success, error pages served from `webServer.ts`. Files: `public/index.html`, `public/success.html`, the inline `Account Not Found` page at `src/website/webServer.ts:242`.

```
Background        #f5f5f5     body
Surface           #fff        cards, panels
Text primary      #333
Text secondary    #555, #666
Text muted        #aaa
Border            #ddd, #eee
Primary brand     #4285F4     Google blue (cased as #4285f4 in success.html — accept both)
Primary hover     #3367d6
Success accent    #34a853     used as an icon background, not a text color
Error text        #c53030
Link              #2563eb     used in the inline error page; #4285F4 also acceptable
```

```
Font family       -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif
Hero h1           2.5rem / 700 / line-height 1.2 / text-wrap: balance
Section h2        1.5rem / text-wrap: balance
Card h3           1rem
Body              1rem / line-height 1.6 / text-wrap: pretty
Secondary copy    0.9rem–0.95rem
Microcopy         0.8rem
```

```
Card radius       12px
Card shadow       0 2px 12px rgba(0,0,0,0.06)     (success.html uses 0.08 — both fine)
Button radius     6–8px
Button padding    0.5rem 1.25rem (nav)  /  0.85rem 2rem (cta)
Container         max-width 1000px, margin auto, padding 0 2rem (success uses 600px)
Theme-color meta  #f5f5f5
```

## Variant: App

Use for authenticated, signed-in surfaces — dashboard, integrations browser, admin, changelog. Files: `public/dashboard.html`, `public/integrations.html`, `public/admin.html`, `public/updates.html`. Visual reference is Vercel's dashboard aesthetic.

```
Background        #000        body
Surface           #0a0a0a     modals, empty-state, sidebar cards
Surface hover     #111        nav-link hover, btn-logout hover
Subtle hover      rgba(255,255,255,0.03–0.05)
Text primary      #ededed
Text secondary    #888
Text muted        #666, #aaa
Border subtle     rgba(255,255,255,0.06–0.08)    (cards, dividers)
Border default    rgba(255,255,255,0.1)          (header, modal)
Border emphasis   rgba(255,255,255,0.15)         (inputs, hover state)
Primary brand     #0070f3     Vercel blue
Primary hover     #005bb5
Primary tint      rgba(0,112,243,0.1–0.15)       (selected MCP-type item, alerts, badges)
Primary on tint   #4ea3ff (badge text), #4f8df7 (subtle link)
Success           #34a853 + rgba(52,168,83,0.15) bg + rgba(52,168,83,0.3) border
Error             #dc3545 + rgba(220,53,69,0.15) bg + rgba(220,53,69,0.3) border
Warning           #f0ad4e, #f59e0b
```

```
Font family       'Inter', -apple-system, ... (loaded via Google Fonts: weights 400, 500, 600, 700)
H1 (page title)   1.5rem / 700 / letter-spacing -0.02em
H2 (section)      1.1rem / color #888 / TEXT-TRANSFORM: UPPERCASE / letter-spacing -0.02em
H3 (card)         1rem / 600 / letter-spacing -0.01em
Modal h3          1.2rem / letter-spacing -0.02em
Body              0.9rem–0.95rem / line-height 1.5–1.6
Microcopy         0.8rem–0.85rem
Badge             0.68rem / uppercase / letter-spacing 0.04em
```

```
Card radius       12px
Card padding      1.5rem
Card bg           rgba(255,255,255,0.03), border rgba(255,255,255,0.08)
Card hover        bg rgba(255,255,255,0.05), border rgba(255,255,255,0.15)
Button radius     6px (most)  /  4px (close icon)
Button padding    0.5–0.6rem 1rem
Modal             #0a0a0a, border rgba(255,255,255,0.1), radius 12px, max-w 500px
Empty state       padding 3rem, bg #0a0a0a, 2px dashed border rgba(255,255,255,0.15)
Header            sticky top:0, padding 1rem 0, border-bottom rgba(255,255,255,0.1),
                  backdrop-filter blur(12px), background rgba(0,0,0,0.8)
Container         max-width 1200px, padding 2rem
Theme-color meta  #000000
```

## Shared a11y baseline

Both variants ship the same accessibility scaffolding. Don't omit it on new pages — it's load-bearing for keyboard users.

```
* { margin: 0; padding: 0; box-sizing: border-box; }
:focus-visible { outline: 2px solid <primary>; outline-offset: 2px; border-radius: 4px; }
.skip-link { positioned off-screen, surfaces on :focus }
.sr-only { 1px clipped }
@media (prefers-reduced-motion: reduce) { transition-duration: 0.01ms !important; ... }
touch-action: manipulation;  on every link and button
```

The exact CSS for these lives in `assets/templates/*.html` — copy from there rather than retyping.

## When primary colors collide

Marketing uses `#4285F4` and app uses `#0070f3`. They are visually close but different. Don't mix them on the same page. The signal that you're in the wrong variant is `:focus-visible` ringing in the other shade.
