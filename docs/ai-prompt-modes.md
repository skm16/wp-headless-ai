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
as a single paragraph of directive prose (`INTENT_BRIEFS`). The earlier
page-code generation pipeline (`lib/ai/prompts.ts`, `lib/ai/agent.ts`,
`lib/inngest/functions/generate-page.ts`) was deleted in commit `75d485a`
(2026-05-25) as the first step of the deterministic-first refocus — when
the page-code path is rebuilt for the Phase 2/3 deployments work, it must
adopt the contract defined here.

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
| Page-code prompt | _(deleted)_ | — | The original `lib/ai/prompts.ts` was removed 2026-05-25. The rebuild lands with the Phase 2/3 deployments work and must adopt the contract in §2 + §4–§6 (gap list at §7.4 is the punch list). |
| Page-code worker | _(deleted)_ | — | `lib/inngest/functions/generate-page.ts` removed 2026-05-25 along with the prompt and `/api/projects/[id]/generate` route. |

**The mode contract this doc defines must be honored by both pipelines.**
Today only the preview pipeline exists; the rebuilt page-code pipeline
inherits the same contract on day one.

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
| Preview render | `apps/web/lib/ai/render-prompts.ts` | ✅ | ❌ today (see §7.1) | Throwaway HTML in an iframe `srcDoc`. No runtime data fetch from the output. But §7.1 / step 6 of the refocus plan moves the worker to read Source B at generation time and pass typed `BlockNode[]` to the renderer. |
| Page-code generation (Phase 2/3 rebuild) | _(file TBD — pipeline deleted 2026-05-25)_ | ✅ | ✅ | Output is real Next.js app; SDK calls fetch live data at request time. Rebuild must consume both sources from day one. |

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

**Operating principle (plugin v0.6.0 onwards):** For Tier 1 source sites
(block-structured — Gutenberg, ACF Flex, ACF Blocks) the AI's job is to
**render the structured page schema** the platform hands it, not infer
the schema from HTML. The contract below describes what the OUTPUT must
preserve; the source-priority chain in §3.5 governs which input the model
reads each value from. **Two Roads (ACF Flex) is firmly Tier 1.** For Tier
2/3 sites the model does correspondingly more inference; the contract
holds the output to the same standard regardless of how much was extracted
vs. inferred.

#### MUST preserve (hard — no exceptions without explicit user override)

1. **Section sequence and count.** Source per §3.5: the page's `blocks[]`
   tree (top-level node order) or its ACF Flex layout array (array order)
   when present; DOM-inferred sequence from scraped HTML only when neither
   exists. The rebuild's section count equals the source's section count —
   no condensing, no expanding, no reordering — regardless of which rung
   of the chain provided it. For a Two Roads-style ACF Flex page that's
   `hero → feature_grid → testimonials → cta → footer`, those five
   layouts come straight out of the page's Flex field. **The field name
   is per-site** — Two Roads happens to call it `acf.page_builder`;
   another site might call it `acf.sections`, `acf.layout`, `acf.blocks`,
   anything. The structure (a Flex field on the page returning a typed
   array of layouts in editor order) is general; the field name is
   whatever the agency named it when they built the ACF group.
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
8. **Data binding via the source-priority chain.** Walk §3.5's chain for
   each section. For Tier 1 sites this means binding directly to the
   matching node in `blocks[]` (including ACF Block `attrs.data`, typed
   end-to-end since v0.6.0) or the matching ACF Flex layout (Two Roads'
   pattern). For dynamic items (recent posts, CPT grids, event lists),
   the SDK call is the data source regardless of tier — the block/Flex
   node provides the wrapper; items come from `jab/get-{type}` at render
   time. Navigation is always `jab/get-menus`, never the scraped nav DOM.

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
9. **Do not infer structure when the plugin provides it.** When `blocks[]`
   is populated for the page, OR when an ACF Flex layout exists, that
   structured tree IS the section schema — use it. Don't fall through
   to DOM inference because the HTML feels more concrete; the model's
   structural inference is noisier than the plugin's deterministic
   extraction. The HTML is for visual reference and Tier 2/3 structural
   fallback only.

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

#### From Source B (WP plugin v0.6.0 — see §1 "Inputs available to the AI")

Page-code pipeline only; preview pipeline does not see these. Authoritative
for content + structural decisions.

**Per-page structured content (highest authority for rebuilding THIS page):**

10. **Page block tree** (`blocks` field on `getPageBySlug`) — typed
    `BlockNode[]` from the page's `post_content`, with a `oneOf`
    discriminated union over every registered block type. Top-level node
    order is the section order. ACF Blocks (`acf/*`) carry typed
    `attrs.data` end-to-end via [`BlockFieldSchema`](../packages/wp-plugin/includes/Acf/BlockFieldSchema.php).
    THIS is the section schema when present; never infer from HTML when
    this is here.
11. **Page ACF Flex layouts** — inside the page's `acf` property, each
    Flex field returns `array<oneOf<layout1 | layout2 | …>>` with
    `acf_fc_layout` as the discriminator. Layout order = section order
    within that field. **Two Roads' pattern.**
12. **Raw page content** (`content` field) — full `post_content` HTML
    string. Use as fallback when the block tree doesn't describe a
    section finely enough (mostly Tier 2/3 cases, or rare Tier 1 cases
    with deeply nested freeform inside a `core/group`).
13. **Rendered page content** (`rendered_content` field) — `post_content`
    after the `the_content` filter chain. Opt-in via `include.render=true`.
    Use only when dynamic blocks / shortcodes / oEmbeds need to be
    expanded for the model to understand what the source actually renders
    (e.g. a `[shortcode]`-driven testimonial slider in a legacy site).

**Catalog (general site knowledge, fetched once per project):**

14. **Abilities catalog + JSON schemas** — what content the model can
    fetch via the SDK at render time. Auto-discovered `jab/get-{type}`
    and `jab/get-{type}-by-slug` for every public post type, with typed
    input/output shapes. Pre-fetched from `/wp-json/jab/v1/manifest`.
15. **Menu structures** (`jab/get-menus`) — canonical nav for every menu
    location, including items hidden behind mobile hamburgers or
    off-screen at scrape-time viewport.
16. **ACF field definitions for OTHER post types** (when ACF is active) —
    structured field shapes used for typing dynamic content fetched
    from non-page post types (e.g. a `beers` CPT with ACF fields).
    The PAGE'S ACF Flex / Block instances are items 10–11 above.
17. **Per-content-type ownership** (`projects.content_ownership` +
    `/wp-json/jab/v1/content-types`) — WP-managed vs JAB-managed per
    post type. The page being rebuilt is also tagged with its
    ownership.
18. **Featured images, taxonomies, post hierarchy** — additional
    structured data per ability; richer than scraped HTML surfaces.

**Tier-aware framing:** For Tier 1 sites, items 10–11 ARE the input — the
AI renders them. For Tier 2 (theme template + scalar ACF), items 10–11
are usually empty or thin; items 12 + 14–18 + Source A HTML inference do
the work. For Tier 3 (pure scrape), Source B narrows to items 15–18 and
Source A bears the load. The contract above holds regardless; what
changes is how much inference the model has to do.

### 4.5 Prompt section structure (Faithful)

The user message, top-down:

```
# Treatment intent
[Global rule — §2 condensed to ~80 words]
[Faithful contract — §4.3 as directive prose, ~400-600 words]
[Source-priority chain reminder — §3.5 in one paragraph]

# Source site
URL, title, captured-at timestamp

# Page identity & ownership  (Source B)
- post type: page
- slug: home
- ownership: WP-managed
- structured content source: ACF Flex (field: page_builder)
  // The field name (`page_builder`) is per-site — whatever the agency
  // named the Flex field when they built the ACF group. Two Roads uses
  // `page_builder`; another site might use `sections`, `layout`, `blocks`.
  // The prompt injects the actual field name at generation time.
  // Other possible values for this line:
  //   "Gutenberg blocks (blocks field)" — page uses post_content blocks
  //   "ACF Blocks (blocks field with acf/* entries)" — custom ACF blocks
  //   "theme template + scalar ACF (fields: hero_headline, hero_image, …)" — Tier 2
  //   "pure scrape (no structured source)" — Tier 3

# Page structured content  (Source B — Tier 1 input, when available)
[For Two Roads' ACF Flex pattern — the array under page.acf.<flex_field_name>.
 Two Roads names the field `page_builder` so the worker injects the array
 from page.acf.page_builder. Another site would inject from whatever name
 its Flex field has.]
[
  {
    "acf_fc_layout": "hero",
    "headline": "Brewing Outside the Lines",
    "subhead": "Modern craft, classic roots",
    "background_image": { "id": 1421, "url": "https://...", "alt": "Brewery interior", "width": 2400, "height": 1600 },
    "cta_label": "Visit the taproom",
    "cta_url": "/visit"
  },
  {
    "acf_fc_layout": "feature_grid",
    "heading": "What we brew",
    "items": [
      { "title": "Ol' Factory Pils", "description": "...", "image": {...} },
      ...
    ]
  },
  ...
]
[Alternative — for a Gutenberg page this would be the `blocks` field:]
[
  { "blockName": "acf/hero", "attrs": { "data": { "headline": "...", "background_image": {...} } }, "innerBlocks": [...], "innerHTML": "...", "innerContent": [...] },
  { "blockName": "core/columns", "attrs": { "columns": 3 }, "innerBlocks": [...], ... },
  ...
]

# WP manifest summary  (Source B — site-wide catalog)
- WP-managed types (live SDK at request time): posts, beers, events
- JAB-managed types (render from content_documents): pages
- abilities available: jab/get-posts, jab/get-beers, jab/get-beer-by-slug,
  jab/get-events, jab/get-menus, jab/get-categories-terms

# Menu structures  (from jab/get-menus)
- primary nav (location: primary): Home, Beers, Events, About, Contact
- footer nav (location: footer): Privacy, Terms, Sitemap

# Design tokens  (Source A — confidence-labeled, drive visual treatment only)
## Colors
- primary: #e94e1b (confidence 92%)
- secondary: ...
- accent: ...

## Typography
- heading family: "Playfair Display" (confidence 88%)
- body family: "Inter" (confidence 95%)

## Logo
- src: https://supabase.../project-assets/.../logo.png  (confidence 90%)

## Buttons (observed on source — fallback when block tree lacks CTA copy)
- primary: "Book a discovery call →"
- secondary: "Learn more"

# Brand voice  (Source A)
- tone: warm-professional
- energy: low-medium
- audience: small-business owners considering a brand refresh

# Source HTML  (Source A — visual reference; Tier 2/3 structural fallback)
[Full HTML, as fallback authority]

# Reference screenshots  (Phase 3 — when available)
[desktop.png] [tablet.png] [mobile.png]

# Output instruction
Produce the [HTML document | app/page.tsx] now. For each section, walk
§3.5's source-priority chain — render structured data verbatim where
present; only infer from HTML when no structured source applies. Honor
the Faithful contract. Use extracted color hex values verbatim. Use
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
| ACF group `hero_section` exists with fields `background_image`, `headline`, `cta_text`, `cta_url`. Bind to ACF or inline the text? | **Depends on which kind of ACF.** (a) If it's an **ACF Block** (`acf/hero` appears in `blocks[]`), bind to `block.attrs.data.headline` etc. — `attrs.data` IS the typed data, 1:1 binding. (b) If it's an **ACF Flex layout** (`page.acf.<flex_field>[i]` with `acf_fc_layout === 'hero'`), bind to that layout's typed sub-fields, 1:1. (c) If they're **ACF scalar fields** on the page (`page.acf.hero_headline` etc.), opportunistic binding when field names clearly map to visible content; otherwise inline. For all three, if the page is JAB-managed the equivalent fields live in the JAB content document — bind there. |
| Source "Our Beers" section shows 6 beer cards from a `beers` CPT. Manifest reports 14 beers total. Render 14 or 6? | **6 — match the source's visible count via `getBeers({ numberposts: 6 })`.** Preservation of section visual size is a Faithful constraint; agency can change the limit post-generation. |
| Source has a contact form (rendered by a WP form plugin); manifest exposes no form abilities. What now? | **Out of scope for AI generation (see existing form rule). Generate `<form action="https://source.com/contact" ...>` shell pointing at the original endpoint; agency wires it later.** |
| The page's `blocks[]` contains a block I don't recognize (e.g. `customtheme/promo-strip`, falls through to the `UnknownBlock` SDK variant because the type isn't in `WP_Block_Type_Registry` at SaaS generation time). How do I render it? | **Render the block's `innerHTML` verbatim inside a semantic `<section>` wrapper, preserving the visual outcome.** Don't fabricate a typed structure for a block you don't have a schema for. Don't drop it. Log the unknown block name to the generation_job so the agency can see which custom blocks need richer typing later. |

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
11. **ACF blindness — three subtypes since v0.6.0.** Model ignores
    structured ACF input and inlines from rendered HTML.
    - **ACF Block blindness:** the page's `blocks[]` has `acf/hero` with
      typed `attrs.data`; the model writes `<h1>Brewing Outside the Lines</h1>`
      as a literal instead of `{block.attrs.data.headline}`.
    - **ACF Flex blindness:** the page has `page.acf.<flex_field>[0]` with
      `acf_fc_layout === 'hero'` and a `headline` sub-field; the model
      bypasses it.
    - **ACF scalar blindness:** the page has scalar ACF fields like
      `page.acf.hero_headline` that map cleanly to visible content; the
      model misses the binding.
    Prompt counters: §4.5's `# Page structured content` block surfaces
    the typed schema explicitly; §4.3 MUST NOT item 9 forbids inference
    when structure is provided.
12. **Page-ownership confusion.** Model writes SDK fetches for a
    JAB-managed page (the homepage), or hardcodes content for a
    WP-managed page. Cause: ownership isn't surfaced in the prompt
    explicitly. Prompt counters with the explicit "this page is
    JAB-managed | WP-managed" block at the top of the user message.
13. **Block tree blindness (new with v0.6.0).** Model ignores `blocks[]`
    entirely and reconstructs the page from scraped HTML alone. Cause:
    rendered HTML feels more concrete than a JSON tree under load; the
    model defaults to what reads like markup. Prompt counters with §4.3
    MUST NOT item 9 + the §4.5 prompt-structure ordering that puts
    `# Page structured content` ABOVE `# Source HTML` in the user
    message. Eval: scan generated output for sections whose copy
    matches scraped HTML but not the corresponding `blocks[]` node — if
    they diverge AND the block tree had the copy, the model used HTML.

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
7. **ACF binding aggressiveness — three sub-cases since v0.6.0.**
   - **ACF Block (`acf/*` in `blocks[]`):** clear binding semantics.
     `attrs.data` IS the data; model binds 1:1 to the typed sub-fields.
     No judgment call.
   - **ACF Flex layout (within `page.acf.<flex_field>`):** clear binding
     by the `acf_fc_layout` discriminator. Model binds the matched
     layout's sub-fields 1:1. No judgment call.
   - **ACF scalar fields (top-level `page.acf.hero_headline` etc.):**
     the judgment tier. Field NAMES correlate with visible content but
     the mapping isn't structurally enforced — `acf.hero_headline`
     *probably* maps to the hero section's headline, but it could be
     misnamed or unused. Recommendation: opportunistic for Faithful —
     map when field names clearly correspond, skip when uncertain,
     never invent a mapping the agency didn't explicitly set up.
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
10. **Unknown blocks in `blocks[]`.** When the page's block tree
    contains a custom block whose type isn't in the SaaS's
    `WP_Block_Type_Registry` snapshot at generation time, the SDK
    types it as the fallback `UnknownBlock` shape. §4.6 row 11 says
    render `innerHTML` verbatim inside a `<section>` wrapper. Open:
    do we surface "we saw N unknown blocks on this page" in the
    workspace so the agency knows which custom blocks need registering
    for richer Faithful typing? Recommendation for v0.5/v0.6: log to
    `generation_jobs.unknown_blocks` (new column) and show a small
    workspace badge — non-blocking but visible.

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

### 7.2 Page-code generation pipeline (deleted; future rebuild)

The original pipeline (`lib/ai/prompts.ts`, `lib/ai/agent.ts`,
`lib/inngest/functions/generate-page.ts`, `/api/projects/[id]/generate`,
`GenerationPanel`, `LocalDevGuide`, `lib/github/push.ts`,
`lib/jab/page-context.ts`) was deleted in commit `75d485a` (2026-05-25).
The Phase 2 deployments work will reintroduce a fresh page-code path,
likely emitting to a different artifact target (a deploy target rather
than a GitHub push).

- **Output (planned):** `app/page.tsx` (Next.js Server Component,
  TypeScript, Tailwind). Multi-file generation (separate components,
  separate config) is a separate later change.
- **What the rebuild must include on day one:**
  - `intent` in the `PromptContext` (whatever the new type is called).
  - The §2 global rule prepended to the static system block.
  - The mode contract (§4.3 / §5 / §6) injected at the **top of the
    user message** — mirror the order discipline from `render-prompts.ts`.
  - The Tailwind theme reference constrained for Faithful / Refresh: a
    project-derived theme using extracted tokens verbatim (see §8.1).
    Tailwind defaults are forbidden in those modes; only Reimagine may
    reach for them as supporting neutrals.
  - For Faithful, the system prompt is **exact-match for sections /
    copy** and **stay-loose for code-style** (semantic HTML, Tailwind
    utilities).
  - The connected-site structured-data path: pull `BlockNode[]` via
    `jab/get-page-by-slug`, do not re-scrape (see step 6 of the §10
    next actions).
- **Full punch list:** §7.4.

### 7.3 The shared mode contract

The contract defined in §2 / §4 / §5 / §6 should live as **one source
of truth**. Recommended:

- A new file `apps/web/lib/ai/mode-contracts.ts` exporting
  `getGlobalRule()`, `getFaithfulContract()`, `getRefreshContract()`,
  `getReimagineContract()` as composed prose blocks.
- Both the preview pipeline (`render-prompts.ts`) and the future
  page-code pipeline import from here.
- Behavioral changes are made in one place; both pipelines stay
  consistent.

Defer until the page-code rebuild lands — extracting a "shared" file with
only one current consumer is premature. `INTENT_BRIEFS` stays as the
temporary one-liner until then.

### 7.4 Page-code rebuild — required contract

The original `lib/ai/prompts.ts` was deleted 2026-05-25 (commit `75d485a`).
The Phase 2/3 rebuild starts from a clean slate. Below is the contract the
new file must satisfy on day one. Group A is foundational — the rebuild
cannot ship without these. Group B is fidelity enhancement that lands as
the extraction pipeline catches up to the §4.4 "not yet captured" block.

#### Group A — Foundational (blocks page-code go-live)

| Requirement | Spec ref | What the rebuild must include | Implementation note |
|---|---|---|---|
| `intent` in `PromptContext` | §4.3 / §5 / §6 | Whatever the new context type is called, it carries `intent: RenderIntent` | Re-export `RenderIntent` from `render-prompts.ts`, or move type to a new `mode-contracts.ts` per §7.3 |
| §2 global rule prepended | §2 | The static system block opens with the "JAB brand never bleeds" rule | Same caching tier as the rest of the static base |
| Mode contract injected first in user message | §4.3 / §5 / §6 | The intent brief sits at the top of the user message, before any source material | `# Treatment intent` block before `# WordPress site`. Mirrors the order discipline in `render-prompts.ts` |
| Page ownership surfaced | §3.5, §4.7 failure mode 12 | Per-page ownership tag ("JAB-managed" vs "WP-managed") computed deterministically and passed to the prompt | Add `pageOwnership: "jab-managed" \| "wp-managed"` + `contentOwnership: Record<string, ...>` to context; render as `# WP manifest summary` block per §4.5 |
| Menu structures pre-fetched | §3.5, §4.6 row 2, §4.7 failure mode 10 | Worker calls `jab/get-menus` ahead of generation; the model is given menu structures as fact, not asked to infer from scraped nav DOM | `load-context` step before prompt assembly; render as `# Menu structures` block per §4.5 |
| ACF field groups enumerated | §3.5, §4.6 row 3, §4.7 failure mode 11 | Manifest's ACF metadata walked and surfaced as ACF sub-block of `# WP manifest summary` per §4.5 | `/wp-json/jab/v1/manifest` (v0.6.0) exposes the JSON Schemas including ACF — one fetch, cacheable |
| Static-vs-dynamic discipline strong | §3.5 | The §3.5 taxonomy + the explicit "don't freeze dynamic content" + "menus always come from the manifest" rules live in the static system block | Not just a hint — enforced via §8.3 frozen-content scan |
| Faithful preservation rules injected per-intent | §4.3 MUST preserve | Full §4.3 MUST-preserve list injected when `intent === "faithful"` (and the contracts from §5 / §6 for the others). Lives in the per-intent treatment block, not the static base | — |
| Tailwind palette discipline at toolchain level | §4.3 MUST preserve #5, MUST NOT #6 | Faithful / Refresh get a project-derived theme with extracted hex verbatim; only Reimagine may use Tailwind's default palette as a fallback | Project-derived theme generator is §10 step 4; see §8.1 |
| Copy-verbatim rules injected | §4.3 MUST preserve #2-4 | Hero copy / section heading / CTA preservation rules in the per-intent treatment block | — |
| Page block tree / content / rendered_content in `PromptContext` | §1 Source B (per-page), §4.4 items 10–13, §4.5 `# Page structured content` | Context carries `blocks: BlockNode[]`, `content?: string`, `renderedContent?: string`; worker fetches them | Call `getPageBySlug` with `include: { content: true, blocks: true }` (by-slug default already on for content + blocks; `render` is opt-in). Render as the `# Page structured content` block at the top of the user message per §4.5. |
| `include` flag set explicitly | §1 Source B (include semantics), §4.4 item 13 | Worker sets `include` explicitly rather than relying on the by-slug default | Opt into `render: true` for Tier 3 / shortcode-heavy pages |
| `/wp-json/jab/v1/manifest` consumed for ability schemas | §1 Source B (REST namespace), §4.4 item 14 | Catalog loading uses the REST manifest, auth-once, cacheable, no MCP session per generation | The SaaS's current scrape-only path likely doesn't touch MCP `discover-abilities`; the rebuild adopts REST manifest as the source of truth |
| Page tier classification computed | §3.5 tier framing, §4.5 `# Page identity & ownership` | Worker tags pages as Tier 1 / 2 / 3 at generation time | Inspect the loaded page object: `blocks.length > 0` OR `acf` has a Flex field with non-empty layouts → Tier 1; `acf` has only scalar fields → Tier 2; neither → Tier 3. Surface as `tier: 'block-structured' \| 'theme-template-acf' \| 'pure-scrape'` in context; render in `# Page identity & ownership`. Tier shapes which subsequent prompt blocks fire (`# Page structured content` only fires for Tier 1). |
| ACF Block instances flagged in prompt | §4.5 `# Page structured content`, §4.7 item 11 ACF-Block subtype | After surfacing the block tree, `acf/*` entries with typed `attrs.data` get an explicit binding callout | "ACF Blocks present: `acf/hero` (data: headline, background_image, cta_label, cta_url), `acf/feature_grid` (data: heading, items). Bind to `block.attrs.data.<field>` per §4.3 item 8." Inoculates against §4.7 item 11's ACF-Block-blindness subtype. |
| Unknown block diagnostics persisted | §4.6 row 11, §4.8 item 10 | A `generation_jobs.diagnostics` JSONB column (or equivalent in whatever table the rebuild uses) with `unknown_blocks: string[]` populated by the worker | Workspace surfaces a small badge per §4.8 item 10 |

#### Group B — Fidelity enhancement (lands as extraction catches up)

| Gap | Spec ref | What's missing | Blocking dependency |
|---|---|---|---|
| Multi-breakpoint screenshots | §4.4 item 2 | Scrape pass captures one render only | Phase 3 extraction: headless-browser pass at 3 viewports, multimodal input to the prompt |
| Section schema with role tags (**Tier 2/3 only — Tier 1 closed by v0.6.0**) | §4.4 item 3 | For Tier 1: solved — typed `blocks[]` discriminated union (`blockName` as the role tag) + ACF Flex `acf_fc_layout` (layout name as the role tag) ARE the section schema. For Tier 2/3: still no structural extraction beyond DOM walk | Tier 1 portion: ✅ done. Tier 2/3 portion: dedicated structural pass on the scraped HTML when (or if) we choose to invest there. |
| Type scale, spacing, container width, radii, shadows, breakpoints | §4.4 item 4 | Stage 2 captures families + colors only | Phase 3 extraction: computed-style read in a headless browser |
| Content brief Markdown | §4.4 item 8 (vs. raw HTML at item 9) | `pageHtml` is passed; the `contentMarkdown` from `scrape-agent` is not | Refactor `PromptContext` to receive the full `ScrapeAgentResult`, not just raw HTML |

#### Notes

- **Caching seam:** the deleted `buildSystemBlocks` cached the SDK source
  as `ephemeral`. The rebuild must restore that pattern. The §2 global
  rule fits in the same cached static base (constant across all calls).
  The mode contract is intent-specific and should stay in the user
  message so intent changes mid-session don't invalidate any cache block.
- **Per-page intent override** (§4.8 Q4) is a no-op data-flow change once
  context carries `intent` — pass per-generation, not derived from
  `project.intent`.
- **Regression baselines:** Group A changes the prompt structure
  substantively vs. anything that came before. When `scripts/validate-ai`
  (or whatever the eval harness becomes) lands, golden files will need
  rebaselining in the same PR; plan for that.

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
- **Confidence-thresholded tokens** (✅ live in `render-prompts.ts`
  `formatToken`) — sub-0.4 fields omitted entirely (gate added 2026-05-25
  alongside the deterministic-color zero-chromatic fallback path; prior
  to that, formatToken only flagged low confidence, didn't omit); 0.4–0.7
  fields flagged "treat as suggestion." Model never sees noise.
- **Deterministic palette + logo selection** (✅ live in
  `scrape-design-deterministic.ts`) — top-3 chromatic palette samples
  (greyscale filtered) become primary/secondary/accent; logo selected by
  region+alt heuristic. LLM design pass shrunk to 3 fields. Eliminates
  §4.7 #2 (palette substitution) and the "first image is the logo"
  confabulation at the extraction layer.
- **Extracted hex normalization** — lowercase, 6-digit form, no
  whitespace. The prompt then asserts "use exactly these strings."
- **Reasoning string sanitization** (⛔ regression — was live at deleted
  `prompts.ts:372`) — strip code fences and ATX heading markers from
  LLM-authored reasoning before embedding. Prevents prompt-injection-
  via-extraction. `render-prompts.ts` currently inlines reasoning
  strings without sanitization; reintroduce before the page-code rebuild.

### 8.2 Prompt configuration (deterministic knobs around the prompt)

- **Model selection per task** (✅ wired 2026-05-25 in `lib/ai/model.ts`).
  Four tasks — `content`, `design`, `render`, `codegen` — each resolve a
  model via `getModelFor(task)` with `JAB_AI_MODEL_<TASK>` per-task env
  override, `JAB_AI_MODEL` legacy global, hardcoded default. All Sonnet
  today; refocus step 4 flips content + design to Haiku via env. This is
  about *which LLM produces what artifact*, orthogonal to per-intent.
- **Model selection per intent.** Open question — for v0 use the per-task
  defaults for all three intents. Faithful's constrained reproduction is
  well within Sonnet's comfort zone; Reimagine's creative latitude might
  justify Opus once eval data shows creativity is a constraint. The two
  axes compose: a Reimagine generation would call `getModelFor("render")`
  which could return Opus for that intent if we add per-intent overrides
  (not wired today; would extend `AiTask` to a `{task, intent}` shape).
- **Temperature per intent.** Faithful = 0 (deterministic). Refresh =
  0.2 (slight design-craft latitude). Reimagine = 0.5 (real creative
  variance). Lower temperature = stronger constraint adherence.
- **Output token cap.** Set high enough that truncation is rare (preview
  pipeline raised to 16384 per commit `c19f67c`). Gate on `stop_reason`
  per §8.3.
- **System block caching.** Engineer-role intro + §2 global rule =
  cached static block. SDK source = second cached ephemeral block. Mode
  contract = uncached user-message block so intent changes don't
  invalidate cache. The pattern was live at the deleted `prompts.ts:99-110`;
  step 2 of the §10 refocus plan re-applies it to the three live system
  prompts (`CONTENT_SYSTEM`, `DESIGN_SYSTEM`, `RENDER_SYSTEM`).
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
| Confidence-thresholded tokens | §8.1 | ✅ live | `render-prompts.ts` `formatToken`. Sub-0.4 omit gate added 2026-05-25 (was warning-only before, which would have let the deterministic-color zero-chromatic sentinel through). |
| Deterministic palette selection | §8.1 | ✅ live | `scrape-design-deterministic.ts` `pickColors` — top-3 chromatic samples, greyscale filtered. Eliminates §4.7 #2 (palette substitution). |
| Deterministic logo selection | §8.1 | ✅ live | `scrape-design-deterministic.ts` `pickLogo` — header+alt > header > nav > first image. Eliminates "first image is the logo" confabulation. |
| Alt-text sanitization (extraction → prompt) | §8.1 | ✅ partial | `sanitizeForPrompt` in `scrape-design-deterministic.ts` strips non-printable ASCII + truncates. Broader sanitization (e.g. heading copy, content brief markdown) is the deferred regression tracked alongside §10.0 step 7. |
| Reasoning sanitization | §8.1 | ⛔ regression | Lived at deleted `prompts.ts:372`. `render-prompts.ts` inlines reasoning strings raw. Reintroduce before the page-code rebuild; consider earlier if eval data shows fence-injection. |
| Image asset capture | §8.1 | ✅ live | `asset-capture.ts` |
| HTML entity decoding (server side) | §8.1 | ⚠ partial | PHP manifest only; scrape HTML not yet decoded |
| Menu pre-fetch | §8.1 | ⛔ | §7.4 Group A |
| Page ownership pre-load | §8.1 | ⛔ | §7.4 Group A |
| Project-derived Tailwind theme | §8.1 | ⛔ | Highest-leverage missing piece |
| Google Fonts link pre-compute | §8.1 | ⛔ | Small, easy |
| Per-task model selection | §8.2 | ✅ live | `lib/ai/model.ts` `getModelFor(task)` — content / design / render / codegen, with per-task env overrides. Per-pass model also persists in `anonymous_previews.usage`. |
| Per-intent model selection | §8.2 | ⛔ | Defer until eval data. Composes orthogonally with per-task once wired (would extend `AiTask` to `{task, intent}`). |
| Per-intent temperature | §8.2 | ⛔ | One-line config change |
| System block caching | §8.2 | ⛔ regression (dormant) | Lived at deleted `buildSystemBlocks` (`prompts.ts:99-110`). Three live system prompts measured 2026-05-25: `CONTENT_SYSTEM` ~250 tokens, `DESIGN_SYSTEM` ~700, `RENDER_SYSTEM` ~720 — all under the 1024-token Sonnet cache minimum. Wiring `cache_control` today would silently no-op; deferred to §10.0 step 7 (contract rewrite) which likely pushes system blocks past the threshold. |
| Build / typecheck gate | §8.3 | ⛔ | Phase 1 QUAL-1. Re-evaluates with the page-code rebuild (no live code path today). |
| `stop_reason` check | §8.3 | ✅ live | `validators.ts` `validateStopReason`; runs inside `preview-renderer.ts` after `extractHtmlBlock`. Anything other than `end_turn` (and `null`) fails. |
| JAB-bleed scan | §8.3 | ✅ live | `validators.ts` `validateJabBleed` — 11 hex tokens + 3 fonts. |
| Palette adherence | §8.3 | ⛔ | Needs project-derived Tailwind theme generator (§8.1 longer-term) to define what's valid. |
| Typography family adherence | §8.3 | ⛔ | Same dependency. |
| Menu structure adherence | §8.3 | ⛔ | Needs step 6 structured menu data. |
| Hero copy verbatim (Faithful) | §8.3 | ✅ live (Tier 2/3) | `validators.ts` `validateHeroCopyVerbatim` — substring of source `extract.h1[0]` after tag-strip + whitespace-collapse. Tier 1 structural equality (vs. `blocks[].find(b => b.blockName === 'acf/hero').attrs.data.headline`) waits on step 6. |
| CTA copy adherence (Faithful) | §8.3 | ✅ live | `validators.ts` `validateCtaCopyVerbatim` — gates on confidence ≥ 0.7 to avoid false-positives when the LLM's buttonPair classification disagreed with the actual hero. |
| Section count adherence | §8.3 | ⛔ (cheap for Tier 1 once step 6 lands) | Tier 1: assert `generated.sections.length === source.blocks.length`. Tier 2/3: DOM heuristic count. The hard part is closed (by v0.6.0). |
| Frozen-content scan | §8.3 | ⛔ | Needs AST walk + "SDK ancestor" concept from step 6. |
| Accessibility floor | §8.3 | ⛔ | axe-core in headless browser. |
| No `<script>` (Faithful) | §8.3 | ✅ live | `validators.ts` `validateNoClientScript`. |
| Hex normalization (post) | §8.4 | ⛔ | Trivial |
| Image URL rewriting (post) | §8.4 | ⛔ | Belt-and-suspenders |
| Block tree fidelity (Faithful, Tier 1) | §8.3 | ⛔ | Walk source `blocks[]`; for each top-level node assert the generated output has a corresponding section (stable identifier: block index + `blockName`). Catches §4.7 item 13 (block tree blindness). |
| ACF Block `attrs.data` binding (Faithful, when applicable) | §8.3 | ⛔ | For each `acf/*` block in source, AST-scan generated TSX: confirm the model references `block.attrs.data.<field>` (or equivalent prop-drilled binding) rather than inlining literal copy. Catches §4.7 item 11 ACF-Block-blindness subtype. |
| Unknown block diagnostics persisted | §8.1 → §8.3 | ⛔ | During input prep, walk the block tree and populate `generation_jobs.diagnostics.unknown_blocks`. During output validation, assert blocks tagged `UnknownBlock` were either rendered (via innerHTML in a `<section>`) or explicitly skipped — never silently dropped. |

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
| 2026-05-25 | **Refocus step 7 — output validators (5 gates live).** New `lib/ai/validators.ts` module. `validateOutput` wired into `preview-renderer.ts` after `extractHtmlBlock`; any failure throws `PreviewRendererError(code="output_validation_failed")` which propagates through both consumers (scrape-preview, regenerate-homepage) into mark-failed + serializePublicError. Validators that landed: `stop_reason` gate, JAB-bleed scan (11 hex tokens + 3 font families), Faithful no-`<script>`, Faithful hero copy verbatim, Faithful CTA copy verbatim (gated on confidence ≥ 0.7 to avoid false-positives from the LLM buttonPair classifier disagreeing with the rendered hero). Validators that need step 6 or the Tailwind theme generator (palette/typography/menu/section-count/frozen-content) remain ⛔ with the dependency called out. §8.6 status table updated; six rows flip ⛔ → ✅ live. Step 6 (connected-site structured-data path) reordered to deferred — investigation flagged that the JAB-ability HTTP client, front-page resolver, and renderer multi-source input shape don't yet exist; resume after step 8 lands the prompt contract that defines what structured data the prompt consumes. Commit `4041caf`. | Cheap regex / string-search gates buy a hard QC floor without LLM-as-judge. JAB-bleed is the most important — closes the §2 global rule's enforcement gap. Faithful gates make the §4.3 MUST preserve list catchable mechanically. | Sean + AI prompt engineer pairing |
| 2026-05-25 | **Refocus step 5 — deterministic palette + logo selection.** New module `lib/ai/scrape-design-deterministic.ts` (`pickColors` + `pickLogo`). LLM design pass shrunk to 3 fields (typography + buttonPair + personality) via `LlmDesignSubsetSchema = DesignAnalysisSchema.omit({colors, logo})`. `DESIGN_SYSTEM` + `buildDesignUserPrompt` shrink correspondingly. Public `DesignAnalysis` shape unchanged — orchestrator stitches deterministic + LLM subset before returning. Two pre-existing-but-latent gaps closed in the same commit: (1) `render-prompts.ts` `formatToken` now gates on `confidence < 0.4` (was warning-only — matters because the new zero-chromatic fallback emits a sentinel `#000000` with confidence 0); (2) `sanitizeForPrompt` strips non-printable ASCII from alt text before it flows into the renderer's user prompt (prompt-injection inoculation). §8.6 grows three new ✅-live rows (deterministic palette, deterministic logo, alt sanitization). Commit `109b1fb`. | Two of the design pass's five fields had hard heuristics — moving them to code eliminates §4.7 #2 (palette substitution) and the "first image is the logo" confabulation at the extraction layer, not the prompt-rule layer. Shrinking the LLM surface area is also cheaper (fewer output tokens) and a smaller schema to validate. | Sean + AI prompt engineer pairing |
| 2026-05-25 | **Refocus step 4 — Haiku 4.5 for content + design with Sonnet fallback.** `DEFAULTS` in `lib/ai/model.ts` flipped — content + design now default to `claude-haiku-4-5-20251001`; render + codegen stay on Sonnet. `scrape-agent.ts` adds `isRetryableOnFallback(err)` classifier and `content_pass_empty` error code (distinguishes "model returned empty markdown" from "Anthropic call failed"). Each pass's orchestrator tries primary, catches retryable errors, logs the fallback event, retries with Sonnet. Optional `label` threads from `runScrapeAgent` to fallback log lines so concurrent Inngest worker logs stay correlated. Transport errors don't retry on a different model (payload is identical; Anthropic SDK already retries transport transients server-side). Worst-case cost: 4 LLM calls per scrape (2 Haiku + 2 Sonnet fallback) when both passes botch — bounded structurally, no inner retry loop. Commit `10db2a9`. | Per-task selector landed at step 3 — flipping defaults is now an env-var-equivalent change with safety net in place. The two passes are the highest-frequency call sites, so ~4× cheaper here is the cost lever the dropped cache step was supposed to be. | Sean + AI prompt engineer pairing |
| 2026-05-25 | **Refocus step 3 — per-task model selector.** `lib/ai/model.ts` rewritten — single eager `MODEL` constant replaced with `getModelFor(task: 'content' \| 'design' \| 'render' \| 'codegen')` resolved per call. Env precedence: `JAB_AI_MODEL_<TASK>` per-task → `JAB_AI_MODEL` legacy global → hardcoded default (Sonnet for all). `ScrapeAgentResult.model` (singular) → `models: { content, design }`. `scrape-preview` mark-succeeded folds per-pass model into the persisted usage blob so cost audits attribute tokens correctly once step 4 splits content/design off Sonnet. Empty-string env var hits validate() and throws (not falls-through) to protect "blank-to-restore-default" semantics. §8.2 distinguishes per-task (wired) from per-intent (open). §8.6 adds Per-task model selection row ✅ live. Commit `80b0ec3`. | Unblocks the Haiku migration without per-callsite churn; honest persistence sets up the cost-audit story for step 4. | Sean + AI prompt engineer pairing |
| 2026-05-25 | **Refocus plan amended — step 2 dropped.** Measured the three live system prompts: `CONTENT_SYSTEM` ~250 tokens, `DESIGN_SYSTEM` ~700, `RENDER_SYSTEM` ~720 — all under the 1024-token Sonnet cache minimum. Wiring `cache_control: ephemeral` today silently no-ops; deferred to step 7 (contract rewrite) which likely pushes the system blocks past the threshold. Step numbers in §10.0 retained for traceability; executed sequence is 1 → 3 → 4 → 5 → 6 → 7 → 8. §8.6 status table reflects the measurement. | Avoid wiring infrastructure that doesn't fire — creates false confidence when measuring later. Honest determination of when the cache actually fires lives with the prompt rewrite that grows the system block. | Sean + AI prompt engineer pairing |
| 2026-05-25 | **Refocus step 1 — deletion.** Strategic refocus to three objectives: deterministic-first generation + QC, prompt hygiene, cost discipline. Audit of `apps/web` found the page-code generation pipeline (`lib/ai/prompts.ts`, `lib/ai/agent.ts`, `lib/inngest/functions/generate-page.ts`, `/api/projects/[id]/generate`, `GenerationPanel`, `LocalDevGuide`, `lib/github/push.ts`, `lib/jab/page-context.ts`) had been quarantined from the UI since the 2026-05-23 SaaS pivot but kept in the tree. The only prompt-caching call in the codebase lived on this dead path. Deleted in commit `75d485a`. Doc reconciled: §0 / §1 / §3.5 / §7.2 / §7.3 / §7.4 / §8 references updated to reflect the deletion; §7.4 reframed as forward-looking "Page-code rebuild — required contract"; §8.6 status table reflects two regressions (system block caching, reasoning sanitization) that step 2 and a later step of the refocus plan restore. §10 restructured to lead with the 8-step refocus sequence. | Sean: "1. Create an approach that leverages what is extended by our custom WP to use deterministic approach to build and QC against to improve accuracy and greatly reduce drift and hallucinations. 2. Ensure our prompts are cleanly organized — ensure we do not have unused prompts and ensure there are unique prompts to generate based on the clients objectives. 3. Keep AI costs low — use the LLMs as needed but use code where possible. Be aggressive about caching requests. Use the proper models for the proper tasks." | Sean + AI prompt engineer pairing |
| 2026-05-25 | **Pass C** of the v0.5.0+v0.6.0 plugin refresh — final reconciliation. §7.4 Group A: ACF-field-groups row updated to note that `/wp-json/jab/v1/manifest` exposes the schemas directly. Six new gap rows added — page block tree / content / rendered_content not in `PromptContext`; `include` flag not explicitly set; manifest REST endpoint not consumed; page tier classification missing; ACF Block instances not flagged in prompt; unknown block diagnostics not persisted. §7.4 Group B "Section schema with role tags" row split — Tier 1 portion marked ✅ done (blocks[] discriminated union + Flex discriminator ARE the schema); Tier 2/3 portion still deferred. §8.6 status table: "Section count adherence" and "Hero copy verbatim (Faithful)" annotated as cheap-for-Tier-1 since v0.6.0 (structural equality replaces heuristic / string search). Three new validators added — block tree fidelity, ACF Block attrs.data binding, unknown block diagnostics persisted. Doc is now fully aligned with plugin v0.6.0. | Pass A landed v0.6.0 in §1/§3.5; Pass B threaded it through §4.3-§4.5; Pass B.5 sharpened §4.6-§4.8; Pass C closes the cycle by reconciling §7.4 and §8.6. | Sean + AI prompt engineer pairing |
| 2026-05-25 | **Pass B.5** — sharpened §4.6 / §4.7 / §4.8 to reflect v0.6.0's three ACF tiers (Block / Flex / scalar) and add block-tree-specific entries. §4.6: ACF row split into the three sub-cases with explicit binding semantics for each; new row added for unknown blocks (custom blocks not in `WP_Block_Type_Registry`). §4.7: item 11 (ACF blindness) restructured into three subtypes mapped to the three ACF tiers; new item 13 (block tree blindness) added. §4.8: item 7 (ACF mapping aggressiveness) split into three sub-cases (Block / Flex = clear binding; scalar = judgment call); new item 10 (unknown blocks workspace surfacing) added. | Pass B updated §4.3 / §4.4 / §4.5 to reflect v0.6.0; the remaining §4 subsections (decision rules, failure modes, open questions) still referenced ACF generically and missed block-tree-specific cases. Small focused pass keeps drift limited per the agreed cadence. | Sean + AI prompt engineer pairing |
| 2026-05-25 | **Pass B** of the v0.5.0+v0.6.0 plugin refresh. §4.3 Faithful contract gained an operating-principle preamble framing the source-priority chain ("render the schema we hand you" for Tier 1; more inference for Tier 2/3). MUST preserve item 1 (section sequence) and item 8 (data binding) rewritten to reference the chain explicitly, with Two Roads' ACF Flex pattern as the concrete example. Added MUST NOT do item 9 (don't infer structure when the plugin provides it). §4.4 Source B subsection restructured into "Per-page structured content" (block tree, Flex layouts, content, rendered_content) + "Catalog (general site knowledge)", with a closing Tier-aware framing paragraph. §4.5 prompt structure example replaced `# Section schema (Phase 3 — when available)` with `# Page identity & ownership` + `# Page structured content` showing concrete ACF Flex JSON (Two Roads-style) plus the Gutenberg-variant shape. Output instruction now explicitly references the source-priority chain walk. Post-edit refinement (review feedback): clarified that `page_builder` is Two Roads' specific Flex field name, not a structural assumption — the field name is per-site, the structure (Flex Content with named layouts) is general. Three inline notes added: §4.3 item 1, §4.5 `# Page identity & ownership`, §4.5 `# Page structured content`. | Pass A landed v0.6.0 reality in §1/§3.5; Pass B threads the same reality through the Faithful contract proper. | Sean + AI prompt engineer pairing |
| 2026-05-25 | **Pass A** of the v0.5.0+v0.6.0 plugin refresh. Restructured §1 Source B to document the new per-page structured content (`content`, `blocks` as typed `oneOf` discriminated union over `WP_Block_Type_Registry`, `rendered_content`), the `include` flag mechanics, ACF Blocks via `block==<name>` location rules, reusable block expansion, and the `/wp-json/jab/v1/*` REST namespace (manifest, content-types, health). §1 "Not yet captured" section-schema bullet updated — block-structured (Tier 1) pages now have it. §3.5 mapping table restructured around a source-priority chain with the block tree at the top; operationally note acknowledges Tier 1 sites shift the contract from "infer the schema" to "render the schema." Pass B (§4.x contract refresh) and Pass C (§7.4 / §8.6 status updates) still to come. | Plugin shipped v0.5.0 (block emission) + v0.6.0 (typed-block moat + manifest endpoint) since the doc was last updated; the §1 / §3.5 cascade was two versions behind. | Sean + AI prompt engineer pairing |
| 2026-05-24 | Added §8 — deterministic guardrails framework. Four classes (input prep / prompt config / output validation / output rewriting) + a status table at §8.6. Reframes the mode contracts as the *prompt's* job vs. what code can enforce reliably — the prompt becomes the last resort, not the first. Renumbered iteration log → §9, next actions → §10, "how this doc connects" → §11. Updated §10 next actions with two new items (Tailwind-theme generator, §8.3 validator suite). | Sean: "Before we move on to the prompts lets think carefully about what should be done deterministically to keep the prompt aligned." | Sean + AI prompt engineer pairing |
| 2026-05-24 | Added §7.4 — structured gap analysis between `prompts.ts` today and the §2 / §3.5 / §4 contract. Group A = foundational gaps that block Phase 3 go-live; Group B = fidelity enhancement that lands as extraction catches up. Cross-referenced in §10 next action #3. | Need a concrete punch list for the Phase 3 prompt rewrite — strategic overview in §7.2 wasn't tactical enough to execute against. | Sean + AI prompt engineer pairing |
| 2026-05-24 | Folded WP manifest in as a first-class input (Source B). New §1 "Inputs available to the AI" two-source breakdown; new §3.5 "Static vs. dynamic content" mapping discipline; threaded manifest-aware rules through §4.3 / §4.4 / §4.5 / §4.6 / §4.7 / §4.8 with mirrors in §5 / §6. | Sean flagged the doc was scrape-centric: "We are connected to WP. We have access to the actual content, menus, etc. How is this taken into consideration?" | Sean |
| 2026-05-24 | Lifted "no JAB bleed" to §2 as a global rule binding all three modes. Reworked Refresh and Reimagine to remove "JAB sensibility" framing — they now apply *universal design craft* within the client brand, not JAB-specific design language. | Sean ratified: "JAB is JAB. The clients are totally separate." | Sean |
| 2026-05-24 | Initial draft. Faithful contract drafted at §4.3; Refresh / Reimagine sketched. Visual-fidelity question raised at §4.2 (resolved same day). | Doc creation. | Sean + AI prompt engineer pairing |

---

## 10. Next actions

### 10.0 Refocus plan (2026-05-25) — primary sequence

Three strategic objectives drive the work: (1) deterministic-first
generation + QC, (2) prompt hygiene, (3) cost discipline. The sequence
below executes against all three. Each step is a small, reviewable PR;
docs land with each step.

1. ✅ ~~**Delete the orphaned page-code pipeline.**~~ Done 2026-05-25,
   commit `75d485a`. Removed `prompts.ts` / `agent.ts` / `generate-page.ts`
   / GitHub-push route / `GenerationPanel` / `LocalDevGuide` /
   `lib/github/push.ts` / `lib/jab/page-context.ts`. Two §8.6 regressions
   surfaced (system block caching; reasoning sanitization).
2. ~~**Add `cache_control: ephemeral` to the three live system prompts.**~~
   **Dropped from immediate sequence** (2026-05-25, post-step-1
   measurement). All three live system prompts are below the 1024-token
   Sonnet cache minimum: `CONTENT_SYSTEM` ~250 tokens, `DESIGN_SYSTEM`
   ~700 tokens, `RENDER_SYSTEM` ~720 tokens. Wiring `cache_control`
   headers today would silently no-op. The §8.6 regression note for
   "system block caching" stays ⛔ with this reason. Step 7 below (the
   contract rewrite, formerly step 8) will likely push the system blocks
   past 1024 if the §2 global rule + Faithful contract are absorbed
   into the system tier — caching gets wired at that point, when it
   actually fires.
3. ✅ ~~**Per-task model selector.**~~ Done 2026-05-25, commit `80b0ec3`.
   `lib/ai/model.ts` now exports `getModelFor(task: 'content' | 'design'
   | 'render' | 'codegen')` resolved per call with per-task env override
   (`JAB_AI_MODEL_<TASK>`) → legacy global (`JAB_AI_MODEL`) → hardcoded
   default. All tasks default to Sonnet today; Haiku migration (step 4)
   is now an env-var flip per task with zero code change. Per-pass model
   also persists in `anonymous_previews.usage` for cost audits.
4. ✅ ~~**Move Content + Design passes to Haiku.**~~ Done 2026-05-25,
   commit `10db2a9`. `DEFAULTS.content` and `DEFAULTS.design` in
   `lib/ai/model.ts` flipped to `claude-haiku-4-5-20251001`. Each pass's
   orchestrator falls back to Sonnet automatically when the primary's
   output is the problem (empty markdown / malformed JSON / failed Zod
   schema). Transport errors aren't retried with a different model.
   Worst case = 4 LLM calls per scrape; bounded structurally. Per-pass
   model already persisted (commit `80b0ec3`) so post-hoc fallback rate
   is queryable. ~4× cheaper on the two highest-frequency call sites —
   the cost win that replaced the dropped cache step.
5. ✅ ~~**Deterministic palette + logo selection.**~~ Done 2026-05-25,
   commit `109b1fb`. New module `lib/ai/scrape-design-deterministic.ts`
   exports `pickColors` (top-3 chromatic hex from frequency-ranked palette
   samples, greyscale filtered via max-min channel spread >= 20) and
   `pickLogo` (header+alt > header > nav > first image > null, with
   stepped confidence). `LlmDesignSubsetSchema = DesignAnalysisSchema.omit({colors, logo})`
   shrinks the LLM call to 3 fields (typography + buttonPair + personality).
   `DESIGN_SYSTEM` prompt + `buildDesignUserPrompt` shrink correspondingly.
   `render-prompts.ts` `formatToken` now gates on `confidence < 0.4`
   (matches §8.1 — was warning-only before this commit). Alt text passes
   through `sanitizeForPrompt` to inoculate against adversarial alt
   injection into the renderer prompt.
6. ⏳ **Connected-site path reads structured data instead of re-scraping.**
   **Deferred 2026-05-25** — investigation surfaced that the work touches
   three things that don't yet exist in `apps/web`: a JAB-ability HTTP
   client (the SaaS doesn't currently call ability endpoints — only the
   `/wp-json/jab/v1/manifest` + `/content-types` admin routes), a
   front-page resolver (was in the just-deleted `page-context.ts:351`,
   needs reintroduction), and the renderer's multi-source input shape
   (which overlaps directly with the §4.5 prompt structure that step 7
   below lands). Resume after step 7 — by then the contract that defines
   what structured data the prompt actually consumes will be explicit, so
   the worker change can target a stable shape instead of guessing. In
   `regenerate-homepage.ts`, detect connected projects; resolve front
   page; pull `BlockNode[]` via `jab/get-page-by-slug`; pass typed blocks
   to the renderer as ground-truth sections. The v0.6.0 moat in
   production — eliminates section/content/CTA guessing for the Tier-1
   site population.
7. ✅ ~~**Output validators**~~ Done 2026-05-25, commit `4041caf`. New
   module `lib/ai/validators.ts`; `validateOutput` wired into
   `preview-renderer.ts` after `extractHtmlBlock`. v0 covers the gates
   that don't depend on step 6: JAB-bleed scan (11 JAB hex tokens + 3
   JAB-restricted font families), `stop_reason !== "end_turn"`, and
   three Faithful-only validators (no-`<script>`, hero copy verbatim,
   CTA copy verbatim). Validators with structural ground-truth (palette
   adherence, typography adherence, menu structure adherence, section
   count adherence) need either the project-derived Tailwind theme
   generator (§8.1 longer-term) or step 6 structured data — those land
   later. Validator failure throws `PreviewRendererError` with code
   `output_validation_failed`, which propagates through the workers'
   existing try/catch into `mark-failed` and `serializePublicError`.
8. **Rewrite `INTENT_BRIEFS[faithful]`** in `render-prompts.ts` per §2 +
   §4.3 + §4.5 + §4.6. Push intent through all live prompts (not just
   renderer) once it actually changes behavior. Inject §2 global rule
   into `RENDER_SYSTEM`. Re-introduce reasoning sanitization at the same
   time (closes the second §8.6 regression). Keep Refresh / Reimagine on
   their one-paragraph briefs until §5 / §6 are deepened — but inject §2
   into all three. **Likely activates dormant caching from step 2** —
   wire `cache_control: ephemeral` at this point if the system block
   crosses 1024 tokens. Becomes step 7.

### 10.1 Longer-term items (post-refocus)

- **Work through §7.4 when the page-code rebuild starts.** The contract
  there is what the new pipeline must absorb on day one. Group A
  foundational; Group B fidelity enhancement.
- **Build the project-derived Tailwind theme generator (§8.1).** Highest
  single-piece leverage. Convert extracted hex + family tokens into a
  per-project `tailwind.config.ts` whose theme exposes only brand-named
  utilities (`brand-primary`, `brand-heading-font`, etc.). Eliminates
  palette and font substitution at the toolchain level. Same fix for
  Refresh; Reimagine gets brand-named utilities plus access to Tailwind's
  neutral scales for supporting palette work.
- **Add an `evals/` directory** with 3–5 source sites per intent. Wire
  the §8.3 validators into the eval harness so the same checks gate eval
  runs AND production generations. Add new failure modes / decision
  points to §4.7 / §4.6 as they surface.
- **Per-intent generation parameters (§8.2).** Set temperature 0 for
  Faithful, 0.2 for Refresh, 0.5 for Reimagine — one-line config change
  after step 3 lands.
- **Defer §7.3 refactor (`mode-contracts.ts`)** until both Faithful and
  Refresh have stable contracts AND the page-code rebuild has a real
  second consumer — premature consolidation locks in the wrong
  abstraction.

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
