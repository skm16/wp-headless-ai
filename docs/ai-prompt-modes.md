# AI Prompt Modes — Working Spec

> **Status:** Working draft — iterate freely. The mode contracts in §4 / §5 / §6
> are the source of truth for what each generation intent promises; the prompts
> in code should be regenerated from this doc when they drift.
> **Last touched:** 2026-05-24

---

## 0. Why this doc exists

JAB's onboarding wizard asks the agency to pick one of three project intents
before generation runs:

| Intent | Picker copy (today) |
|---|---|
| Faithful | Keep the existing structure and content priority. Good for sites that mostly need a speed and polish update. |
| Refresh | Same content, fresh design. Best for clients who want an update within their existing brand. |
| Reimagine | Start from scratch. Best for clients who want a real redesign anyway. |

The intent is persisted to `projects.intent` and fed to the **preview-render
prompt** at [`apps/web/lib/ai/render-prompts.ts:17`](../apps/web/lib/ai/render-prompts.ts#L17)
as a single paragraph of directive prose (`INTENT_BRIEFS`). It is **not yet
wired** into the page-code generation prompt at [`apps/web/lib/ai/prompts.ts`](../apps/web/lib/ai/prompts.ts).

The three intents are also the load-bearing fidelity decision in
[`saas-mvp-transition.md` §5 Phase 3](saas-mvp-transition.md) — the doc
commits Faithful to a real engineering bar: computed-style extraction →
derived Tailwind theme, multi-breakpoint screenshots, visual-diff verification.

This doc is the place we write down what each mode actually **promises the
user**, what **input artifacts** it consumes, what **license** it grants the
model, and what **hard rules** it never breaks. The current `INTENT_BRIEFS`
paragraphs were a starting point; this is the structured contract that
replaces them.

**Initial focus: Faithful**, because (1) it is the hardest — preservation
constraints are stricter than license, (2) it is what migration-shop agencies
actually buy, and (3) the existing one-paragraph brief is the thinnest of
the three.

---

## 1. Current state — what's wired, what's not

| Surface | File | Intent-aware? | Notes |
|---|---|---|---|
| Picker UI | `apps/web/components/intent-picker.tsx` | ✅ | Step 0 of the wizard. Radio cards. |
| DB column | `projects.intent` (migration 0011) | ✅ | `TEXT CHECK (intent IN ('faithful','refresh','reimagine'))`. Nullable until step 0 completes. |
| Preview-render prompt | `apps/web/lib/ai/render-prompts.ts` | ✅ | `INTENT_BRIEFS` — one paragraph per mode. Injected **first** in the user message. |
| Preview worker | `apps/web/lib/inngest/functions/regenerate-homepage.ts` | ✅ | Passes `intent` from DB → renderer. End-to-end live. |
| Page-code prompt | `apps/web/lib/ai/prompts.ts` | ❌ | `STATIC_SYSTEM_BASE` + `buildUserPrompt` — never consume `intent`. |
| Page-code worker | `apps/web/lib/inngest/functions/generate-page.ts` | ❌ | Orphaned today; rebuilt in Phase 2 deployments work. |

**The mode contract this doc defines must be honored by both pipelines.**
Today only the preview pipeline reads it; Phase 3 multi-template generation
will need the same contract at the page-code layer.

### Inputs available to the AI (two sources)

The platform has **two independent input pipelines** feeding the prompts —
both run at onboarding, both persist to the project record, and the modes
in §4 / §5 / §6 must address both.

#### Source A — Public-HTML scrape extraction (`scrape-agent`)

Runs against the public homepage URL. Produces the visual + content snapshot:

- **Colors:** primary / secondary / accent, each with `value`, `confidence`, `reasoning`.
- **Typography:** heading family, body family, each with confidence + reasoning.
- **Logo:** src URL, confidence, reasoning. Cached to Supabase Storage.
- **Favicon, OG image:** captured + cached.
- **Buttons:** primary + secondary CTA copy, classified by LLM.
- **Personality:** tone, energy, audience.
- **Content brief:** Markdown extraction of the page's content + heading hierarchy.
- **Rendered HTML** (full document, used as fallback authority).

#### Source B — Authenticated WP plugin (`probeWordPress` + `fetchManifest`)

Runs against the connected WP install via the JAB plugin + app-password.
Plugin floor: **v0.6.0** (typed-block moat + REST manifest endpoint).
Produces the structured catalog of *what content the site actually has*
AND, since v0.5.0+v0.6.0, the structured *page schema itself*:

**Catalog (always available)**

- **Abilities** — every `jab/get-{type}` and `jab/get-{type}-by-slug` the
  plugin auto-discovers (posts, pages, all public CPTs). Each ability ships
  with full input + output JSON Schemas.
- **Menus** — full menu tree via `jab/get-menus`, with item titles, URLs,
  parent/child relationships, and menu location slugs.
- **Taxonomies** — all public taxonomies and their terms.
- **Featured images** — structured `{ id, url, alt, width, height }`
  per post.
- **Drafts and private posts** — the manifest is authenticated; it sees
  everything the WP admin sees, not just what's published.
- **Per-content-type ownership** — `projects.content_ownership` records
  whether each content type is WP-managed (fetched live via SDK at runtime)
  or JAB-managed (lives in `content_documents` JSONB, edited via AI
  iteration). See [`saas-mvp-transition.md` §3](saas-mvp-transition.md).

**Per-page structured content (opt-in via `include` flag — by-slug
abilities default `content + blocks` ON; list abilities default everything OFF)**

- **`content`** — raw `post_content` HTML string.
- **`blocks`** — parsed `BlockNode[]` tree (`parse_blocks()` shape,
  normalized through [`BlockParser`](../packages/wp-plugin/includes/Schema/BlockParser.php)).
  Each node is `{ blockName, attrs, innerBlocks, innerHTML, innerContent }`.
  **v0.6.0:** the per-item schema is a `oneOf` discriminated union over one
  variant per registered block type (from `WP_Block_Type_Registry`) plus a
  permissive fallback for unknown blocks — so the AI receives
  `ParagraphBlock | HeadingBlock | CoverBlock | AcfHeroBlock | … | UnknownBlock`
  in the typed SDK. Recursive `innerBlocks` stay loosely typed at the schema
  layer (WP REST validator doesn't support `$ref`); the structural tree is
  still walkable at runtime.
- **`rendered_content`** — full `post_content` run through the `the_content`
  filter chain (dynamic blocks, shortcodes, oEmbeds all expanded). Opt-in
  only — `include.render=true`. Useful as a fallback when the AI needs the
  resolved HTML for a section the block tree doesn't describe finely
  enough.
- **ACF Flex Content** — per-page Flex layouts live inside the post's
  `acf` property; each Flex field returns `array<oneOf<layout1 | layout2 | …>>`
  with `acf_fc_layout` as the discriminator. Layout order preserved.
  This is what Two Roads uses.
- **ACF Blocks (`acf/*`)** — custom Gutenberg blocks built with ACF.
  v0.6.0's [`BlockFieldSchema`](../packages/wp-plugin/includes/Acf/BlockFieldSchema.php)
  walks `block==<name>` location rules and types `attrs.data` end-to-end
  through the same ACF schema generator used for post-type fields. Image
  fields resolve to attachment objects, nested Flex Content gets the
  discriminated union, etc.
- **Reusable blocks (`core/block { ref: N }`)** — inlined automatically
  via [`BlockExpander`](../packages/wp-plugin/includes/Abilities/BlockExpander.php);
  the `core/block` envelope is preserved (so consumers can tell what came
  from a reusable block) and `innerBlocks` is populated from the
  referenced `wp_block` post, with cycle detection.

**REST namespace `/wp-json/jab/v1/*` (v0.5.0+v0.6.0)**

- **`/wp-json/jab/v1/manifest`** — full ability roster (names, categories,
  input/output schemas, meta). Auth: `read` cap via Application Password.
  The CLI's `jab sync` and the SaaS's onboarding consume this directly;
  no MCP session required. (Schemas may include internal field names —
  intentionally gated, not anonymous.)
- **`/wp-json/jab/v1/content-types`** — auth'd catalog of post types
  with real counts. Powers the onboarding ownership picker.
- **`/wp-json/jab/v1/`** — health probe for the wizard's Verify install
  step.

#### Which pipeline sees what

| Pipeline | File | Sees Source A | Sees Source B | Why |
|---|---|---|---|---|
| Preview render | `apps/web/lib/ai/render-prompts.ts` | ✅ | ❌ | Throwaway HTML in an iframe `srcDoc`. No runtime data fetch possible. |
| Page-code generation (Phase 3) | `apps/web/lib/ai/prompts.ts` | ✅ | ✅ | Output is real Next.js app; SDK calls fetch live data at request time. |

**This dual-source reality is load-bearing for the modes:** Faithful and
Refresh preserve the source HTML's visual structure (Source A) while
binding dynamic sections to live SDK calls (Source B). Reimagine treats
Source A as reference only and leans on Source B for "what content does
this site have to surface." See §3.5 for the data-binding discipline.

#### Not yet captured (Phase 3 fidelity work)

- Type scale (h1 / h2 / h3 / body / small sizes) — Source A.
- Spacing scale (section padding, container gaps) — Source A.
- Container max-width — Source A.
- Border-radius scale — Source A.
- Shadows — Source A.
- Breakpoints — Source A.
- Multi-breakpoint screenshots (desktop / tablet / mobile) — Source A.
- Section schema for **Tier 2 (theme template + scalar ACF) and Tier 3
  (pure scrape)** pages — would still benefit from a fusion of Source A's
  DOM walk + Source B's ACF introspection. **For Tier 1 (block-structured:
  Gutenberg, ACF Flex, ACF Blocks) this is now solved** — the `blocks[]`
  field and ACF Flex layouts ARE the section schema, with typed
  per-section data. See §3.5 for the resulting source-priority chain.

Faithful's promise as currently worded depends on the bottom block being
captured for non-Tier-1 sites. For Tier 1 sites the prompt's job shrinks
substantially — "render the schema we hand you" — because the structured
schema is already there.

---

## 2. ⭐ Global rule (binds all three modes)

> **JAB is JAB. Client sites are client sites. JAB's brand never bleeds
> into the generated output, in any mode, ever.**

Decided 2026-05-24 (Sean). This is the foundational rule the rest of the
doc rests on. It applies equally to Faithful, Refresh, and Reimagine.

**What this means in practice:**

| Surface | JAB brand? | Notes |
|---|---|---|
| JAB marketing site (`apps/web/app/page.tsx`, `/pricing`, `/preview`) | ✅ Yes | This is the platform's storefront. Syne in hero, dark surfaces, teal CTAs. |
| Agency-facing dashboard / workspace / settings | ✅ Yes | The agency works inside JAB; the chrome is JAB-branded. |
| Generated client homepage (preview iframe `srcDoc`) | ❌ Never | Source brand only. No Syne, no DM Sans, no teal/dark tokens, no JAB component primitives. |
| Generated client pages (Phase 3 `app/page.tsx` output) | ❌ Never | Same. Tailwind theme is derived from extracted source tokens, not JAB tokens. |
| Generated client emails / forms / etc. (post-MVP) | ❌ Never | Same rule extends to every customer-facing artifact. |

**Why this rule exists (so we can defend it under pressure):**

1. **Trust with migration agencies.** The buyer is a marketing/web agency.
   Their value to their client is *their client's brand*. A platform that
   smuggles its own visual identity into the deliverable is competing
   with the agency's craft, not enabling it.
2. **The platform's moat isn't visual identity in the output.** The moat
   is speed, AI iteration, headless stack ergonomics, the agency playbook.
   "You get a JAB-styled site" is not the pitch.
3. **Multi-client-site reality.** An agency runs JAB for 20 different
   clients. Twenty client homepages all wearing JAB's visual identity
   would make every site look like a JAB site, not their own. That's
   the failure mode.
4. **Cleaner mode framing.** All three intents become gradations of
   *creative latitude within the client's brand* — not gradations of
   *how much JAB to apply*. The contracts in §4 / §5 / §6 are sharper
   because of it.

**Failure modes this rule polices against:**

- Sonnet uses `font-display: 'Syne'` because it saw Syne in earlier JAB
  generation context.
- A "polish update" replaces the client's button styles with JAB's
  rounded-md teal primary.
- A "modern" section divider becomes JAB's dark gradient strip.
- A `tailwind.config.ts` for a client project inherits JAB's color tokens.

The prompts must explicitly inoculate against each of these. Reference
this section in every mode's "MUST NOT do" list.

---

## 3. The three modes — at a glance

The global rule above (no JAB bleed) is hard and universal. The
distinctions below are about **creative latitude within the client's
brand** — what the AI may change, what it must preserve.

| Dimension | Faithful | Refresh | Reimagine |
|---|---|---|---|
| **Section order** | Preserve exactly | Preserve | Re-orderable |
| **Section count** | Preserve | Preserve (±1 allowed for clarity) | New structural choices welcome |
| **Hero copy** | Verbatim | Light edit for clarity | New copy, grounded in brief |
| **Body copy** | Verbatim | Light edit | Re-written, grounded in brief |
| **CTA copy** | Verbatim | Verbatim | Author CTAs grounded in offerings |
| **Color palette** | Source palette (extracted hex, verbatim) | Source palette (extracted hex, verbatim) | Source palette as foundation; can introduce supporting neutrals |
| **Typography family** | Source families (loaded via Google Fonts if needed) | Source families | Source families OR a deliberate modernized substitute that respects the brand register |
| **Type scale, spacing** | Source where extractable; sensible defaults elsewhere | Modernized rhythm (bigger hierarchy, more whitespace) | New rhythm, ambition-led |
| **Visual polish** | "Honor without improving" | Modern design craft (clearer hierarchy, better whitespace, sharper CTAs) — within source brand | Free creative latitude — within source brand |
| **Mobile responsiveness** | Required (modernized from source where source is weak) | Required, modernized | Required, modernized |
| **Accessibility floor** | Required (overrides source if source fails) | Required | Required |
| **Performance** | Required (semantic HTML, no script bloat) | Required | Required |
| **JAB brand applied?** | **Never** (see §2) | **Never** (see §2) | **Never** (see §2) |
| **Confidence to ship** | Highest fidelity, lowest creative risk | Balanced | Highest creative variance |
| **Expensive extraction** | Yes (Phase 3: computed styles + screenshots) | Lighter | Lightest |

The picker copy is the user's mental model. The table above is the contract
the prompt enforces.

**Mental model for distinguishing the three:**

- **Faithful** = "your client's site, but actually fast and accessible."
  The agency's deliverable is the same site, polished under the hood.
- **Refresh** = "your client's site, redesigned to 2026 standards within
  their brand." The client recognizes it as theirs; it looks more current.
- **Reimagine** = "the homepage you'd build today for this brand from
  scratch." Same brand inputs, different ambition level.

### 3.5 Static vs. dynamic content — the mapping problem (all modes)

For each section the AI is generating, it has to decide: is this content
*static* (a one-off marketing message frozen in JSX) or *dynamic* (data
sourced from a WP post type, ACF field, or menu)? The page-code pipeline
can do both — static copy goes inline; dynamic content gets bound to an
SDK call at render time so the live WP site stays the source of truth.

The model walks a **source-priority chain** for each section: structured
data first (highest), scraped HTML last (fallback). The chain is the same
for every mode; the modes govern *visual treatment*, not *data source*.

| Section type | Source priority (highest → lowest) |
|---|---|
| Site nav | Source B (`jab/get-menus`) — *only* source; never scraped DOM. |
| Hero | (1) Matching node in the page's `blocks[]` tree (e.g. `acf/hero` ACF Block with typed `attrs.data`, or `core/cover` with `core/heading` child) → (2) ACF Flex layout on the page (`acf.flex_field[i]` where `acf_fc_layout === 'hero'`) → (3) ACF scalar fields if names map to hero content → (4) Scraped HTML. |
| Section sequence (page structure) | (1) `blocks[]` tree (top-level node order) → (2) ACF Flex layouts (array order) → (3) Inferred from scraped HTML DOM. |
| Feature grid / supporting sections | (1) Matching block (e.g. `core/columns`, `acf/feature_grid`) → (2) ACF Flex layout (matching `acf_fc_layout`) → (3) Scraped HTML. |
| Blog teaser ("recent posts" block) | Source B (`jab/get-posts`) for the items — always. The block/Flex node provides the *wrapper* (heading, layout choice); posts come live via the SDK. |
| Product grid (CPT-backed) | Source B (`jab/get-{cpt}`) for items — always. Wrapper from block/Flex if present. |
| Event list | Source B (`jab/get-events`) for items — always. Wrapper from block/Flex if present. |
| Static feature cards (marketing copy) | (1) `blocks[]` text content (`core/group`, `core/columns` with paragraphs/headings) → (2) ACF Flex layout copy → (3) JAB content document (if page is JAB-managed) → (4) Inline JSX (last resort, only for Tier 3 pages). |
| Testimonials | (1) Testimonials CPT (`jab/get-testimonials`) if exists → (2) `blocks[]` with hardcoded quotes → (3) ACF Flex layout → (4) Scraped HTML. |
| Footer | Menu links via `jab/get-menus`; copy from theme options or block tree; scrape fallback. |

**The mode contracts in §4 / §5 / §6 govern visual + structural fidelity.**
This sub-section governs **data-binding discipline** — mode-independent.
Hardcoding three most-recent blog posts as static JSX text is a failure
mode regardless of which intent you picked; the headless platform's
central promise is that content stays live.

Operationally:
- **Preview pipeline (Source A only):** cannot do dynamic binding;
  renders whatever the scrape pass saw at scrape time. Acceptable
  because the preview is a throwaway artifact in an iframe `srcDoc`.
- **Page-code pipeline (Source A + B):** MUST walk the source-priority
  chain. With v0.6.0's block tree exposure, the AI typically receives the
  structured page schema directly — for **Tier 1** sites (block-structured)
  the §4.3 contract becomes "render the schema we hand you" rather than
  "infer the schema from HTML and then render it." For **Tier 2/3** sites
  the lower rungs of the chain (ACF scalar fields, scraped HTML) absorb
  more of the load. The §4.3 contract holds either way; what changes is
  how much inference the model has to do.

---

## 4. Faithful — deep dive (our focus)

### 4.1 What Faithful promises the user

The agency picked Faithful because the client's existing site is **broadly
working** — the structure makes sense to the client, the copy is on-message,
the visual identity is theirs and they don't want to rebrand. What they want
is:

1. **Speed.** Statically generated, edge-deployed, Lighthouse 90+.
2. **Polish under the hood.** Semantic HTML, accessibility floor, mobile
   responsiveness even when the source was bolt-on responsive.
3. **Decoupling from the WP theme.** No more theme-update breakage, no PHP,
   no plugin conflicts in the frontend layer.
4. **A site they can show the client and say "look, same site, but it
   loads instantly."**

Faithful is NOT:

- A redesign in disguise.
- An opportunity to "fix" their typography because we don't like it.
- A vehicle for the JAB house style (see §2 — this is a global rule).
- A pixel-clone. (See §4.4 — never promise pixel-perfect.)

### 4.2 Resolved decisions

- ✅ **2026-05-24 (Sean):** Faithful uses the source brand. JAB visual
  identity does not appear in the rendered output. This is now §2 as a
  global rule across all three modes.

### 4.3 The Faithful contract

The prompt enforces three categories of behavior — **MUST preserve**, **MAY
upgrade**, **MUST NOT do** — in roughly that order of stringency.

#### MUST preserve (hard — no exceptions without explicit user override)

1. **Section sequence and count.** If the source has nav → hero → 3 feature
   cards → testimonial → product grid → footer, the rebuild has the same
   sequence and the same count. No condensing, no expanding, no reordering.
2. **Hero copy verbatim.** Headline, subhead, primary CTA label — exact
   string match. Punctuation, capitalization, line breaks preserved.
3. **Per-section primary copy.** Section headings and the first paragraph
   of body copy in each section, verbatim. (Trailing fluff in long
   sections may be lightly trimmed only if the section overflows mobile
   viewport in the source — see §4.6.)
4. **CTA labels and destinations.** Every button/link label preserved,
   every `href` preserved. If the source's primary CTA says "Book a free
   discovery call →" the rebuild says exactly that.
5. **Color palette.** Use the extracted primary / secondary / accent values
   verbatim. No translating to Tailwind's named palettes ("close enough"
   blue/indigo substitution is forbidden in Faithful).
6. **Typography families.** Use the extracted heading and body font
   families. Load via Google Fonts `<link>` if needed; do not substitute.
   If extraction confidence is below the review tier (0.4), and only
   then, fall back to a system stack with an apology comment.
7. **Information hierarchy.** What's above the fold in the source stays
   above the fold in the rebuild. What's a sidebar in the source stays
   visually de-emphasized. (Modernization of HOW that's expressed — flex
   vs. float vs. grid — is at the model's discretion; preserving the
   hierarchy is not.)
8. **Dynamic data binding for content backed by WP types.** When a section
   in the source renders content from a WP post type (posts, CPTs, events,
   menus), the rebuild fetches it via the typed SDK at render time, not
   as hardcoded JSX. Same for navigation: `jab/get-menus` is the canonical
   source, not the scraped nav DOM. See §3.5 for the static-vs-dynamic
   taxonomy.

#### MAY upgrade (license — model SHOULD do these when needed)

1. **Semantic HTML.** `<section>`, `<article>`, `<header>`, `<nav>`,
   `<footer>` instead of `<div>` salad — always.
2. **Mobile responsiveness.** If the source breaks at <768px, the rebuild
   doesn't. At least one tablet breakpoint, one mobile breakpoint, with
   sensible grid → stack and font scaling. The visual treatment at narrow
   widths is the model's call; just don't ship a broken mobile.
3. **Accessibility floor.** Alt text on all `<img>`. Semantic heading order
   (no h1 → h3 → h2). Color contrast ≥ 4.5:1 for body text against background
   — and this overrides the source if the source fails. (If a teal-on-cream
   button label fails contrast in the source, the rebuild deepens the teal
   to pass; the source brand stays directionally honored.)
4. **Performance.** Static export by default. No client-side JS unless a
   specific interaction in the source requires it. No external font loading
   beyond the families specifically named in tokens. Compressed images,
   `loading="lazy"` for below-the-fold media.
5. **Clean code.** No inline styles in the JSX. No `!important`. No
   redundant wrapper divs. Tailwind utility classes only (post-Phase 3:
   constrained to a project-derived Tailwind theme).
6. **Trimming demonstrable bloat.** If a section in the source contains
   the same paragraph three times due to a CMS bug, render it once and
   leave a comment. If a footer has 47 social-network icons of which 38
   link to dead profiles… we don't fix that. Render them all. Bloat we
   can prove (duplicate content) we can trim; bloat we'd just like to
   trim, we don't.

#### MUST NOT do (hard rules — failure modes worth listing)

1. **Do not apply the JAB brand. Ever.** No Syne, no DM Sans, no
   `--color-teal`, no `--color-bg`, no JAB component primitives, no dark
   surface tokens. This is the §2 global rule; reminder lives in every
   mode's contract because Sonnet drifts toward styles it has seen in
   the same context window. (Note: this applies equally to Refresh and
   Reimagine — Faithful isn't special on this dimension.)
2. **Do not invent content.** No new sections, no new testimonials, no
   new feature claims, no "and more" lists. If the source brief is sparse
   for a section, render exactly what's there — a short heading plus the
   one available sentence — and stop.
3. **Do not invent CTAs.** No defaulting to "Get Started" or "Learn More"
   when the source uses a more specific verb. No adding a second CTA where
   the source has one.
4. **Do not "improve" copy voice.** No converting "Reach out today" to
   "Get in touch" because it sounds more modern. No converting "Schedule
   your free consultation" to "Book a call". Voice is the client's.
5. **Do not collapse sections.** If two sections in the source both
   present features in slightly different layouts, the rebuild renders
   both, not a merged grid. The duplication is intentional or at least
   the client's; we honor it.
6. **Do not substitute palettes.** Even when extraction confidence is
   high, Sonnet sometimes wants to swap to a Tailwind named color
   "because it's closer to spec." The prompt has to be loud here: use
   the extracted hex verbatim.
7. **Do not promise pixel-perfect.** Output should aim for client-sign-off
   fidelity — a reasonable person looking at side-by-side desktop screenshots
   says "yes, that's a clean rebuild of our site." We never claim pixel
   equivalence in product copy or in the prompt's self-description.
8. **Do not freeze dynamic content.** If a homepage section in the source
   was rendering 3 recent blog posts at scrape time, the rebuild does not
   hardcode those 3 posts. It calls `getPosts({ numberposts: 3 })` and
   renders from data. Same applies to product grids, event lists,
   team-member cards, anything backed by a WP post type. Frozen dynamic
   content breaks the headless platform's central promise that the live
   WP site stays the source of truth.

### 4.4 Input artifacts the AI needs for Faithful

#### Mode contract

1. **The §2 global rule + the §4.3 Faithful contract** (injected as the
   treatment intent block at the top of the user message).

#### From Source A (scrape pass — see §1 "Inputs available to the AI")

In rough order of authority for visual + structural decisions:

2. **Source page screenshots** at desktop / tablet / mobile *(Phase 3 — not
   captured today)*. Sonnet 3.5+ is multimodal; the screenshots are
   ground-truth for the visual structure.
3. **Section schema** *(Phase 3 — not extracted today)*. An ordered list of
   sections with role tags (hero, features, testimonials, product-grid,
   cta, footer) extracted from the source HTML by a dedicated structural
   pass.
4. **Computed design tokens** *(Phase 3 — Stage 2 partial today)*:
   - Colors: primary / secondary / accent (✅ live)
   - Type families: heading + body (✅ live)
   - Type scale: h1 / h2 / h3 / body / small font sizes (⛔ not extracted)
   - Spacing scale: section padding, container gaps (⛔ not extracted)
   - Container max-width (⛔ not extracted)
   - Border-radius scale (⛔ not extracted)
   - Shadows (⛔ not extracted)
   - Breakpoints (⛔ not extracted)
5. **Logo + favicon** as cached assets (✅ live).
6. **CTA copy** primary + secondary, with confidence (✅ live).
7. **Brand personality** tone / energy / audience (✅ live — useful for
   small judgment calls about voice when copy is sparse).
8. **Content brief** Markdown extraction of the page (✅ live).
9. **Source HTML** as a fallback when the structural pass doesn't catch a
   section (✅ live; this is most of what the model sees today).

#### From Source B (WP manifest — see §1 "Inputs available to the AI")

Authoritative for content + data-binding decisions. Page-code pipeline only;
preview pipeline does not see these:

10. **Abilities catalog + JSON schemas** — what content the model can
    fetch via the SDK. Includes auto-discovered `jab/get-{type}` and
    `jab/get-{type}-by-slug` for every public post type, plus typed
    input / output shapes.
11. **Menu structures** (`jab/get-menus`) — canonical nav for every menu
    location, including items hidden in the scraped DOM behind mobile
    hamburger menus or off-screen at scrape-time viewport.
12. **ACF field definitions** (when ACF is active) — structured field
    shapes per post type. Preferred over inferring section semantics
    from rendered HTML; binding to ACF fields preserves the agency's
    wp-admin editing path.
13. **Per-content-type ownership** (`projects.content_ownership`) —
    whether each post type is WP-managed (live SDK fetch at request
    time) or JAB-managed (renders from `content_documents`). The page
    being rebuilt is also tagged with its ownership.
14. **Featured images, taxonomies, post hierarchy** — additional
    structured data the SDK exposes per ability; richer than what the
    scraped HTML surfaces.

**Today's Faithful is constrained:** the page-code pipeline that uses
Source B is the orphaned one — the live preview pipeline only sees
Source A. So today's running Faithful (preview-only) compensates with
explicit preservation rules; Phase 3 page-code Faithful inherits those
rules AND adds the data-binding discipline from §3.5.

### 4.5 Prompt section structure (Faithful)

The user message, top-down:

```
# Treatment intent
[Global rule — §2 condensed to ~80 words]
[Faithful contract — §4.3 as directive prose, ~400-600 words]

# Source site
URL, title, captured-at timestamp

# Section schema  (Phase 3 — when available)
1. nav  (role: nav)
2. hero  (role: hero, copy: "...", cta: "...")
3. feature-grid  (role: features, count: 3, items: [...])
4. testimonial  (role: testimonial, attributed: true)
5. footer  (role: footer)

# Content brief
[Markdown content extraction]

# Design tokens  (with confidence labels)
## Colors
- primary: #e94e1b (confidence 92%)
- secondary: ...
- accent: ...

## Typography
- heading family: "Playfair Display" (confidence 88%)
- body family: "Inter" (confidence 95%)

## Logo
- src: https://supabase.../project-assets/.../logo.png
- confidence: 90%

## Buttons (observed on source)
- primary: "Book a discovery call →"
- secondary: "Learn more"

# Brand voice
- tone: warm-professional
- energy: low-medium
- audience: small-business owners considering a brand refresh

# WP manifest summary  (Source B — page-code pipeline only)
- this page (homepage): JAB-managed
- WP-managed types (live SDK at request time): posts, beers, events
- JAB-managed types (render from content_documents): pages
- abilities available: jab/get-posts, jab/get-beers, jab/get-beer-by-slug,
  jab/get-events, jab/get-menus, jab/get-categories-terms
- ACF field groups: hero_section (background_image, headline, cta_text,
  cta_url) attached to homepage

# Menu structures  (from jab/get-menus)
- primary nav (location: primary): Home, Beers, Events, About, Contact
- footer nav (location: footer): Privacy, Terms, Sitemap

# Source HTML
[Full HTML, as fallback authority]

# Reference screenshots  (Phase 3 — when available)
[desktop.png] [tablet.png] [mobile.png]

# Output instruction
Produce the [HTML document | app/page.tsx] now. Honor the Faithful
contract above. Use the extracted color hex values verbatim. Use the
extracted typography families verbatim (via Google Fonts <link> if
needed). Output ONLY the code block.
```

The treatment intent block goes **first**, before the source material —
this is already the live ordering and the reasoning at
[`render-prompts.ts:80-89`](../apps/web/lib/ai/render-prompts.ts#L80-L89)
is correct: a faithful brief framed after the content drifts toward
"improve the page" tendencies, where the same brief at the top steers
the output correctly.

### 4.6 Decision rules for ambiguity (Faithful-specific)

These are the questions Sonnet will face mid-generation and needs the
prompt to answer in advance:

| Question | Faithful answer |
|---|---|
| Source has 8 sections but they don't all fit gracefully on a modern viewport — should I drop the weakest? | **No.** Render all 8. Use mobile breakpoint to stack. |
| Source typography is hard to read at small sizes — should I scale up? | **No to scaling the family up universally. Yes to setting a reasonable mobile minimum (16px body) even if source uses 13px.** Accessibility floor wins. |
| Source has duplicate content (same testimonial block twice on the page) — should I de-dupe? | **Yes — render once with a code comment noting the duplication.** Provable duplication = bloat. |
| Source CTA says "click here" — should I improve it to something descriptive? | **No.** Voice is the client's. Use "click here." Add `aria-label` for screen readers if the link target context allows. |
| Source uses inline styles like `<p style="color: red; font-size: 28px">` — should I preserve? | **Preserve the visual outcome (red, ~28px). Don't preserve the inline style mechanism — translate to a Tailwind utility / theme value.** |
| Source has a section with no copy except "Coming soon" — render or skip? | **Render.** It's the client's choice to publish "coming soon" and we don't second-guess. |
| Source uses a font that Google Fonts doesn't host (proprietary or custom) — what now? | **Set the family name in CSS without loading it; the browser falls back to nearest match. Leave a comment naming the missing font so the agency can host it themselves later.** |
| Source has a contact form — generate or skip? | **Out of scope for the AI generation (forms are Phase 3 work — currently falls through to the strangler-fig WP proxy). Generate a `<form>` shell with the action pointing to the source's original form endpoint; the agency wires it later.** |
| Source has a 16-image carousel — generate or simplify? | **Render as a static grid in DOM order; do not generate JS for the carousel.** No client-side interactivity in v0. |
| Source layout uses a unique technique (asymmetric grid, custom shape clip-path) — replicate or normalize? | **Replicate the visual effect via Tailwind / CSS, but do not copy the source's CSS hacks. Modern technique, same outcome.** |
| Source has a "recent posts" block showing 3 most-recent articles — hardcode them as static JSX? | **No.** Call `getPosts({ numberposts: 3 })` and render from data. Frozen post lists are the headless platform's #1 failure mode. |
| `jab/get-menus` returns 7 nav items but the scraped `<nav>` shows 5 (rest hidden in a hamburger I couldn't simulate). Which wins? | **The manifest. Always.** Render all 7 with appropriate mobile collapse. Scraped DOM is one viewport's render; the manifest is the source. |
| ACF group `hero_section` exists on the homepage with fields `background_image`, `headline`, `cta_text`, `cta_url`. The source HTML renders these. Bind to ACF or inline the text? | **Bind to ACF fields when the page is WP-managed.** Enables the agency to edit headline/CTA in wp-admin later. If the homepage is JAB-managed, the equivalent fields live in the JAB content document; bind there instead. |
| Source "Our Beers" section shows 6 beer cards from a `beers` CPT. Manifest reports 14 beers total. Render 14 or 6? | **6 — match the source's visible count via `getBeers({ numberposts: 6 })`.** Preservation of section visual size is a Faithful constraint; agency can change the limit post-generation. |
| Source has a contact form (rendered by a WP form plugin); manifest exposes no form abilities. What now? | **Out of scope for AI generation (see existing form rule). Generate `<form action="https://source.com/contact" ...>` shell pointing at the original endpoint; agency wires it later.** |

Add to this table as new cases come up during testing.

### 4.7 Failure modes to watch (Faithful-specific)

When Faithful goes wrong, it goes wrong in characteristic ways. List below
informs eval / regression test design.

1. **JAB-brand leakage.** Model uses Syne or a dark-surface palette
   despite source being a light cream brand. Cause: Sonnet trained on JAB
   examples in earlier sessions / saw JAB in the system context. Prompt
   inoculates with the §2 global rule in the treatment intent block.
2. **Palette substitution.** Model swaps extracted `#e94e1b` for
   `Tailwind orange-600`. Cause: Tailwind-native habit. Prompt counters
   with "use hex verbatim" + an example showing the bad substitution.
3. **Copy improvement.** Model "tightens" the hero copy from "Reach out
   today for a free consultation and let's chat about your project" to
   "Get a free consultation". Cause: helpfulness training. Prompt counters
   with "voice is the client's, exact strings only."
4. **Section collapse.** Source has three feature blocks (features /
   benefits / case studies); model merges them into one features grid.
   Cause: structural-elegance bias. Prompt counters with "preserve
   section count exactly."
5. **CTA invention.** Source has one CTA "Book a discovery call"; model
   adds a secondary "Learn More" to "balance" the hero. Cause: marketing-
   page priors. Prompt counters with "do not add CTAs the source doesn't
   have."
6. **Font substitution.** Source uses "Playfair Display"; model substitutes
   "Cormorant Garamond" because it's "more elegant". Same fix as palette.
7. **Mobile overhaul.** Model rebuilds the page mobile-first to the point
   that desktop reads as a scaled-up mobile design. Cause: mobile-first
   doctrine. Prompt counters with "preserve the desktop hierarchy; adapt
   it for mobile, not the other way around."
8. **Accessibility paternalism.** Model adds an entire skip-nav system,
   ARIA landmarks, focus-visible polish where source had none. Some of
   this is the §4.3 license; the line is whether the visible UI changes.
   Adding `<nav aria-label="Main">` — fine. Adding a visible skip link
   above the nav — visible change, not in Faithful's mandate.
9. **Frozen dynamic content.** Model renders 3 hardcoded blog teasers
   as static JSX instead of calling `getPosts({ numberposts: 3 })`.
   Cause: the rendered HTML feels concrete and the model treats it as
   the source of truth for content, missing that the section is
   data-bound. Prompt counters with §3.5's static-vs-dynamic taxonomy +
   an explicit "use the SDK when content is backed by a WP type" rule.
10. **Scraped-nav drift.** Model uses the scraped `<nav>` DOM (5 items,
    missing the 2 hidden behind a hamburger) instead of `jab/get-menus`
    (7 items). Cause: HTML feels more concrete than a JSON-schema list.
    Prompt counters with "menu structure always comes from the manifest,
    full stop."
11. **ACF blindness.** Model writes `<h1>{heroHeadline}</h1>` with a
    literal `heroHeadline = "..."` string instead of binding to an ACF
    field exposed on the page. Cause: ACF field structure is in the
    manifest but the model defaults to inlining what it sees in the
    rendered HTML. Prompt counters with "if an ACF field maps to a
    section, bind to it; that's the agency's wp-admin edit path."
12. **Page-ownership confusion.** Model writes SDK fetches for a
    JAB-managed page (the homepage), or hardcodes content for a
    WP-managed page. Cause: ownership isn't surfaced in the prompt
    explicitly. Prompt counters with the explicit "this page is
    JAB-managed | WP-managed" block at the top of the user message.

### 4.8 Open questions for Faithful (resolve as we iterate)

1. **What's the minimum extraction set for Faithful to be honest?**
   Today: colors + fonts + content + HTML. The contract above assumes
   that's enough with a strong prompt. Is it? When do we tell agencies
   "Faithful is degraded for this site, we couldn't extract X"?
2. **How do we handle low-confidence extractions in Faithful?** If
   primary color extracted at confidence 0.45 ("review tier"), do we
   still use it verbatim, do we show the agency a "review this" prompt
   before generating, or do we fall back to a neutral?
3. **What's the AI's escape hatch when source contradicts itself?**
   E.g., source CSS says primary is teal but the hero button is orange.
   Faithful preserves visual hierarchy (hero CTA is the visually
   dominant button) — but which is the brand color? Today: model picks.
   Should the prompt prescribe?
4. **Sectional Faithful, page-level Reimagine?** The transition doc
   mentions per-page intent override. Does that change anything about
   the section-level rules above, or is it just "this page is Faithful,
   that page is Reimagine"? Assume the latter unless we say otherwise.
5. **Image fidelity.** Source uses 2400×1600 hero JPEG that's 800KB.
   Faithful preserves the image but the §4.3 performance license says
   we can compress and `loading="lazy"`. How far can we go before this
   becomes a visible change? (Recommendation: any compression that
   leaves the image visibly indistinguishable at the rendered size is
   in scope; anything visually different is not.)
6. **When manifest data contradicts scraped HTML, what's the tiebreaker
   beyond menus?** E.g., scraped nav shows "Beers" but `jab/get-menus`
   shows "Our Beers" — the manifest wins (per §3.5). Less obvious: an
   ACF `hero_headline` field reads "Brewing Outside the Lines" but the
   scraped hero says "Brewing outside the lines." Whitespace/casing
   divergence — manifest probably right, but worth a confidence rule.
7. **How aggressive should ACF-field mapping be?** Mapping the hero
   headline to an ACF `hero_headline` field gives the agency a
   wp-admin edit path, but adds complexity (model has to confidently
   identify the right field). Recommendation for Faithful:
   opportunistic — map when ACF field names clearly correspond to
   visible page content, skip when uncertain.
8. **For JAB-managed pages, where does the rebuild source homepage
   content at generation time?** The `content_documents` table doesn't
   have an entry yet (Phase 2 work). Recommendation: at first
   generation, derive the content_document from the scraped HTML +
   ACF fields and persist it; subsequent generations read from the
   document. The document becomes the persistent source of truth,
   with the scrape as initial seed.
9. **Section limits inheritance.** When the source shows 6 of 14
   beers, we match 6 (per §4.6). What about ordering? Does the model
   preserve the source's display order (probably date-DESC from WP),
   or does it preserve the SPECIFIC 6 the source happens to show? For
   Faithful: query order, not specific IDs — keeps the page fresh as
   new beers get added in WP.

---

## 5. Refresh — sketch (we'll deepen after Faithful is solid)

### What Refresh promises

The client likes their brand and their site's content/structure, but the
visual presentation is dated. Refresh = "your site, redesigned in 2026,
within your existing brand." The agency is the buyer; the deliverable is
"a site the client says wow at when you show it, but doesn't say
'this isn't us' to."

The brand stays the client's brand (§2 global rule). What changes is the
**design craft layer** — typography rhythm, whitespace, hierarchy,
component treatment — applied with 2026 design conventions instead of
the often-2014-or-earlier conventions of the source theme.

### Where Refresh differs from Faithful

- **Type scale is modernized.** Bigger, more hierarchical, more breathing
  room. The source families are still the families; the sizes evolve.
- **Spacing is modernized.** More generous section padding, more white
  space between elements.
- **CTAs are sharpened visually.** Bigger buttons, clearer hover states,
  better contrast. Copy is still verbatim.
- **Section transitions can be modernized.** Source uses hard horizontal
  rules; Refresh might use gradient backgrounds in the source palette
  or soft section separators.
- **Light copy editing for clarity.** Removing redundant qualifiers,
  fixing typos, joining run-on sentences. Substantive copy stays.
- **Section count may flex by ±1 for clarity.** If two source sections
  are saying the same thing differently, Refresh can merge them. (Faithful
  cannot.)

### Where Refresh differs from Reimagine

- **Section sequence preserved.**
- **No new sections invented.**
- **No re-pitching of the value prop.**
- **No section re-roling** (a testimonial section stays a testimonial
  section; doesn't become a logo wall).

### Hard rules Refresh still respects

- **§2 global rule.** Refresh renders in the client's brand. Not JAB's.
- **No invented offerings, testimonials, or claims.**
- **Source palette used verbatim** (colors don't drift even with modern
  design craft applied around them).
- **Source typography families used** unless the source family is
  unloadable AND a substitute is needed; substitution requires
  confidence < 0.4 on the extraction, same as Faithful.
- **Same data-binding discipline as Faithful** (§3.5). Dynamic sections
  use SDK calls; menus come from `jab/get-menus`; ACF mapping is
  opportunistic. Modernized visual treatment doesn't justify freezing
  what should be live data.

### Refresh open questions

1. How much copy editing is "light"? Where's the line between Refresh
   and Reimagine on the copy axis? (Recommendation: Refresh = grammatical
   and brevity cleanups only; no shifts in voice, no re-pitching.)
2. Does Refresh have a "modernization style guide" of design conventions
   the model should apply? (E.g., "use generous line-height, prefer
   `text-balance` for headlines, prefer 1.5rem section padding minimum
   on mobile…") Or do we trust Sonnet's design priors? Recommendation:
   list 5-8 explicit conventions to stabilize output.

---

## 6. Reimagine — sketch (we'll deepen after Faithful is solid)

### What Reimagine promises

The agency / client agreed they want a real redesign. The existing site
is a content + brand input, not a structural reference. The AI is asked
to build the homepage it would build today for this brand if starting
fresh.

The brand stays the client's brand (§2 global rule). What changes is the
**structural and creative latitude** — the model gets to make new
choices about section ordering, hero treatment, supporting sections,
visual ambition.

### The license Reimagine grants

- **New structural choices** — feature ordering, hero treatment, supporting
  sections, section roles can shift.
- **New copy** — author CTAs, headlines, subheads grounded in the
  offerings. Voice stays the brand's.
- **Visual ambition** — bolder typography hierarchy, more sophisticated
  layouts, decorative treatments that wouldn't fit Faithful or Refresh.
- **Supporting palette** — the source palette stays foundational; the
  model may introduce supporting neutrals to round it out for a modern
  system (e.g., source brand is just orange + black; model adds a
  supporting warm-gray scale for body text and surfaces).
- **Modernized typography** — may swap to a deliberate substitute that
  respects the brand register (e.g., source uses Georgia for body;
  Reimagine may use Source Serif Pro for a similar register with better
  type scale). This is intentional, not casual substitution.

### The hard rules Reimagine still respects

- **§2 global rule.** Reimagine renders in the client's brand. Not JAB's.
  The "visual ambition" license is ambition within the client's brand
  foundation — not a re-skin to a different visual identity.
- **Manifest-led, scrape-referenced.** Reimagine treats Source B (the WP
  manifest) as the primary content authority — *what does this site have
  to surface?* — and Source A (scraped HTML) as visual reference only.
  Dynamic data binding via SDK is mandatory; the §3.5 discipline applies
  in full. A "Reimagined" site that hardcodes 3 latest posts is worse
  than the source, not better.
- **No invented offerings.** If the source doesn't mention "AI consulting,"
  the rebuild doesn't either.
- **No invented testimonials, case studies, statistics.** Every claim
  must trace back to the source content.
- **Brand foundation stays the brand's.** The extracted palette and
  typography are the starting point, even if rendered with more
  ambition. Reimagine is not a re-brand; it's a redesign within the
  brand.
- **Audience stays the source's audience.** Personality extraction
  drives voice and visual register; we don't pivot from "warm-professional
  / small-business" to "cool-techbro / VC-backed startup" because we
  think it's more compelling.

### Reimagine open questions

1. How much weight does the source HTML get vs. being treated purely
   as a content + brand inputs file? If the source HTML is the kind of
   thing the agency would never want to inherit, do we even include it
   in the prompt for Reimagine? (Recommendation: include it but
   demote it — "for reference only, not as a structural template.")
2. Does Reimagine cap creative variance with examples ("here are 3
   ways agencies have used Reimagine well")? Or do we trust the
   personality + brand inputs to constrain it? Open until we have
   eval data.
3. Can Reimagine introduce decorative elements not in the source
   (subtle background patterns, geometric accents)? Recommendation:
   yes, sparingly, but they must use the source palette and avoid any
   visual signature that reads as JAB's identity.

---

## 7. Implementation surfaces

### 7.1 Preview-render pipeline (live today)

- **File:** `apps/web/lib/ai/render-prompts.ts`
- **Function:** `buildRenderPrompt(scrape, { intent })`
- **Output:** Self-contained HTML inside an iframe `srcDoc`.
- **What changes when this doc lands:**
  - Replace the one-paragraph `INTENT_BRIEFS[intent]` with the
    contract-style prose from §2 + §4.3 / §5 / §6.
  - Add the §4.6 decision-rules table as an explicit "When you face
    ambiguity" section.
  - Add the §2 global-rule reminder to `RENDER_SYSTEM` as well —
    belt-and-suspenders against JAB-brand leakage across all modes.
  - Keep the existing token / personality / brief blocks as-is.
- **Constraints:** Sonnet's 8192-token output cap (recently raised to
  16384 in the preview renderer per commit `c19f67c`). Self-contained
  HTML with inline `<style>` element; no external CSS.

### 7.2 Page-code generation pipeline (Phase 3 — not live)

- **File:** `apps/web/lib/ai/prompts.ts`
- **Function:** `buildUserPrompt(ctx)` and `buildSystemBlocks(sdkSource)`
- **Output:** `app/page.tsx` (Next.js Server Component, TypeScript,
  Tailwind).
- **What changes when this doc lands:**
  - Add `intent` to `PromptContext`.
  - Inject the same contract-style intent block as the preview
    pipeline does, at the **top of the user message** (mirror the
    order discipline).
  - Add the §2 global rule to `STATIC_SYSTEM_BASE`. This is critical:
    the page-code pipeline produces an actual deployable artifact;
    JAB-brand leakage here ships to a client URL.
  - Constrain the Tailwind theme reference: for Faithful (and Refresh),
    the generated `tailwind.config.ts` should use the extracted tokens
    verbatim, not Tailwind defaults.
  - For Faithful, the system prompt's "Match the source page's
    visual structure approximately" line needs to be **strengthened
    to exact-match for sections / copy** and **stay-loose for
    code-style** (semantic HTML, Tailwind utilities).
- **Constraints:** Sonnet outputs `app/page.tsx` as a single file in one
  generation. Multi-file generation (separate components, separate
  config) is a separate pipeline change tracked in Phase 3.

### 7.3 The shared mode contract

The contract defined in §2 / §4 / §5 / §6 should live as **one source
of truth**. Recommended:

- A new file `apps/web/lib/ai/mode-contracts.ts` exporting
  `getGlobalRule()`, `getFaithfulContract()`, `getRefreshContract()`,
  `getReimagineContract()` as composed prose blocks.
- Both `render-prompts.ts` and `prompts.ts` import from here.
- Behavioral changes are made in one place; the two pipelines stay
  consistent.

This keeps `INTENT_BRIEFS` as a temporary alias that can be removed
once both pipelines consume the new contracts.

### 7.4 Gap analysis — what `prompts.ts` is missing today

The Phase 3 page-code prompt at [`apps/web/lib/ai/prompts.ts`](../apps/web/lib/ai/prompts.ts)
exists but predates §2 / §3.5 / §4. Below is the checklist of what the file
needs to absorb when it gets rewired. Group A is foundational — Phase 3
cannot ship without these. Group B is fidelity enhancement and lands as the
extraction pipeline catches up to the §4.4 "not yet captured" block.

#### Group A — Foundational (blocks Phase 3 go-live)

| Gap | Spec ref | What's missing in `prompts.ts` today | Suggested change |
|---|---|---|---|
| `intent` not in `PromptContext` | §4.3 / §5 / §6 | The `PromptContext` interface ([prompts.ts:52-91](../apps/web/lib/ai/prompts.ts#L52-L91)) has no `intent` field | Add `intent: RenderIntent` (re-export from `render-prompts.ts`, or move type to a new `mode-contracts.ts` per §7.3) |
| §2 global rule absent | §2 | `STATIC_SYSTEM_BASE` has no "JAB brand never bleeds" rule | Prepend the §2 rule as the first paragraph after the engineer-role intro. Same caching tier as the rest of the static base |
| Mode contract not injected | §4.3 / §5 / §6 | `buildUserPrompt` does not inject an intent brief at the top of the user message | Inject `# Treatment intent` block before `# WordPress site`. Mirrors the order discipline in `render-prompts.ts` |
| Page ownership not surfaced | §3.5, §4.7 failure mode 12 | `projects.content_ownership` exists in DB but isn't loaded into `PromptContext`; page-level ownership tag isn't computed | Add `pageOwnership: "jab-managed" \| "wp-managed"` + `contentOwnership: Record<string, ...>` to `PromptContext`; render as `# WP manifest summary` block per §4.5 |
| Menu structures not pre-fetched | §3.5, §4.6 row 2, §4.7 failure mode 10 | Worker doesn't call `jab/get-menus` ahead of generation; the model is left to infer from the scraped nav DOM | Add a `load-context` step that fetches menus via the SDK; render as `# Menu structures` block per §4.5 |
| ACF field groups not enumerated | §3.5, §4.6 row 3, §4.7 failure mode 11 | `abilitiesSummary` is a flat string; doesn't surface ACF group → post-type mapping | Walk the manifest's ACF metadata; render as ACF sub-block of `# WP manifest summary` per §4.5 |
| Static-vs-dynamic discipline weak | §3.5 | Only weak hint at [prompts.ts:48](../apps/web/lib/ai/prompts.ts#L48): "If the source HTML references content that maps to an SDK call, fetch it." Permissive, not enforcing | Replace with the §3.5 taxonomy + the explicit "don't freeze dynamic content" + "menus always come from the manifest" rules. Lives in `STATIC_SYSTEM_BASE` |
| Faithful preservation rules absent | §4.3 MUST preserve | Only weak hint at [prompts.ts:46](../apps/web/lib/ai/prompts.ts#L46): "Match the source page's visual structure approximately... Don't try to pixel-match." Latter is fine, former is too permissive for Faithful | Inject the full §4.3 MUST-preserve list when `intent === "faithful"` (and the contract from §5 / §6 for the others). Lives in the per-intent treatment block, not the static base |
| Tailwind palette discipline too soft | §4.3 MUST preserve #5, MUST NOT #6 | Current prompt asks model to pick Tailwind classes that "approximate" extracted hex — explicitly the wrong behavior per §4.3 | Per-intent Tailwind config: Faithful / Refresh get a project-derived theme with extracted hex verbatim (post-Phase 3 extraction); only Reimagine may use Tailwind's default palette as a fallback |
| Copy-verbatim rules absent | §4.3 MUST preserve #2-4 | No rules about hero copy / section heading / CTA preservation | Inject from §4.3 contract in the per-intent treatment block |

#### Group B — Fidelity enhancement (lands as extraction catches up)

| Gap | Spec ref | What's missing | Blocking dependency |
|---|---|---|---|
| Multi-breakpoint screenshots | §4.4 item 2 | Scrape pass captures one render only | Phase 3 extraction: headless-browser pass at 3 viewports, multimodal input to the prompt |
| Section schema with role tags | §4.4 item 3 | No structural extraction beyond raw HTML | Phase 3 extraction: dedicated structural pass (DOM walk + ACF-flex / Gutenberg-block introspection) |
| Type scale, spacing, container width, radii, shadows, breakpoints | §4.4 item 4 | Stage 2 captures families + colors only | Phase 3 extraction: computed-style read in a headless browser |
| Content brief Markdown | §4.4 item 8 (vs. raw HTML at item 9) | `pageHtml` is passed; the `contentMarkdown` from `scrape-agent` is not | Refactor `PromptContext` to receive the full `ScrapeAgentResult`, not just raw HTML |

#### Notes

- **Caching seam:** `buildSystemBlocks` ([prompts.ts:99-110](../apps/web/lib/ai/prompts.ts#L99-L110))
  already caches the SDK source as `ephemeral`. The §2 global rule fits in
  the same uncached static base (constant across all calls). The mode
  contract is intent-specific and should stay in the user message so
  intent changes mid-session don't invalidate any cache block.
- **Per-page intent override** (§4.8 Q4) is a no-op data-flow change once
  `PromptContext.intent` exists — pass per-generation, not derived from
  `project.intent`.
- **Regression baselines:** Group A changes the prompt structure
  substantively. `scripts/validate-ai` golden files will need rebaselining
  in the same PR; plan for that.

---

## 8. Deterministic guardrails — what shouldn't live in the prompt

Prompts are probabilistic. Every responsibility we move out of the prompt
and into deterministic code is one less thing the model can get wrong.

**The principle: the prompt is the last resort, not the first.**

This section enumerates the four classes of guardrails — pre-prompt input
preparation, prompt configuration, post-output validation, post-output
rewriting — and what belongs in each. The §4 / §5 / §6 mode contracts
assume these guardrails are in place; the prompt text only enforces what
code cannot.

### 8.1 Pre-prompt input preparation (deterministic)

Things the system computes, fetches, or normalizes **before** the prompt
fires, so the model never sees ambiguous or unvalidated input.

- **Menu structures** — fetch via `jab/get-menus` at generation time.
  Don't ask the model to infer menus from scraped HTML.
- **Per-page ownership tag** — read `projects.content_ownership` + the
  page's post-type; compute "JAB-managed" or "WP-managed" and pass to
  the prompt as a known fact, not something for the model to deduce.
- **Project-derived Tailwind theme** — for Faithful and Refresh, emit a
  per-project `tailwind.config.ts` whose theme only exposes brand-named
  utilities (`brand-primary`, `brand-secondary`, `brand-heading-font`,
  etc.) mapped to extracted tokens. The model writes `bg-brand-primary`;
  the build resolves to extracted hex. **This eliminates §4.7 failure
  mode #2 (palette substitution) at the toolchain level — the model
  literally cannot write `bg-orange-500` because the class doesn't exist
  in the project's Tailwind theme.** Same trick locks typography
  families.
- **Google Fonts `<link>` tag** — compute from extracted family names
  and pass the full tag ready to inline. Don't ask the model to figure
  out the URL.
- **Image asset URLs** — already rewritten to JAB's Supabase Storage by
  Stage 1 asset capture. The model never sees the source CDN.
- **HTML entity decoding** — pre-decode in extraction (already done in
  the PHP manifest layer; not yet for scraped HTML). Belt-and-suspenders:
  also ship a tested `decode()` utility for the model to use on any
  WP-sourced text. Code-side fix removes 80% of the failure mode; prompt
  rule covers the long tail.
- **Confidence-thresholded tokens** (✅ live in `render-prompts.ts` and
  `prompts.ts`) — sub-0.4 fields omitted entirely; 0.4–0.7 fields flagged
  "treat as suggestion." Model never sees noise.
- **Extracted hex normalization** — lowercase, 6-digit form, no
  whitespace. The prompt then asserts "use exactly these strings."
- **Reasoning string sanitization** (✅ live at `prompts.ts:372`) —
  strip code fences and ATX heading markers from LLM-authored reasoning
  before embedding in a code-fence-aware prompt. Prevents prompt-
  injection-via-extraction.

### 8.2 Prompt configuration (deterministic knobs around the prompt)

- **Model selection per intent.** Open question — for v0 use Sonnet for
  all three. Faithful's constrained reproduction is well within Sonnet's
  comfort zone; Reimagine's creative latitude might justify Opus once
  eval data shows creativity is a constraint. Cost-side measurement
  needed (saas-mvp-transition COST-2).
- **Temperature per intent.** Faithful = 0 (deterministic). Refresh =
  0.2 (slight design-craft latitude). Reimagine = 0.5 (real creative
  variance). Lower temperature = stronger constraint adherence.
- **Output token cap.** Set high enough that truncation is rare (preview
  pipeline raised to 16384 per commit `c19f67c`). Gate on `stop_reason`
  per §8.3.
- **System block caching.** Engineer-role intro + §2 global rule =
  cached static block. SDK source = second cached ephemeral block. Mode
  contract = uncached user-message block so intent changes don't
  invalidate cache. Pattern documented at `prompts.ts:99-110`.
- **Block ordering in the user message.** Treatment intent → page
  ownership → manifest summary → menus → design tokens → content brief
  → source HTML. Order matters; preview pipeline's reasoning at
  `render-prompts.ts:80-89` is correct on this and the page-code
  pipeline should mirror it.

### 8.3 Post-output validation (deterministic, gates publication)

These run on the model's output **before anything ships**. Any failure
fails the generation job; the output never reaches a client URL. Most
are regex / AST passes — no LLM-as-judge needed.

| Validator | What it catches | Spec ref |
|---|---|---|
| **Build / typecheck gate** | Doesn't compile, type errors, malformed JSX, broken imports | saas-mvp-transition Phase 1 QUAL-1 |
| **`stop_reason !== "end_turn"`** | Truncated output silently shipped as success | saas-mvp-transition Phase 1 QUAL-2 |
| **JAB-bleed scan** | Output contains `Syne`, `DM Sans`, `JetBrains Mono`, or any JAB hex token (`#060d16`, `#00c9a7`, `#0a1628`, `#0f2040`, `#1a3158`, `#2563ff`, `#ff4444`, `#f59e0b`, `#f0f4f8`, `#7a9ab8`, `#3a5070`) | §2, §4.7 #1 |
| **Palette adherence** | Any color value not traceable to the extracted palette (after §8.1 Tailwind-theme remap) | §4.7 #2 |
| **Typography family adherence** | Any `font-family` declaration or Google Fonts `<link>` referencing a family not in extraction | §4.7 #6 |
| **Menu structure adherence** | Faithful: generated nav DOM doesn't include all items from `jab/get-menus` with exact label match | §4.7 #10 |
| **Hero copy verbatim** | Faithful: hero copy extracted by scrape-agent doesn't appear verbatim in output | §4.7 #3 |
| **CTA copy adherence** | Faithful: any extracted CTA label missing from output, or extra CTAs invented | §4.7 #5 |
| **Section count adherence** | Faithful: extracted vs. generated section count mismatches. Refresh: > ±1 delta. Reimagine: no constraint *(requires Phase 3 section-schema extraction; falls back to weaker heuristic counting until then)* | §4.7 #4 |
| **Frozen-content scan** | `<article>` / post-card / event / product-grid markup that doesn't trace back to an SDK call | §4.7 #9 |
| **Accessibility floor (axe-core)** | Critical a11y violations in rendered HTML — catches the *opposite* of §4.7 #8 (too little a11y, not too much) | §4.3 MAY upgrade #3 |
| **No client-side JS injected** | Faithful: any `<script>` or `"use client"` in output (carousels, sliders, interactive widgets) | §4.6 carousel row |

### 8.4 Post-output rewriting (deterministic, transforms but doesn't fail)

Light touch — the model produced something usable but needs small
mechanical cleanup. Auto-fix and proceed; log the rewrite.

- **Hex normalization.** Model wrote `#E94E1B`; extracted token is
  `#e94e1b`. Normalize to match.
- **Image URL rewriting.** Model referenced source CDN for an image
  cached in Supabase Storage; swap to cached URL.
- **Whitespace normalization in copy.** `"Welcome  to"` → `"Welcome to"`.
  Don't go fishing for non-trivial differences — fail those at §8.3.

Auto-rewrites should be the exception, not the rule. If a class of issue
is common enough to want auto-fixing, the right answer is usually to fix
the prompt or the §8.1 input prep — not to keep cleaning up after the
model.

### 8.5 What genuinely needs to stay in the prompt

Everything the system can't determine in advance or check at the end:

- Visual layout judgment ("how should this section render at this
  breakpoint within the contract?")
- Component composition decisions (Card vs Section vs Article — the
  semantic choice)
- Copy authoring (Reimagine's authored CTAs, Refresh's light edits)
- Section role inference when section schema isn't pre-extracted
- ACF field-to-section semantic mapping when field names are ambiguous
- Aesthetic harmony judgments (spacing rhythm, color balance, type
  scale within constraints)
- Responsive behavior at narrow widths within the contract
- Brand voice application to inline copy

These are the things the prompt should be tight about — and *only* these.
Everything else belongs in §8.1–§8.4.

### 8.6 Current state of the guardrails

| Guardrail | Class | Status | Notes |
|---|---|---|---|
| Confidence-thresholded tokens | §8.1 | ✅ live | `prompts.ts`, `render-prompts.ts` |
| Reasoning sanitization | §8.1 | ✅ live | `prompts.ts:372` |
| Image asset capture | §8.1 | ✅ live | `asset-capture.ts` |
| HTML entity decoding (server side) | §8.1 | ⚠ partial | PHP manifest only; scrape HTML not yet decoded |
| Menu pre-fetch | §8.1 | ⛔ | §7.4 Group A |
| Page ownership pre-load | §8.1 | ⛔ | §7.4 Group A |
| Project-derived Tailwind theme | §8.1 | ⛔ | Highest-leverage missing piece |
| Google Fonts link pre-compute | §8.1 | ⛔ | Small, easy |
| Per-intent model selection | §8.2 | ⛔ | Defer until eval data |
| Per-intent temperature | §8.2 | ⛔ | One-line config change |
| System block caching | §8.2 | ✅ live | `buildSystemBlocks` |
| Build / typecheck gate | §8.3 | ⛔ | Phase 1 QUAL-1 |
| `stop_reason` check | §8.3 | ⛔ | Phase 1 QUAL-2 |
| JAB-bleed scan | §8.3 | ⛔ | Cheap regex |
| Palette adherence | §8.3 | ⛔ | AST pass on Tailwind classes + inline CSS |
| Typography family adherence | §8.3 | ⛔ | Regex on `font-family` + `<link>` |
| Menu structure adherence | §8.3 | ⛔ | DOM walk |
| Hero copy verbatim (Faithful) | §8.3 | ⛔ | String search |
| CTA copy adherence (Faithful) | §8.3 | ⛔ | String search |
| Section count adherence | §8.3 | ⛔ | Heuristic until Phase 3 schema lands |
| Frozen-content scan | §8.3 | ⛔ | AST walk for `<article>` etc. without an SDK ancestor |
| Accessibility floor | §8.3 | ⛔ | axe-core in headless browser |
| No `<script>` (Faithful) | §8.3 | ⛔ | Regex |
| Hex normalization (post) | §8.4 | ⛔ | Trivial |
| Image URL rewriting (post) | §8.4 | ⛔ | Belt-and-suspenders |

**Read across the table:** the input-prep side (§8.1) is mostly done or
small. The validation side (§8.3) is mostly missing and is the biggest
batch of work — but every single one is a regex / AST / build-tool pass,
not an LLM call. Cheap to build, high leverage, and they let the prompt
itself stay shorter because the prompt no longer has to be the only
enforcement of every rule.

**The pattern to push toward:** every §4.7 failure mode should be caught
by *both* a prompt rule (in §4.3) AND a §8.3 validator. Two-layer defense
— prompt steers, validator catches anything that drifts through.

---

## 9. Iteration log

Track changes to mode definitions, prompt structure, and failure modes
discovered in eval / production. New entries at the top.

| Date | Change | Reason | Author |
|---|---|---|---|
| 2026-05-25 | **Pass A** of the v0.5.0+v0.6.0 plugin refresh. Restructured §1 Source B to document the new per-page structured content (`content`, `blocks` as typed `oneOf` discriminated union over `WP_Block_Type_Registry`, `rendered_content`), the `include` flag mechanics, ACF Blocks via `block==<name>` location rules, reusable block expansion, and the `/wp-json/jab/v1/*` REST namespace (manifest, content-types, health). §1 "Not yet captured" section-schema bullet updated — block-structured (Tier 1) pages now have it. §3.5 mapping table restructured around a source-priority chain with the block tree at the top; operationally note acknowledges Tier 1 sites shift the contract from "infer the schema" to "render the schema." Pass B (§4.x contract refresh) and Pass C (§7.4 / §8.6 status updates) still to come. | Plugin shipped v0.5.0 (block emission) + v0.6.0 (typed-block moat + manifest endpoint) since the doc was last updated; the §1 / §3.5 cascade was two versions behind. | Sean + AI prompt engineer pairing |
| 2026-05-24 | Added §8 — deterministic guardrails framework. Four classes (input prep / prompt config / output validation / output rewriting) + a status table at §8.6. Reframes the mode contracts as the *prompt's* job vs. what code can enforce reliably — the prompt becomes the last resort, not the first. Renumbered iteration log → §9, next actions → §10, "how this doc connects" → §11. Updated §10 next actions with two new items (Tailwind-theme generator, §8.3 validator suite). | Sean: "Before we move on to the prompts lets think carefully about what should be done deterministically to keep the prompt aligned." | Sean + AI prompt engineer pairing |
| 2026-05-24 | Added §7.4 — structured gap analysis between `prompts.ts` today and the §2 / §3.5 / §4 contract. Group A = foundational gaps that block Phase 3 go-live; Group B = fidelity enhancement that lands as extraction catches up. Cross-referenced in §10 next action #3. | Need a concrete punch list for the Phase 3 prompt rewrite — strategic overview in §7.2 wasn't tactical enough to execute against. | Sean + AI prompt engineer pairing |
| 2026-05-24 | Folded WP manifest in as a first-class input (Source B). New §1 "Inputs available to the AI" two-source breakdown; new §3.5 "Static vs. dynamic content" mapping discipline; threaded manifest-aware rules through §4.3 / §4.4 / §4.5 / §4.6 / §4.7 / §4.8 with mirrors in §5 / §6. | Sean flagged the doc was scrape-centric: "We are connected to WP. We have access to the actual content, menus, etc. How is this taken into consideration?" | Sean |
| 2026-05-24 | Lifted "no JAB bleed" to §2 as a global rule binding all three modes. Reworked Refresh and Reimagine to remove "JAB sensibility" framing — they now apply *universal design craft* within the client brand, not JAB-specific design language. | Sean ratified: "JAB is JAB. The clients are totally separate." | Sean |
| 2026-05-24 | Initial draft. Faithful contract drafted at §4.3; Refresh / Reimagine sketched. Visual-fidelity question raised at §4.2 (resolved same day). | Doc creation. | Sean + AI prompt engineer pairing |

---

## 10. Next actions

1. ✅ ~~Resolve the visual-fidelity question~~ — done 2026-05-24, see §2.
2. **Rewrite the current `INTENT_BRIEFS[faithful]`** in `render-prompts.ts`
   using §2 + §4.3 + §4.5 + §4.6 as source material. Add the §2 global
   rule to both modes' briefs and to `RENDER_SYSTEM`. Keep Refresh and
   Reimagine on their current one-paragraph briefs until §5 / §6 are
   deepened — but inject §2 into all three.
3. **Work through §7.4 Group A before Phase 3 page-code generation goes
   live.** The Phase 3 deployment pipeline cannot ship without these
   foundational changes — generated `app/page.tsx` files won't honor the
   mode contract, page-ownership routing, or the data-binding discipline.
   Group B is fidelity enhancement and lands as the extraction pipeline
   catches up; it isn't a Phase-3-blocker.
4. **Build the project-derived Tailwind theme generator (§8.1).** This is
   the single highest-leverage piece of new code. Convert extracted hex +
   family tokens into a per-project `tailwind.config.ts` whose theme only
   exposes brand-named utilities (`brand-primary`, `brand-heading-font`,
   etc.). Eliminates palette and font substitution at the toolchain level
   — the model literally cannot write a non-brand class because it doesn't
   exist in the project's theme. Same fix for Refresh; Reimagine gets the
   brand-named utilities plus access to Tailwind's neutral scales for
   supporting palette work (per §6).
5. **Build the §8.3 post-output validator suite** alongside §7.4 Group A.
   Highest-leverage cheap guardrails (all regex / AST / build-tool passes
   — no LLM-as-judge): build/typecheck gate, `stop_reason` check, JAB-bleed
   scan, palette adherence, typography family adherence, menu structure
   adherence, frozen-content scan, hero copy verbatim (Faithful), CTA copy
   adherence (Faithful), no-`<script>` (Faithful). Run as part of every
   generation job before persisting output to `generation_jobs.generated_code`
   — any validator failure fails the job; no output reaches a client URL
   without passing. See §8.6 for the full table.
6. **Add an `evals/` directory** with 3–5 source sites per intent, run
   the rewritten Faithful prompt against each, and add to §4.7 / §4.6 as
   new failure modes / decision points surface. Wire the §8.3 validators
   into the eval harness so the same checks gate eval runs AND production
   generations.
7. **Per-intent generation parameters (§8.2).** Set temperature 0 for
   Faithful, 0.2 for Refresh, 0.5 for Reimagine — one-line config change.
   Default model = Sonnet for all three; revisit Opus for Reimagine once
   eval data shows creativity is constrained by Sonnet.
8. **Defer §7.3 refactor (`mode-contracts.ts`)** until both Faithful and
   Refresh have stable contracts — premature consolidation locks in the
   wrong abstraction.

---

## 11. How this doc connects to others

- [`jab-brand.md`](jab-brand.md) — the JAB platform brand. §2 of this doc
  draws the line between where JAB brand applies (platform surfaces) and
  where it must not (every customer-facing generated artifact). Consider
  adding a "Where JAB brand ends" pointer in `jab-brand.md` to §2 here.
- [`saas-mvp-transition.md` §5 Phase 3](saas-mvp-transition.md) — commits
  Faithful to computed-style extraction + multi-breakpoint screenshots +
  visual-diff verification. This doc is the prompt-side contract that
  the Phase 3 extraction work feeds; the bullet list there can eventually
  be replaced with a reference here.
- [`apps/web/lib/ai/render-prompts.ts`](../apps/web/lib/ai/render-prompts.ts) —
  the live implementation of §7.1. When the prose in `INTENT_BRIEFS` is
  rewritten, the file's header comment should point back to this doc as
  the spec being implemented.
