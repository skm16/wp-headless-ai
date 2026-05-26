# JAB SaaS v2 — Component-Pipeline Architecture

> **Status:** APPROVED DESIGN (2026-05-25) — supersedes the homepage-shaped pipeline implied by [`saas-mvp-transition.md`](saas-mvp-transition.md) Phase 2/3.
> **Author:** Sean + Claude (senior dev / product design hat).
> **Plugin baseline:** v0.6.0 (typed `BlockNode[]` + `/wp-json/jab/v1/manifest`).
> **Implementation roadmap:** [`docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md`](superpowers/plans/2026-05-25-saas-v2-roadmap.md).

---

## 0. Why this exists

`saas-mvp-transition.md` defined the strategic pivot from "code generator" to "managed headless platform." [`ai-prompt-modes.md`](ai-prompt-modes.md) defined the three fidelity intents (Faithful / Refresh / Reimagine) and the inputs available. This document defines the **architecture** that satisfies both — specifically:

- **What gets generated** (component library vs. page blobs)
- **In what order** (the 6-phase pipeline)
- **From what inputs** (the accuracy stack)
- **With what verification** (output diff + mandatory review gate)

It exists because the prior architecture (homepage-focused, page-at-once LLM render, scrape-as-primary-content) cannot scale to *whole-site migration* — which is the actual product promise.

---

## 1. TL;DR — three decisions

1. **Drop the preview path.** The anonymous `/preview` flow forced an HTML-blob output shape, a "scrape-only floor," and a homepage-only focus. With it gone, **a connected WP install is a precondition for builds**, the scrape becomes a design-tokens-only signal, and the renderer can output a real Next.js project (typed component library + page routes) instead of inline HTML.

2. **Build component-by-component, not page-by-page.** One unique WP block type → one typed React component. Page composition becomes deterministic block-tree-walking (no LLM call per page). The v0.6.0 `BlockNode[]` schema is already the perfect component prop type — the architecture aligns the SaaS with the plugin's typed-block moat instead of fighting it.

3. **The pipeline is six phases with verification + review as first-class steps.** Discover → Components → Compose → Build → Verify → Review. Verification (output screenshots vs. source screenshots, fidelity scoring) and a mandatory pre-publish review screen are non-negotiable in v1. Accuracy is the product promise; it has to be measurable and surfaced.

---

## 2. What this supersedes vs. extends

| Doc / section | This v2 doc … |
|---|---|
| [`saas-mvp-transition.md`](saas-mvp-transition.md) §2 — preview as wow flow | **Supersedes.** Preview is dropped. Onboarding flow becomes URL → account → plugin → connect → ownership → build. |
| [`saas-mvp-transition.md`](saas-mvp-transition.md) §5 Phase 2 — deploy pipeline | **Extends.** Phase 2's "assemble file set → deploy" stays; the file set now includes the component library + page routes, not just `app/page.tsx`. |
| [`saas-mvp-transition.md`](saas-mvp-transition.md) §5 Phase 3 — multi-template + fidelity | **Supersedes.** Multi-template generation is *deterministic composition* of generated components, not per-template LLM calls. Fidelity approach is formalized as the 6-mechanism accuracy stack in §6. |
| [`ai-prompt-modes.md`](ai-prompt-modes.md) §4 Faithful mode contract | **Extends.** Faithful mode is the only intent in v1 of the new pipeline (Refresh / Reimagine deferred). The contract's preservation requirements map onto per-component generation prompts. |
| Existing `regenerateHomepage` worker | **Replaced** by `buildSite`, `regenerateBlock(blockType)`, and `revalidatePage(slug)` workers. |
| Existing `renderPreviewHtml` | **Replaced** by `generateBlockComponent(blockType, inventory, tokens, samples, screenshots, intent)`. |
| Existing `runScrapeAgent` content pass | **Removed.** Design pass survives as `extractDesignTokens` (one-shot at onboarding). |
| Existing `preview_html` column on `projects` | **Removed.** Replaced by `site_builds` + `deployments` tables. |
| Existing `/preview` route + `anonymous_previews` table | **Removed.** |

---

## 3. Architectural decisions (in detail)

### Decision 1 — Connected WP is a precondition

The wow-preview path required the renderer to work from scrape-only inputs. That requirement is what forces:

- `connected` being optional in `renderPreviewHtml`'s signature
- The scrape pipeline extracting every conceivable signal (headings, sections, footer text, button candidates) because it's the only input
- The HTML-document output shape (iframes consume HTML, not Next.js trees)
- The single `preview_html` column (matches the iframe consumption model)

Drop the preview, and all of that collapses. **Onboarding completes** when:

- A valid WP URL is connected
- The JAB plugin v0.6.0+ is detected
- An app-password probe succeeds
- The agency assigns content-type ownership per `saas-mvp-transition.md` §3

Only then is a build dispatchable. The scrape's residual job is **design-token extraction at onboarding**, run once, persisted on the project row — see §6.3.

### Decision 2 — Component-by-component, not page-by-page

The v0.6.0 plugin emits typed `BlockNode[]` trees per page. Each node is `{ blockName, attrs, innerBlocks, innerHTML, innerContent }`. The block schema is a `oneOf` discriminated union — one variant per registered block type. **That schema IS a React prop type.** A `core/heading` block's variant is `{ level: 1..6, content: string, align?: 'left'|'center'|'right' }` — that's a `<Heading>` component prop type, no translation needed.

Implications:

- **One LLM call per unique block type**, not per page. A 50-page site with 30 unique block types is 30 calls, not 50.
- **Components are reusable across pages** by construction. A `<Hero>` rendered on the homepage is the same `<Hero>` rendered on `/about` with different content.
- **Editing a single block re-renders one component**, not the whole page. Per-page changes are *data* changes (ISR revalidate); per-component changes are localized rebuilds.
- **The output is a real Next.js project**, not an HTML blob. Inspectable, exportable, editable.

The "page composition" step is therefore deterministic: walk the block tree, dispatch each node to its component. No LLM. Sub-second per page.

### Decision 3 — Long-tail blocks fall back to a sanitized HTML passthrough

In v1, **rare blocks (occurrence ≤ 2 across the site) and third-party plugin blocks** do not get custom-generated components. They render via a passthrough component that sanitizes the WP-supplied HTML before injection:

```tsx
import DOMPurify from "isomorphic-dompurify";

export function PassthroughBlock({ block }: { block: BlockNode }) {
  const sanitized = DOMPurify.sanitize(block.innerHTML, {
    USE_PROFILES: { html: true },
  });
  return (
    <div
      className="wp-block-passthrough"
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}
```

**Why sanitization is required even though the source is authenticated WP content:** the WP install holds editorial trust (admin-authored), but the content can include arbitrary user-pasted HTML, third-party plugin output, or shortcode-expanded markup. Treat it as untrusted at the React boundary. DOMPurify with the default HTML profile strips `<script>`, `on*=` handlers, `javascript:` URLs, and other XSS vectors while preserving formatting markup.

This preserves end-to-end site coverage without inflating Phase B costs. Such blocks look "WordPress default" but render correctly and safely. The agency can request component generation for specific blocks post-publish. Future work: detect block-pattern reuse and treat reused patterns as compound components.

### Decision 4 — Faithful intent only in v1

The three intents from `ai-prompt-modes.md` (Faithful / Refresh / Reimagine) ship in the new pipeline **one at a time**. Faithful first because:

- It is the hardest — preservation constraints are strictest, drift is most visible
- It is what migration-shop agencies actually buy
- The other two are creative re-skins of Faithful's component library — adding them is a *prompt change*, not a pipeline change

Refresh and Reimagine land post-v1 as additional intent variants in the component generator prompt. The pipeline shape doesn't change.

---

## 4. The pipeline — six phases

```
┌─────────────────────────────────────────────────────────────────────┐
│ PHASE A — DISCOVER             (~30s–2 min, deterministic + scrape) │
│                                                                     │
│  Goal: enumerate everything to be built. No LLM calls in this phase │
│        except the one-shot design-tokens scrape.                    │
│                                                                     │
│  Inputs: project_id (with WP creds + ownership assignments)         │
│  Outputs persisted: block_inventory, page_inventory, design_tokens, │
│                     menu_snapshots, theme_json                      │
│                                                                     │
│  Steps:                                                             │
│    1. Probe WP via jab/v1/manifest → catalog abilities              │
│    2. jab/get-menus → header + footer + any other menus             │
│    3. /wp-json/wp/v2/types → list public post types                 │
│    4. For each post type: jab/get-{cpt} → list of pages/posts       │
│    5. For each page: jab/get-{cpt}-by-slug → BlockNode[] tree       │
│    6. Walk every tree → build block_inventory:                      │
│         { block_name, attr_samples, occurrences, page_slugs[],      │
│           tier (visual|standard|trivial|passthrough) }              │
│    7. Playwright pass against the WP site:                          │
│         - per-page screenshots (3 viewports)                        │
│         - per-block bounding rects (via WP block class names /      │
│           data-block IDs in the rendered DOM)                       │
│         - per-block computed CSS (font/spacing/color/border)        │
│    8. /wp-json/wp/v2/global-styles → theme.json tokens              │
│    9. One-shot design-tokens scrape (existing scrape-agent          │
│       design pass) for logo + brand colors confirmation             │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ PHASE B — COMPONENTS           (~3–5 min, LLM-heavy, parallelized) │
│                                                                     │
│  Goal: generate one typed React component per unique block type.    │
│                                                                     │
│  Inputs: block_inventory, design_tokens, theme_json,                │
│          per-block screenshots (visual tier), per-block computed    │
│          CSS                                                        │
│  Outputs: components/blocks/<BlockName>.tsx files                   │
│                                                                     │
│  Steps:                                                             │
│    1. Generate tailwind.config.ts from theme.json (deterministic)   │
│    2. Order block generation queue:                                 │
│         - first: blocks used on the homepage                        │
│         - then: descending by occurrence count                      │
│       (so homepage components finish first → Phase C₁ can start)    │
│    3. Per block, route by tier:                                     │
│         - visual:     Sonnet 4.6 + per-block screenshots + computed │
│                       CSS + full attr-sample union                  │
│         - standard:   Sonnet 4.6 + computed CSS + attr samples      │
│         - trivial:    Haiku 4.5 + attr samples only                 │
│         - passthrough: no LLM, emit innerHTML dispatcher only       │
│    4. Each generated component:                                     │
│         - Typed prop matching the BlockNode variant                 │
│         - Tailwind classes from the generated tailwind.config       │
│         - No external font loading (use theme font-family tokens)   │
│         - JSDoc with the source block name and sample attrs         │
│    5. Parallelize in batches of 10 (Anthropic rate limit floor)     │
│    6. Each component emit triggers a per-component compile check    │
│       (tsc on the file). Compile failures → retry once, then mark   │
│       block as passthrough fallback.                                │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ PHASE C — COMPOSE & SHELL      (~30s, mostly deterministic)        │
│                                                                     │
│  Goal: emit the page routes and site chrome.                        │
│                                                                     │
│  Steps:                                                             │
│    C₁. Homepage compose                  (deterministic, <1s)       │
│    C₂. Catch-all route app/[...slug]/page.tsx (deterministic)       │
│         - Resolves slug → calls SDK → walks blocks → dispatches     │
│    C₃. CPT archives + singles            (deterministic per CPT)    │
│         - app/{cpt}/page.tsx (list, paginated)                      │
│         - app/{cpt}/[slug]/page.tsx (single, block-walks)           │
│    C₄. Block dispatcher                  (deterministic)            │
│         - BlockNode → component map, with passthrough fallback      │
│    C₅. SDK from @jab/core (deterministic emit)                      │
│    C₆. Site shell                        (3 LLM calls)              │
│         - <SiteHeader> from primary menu + logo                     │
│         - <SiteFooter> from footer menu + WP options                │
│         - app/layout.tsx composes header/footer/fonts               │
│    C₇. Misc                              (deterministic)            │
│         - app/not-found.tsx, app/robots.ts, app/sitemap.ts          │
│         - next.config.ts, env scaffold, package.json                │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ PHASE D — BUILD & DEPLOY       (~2–3 min, no LLM)                   │
│                                                                     │
│  Steps:                                                             │
│    1. Assemble file tree (extend lib/jab/scaffold.ts)               │
│    2. next build — full project compile. Failures kill the build.   │
│       (QUAL-1 gate from saas-mvp-transition.md Phase 1 audit.)      │
│    3. Top-N pages get generateStaticParams; rest dynamic-rendered   │
│       (keeps build time bounded on large sites)                     │
│    4. Deploy via DeployProvider (Vercel for MVP, per hosting.md)    │
│    5. Capture immutable preview URL                                 │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ PHASE E — VERIFY               (~2–3 min, vision LLM)               │
│                                                                     │
│  Goal: measure fidelity. Output is a structured report, not a       │
│        pass/fail gate (the agency owns the publish decision).       │
│                                                                     │
│  Steps:                                                             │
│    1. Playwright against the preview URL, per page, 3 viewports     │
│    2. Per page, pixel-diff vs the Phase A source screenshots        │
│    3. For pages above pixel-diff threshold:                         │
│         - Vision LLM call (Sonnet 4.6 vision)                       │
│         - Returns: { score: 0..1, issues: [{ block_name,            │
│                     severity, description }] }                      │
│    4. Persist fidelity_report on the build record (per page)        │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ PHASE F — REVIEW               (user-facing, mandatory before       │
│                                 publish)                            │
│                                                                     │
│  Goal: surface the fidelity report; let the agency approve or       │
│        regenerate per page / per component before publish.          │
│                                                                     │
│  Surfaces:                                                          │
│    - Site review screen: per-page rows with source + generated      │
│      thumbnails, fidelity score, list of flagged issues             │
│    - Per-page actions: ✅ Approve | ⚠️ Regenerate flagged components │
│    - Bulk actions: Approve all | Regenerate flagged                 │
│  Publish:                                                           │
│    - "Publish" promotes the preview deployment to production        │
│      (client.jab.app subdomain)                                     │
│    - Publish blocked until all pages have status approved           │
│    - Approve-with-issues is allowed (agency override) but recorded  │
└─────────────────────────────────────────────────────────────────────┘

Total: ~8–13 min wall-clock for a fresh build of a typical agency site.
       Re-renders triggered by content edits: seconds (ISR data refetch).
       Re-renders triggered by component fix: ~30s + deploy (~2-3 min).
```

---

## 5. Progressive disclosure UX

The 8–13 min build window is acceptable to the agency **only if they can see progress and intermediate value**. The UX during the build:

```
T+0:00   "Analyzing your site..."           (Phase A)
T+0:30   "Discovered 47 pages, 28 block types, 6 menus"
         → block inventory rendered as a sortable table
         → agency confirms scope, can defer specific blocks
T+0:30   "Generating component library..."  (Phase B begins)
         → live counter: 28 components, 6 done... 12... 18... 28
         → component preview tiles fill in as each completes
T+4:30   "Composing homepage..."            (Phase B → C₁)
T+4:35   ⚡ HOMEPAGE PREVIEW READY (clickable subdomain link)
         → agency can preview the homepage now
         → background: rest of site continues building
T+5:00   "Composing the other 46 pages..."
T+7:00   "Verifying fidelity..."            (Phase E)
T+10:00  ⚡ SITE REVIEW READY (Phase F surface)
         → all 47 pages clickable, fidelity reports per page
```

The homepage as intermediate milestone is *natural*, not artificial: Phase B's queue is ordered "homepage blocks first, then descending occurrence," so the homepage's components finish first and Phase C₁ runs immediately. No special-case code path; just ordering.

---

## 6. The accuracy stack — six mechanisms

Ranked by accuracy-per-engineering-dollar.

### 6.1 Computed CSS extraction (biggest lever)

Run headless Chromium against each WP page in Phase A. For every rendered block:

```ts
{
  blockName: "acf/hero",
  computedStyles: {
    fontSize: "28px",
    lineHeight: "1.2",
    fontWeight: "600",
    color: "rgb(26, 77, 46)",
    paddingTop: "96px",
    paddingBottom: "96px",
    backgroundColor: "rgb(245, 240, 230)",
    gap: "24px"
    // ~30 properties total that matter for layout/typography
  },
  boundingRect: { width: 1200, height: 480, x: 0, y: 80 }
}
```

This dwarfs the current `scrape-extract.ts` approach, which pulls hex codes from inline `style=""` attributes — usually empty in modern themes. Computed CSS is what the browser actually painted, including everything coming from the theme stylesheet, theme.json tokens, and customizer settings.

Per-block computed-style **aggregates** (median, range, variants across all occurrences) get fed to the component-generation prompt. The LLM stops inferring and starts translating.

### 6.2 Source screenshots (paired with 6.1)

Two crops per block per viewport (1440 / 768 / 375):

- **Full page screenshots** — passed to the *layout-shaping* prompts (header, footer, page composition LLM calls in Phase C₆)
- **Per-block crops** — passed to the *component-generation* prompts for visual-tier blocks (Phase B). Crops are derived from the bounding rects captured in 6.1.

Vision-enabled Claude can see "this hero is a centered headline with a CTA below it, image on the right" — semantic information that a structured BlockNode does not carry.

**Cost note:** Sonnet 4.6 with vision is ~2× the token cost of text-only. Worth it for visual-priority blocks. The tiered approach (§7) makes this affordable.

#### 6.2.1 Capture reliability — best-effort + client supplementation (decided 2026-05-26)

The Two Roads pilot Stage 1 smoke surfaced that headless Chromium captures against Cloudflare-protected sites are unreliable — even with realistic UA, locale, timezone, and an inline stealth init script masking the standard four bot-detection signals (`navigator.webdriver`, `navigator.plugins`, `navigator.languages`, `window.chrome`), Cloudflare's bot management routinely served JS challenges that crashed the renderer. Capture success rate against Two Roads landed at ~10% per page.

Pushing further (playwright-extra + stealth plugin, residential proxies, TLS fingerprint masking via uTLS or similar) is technically possible but is a maintenance arms-race and not differentiating product work.

**Decision:** Phase A screenshot capture is **best-effort**, not gating.

- `page_inventory.source_screenshot_paths` already tolerates 0–3 viewport coverage per page.
- The orchestrator never throws on capture failures — they're recorded in `failures` for telemetry and the rest of the pipeline proceeds.
- Phase B's component generator reads what's present. For pages without screenshots, it falls back to block-tree-only generation. Core Gutenberg blocks have well-known visual shapes; the block-type schema carries the structural information; visual context is mostly an *accuracy boost* for themed sites and custom blocks, not a hard requirement.
- **Client-uploaded screenshots during onboarding** become the supplementation path. During the onboarding flow, the client picks representative pages and uploads from their real Chrome session (or design files). This is strictly better than auto-capture: the client knows which pages are visually load-bearing, has higher-quality outputs, sidesteps Cloudflare entirely, and engages them in the onboarding loop. **Implementation pending** — Stage 2+ planning will add the upload UI; the data model is already there.
- Phase E verification (preview-vs-source pixel diff) operates only on pages where source screenshots exist. Coverage is reported on the review screen so the agency can supplement coverage before publish.

**Failure mode signal:** If a pilot site's auto-capture rate is <60%, the agency should expect to supplement during onboarding. The Phase A inventory should surface a per-page "capture status" hint so the onboarding UI can prompt for the right uploads.

### 6.3 theme.json + global-styles (foundation for 6.1 and 6.2)

WP 5.9+ exposes the theme's design system via `/wp-json/wp/v2/global-styles`:

```json
{
  "settings": {
    "typography": {
      "fontSizes": [{ "slug": "large", "size": "32px" }, ...],
      "fontFamilies": [...]
    },
    "spacing": { "spacingScale": {...}, "blockGap": "24px" }
  },
  "styles": { "color": { "background": "#fff" }, ... }
}
```

Pulled once in Phase A. The project's `tailwind.config.ts` is generated from this **deterministically**. Every component then uses the same token system. This makes typography rhythm consistent across the generated site **by construction** — not by hoping 30 independent component-generation calls pick the same values.

If the WP theme is classic (no `theme.json`), fall back to inferring tokens from the computed-CSS aggregates in 6.1.

### 6.4 Tiered component generation

Not every block deserves the same budget:

| Tier | Examples | Inputs to LLM | Model | Approx tokens |
|---|---|---|---|---|
| **Visual** | heroes, page sections, ACF custom blocks, feature grids | schema + computed CSS + per-block crops (3 viewports) + theme tokens + attr-sample union | Sonnet 4.6 (vision) | ~8k |
| **Standard** | card lists, image+text rows, columns blocks | schema + computed CSS + theme tokens + attr samples | Sonnet 4.6 (text) | ~4k |
| **Trivial** | paragraphs, headings, lists, separators, basic buttons | schema + theme tokens only | Haiku 4.5 | ~1k |
| **Passthrough** | rare blocks (occurrence ≤ 2), third-party plugin blocks | no LLM | — | $0 |

Tier assignment happens during Phase A inventory based on:
- Block name (hardcoded heuristics: `acf/*` → visual default; `core/paragraph|core/heading|core/list` → trivial; etc.)
- Occurrence count (visual + standard tiers require occurrence ≥ 3 by default; passthrough below)
- An agency override per build (post-MVP)

Total Phase B cost drops ~40–60% vs. uniform Sonnet-with-vision, and quality is *higher* because critical blocks get the budget that actually matters.

**Per-tier model selection (v1 defaults, swappable via the `ModelClient` seam):**

| Tier | Provider | Model | Why |
|---|---|---|---|
| Visual | Anthropic | claude-sonnet-4-6 (vision) | Leads on TSX/React code gen in most public evals; vision solid for screenshot inputs. |
| Standard | Anthropic | claude-sonnet-4-6 (text) | Same code-quality argument, no vision cost overhead. |
| Trivial | **Google** | gemini-1.5-flash | ~1/15th the cost of Sonnet, no meaningful quality difference on paragraph/heading scaffolds. The single biggest model-switching win in the pipeline. |
| Passthrough | — | — | No LLM. |
| Fidelity (Phase E) | Anthropic | claude-sonnet-4-6 (vision) | Structured-output reliability + vision quality. |
| Design tokens (Phase A) | Anthropic | claude-haiku-4-5 | Cheap classification; existing integration. |

The `ModelClient` interface (introduced in Stage 2) decouples tier → provider+model, so v1.1 can A/B benchmark alternatives (GPT-5, Gemini 2.0 Pro, Grok 4 when it has the track record) without rearchitecting Phase B.

---

### 6.7 Cost-optimization levers (apply *before* changing providers)

These compound. Estimated combined savings: ~$0.75 per build (from ~$1.35 → ~$0.60). All four ship in Stage 2 and Stage 5 implementations.

**a. Anthropic prompt caching — biggest single lever (~$0.50/build savings)**

The BlockNode schema, design tokens, theme.json, and per-tier system prompts are identical across all ~30 Phase B calls. Mark them with `cache_control: { type: "ephemeral" }` — cached input tokens are ~90% cheaper. Cache TTL is 5 min, which fits Phase B's parallel-batch window.

```ts
{
  role: "system",
  content: [
    {
      type: "text",
      text: BLOCK_NODE_SCHEMA + DESIGN_TOKENS + THEME_JSON,
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: tierPrompt },
  ],
}
```

**b. Anthropic Batch API — 50% off, ~5 min latency (~$0.20/build savings)**

Phase B doesn't need synchronous responses. Submit the batch, poll for results. The 8–13 min build window absorbs the latency.

**c. Per-tier schema slimming (~$0.10/build savings)**

Don't pass the full BlockNode union to every call. A `core/paragraph` generation prompt needs only the `ParagraphBlock` variant. Slim per-call.

**d. Tighter pixel-diff threshold for Phase E vision escalation**

Variable, depends on threshold tuning. Each vision call avoided is ~$0.04.

### 6.5 Output verification with vision diff

After Phase D deploys, Phase E:

1. Playwright loads the preview URL at 1440/768/375 → 3 screenshots per page
2. Pixel diff (image-similarity score, e.g. `pixelmatch`) vs. the Phase A source screenshots → cheap first-pass filter
3. For pages with diff above a threshold (e.g. > 0.10 pixel divergence):
   - Vision LLM call (Sonnet 4.6 with vision)
   - Prompt: "Rate visual fidelity 0–1; list specific mismatches, each tagged with the offending block name if identifiable"
   - Returns structured JSON: `{ score, issues: [{ block_name, severity: 'low'|'medium'|'high', description }] }`
4. Persist per-page `fidelity_report` on the build record

### 6.6 Mandatory pre-publish review screen (Phase F)

The agency's quality gate **before showing the client**. Surface design:

```
┌──────────────────────────────────────────────────────────────┐
│ Site Review — 47 pages, 28 components, fidelity 0.87 avg    │
├──────────────────────────────────────────────────────────────┤
│ Page                | Source | Generated | Score | Action    │
│ /                   |  [img] |  [img]    | 0.94  | ✅       │
│ /about              |  [img] |  [img]    | 0.91  | ✅       │
│ /services           |  [img] |  [img]    | 0.72  | ⚠️ Review│
│   ↳ Hero alignment off (text-left vs source text-center)     │
│   ↳ [Regenerate Hero component] [Skip & approve]             │
│ /blog               |  [img] |  [img]    | 0.88  | ✅       │
│ ...                                                          │
├──────────────────────────────────────────────────────────────┤
│ [Approve all & publish]  [Regenerate flagged pages]          │
└──────────────────────────────────────────────────────────────┘
```

Three things this accomplishes:

1. Catches drift before it's anyone else's problem
2. Makes "accuracy" a measurable, surfaced number rather than vibes
3. Gives the agency the language to push back on the AI: "the hero is off, fix that one"

Regenerating a flagged component is cheap (~30s for 1 component + redeploy with cached blocks). The agency iterates inside the SaaS until satisfied, then publishes.

---

## 7. Time + cost budget

Per build, for a typical agency site (~50 pages, ~30 unique block types):

| Phase | Wall-clock | LLM calls | Approx model cost |
|---|---|---|---|
| A — Discover | 1–2 min | ~3 (one-shot design tokens) | ~$0.05 |
| B — Components | 3–5 min | ~30 (tiered) | ~$0.80 |
| C — Compose & Shell | 30s | ~3 (shell only) | ~$0.10 |
| D — Build & Deploy | 2–3 min | 0 | 0 |
| E — Verify | 2–3 min | up to 10 vision calls | ~$0.40 |
| F — Review | user-paced | 0 (until they regenerate) | 0 |
| **Total** | **8–13 min** | **~46** | **~$1.35** |

Per-component regeneration (post-review):
- Wall-clock: ~30s LLM + ~2 min redeploy = ~2.5 min
- Cost: ~$0.03 per component

These are illustrative — real numbers come from telemetry once the pipeline is live.

---

## 8. What changes in the existing code

### Keep & extend
- **`@jab/core` `fetchManifest` + `McpClient`** — still the right plumbing
- **`AcfValueWalker` + `BlockNode` schema** (plugin v0.6.0) — the architecture is built on this
- **`lib/jab/ability-client.ts`** — extend with `getMenus()`, `listPostType()`, `getPostsBySlug()`, `listPostTypes()`, `getTaxonomyTerms()`, `getGlobalStyles()`
- **`lib/jab/scaffold.ts`** — already emits a Next.js project; becomes the spine of Phase C
- **Existing Inngest step-based worker pattern** — perfect fit for the new pipeline
- **`extractProjectDesign`** — keep but scope to design tokens only, run once at onboarding

### Gut
- **`runScrapeAgent` content path** — kill the content pass; design pass survives, scoped down
- **`renderPreviewHtml`** — replaced by `generateBlockComponent()` + `composePage()` + the shell generators
- **`regenerateHomepage` worker** — replaced by `buildSite`, `regenerateBlock`, `revalidatePage`
- **`preview_html` column on `projects`** — replaced by `site_builds` + `deployments` tables
- **`/preview` route, `anonymous_previews` table, the pre-auth funnel** — removed
- **`render-prompts.ts` page-shaped `INTENT_BRIEFS`** — replaced by component-shaped intent briefs in the new component generator

### Add
- **`block_inventory` table** — `(project_id, build_id, block_name, attr_samples jsonb, occurrence_count, page_slugs[], tier, computed_styles jsonb)`
- **`page_inventory` table** — `(project_id, build_id, slug, post_type, source_screenshot_paths jsonb, block_count)`
- **`site_builds` table** — one row per build attempt with status, phase, component_count, page_count, started_at, finished_at, deploy_url, fidelity_summary
- **`deployments` table** — preview URL, production URL, status, build_id reference
- **`fidelity_reports` table** — per-page-per-build score + issues
- **Generated Next.js project output** — `components/blocks/<BlockName>.tsx` files, `app/[...slug]/page.tsx`, `app/{cpt}/page.tsx`, `app/{cpt}/[slug]/page.tsx`, `tailwind.config.ts` from theme.json
- **Phase F review UI** — site review screen, per-page drilldown, regenerate actions
- **Playwright worker** — runs in Phase A (source capture) and Phase E (output verification). Likely a separate Inngest function or a dedicated service depending on infra constraints.

---

## 9. v1 scope cuts

**In scope for v1 of the new pipeline:**
- Faithful intent only (Refresh / Reimagine deferred)
- Core blocks (`core/*`) and ACF blocks (`acf/*`) with custom components
- Third-party blocks → sanitized HTML passthrough (DOMPurify)
- Pages + posts (and the blog index)
- Header + footer from `jab/get-menus`
- ISR for content freshness (`revalidate: 60`)
- Subdomain hosting (`client.jab.app`)
- Mandatory pre-publish review screen

**Explicitly *not* in v1 of the new pipeline:**
- Custom post-type templates (`app/{cpt}/...` routes) — deferred to v1.1
- Multi-level menus (depth > 2) — most sites don't use this, deferred
- The Jab-managed lightweight CMS (`content_documents` from `saas-mvp-transition.md` §3) — separate workstream
- Multi-fidelity intents (Refresh / Reimagine)
- Block-level inline editing
- WP-save webhook revalidation (use ISR floor)
- Custom domains
- Form rendering (deferred to v1.2, aligns with plugin v0.7.x forms work)
- Lighthouse / accessibility scoring in the build loop (separate post-publish report)
- Drift detection cron (post-MVP)
- Site-pattern detection (treating reused page patterns as compound components)

---

## 10. Decisions still required from Sean

1. **Confirm preview drop.** Sean said "likely going to close" — this doc assumes confirmed. If preview survives in some form (e.g. cheap public-URL screenshot for landing-page social proof), the architecture still works but onboarding wording changes.
2. **Tiering heuristics initial table.** §6.4 proposes seeding tiers by block-name pattern matching. Sean to review the initial seed list before Phase B implementation begins.
3. **Pixel-diff threshold + fidelity score acceptance floor.** §6.5/§6.6 reference a threshold and acceptance floor; specific numbers (e.g. fidelity ≥ 0.85 = ✅) should be set after Phase E telemetry is available, but a working default needs to land in v1 (proposed default: 0.85).
4. **DeployProvider implementation choice.** `hosting.md` proposes a `DeployProvider` seam; v1 ships the Vercel adapter. Cloudflare adapter timing is open.
5. **Inngest vs. dedicated worker for Playwright.** Headless Chromium is heavy. If Inngest's serverless runtime can't host it reliably, a small dedicated service (Fly / Railway) is needed. Decision affects Phase A and E.

---

## 11. Glossary

- **Block inventory** — the per-build catalog of unique block types found across the site, with attr samples and computed styles. The "spec sheet" for Phase B.
- **Block tier** — visual / standard / trivial / passthrough. Determines model + inputs for Phase B's component generation.
- **Component library** — the generated React components, one per unique block type, stored in `components/blocks/` of the output Next.js project.
- **Page inventory** — the per-build list of pages to render, with source screenshots + block-tree references.
- **Fidelity report** — per-page-per-build structured output of Phase E (score + issues list).
- **Site build** — one full execution of Phases A–D (and E), producing a preview deployment URL.
- **Build vs. regen** — *build* = full pipeline from Phase A; *regen* = targeted Phase B + C composition + Phase D redeploy for one or more components.

---

## 12. What success looks like

A user with a real WordPress agency client:

1. Connects the client's WP site (URL, plugin install, app password) and assigns content-type ownership — **~10 minutes**
2. Clicks "Build site" — **8–13 minutes wall-clock**
3. Sees the homepage as an intermediate milestone at ~4–5 minutes; sees the full site at ~10 minutes
4. Reviews the per-page fidelity report; regenerates 1–3 components that drifted
5. Publishes to `client-name.jab.app`
6. **The whole client site is now a fast, modern Next.js frontend backed by their existing WordPress.** The client keeps editing in wp-admin; content shows up on the new site within the ISR window.

That is the product promise. Everything in this doc serves it.
