# Independent Code Review — Recommendations & Status

> **Status doc — not a plan.** This captures an external independent code review of the
> `apps/web` SaaS pipeline, with each finding **verified against current `master`** and
> mapped to its fleet-gap-register entry. It is the source we convert into per-finding
> implementation plans (one plan per open item, authored via `superpowers:writing-plans`).

- **Reviewed against:** `master @ 885da5b` (post-merge `c3c2d1d` + dead-code sweep `8ed26bd` + lockfile fix `885da5b`).
- **Audited:** 2026-06-17, per-finding, with `file:line` evidence (see each finding).
- **Cross-reference:** [fleet-gap register](2026-06-16-jab-fleet-gap-register.md) (items A1–A11, B1–B6, C1–C5).
- **Headline:** of the 9 findings, **3 are now fixed** — 2 by the June 16 fleet-gap merge (planner inventory, draft/deployed parity) plus the blog-index home (#1, [blog-index-front-page plan](../plans/2026-06-17-blog-index-front-page.md)) — **6 remain open** (5 tracked, 1 untracked), and the **hygiene note is a non-issue** (no secret was ever committed).

---

## Summary table

| # | Finding | Severity | Status | Register | Evidence (current master) |
|---|---------|----------|--------|----------|---------------------------|
| 1 | Blog-index home (`show_on_front="posts"`) hard-fails build | **High** | ✅ FIXED | A10 | [blog-index-front-page plan](../plans/2026-06-17-blog-index-front-page.md) (deployed build; blog-index homepage reuses the dynamic-list runtime) |
| 2 | Edit planner inventory ≠ what renders | **High** | ✅ FIXED | A2/A3 | planner-inventory-correctness plan (merged) |
| 3 | Classic-editor body un-editable | **High** | 🔴 OPEN | A1 | [compose-block-tree-runtime.ts:145](../../../apps/web/lib/jab/compose-block-tree-runtime.ts#L145), [component-generator.ts:1024](../../../apps/web/lib/ai/component-generator.ts#L1024) |
| 4 | Desktop-1280-only generation + fidelity | Med-high | 🔴 OPEN | A6 | [component-generator.ts:437](../../../apps/web/lib/ai/component-generator.ts#L437), [generate-components.ts:313](../../../apps/web/lib/inngest/functions/generate-components.ts#L313), [verify-fidelity.ts:207](../../../apps/web/lib/inngest/functions/verify-fidelity.ts#L207) |
| 5 | Live Draft render ≠ deployed (CSS / origin) | Med-high | ✅ FIXED | B-series | draft-deployed-css-parity plan (merged) |
| 6 | Fidelity "vision" scoring is a stub | Medium | 🔴 OPEN — **untracked** | *(none — file one)* | [fidelity-score.ts:219](../../../apps/web/lib/ai/fidelity-score.ts#L219) |
| 7 | Hardcoded `lang="en"` / no `dir` | Medium | 🔴 OPEN | A9 | [compose-site-emit.ts:788](../../../apps/web/lib/jab/compose-site-emit.ts#L788), [discover-site.ts:223](../../../apps/web/lib/inngest/functions/discover-site.ts#L223), [layout.tsx:15](../../../packages/frontend-template/app/layout.tsx#L15) |
| 8 | Narrow stylesheet / font / chrome capture | Medium | 🔴 OPEN | A8 + A11 | [capture-theme-stylesheets.ts:131](../../../apps/web/lib/jab/capture-theme-stylesheets.ts#L131) |
| 9 | Dynamic-list query not editable | Low | 🔴 OPEN | A5 | [dynamic-list-detect.ts:253](../../../apps/web/lib/jab/dynamic-list-detect.ts#L253), [edit-plan.ts:47](../../../apps/web/lib/jab/edit-plan.ts#L47) |
| H | `.mcp.json` Supabase token | — | ✅ N/A (no leak) | — | gitignored; never committed; `.example` is an all-`x` placeholder |

> **Register-ID caveat:** the audit found the fleet-gap register's `A`-numbers cited
> inconsistently across notes (e.g. `A6` used for both multi-viewport and token-edit scope).
> The IDs above are best-effort; **reconcile the register numbering** as a cheap cleanup
> (see [Tracking gaps](#tracking-gaps-to-close)).

---

## Findings — detail

### ✅ 2. Edit planner inventory ≠ what renders — FIXED

The review flagged that the planner derived shell presence from a cost-telemetry table and
offered targets that don't render. **Closed by the planner-inventory-correctness plan**
(landed in merge `c3c2d1d`). All four sub-claims are resolved on master:

- Shell presence now reads the **emitted artifact** (`decideShellPresence` → `listShellDir`),
  failing **closed to "present"** on a Storage error.
- Block list excludes `passthrough` tier, `compile_status != 'ok'`, `__null__`, and `core/image`.
- Page blast-radius reports a real distinct-page count (`pageCountIsFloor` → "at least N").
- The fabricated "Featured Offerings"-style invented literal is gone.

The reviewer's line numbers pointed at pre-merge code (`9e3956c`). **No action.**

### ✅ 5. Live Draft render ≠ deployed output — FIXED

The review flagged that the in-app draft renderer diverged visually from the deployed site.
**Closed by the draft-deployed-css-parity plan** (merge `c3c2d1d`):

- Global preflight `box-sizing` base injected by `buildDraftCss` (the draft dropped it when
  it stopped emitting `@tailwind base`) — [css.ts](../../../apps/web/lib/draft/css.ts).
- Image shim emits an inline `style` to match deployed sizing — [media-image.tsx](../../../apps/web/lib/draft/runtime/media-image.tsx).
- The patch path now runs `rewriteWpOriginUrls` with `sourceHosts` + `routePathMap`, so
  draft links match deployed links.

Residual cosmetic slivers are accepted/tracked as register B3–B5. **No action.**

### ✅ 1. Blog-index homepage (`show_on_front="posts"`) hard-fails the build — FIXED, A10

A WP site whose **Settings → Reading** is "Your latest posts" (the WP default) previously
could not build: `resolveFrontPage` returned `null` unless `show_on_front === "page"` and
`emitHomepageTsx` then threw "no static front-page configured". **Closed by the
[blog-index-front-page plan](../plans/2026-06-17-blog-index-front-page.md)** (deployed build):

- Discovery now persists `show_on_front` into `site_builds.config` (via
  `buildFrontPageConfigPatch`) even when there is no static slug.
- Compose branches on the persisted mode (`resolveHomepageEmit`): `show_on_front === "posts"`
  emits a deterministic latest-posts homepage (`emitBlogIndexTsx`) that **reuses the existing
  dynamic-list runtime** (`normalizeRecord` → `/<postType>/<slug>` local links + featured
  images) rather than throwing. No new LLM call, no WP plugin change, no DB migration.
- Still fails loud — the blog-index branch throws a specific message if the posts list ability
  is missing; the static path's error messages are reproduced verbatim.

**Residuals** (documented follow-ups, deliberately out of scope of this fix):
1. Live-Draft preview of the blog-index homepage — `page-data.ts` resolves the draft homepage
   via `config.front_page_slug`, which is `null` for posts sites; the deployed `/` is correct.
2. Pagination — latest-N only, no `/page/2`.
3. The synthesized homepage bypasses the per-page review screen + fidelity scoring (no
   `page_inventory` `/` row) — same class as the documented "fallback-resolved long-tail pages
   bypass review" residual.

### 🔴 3. Classic-editor body is un-editable — HIGH, A1

For Classic-editor (non-Gutenberg) content, `synthClassic` emits a single `blockName: null`
node ([compose-block-tree-runtime.ts:145](../../../apps/web/lib/jab/compose-block-tree-runtime.ts#L145)),
and `generateComponent` short-circuits null-named blocks to a **skipped passthrough**
([component-generator.ts:1024](../../../apps/web/lib/ai/component-generator.ts#L1024)).

- **Correction to the review's wording:** the content **does render** — via a raw-HTML
  passthrough. The defect is that it is **un-editable** (the chat editor has no addressable
  component/unit for it). The Live-Draft artifact layer also excludes it
  ([artifacts.ts](../../../apps/web/lib/draft/artifacts.ts)).
- **Severity rationale:** older agency sites are frequently all-Classic — for those, the
  entire body is outside the edit loop.
- **Direction:** segment Classic HTML into addressable units (heading/paragraph/image runs)
  so the body becomes patchable, or expose the passthrough block as an editable unit.

### 🔴 4. Desktop-1280-only generation + fidelity — MEDIUM-HIGH, A6

Generation consumes computed styles at 1280→768 only
([component-generator.ts:437](../../../apps/web/lib/ai/component-generator.ts#L437)), the
screenshot fed to generation is 1280 only
([generate-components.ts:313](../../../apps/web/lib/inngest/functions/generate-components.ts#L313)),
and fidelity scores the 1280 viewport only
([verify-fidelity.ts:207](../../../apps/web/lib/inngest/functions/verify-fidelity.ts#L207)).

- **Note:** capture **already grabs 375/768/1280** — mobile is captured then discarded.
  The fix is to *use* the existing captures, not to add capture.
- **Direction:** thread the 375 (and 768) signal into generation prompts and add a mobile
  fidelity gate so phone-layout drift can't silently pass review.

### 🔴 6. Fidelity vision scoring is a stub — MEDIUM, UNTRACKED

`visionScore` still returns `{ score: clamp01(input.pixelDiffScore), issues: [] }` with no
LLM call ([fidelity-score.ts:219](../../../apps/web/lib/ai/fidelity-score.ts#L219)).

- **Tracking gap:** this is the **only open finding with no fleet-gap-register entry** — it
  exists merely as an in-code "Phase 7.1" comment + a CLAUDE.md mention. **File a register
  entry** so it isn't lost (see [Tracking gaps](#tracking-gaps-to-close)).
- **Direction:** replace the echo with a real vision-LLM call (`getModelFor('fidelity-vision')`
  already exists from the AI-opt campaign) that emits structured per-page issues, gated by
  cost cap, fail-soft to the pixel score.

### 🔴 7. Hardcoded `lang="en"` / no `dir` — MEDIUM, A9

`<html lang="en">` is hardcoded in the emitter
([compose-site-emit.ts:788](../../../apps/web/lib/jab/compose-site-emit.ts#L788)), the draft
shell route, and the CLI template ([layout.tsx:15](../../../packages/frontend-template/app/layout.tsx#L15)).
The site locale **is fetched** at discovery via `getSiteManifest`
([discover-site.ts:223](../../../apps/web/lib/inngest/functions/discover-site.ts#L223)) but
only `front_page.static_front.slug` is consumed — locale is dropped, never persisted.

- **Direction:** persist `language` + `text_direction` from `/jab/v1/site`, thread into the
  emitted `<html lang dir>` and the draft shell. (Cheap: the data is already on the wire.)

### 🔴 8. Narrow stylesheet / font / chrome capture — MEDIUM, A8 + A11

`classifyStylesheetHref` keeps only theme + a cache allowlist
([capture-theme-stylesheets.ts:131](../../../apps/web/lib/jab/capture-theme-stylesheets.ts#L131)),
dropping Adobe/Typekit/CDN font kits; `findHeader`/`findFooter` take a single element from the
homepage only (single-header/footer model).

- **Scope correction:** self-hosted `@font-face` **is** captured — the real gap is hosted
  font *kits* (Adobe/Typekit) and CDN-delivered theme CSS, plus the single-chrome assumption.
- **Direction (A8):** widen the stylesheet allowlist to recognized font-kit hosts.
  **Direction (A11):** support per-template header/footer variants.

### 🔴 9. Dynamic-list query is not editable — LOW, A5

`DynamicListSpec`'s query is fixed at detect time
([dynamic-list-detect.ts:253](../../../apps/web/lib/jab/dynamic-list-detect.ts#L253)); the
edit-plan scope enum is only `["component","shell"]`
([edit-plan.ts:47](../../../apps/web/lib/jab/edit-plan.ts#L47)). Chat can restyle list cards
but cannot change count/order/filter — and the request currently **silently no-ops** (no
"can't do that yet" clarification path either).

- **Direction (interim):** make the planner refuse list-query edits with a clear
  `needsClarification`. **Direction (full):** add a `list-config` edit scope.

### ✅ H. `.mcp.json` Supabase token — NO LEAK, no rotation required

- `.mcp.json` is gitignored ([.gitignore:29]) and **never appears on any git ref** (full-history
  scan empty); the only `sbp_` string in the repo is in `.mcp.json.example`, whose suffix is an
  all-`x` **placeholder**.
- The real PAT lives **only** in the untracked local file. **Rotate only if** that local file
  was ever shared / screen-shared / synced off-device.
- Optional hardening: add a `gitleaks` pre-commit hook so a future accidental commit is caught.

---

## Strengths the review affirmed

The review was positive on the architecture; the items below are *not* defects and should be
preserved as we work the backlog:

- **WP stays source of truth** — content fetched at runtime via abilities (ISR `revalidate=60`),
  not baked at build.
- **Deterministic page composition** — one LLM call per unique block type; pages assembled by
  tree-walking, not per-page LLM generation.
- **Mandatory pre-publish review gate** with per-page fidelity scoring.
- **AI-call-optimization campaign** — prompt caching, model registry, batch waves,
  carry-forward reuse, typed retry taxonomy (landed on master).

---

## Recommended implementation sequence

The review's "Suggested Order" led with "land the June 16 plans" — **done**. The blog-index
homepage (#1 / A10) is also **done** ([blog-index-front-page plan](../plans/2026-06-17-blog-index-front-page.md)).
Updated order for the *remaining* work, severity-weighted:

1. **Classic-editor body editability** (#3 / A1) — High; unblocks all-Classic legacy sites.
2. **Multi-viewport generation + mobile fidelity gate** (#4 / A6) — Med-high; uses captures we already take.
3. **Real vision scoring** (#6) — Medium; **file its register entry first**.
4. **Locale / RTL** (#7 / A9) — Medium; cheap, data already on the wire.
5. **Broader capture** (#8 / A8+A11) — Medium.
6. **Dynamic-list editing** (#9 / A5) — Low (ship the refuse-with-clarification interim early — it's small).

Each becomes its own plan under `docs/superpowers/plans/` via `superpowers:writing-plans`,
TDD task-by-task, with an adversarial review pass before merge.

## Tracking gaps to close

- [ ] **File a fleet-gap-register entry for the vision stub (#6)** — currently the only
      open finding with no register row.
- [ ] **Reconcile the register's `A`-numbering** — at least one ID is cited for two different
      gaps; renumber/disambiguate so the IDs in this table are authoritative.
