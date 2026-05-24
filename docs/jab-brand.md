# JAB brand system — `apps/web`

> The JAB dark brand is implemented across the public marketing site and the
> authenticated product surface as of 2026-05-24. This doc is the canonical
> reference for the palette, typography, tokens, and conventions any UI work
> in `apps/web` should follow. Read this before touching any visual surface.
>
> Source-of-truth design files live in the handoff bundle from
> `claude.ai/design` — JAB Homepage, JAB Dashboard, JAB Site Detail, JAB
> Brand Guidelines, JAB Style Guide. The implementation reproduces their
> visual output; it does not copy their inline `<style>` structure.

---

## Palette

All colors live as **CSS custom properties in space-separated RGB-triplet
form** so Tailwind's `<alpha-value>` placeholder works — that's what makes
`bg-teal/10`, `border-bord/20`, and the auth-aware nav's `bg-bg/90` glass
effect possible. Defined in [`apps/web/app/globals.css`](../apps/web/app/globals.css)
and surfaced as Tailwind utility classes via
[`apps/web/tailwind.config.ts`](../apps/web/tailwind.config.ts).

### Surface scale (darkest → lightest)

| Token   | Hex       | Use                                       |
|---------|-----------|-------------------------------------------|
| `bg`    | `#060d16` | Page background, sidebar background, cards inside surfaces |
| `surf`  | `#0a1628` | Body default, alt-section backgrounds, browser-chrome bars |
| `elev`  | `#0f2040` | Elevated chips/badges, hover states for `bg` surfaces       |
| `bord`  | `#1a3158` | All hairline borders                                        |

### Brand & semantic accents

| Token  | Hex       | Use                                                  |
|--------|-----------|------------------------------------------------------|
| `teal` | `#00c9a7` | Primary CTA, active states, success, links of import |
| `blue` | `#2563ff` | URLs, info-tone accents                              |
| `red`  | `#ff4444` | Errors, destructive actions                          |
| `amb`  | `#f59e0b` | Warning, in-progress, mid Lighthouse scores          |

### Text scale

| Token   | Hex       | Use                                          |
|---------|-----------|----------------------------------------------|
| `wht`   | `#f0f4f8` | Primary text, headlines                      |
| `gry`   | `#7a9ab8` | Body copy, secondary text                    |
| `gry-d` | `#3a5070` | Tertiary, mono labels, separator captions    |

---

## Typography

Three Google fonts, loaded via `next/font/google` in
[`apps/web/app/layout.tsx`](../apps/web/app/layout.tsx) and exposed as
CSS variables consumed by Tailwind:

| Family          | CSS var           | Tailwind class | Use                                                     |
|-----------------|-------------------|----------------|---------------------------------------------------------|
| Syne            | `--font-display`  | `font-display` | Logo (JAB wordmark + site-initial avatars) and page hero spots only — the top-of-page H1 on marketing landings and the bottom closing-CTA H2 that mirrors it |
| DM Sans         | `--font-body`     | `font-body`    | Body copy, buttons, links, **and all sub-headlines** — page titles in the app, card titles, stat values, mid-page section banners, modal/empty-state headings. Applied via `<body>`, so the secondary headline pattern is `text-[size] font-bold leading-snug text-wht` with no font class — DM Sans is inherited |
| JetBrains Mono  | `--font-mono`     | `font-mono`    | Section labels, URLs, codes, chips, deploy IDs, captions |

### Why the narrow Syne footprint (2026-05-24)

Syne reads beautifully at 40px+ as a brand voice but its proportions
make sub-headlines and stat values harder to scan than DM Sans at the
same size — particularly at `text-sm`/`text-base`/`text-lg` where most
in-app titles live. The rule shifted to: **Syne earns its place only
where the brand needs to assert itself** (the logo + the two hero
spots per marketing page). Everything else falls through to DM Sans by
omitting `font-display`. Resist re-adding `font-display` to card
titles, stat values, or sub-section headings — the readability cost
outweighs the visual cohesion you'd gain.

### Descender rule

The handoff chat surfaces a real bug — `g j p q y` in Syne headlines
get clipped at tight line-heights. **Use `leading-[1.15]` or looser on
any Syne heading.** This still applies to the surviving Syne spots —
the marketing hero H1s and the bottom CTA H2 — even though most former
offenders (the dashboard `stat-val`, the Site Detail site-name)
switched to DM Sans and no longer need the rule.

---

## Tailwind tokens — naming & legacy

The new JAB tokens (`bg`, `surf`, `elev`, `bord`, `teal`, `blue`, `red`,
`amb`, `wht`, `gry`, `gry-d`) are first-class Tailwind colors. Prefer
them in all new code.

**The legacy semantic tokens are still defined** —
`brand|success|warning|danger|info` with `DEFAULT` / `muted` / `strong`
variants — because primitives like `Alert` and `Badge` exposed them as
part of their public `tone="success|warning|..."` API. Removing them
would have meant a coupled change across ~25 component consumers; instead
they're remapped to the JAB equivalents in
[`tailwind.config.ts`](../apps/web/tailwind.config.ts) so existing call
sites keep working.

**Rule:** never introduce business-state vocabulary (`live`, `building`,
`error`) at the primitive layer. Build a thin wrapper at the call site
that maps business state → semantic tone (`live → success`,
`building → warning`, etc.). The Site Detail page's `StatusChip` is the
reference example.

### Border radius

Defaults are overridden: `rounded-md` = 8px (buttons, inputs, chips) and
`rounded-lg` = 12px (cards). Don't sprinkle `rounded-xl` to get the
larger radius — use `rounded-lg`.

### Opacity modifiers

Because all colors are stored as RGB triplets, every opacity modifier
works on every token: `bg-teal/10`, `border-bord/40`, `bg-bg/90`. Use
these instead of inventing new fixed-alpha tokens.

---

## Component locations

| Layer                  | Path                                                   |
|------------------------|--------------------------------------------------------|
| Foundation tokens      | `apps/web/app/globals.css`, `apps/web/tailwind.config.ts` |
| Root layout (fonts)    | `apps/web/app/layout.tsx`                              |
| Workspace shell        | `apps/web/components/ui/workspace-shell.tsx`           |
| App shell (signed-in)  | `apps/web/app/(app)/app-shell.tsx`                     |
| Marketing chrome       | `apps/web/components/marketing-chrome.tsx`             |
| Auth shell             | `apps/web/components/ui/auth-shell.tsx`                |
| Onboarding shell       | `apps/web/components/ui/onboarding-shell.tsx`          |
| Primitives             | `apps/web/components/ui/*.tsx`                         |
| Composed components    | `apps/web/components/*.tsx`                            |

---

## Marketing chrome — auth-aware

`MarketingHeader` and `MarketingFooter` are **async Server Components**
that call `supabase.auth.getUser()` and adapt:

- **Signed out** — nav shows `Sign in` + teal `Try it free` (routes to
  `/preview`, the wow-before-friction path); footer bottom-row has
  `Try it free` / `Pricing` / `Sign in`.
- **Signed in** — nav collapses to a single `Open dashboard` teal CTA;
  footer bottom-row has `Dashboard` / `Pricing`.

The auth lookup is wrapped in try/catch so a misconfigured Supabase at
runtime degrades to the signed-out state — public routes must never
crash. The lookup is repeated in `MarketingHeader` and `MarketingFooter`
(rather than threaded through props) so consumers stay ignorant of
auth — within a single request Supabase caches the JWT decode anyway.

---

## Site Detail page architecture

`apps/web/app/(app)/projects/[id]/page.tsx` is the reference for the
"real data + mocked extras" pattern any Phase 2 page should follow:

- **Real data** comes from a single Supabase query (`projects` row).
- **Derived values** (status chip mapping, site-icon initials, display
  domain) live in [`apps/web/lib/derive.ts`](../apps/web/lib/derive.ts).
  When the deployments-derived status fields land, only this file
  changes — pages stay untouched.
- **Mocked extras** (Lighthouse, deploys, WP sync, AI history) live in
  [`apps/web/app/(app)/projects/[id]/mocks.ts`](../apps/web/app/(app)/projects/[id]/mocks.ts)
  as typed object literals with `TODO(phase 2):` comments pointing at
  the tables that'll back them.

The page itself **owns its topbar** — the WorkspaceShell topbar slot is
conditional and only renders when `headerLeft`/`headerRight` are passed.
The Site Detail page renders a sticky topbar inline so it can fit a
breadcrumb + actions without a duplicate empty bar above it.

---

## Extending the brand

**Adding a page**: start from the JAB token set. Use `bg-bg` or
`bg-surf` for the page background, DM Sans (inherited — just omit
`font-display`) for headlines, `font-mono` for labels/chips/code,
`text-wht` / `text-gry` / `text-gry-d` for the text scale. Cards use
`rounded-lg border border-bord bg-bg`. `font-display` is reserved for
the JAB wordmark, site-initial logo avatars, and the topmost hero H1 +
closing-CTA H2 on marketing pages — see the typography table above.

**Adding a primitive**: keep the `tone="success|warning|danger|info"`
semantic API. Map tones to JAB tokens at the variant level. Don't leak
business vocabulary into primitives.

**Adding a Site Detail tab**: lift the existing sub-component layout
(card with `border-b border-bord` header bar + body rows). Reuse the
helpers in `lib/derive.ts` for any status-chip rendering.

**Adding new colors**: don't. If you need a new accent, justify it
against the four existing accents (`teal`, `blue`, `red`, `amb`). The
brand is intentionally narrow.

---

## Anti-patterns

- **Inline hex values** outside of decorative artifacts (browser-chrome
  traffic-light dots, gradient blobs that don't repeat). Everything else
  uses tokens.
- **`bg-white`, `text-slate-*`** — the foundation sweep removed these
  from authenticated and marketing routes. If a sweep missed one, fix
  it; don't add new ones.
- **`rounded-xl` to get a larger radius** — `rounded-lg` is 12px now.
- **Business state in primitive tone enums** — see the rule above.
- **Sub-1.15 line-height on Syne headlines** — descenders clip.
- **`font-display` on sub-headlines, card titles, stat values, or
  in-app page titles** — Syne is reserved for logos + hero spots
  (2026-05-24 narrowing, readability-driven). Use DM Sans inherited
  from `<body>`; the pattern is `text-[size] font-bold leading-snug
  text-wht` with no font class.

---

## Out of scope

- `/ui-kit/*` demo routes were not swept. They're dev-only kitchen
  sinks. Migrate them ad-hoc when they're referenced as the canonical
  shape for a new feature.
- Server-rendered brand assets (OG images, email templates, PDF
  exports) are untouched. They keep their old visual treatment until a
  dedicated pass.
- A real mobile nav for the WorkspaceShell. The sidebar is `hidden
  sm:flex` — below the `sm` breakpoint the entire nav is inaccessible.
  Engineering follow-up before agencies who log in from their phones
  encounter the product.
