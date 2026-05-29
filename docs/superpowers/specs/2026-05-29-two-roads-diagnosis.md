# Two Roads deployed-site diagnosis — 2026-05-29

> Companion to `docs/superpowers/plans/2026-05-29-two-roads-visual-fixes.md` Phase 1. Read-only investigation of the most-recent Two Roads `site_builds` row (`982f0d57-5275-499a-92d8-5f00dc70dba1`, deployed to `https://two-roads-ioux1tk5u-skmdigital.vercel.app`) to determine which silent-degradation paths fired and which the plan's hypotheses got wrong.

## Identifiers

| Field | Value |
|---|---|
| project.id | `075e33fd-8984-4e48-b58e-a9eab54d1828` |
| project.name | `two-roads` |
| project.wp_url | `https://tworoadsbrewing.com/` |
| latest build.id | `982f0d57-5275-499a-92d8-5f00dc70dba1` |
| build.status | `verifying` |
| build.preview_url | `https://two-roads-ioux1tk5u-skmdigital.vercel.app` |

## Phase A capture state

| Signal | State | Source |
|---|---|---|
| `design_tokens.shellDom.header` | captured, 4664 chars | projects table |
| `design_tokens.shellDom.footer` | captured, 6791 chars | projects table |
| `design_tokens.themeStylesheets` | **empty array (0)** | projects table |
| `design_tokens.themeJson` | **null** (classic theme, no `theme.json`) | projects table |
| `design_tokens.colors` | `{primary: "#ffc72c" @ 0.85, secondary: "#ff6900" @ 0.7, accent: "#cf2e2e" @ 0.55}` | scrape-agent output |
| `design_tokens.typography` | `{heading: "Anton" @ 0.95, body: "Source Sans Pro" @ 0.9}` | scrape-agent output |

## Shell LLM run state

| Shell | compile_status | attempts | model | tokens (in/out) |
|---|---|---|---|---|
| Header | `ok` | 1 | claude-sonnet-4-6 | 2108 / 2757 |
| Footer | `ok` | 1 | claude-sonnet-4-6 | 1939 / 6099 |

**Both shell LLMs ran successfully.** No deterministic fallback fired. The visual regressions in masthead and footer come from prompt-quality issues, not the fallback emitter — this rules out Case A in plan §2.2 and shifts attention entirely to Case B.

## Symptom → root cause table

| Symptom | Plan hypothesis | Actual state from build artifacts | Confirmed? |
|---|---|---|---|
| Masthead white instead of brand yellow | Deterministic fallback or LLM didn't see hex values | `Header.tsx` line 62: `<div id="masthead" className="brand-is-light bg-white w-full shadow-sm">`. LLM ran successfully but produced `bg-white`. **Brand colors (`#ffc72c` primary) live in `design_tokens.colors`, but compose-site.ts:212 reads `designTokens.themeJson ?? null`**. `themeJson` is null for the classic Two Roads theme, so `themeTokens = null` is passed to `generateShell`, and the prompt's token section emits `Colors: (none)`. | **Yes — confirmed prompt-input bug, not a fallback bug** |
| Footer constrained instead of full-bleed | Deterministic fallback OR LLM prompt missing full-bleed instruction | `Footer.tsx` line 5–6: `<footer ... className="bg-gray-900 text-gray-300 py-12"><div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">`. LLM ran successfully and chose `max-w-7xl` even though source footer is full-bleed. No instruction in `sharedShellSystemPrompt` constrains this choice. | **Yes — prompt-quality issue** |
| Body fonts wrong (Source Sans Pro / Anton not loading) | `theme.css` empty or `@font-face` URLs broken | **`styles/theme.css` does not exist in Storage** (`Object not found`). Cause: `captureHomepageDesign()` filters `<link rel="stylesheet">` to URLs containing `/wp-content/themes/` (capture-theme-stylesheets.ts:101). Two Roads uses **ShortPixel optimization** (visible in the footer's `sp-ao.shortpixel.ai/...` image URLs) — the optimization plugin combines theme CSS into a `/wp-content/cache/...` or CDN URL that the path filter rejects. Result: 0 stylesheets captured, no `theme.css` emitted, generated app falls back to OS sans-serif. The scrape-agent did extract `typography.heading: "Anton"` and `typography.body: "Source Sans Pro"`, but **these are never threaded into `tailwind.config.ts` either** — `emitTailwindConfigTs()` consumes `ThemeJsonTokens` only, which is null. | **Yes — confirmed two compounding bugs: stylesheet capture too-strict filter AND scraped typography never emitted** |
| Hero, featured-beer, event-card, news-thumbnail images broken | `next.config.ts` lacks WP host OR component-level placeholders OR runtime data shape | **`next.config.ts` is correctly emitted with `hostname: "tworoadsbrewing.com"`** — `emitNextConfigTs()` does have a `"**"` wildcard fallback path on URL parse failure (a latent bug), but it didn't fire here. The actual breakage is **component-level**: `FeaturedBeer.tsx` defines `interface BeerPost { ID; post_title; post_name; post_type }` (no image field) and renders an explicit `<BeerPlaceholderImage>` with the comment `"Image area — actual images loaded at runtime via CMS"` — the LLM reasoned that images would be filled in elsewhere because its field summary didn't include the beer's `featured_image` / ACF image fields. `UpcomingEvents.tsx` defines `interface EventAttrs { image_url?: string }` and the runtime ACF likely returns events in a different shape (post-object lookups), so `event.image_url` is undefined at runtime → background-image renders nothing. `FeaturedNews.tsx` types `featured_image?: string` (not `{url,alt}`) so an object-shaped value would also fail. `LargeHero.tsx` uses raw `<img>` and inline `backgroundImage` correctly — that one's a runtime data issue at most. | **Yes — primary cause is Phase B prompt omitting image-bearing field summaries; next.config.ts hostname fix is unnecessary for the primary host but the `"**"` fallback is still latent** |

## What the plan got wrong / right

**Wrong:**
- **§2.1 main hypothesis** — `next.config.ts` is correctly emitted; the WP host is in remotePatterns. The `wp_url` validation hardening still makes sense as defense in depth, but it would not have fixed Two Roads. The real images bug is Phase B's prompt context.
- **§2.2 Case A** — fallback did not fire; only Case B applies. The fallback-hardening work is not necessary for this pilot, though still defensive.
- **§2.4 second branch (`@font-face` relative URL rewriting)** — moot. `theme.css` doesn't exist because capture failed entirely, not because URLs were relative.

**Right:**
- **§2.1.4** placeholder diagnosis — exactly correct. FeaturedBeer is the smoking gun.
- **§2.2 Case B** — exactly correct. `renderTokenSection` sends slug names without hex; the LLM cannot map source `#FDB813`-yellow → `bg-primary` without that mapping. **Additional finding:** there's no slug→hex data to send in the first place, because `themeTokens` is null for classic themes. Fix needs an adapter from `design_tokens.colors` shape → `ThemeJsonTokens` shape.
- **§2.3 LLM prompt fix** — correct. The shared system prompt needs an explicit footer-width instruction.
- **§2.4 first branch (capture failed)** — correct symptom, but root cause is the filter being too strict (excludes optimization-plugin-rewritten URLs), not Cloudflare blocking.

## Concrete fix list (revised after diagnosis)

In priority order:

1. **Image placeholders (Phase B prompt context)** — add image-bearing field summaries (featured_image, ACF image fields, post-object lookups) to the component-generator's field context so the LLM sees the URL paths. Highest visual leverage.
2. **Brand colors in shell + tailwind (adapter for classic themes)** — add an adapter from `design_tokens.colors` / `design_tokens.typography` → `ThemeJsonTokens` shape, plumb through `compose-site.ts:212`. Update `renderTokenSection` to emit slug + hex pairs. Add the explicit color-binding instruction to `sharedShellSystemPrompt`.
3. **Footer full-bleed** — add the explicit "no max-width container for full-bleed source footer" instruction to `sharedShellSystemPrompt`. (Trivial follow-on once §2 is in flight — same prompt module.)
4. **Theme stylesheet capture broadening** — relax the `/wp-content/themes/` filter in `captureHomepageDesign()` to also include other site-origin stylesheets when no theme-path sheets are found, then test against Two Roads (with its ShortPixel pipeline). Defensive fallback: still emit `theme.css` (empty allowed) so generated app structure is consistent.
5. **Loud errors for unrelated silent paths** — `emitNextConfigTs("**")` fallback is wrong (Next.js rejects bare `**`). Throw on URL parse failure rather than emit invalid config. Defense in depth even though it didn't fire here.

## Defaults the diagnosis confirms

- `app/page.tsx` correctly calls `jab/get-page-by-slug` with `include: { blocks: true }` and the right slug `"two-roads-brewing-new"`.
- Block dispatcher and compose-block-tree are wired correctly (21 components emitted, 3 block types).
- Logo storage path resolves and renders (`/projects/<id>/logo.png` works in Header).
- Phase D deploy succeeded; this is a Phase A/B/C output-quality problem, not a deploy problem.

## Files referenced during diagnosis

- `apps/web/lib/inngest/functions/compose-site.ts:212` — `themeJson ?? null` adapter bug
- `apps/web/lib/jab/compose-site-emit.ts:157` (`emitNextConfigTs`), `:453` (`emitTailwindConfigTs`)
- `apps/web/lib/ai/shell-prompts.ts:57` (`renderTokenSection`), `:87` (`sharedShellSystemPrompt`), `:161` (`shellDeterministicFallback`)
- `apps/web/lib/jab/capture-theme-stylesheets.ts:101` — strict `/wp-content/themes/` filter
- Storage `builds/982f0d57.../project/components/blocks/AcfFlexPagePageBuilderFeaturedBeer.tsx` — placeholder smoking gun
- Storage `builds/982f0d57.../project/components/blocks/AcfFlexPagePageBuilderUpcomingEvents.tsx` — `image_url?: string` schema mismatch
- Storage `builds/982f0d57.../project/components/blocks/AcfFlexPagePageBuilderFeaturedNews.tsx` — `featured_image?: string` shape mismatch
- Storage `builds/982f0d57.../project/components/site/Header.tsx` line 62 — `bg-white`
- Storage `builds/982f0d57.../project/components/site/Footer.tsx` line 6 — `max-w-7xl mx-auto`
