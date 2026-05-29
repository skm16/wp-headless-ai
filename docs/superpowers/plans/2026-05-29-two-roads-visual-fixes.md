# Fix Two Roads visual regressions in the deployed v2 pipeline

> Planned 2026-05-29. Follows the first end-to-end Phase D deploy of Two Roads on 2026-05-28. Diagnosis report landed at [`docs/superpowers/specs/2026-05-29-two-roads-diagnosis.md`](../specs/2026-05-29-two-roads-diagnosis.md).

## Progress (2026-05-29)

| Fix | Status | Commit | Notes |
|---|---|---|---|
| Phase 1 — Diagnose | **Shipped** | `5355ea0` | Diagnosis reordered priorities; see report. Plan §2.1 next.config.ts hypothesis was wrong (host was correct); real images bug is Phase B prompt context. |
| 2.1 defensive — loud errors on `emitNextConfigTs` + compose-site failed_phase | **Shipped** | `2ce3d2f` | Throws on missing/unparseable wpUrl; compose-site.ts wraps body in try/catch to flip failed; extraHosts param added for CDN domains. |
| 2.2 main — classic-theme adapter (`design_tokens.colors`/`typography` → `ThemeJsonTokens`) | **Shipped** | `c1787c7` | `brandTokensFromDesignAnalysis` + `resolveThemeTokens` wired into both compose-site.ts (shell prompts) and generate-components.ts (Phase B block prompts). |
| 2.2 ergo — `renderTokenSection` emits slug + hex pair | **Shipped** | `c1787c7` | Pairs emit as `primary (#ffc72c)`; matched system-prompt instruction directs hex-based matching over semantic-name approximation. |
| 2.3 — footer full-bleed system prompt instruction | **Shipped** | `3908160` | "Width contract" bullet scopes the rule to outer element only; inner sub-section `max-w-*` stays legal. |
| 2.1 main — Phase B prompt context for image-bearing ACF fields | Pending | — | Highest visual leverage; smoking gun is `FeaturedBeer.tsx` placeholder. |
| 2.4 main — broaden theme stylesheet capture filter | Pending | — | Two Roads uses ShortPixel which rewrites theme CSS out of `/wp-content/themes/`. |
| 2.2 Case A fallback hardening | **Not needed** | — | Diagnosis: both shell LLMs ran successfully (compile_status=ok); fallback did not fire. |
| 2.4 `@font-face` relative URL rewriting | **Not needed** | — | Diagnosis: theme.css never emitted (capture returned 0 sheets); URL rewriting is moot until capture is fixed. |

## Context

The JAB SaaS v2 pipeline (Phase A → B → C → D) shipped end-to-end on 2026-05-28 and successfully deployed the Two Roads brewery pilot to Vercel. That validates the workflow, but the deployed site has four visible visual regressions vs. the source:

1. **Masthead is white instead of brand yellow.** The header bar at the top of the source site is `#FDB813` (Two Roads yellow) with the wordmark inside; the deployed site renders a plain white bar with a small gray "Two Roads" text link.
2. **Hero + featured-offerings + event-card + news images are broken.** Source shows beer can shots, event flyers, and news thumbnails. Deployed shows gray placeholder boxes. Importantly: the "Here's TO TAKING THE ROAD LESS TRAVELED" wordmark on the hero is also an image in the source — so it also renders as blank space in the deployed site. **Image breakage explains more of the visual diff than initially thought.**
3. **Footer renders at constrained width with centered content** instead of full-bleed dark band with edge-padded columns.
4. **Body typography uses generic sans-serif** instead of Two Roads' chosen body face (visible in the "FEATURED OFFERINGS" caps, "VISIT US" headings, body paragraphs). The fancy display wordmarks are images, so this is body-text-only.

All four symptoms trace back to the same architectural issue: **the pipeline silently degrades when Phase A capture is incomplete, generated components cannot bind image data, or required project inputs are missing**, which violates the kit's "Errors are loud" convention (CLAUDE.md). Four concrete silent-fallback paths surfaced during exploration:

- `apps/web/lib/jab/compose-site-emit.ts:157-177` — `emitNextConfigTs(wpUrl)` returns an empty Next config (no `images.remotePatterns`) when `wpUrl` is falsy, and falls back to `hostname = "**"` (invalid in Next.js) on a URL parse failure. Result: every `<Image>` silently refuses to render.
- `apps/web/lib/ai/shell-prompts.ts:161-200` — deterministic shell fallback hardcodes `border-gray-200` + `max-w-6xl mx-auto`, has zero awareness of brand color or full-bleed intent. Fires whenever `shellDom` is empty (Cloudflare-blocked Playwright capture) or the LLM call fails twice.
- `apps/web/lib/ai/shell-prompts.ts:57-65` — `renderTokenSection` passes only color **slug names** (`"primary"`, `"secondary"`) to the LLM, never the hex values. The LLM cannot map a captured `style="background-color: #FDB813"` in source DOM to `bg-primary` because it doesn't know what `bg-primary` actually is.
- Phase B generated block components may render image placeholders even when the runtime WP record contains usable image URLs. The deployed screenshot's gray boxes look like component-level placeholders in some sections, not only failed `next/image` loads. This must be diagnosed from emitted TSX plus the live/runtime record shape, not inferred from `next.config.ts` alone.

We need to first **diagnose** which of these silent paths actually fired for the Two Roads build (the database has the answer; we should not guess), then land targeted fixes.

## Approach

Two-phase: **diagnose with read-only queries** against the existing Two Roads build artifacts in Supabase + Storage, then **apply fixes in priority order** (images first — definitive bug + biggest visual win; then masthead; then footer; then body fonts). Each fix includes the "loud-error" hardening so the next pilot doesn't silently fail the same way.

---

## Phase 1 — Diagnose Two Roads build state (read-only)

Goal: produce a one-page report stating, for the most recent Two Roads `site_builds` row, exactly which silent-degradation paths fired. Do this **before writing any fix code** — several of the planned fixes only help if specific paths fired, and we should not invest in dead-code fixes.

### 1.1 Project + build identifiers

Query Supabase via the `mcp__supabase__execute_sql` MCP tool (read-only):

```sql
SELECT id, name, wp_url, design_tokens->>'shellDom' IS NOT NULL AS has_shell_dom,
       jsonb_array_length(COALESCE(design_tokens->'themeStylesheets', '[]'::jsonb)) AS theme_sheet_count,
       jsonb_array_length(COALESCE(design_tokens->'themeJson'->'colorPalette', '[]'::jsonb)) AS palette_count
  FROM projects
 WHERE name ILIKE '%two roads%' OR wp_url ILIKE '%tworoads%';

SELECT id, project_id, status, created_at, vercel_deployment_url
  FROM site_builds
 WHERE project_id = '<id-from-above>'
 ORDER BY created_at DESC
 LIMIT 3;
```

Capture: `project.id`, `project.wp_url` (the load-bearing field for the image fix), `has_shell_dom`, `theme_sheet_count`, `palette_count`, latest `build.id`.

### 1.2 Inspect captured Phase A data

```sql
SELECT design_tokens->'shellDom'->'header' IS NOT NULL AS header_captured,
       design_tokens->'shellDom'->'footer' IS NOT NULL AS footer_captured,
       LENGTH(design_tokens->'shellDom'->>'header') AS header_len,
       LENGTH(design_tokens->'shellDom'->>'footer') AS footer_len,
       design_tokens->'themeJson'->'colorPalette' AS palette
  FROM projects WHERE id = '<project-id>';

SELECT compile_status, model, attempts, cost_usd
  FROM shell_generations WHERE build_id = '<build-id>';
```

This tells us whether the shell fell back deterministically or the LLM ran. `compile_status = 'skipped'` means shellDom was empty → no LLM call → gray fallback was emitted.

### 1.3 Pull the actual emitted files from Storage

Storage bucket: `site-screenshots` (historical name; now the private build-artifact bucket). Paths are still under `builds/<build-id>/project/...`. Use `mcp__supabase__execute_sql` to confirm path, then a one-off download script or the existing `downloadProjectTree` helper in `apps/web/lib/jab/download-project-tree.ts` which Phase D already uses.

Files to inspect for build `<build-id>`:
- `builds/<build-id>/project/next.config.ts` — does it have `images.remotePatterns` and what hostname?
- `builds/<build-id>/project/components/site/Header.tsx` — fallback (gray, max-w-6xl) or LLM output (real markup)?
- `builds/<build-id>/project/components/site/Footer.tsx` — same check
- `builds/<build-id>/project/tailwind.config.ts` — what colors + fontFamily tokens emitted?
- `builds/<build-id>/project/styles/theme.css` — empty (Phase A capture failed) or contains `@font-face` rules?
- `builds/<build-id>/project/components/blocks/*.tsx` for the visible image-bearing sections — determine whether gray boxes are hardcoded placeholders / missing image-field extraction vs. real `<Image>`/`<img>` tags with bad hosts.
- `builds/<build-id>/project/lib/compose-block-tree.ts` plus a fresh front-page ability response (read-only MCP call or existing diagnostic helper) — inspect where image URLs actually live in `record.blocks`, `record.acf`, `featured_image`, and flexible-content rows. This is necessary because Phase C emits code that assembles the block tree at generated-app request time; it does **not** have a materialized block tree available while composing.

### 1.4 Output

A short markdown report (committed alongside the fix PRs as `docs/superpowers/specs/2026-05-29-two-roads-diagnosis.md`) with a table:

| Symptom | Hypothesized cause | Actual state from build | Confirmed? |
|---|---|---|---|
| Broken images | `wp_url` missing or `next.config.ts` lacks WP host | `wp_url = 'https://...'`, `next.config.ts` hostname = `...` | yes/no |
| Gray image placeholders | Generated block TSX failed to bind image fields | Component has hardcoded gray placeholder / live record has URL at `...` | yes/no |
| White masthead | Shell LLM skipped → deterministic fallback | `Header.tsx` is fallback / is LLM output | yes/no |
| Constrained footer | Same fallback path | `Footer.tsx` is fallback / is LLM output | yes/no |
| Wrong body font | `theme.css` empty or `@font-face` URLs broken | `theme.css` size = ..., has @font-face = ... | yes/no |

This report determines which fixes below ship and which are deferred.

---

## Phase 2 — Fixes (ordered by impact)

Each fix is scoped to land on its own branch with TDD per the kit's testing convention. Files listed are the primary touch points; verify before edit.

### 2.1 Image rendering (highest leverage — definitive bug)

**Root cause:** `apps/web/lib/jab/compose-site-emit.ts:157-177` silently emits a broken `next.config.ts` when input is missing or malformed.

**Changes:**

1. **Fail loud on missing `wp_url`.** In `apps/web/lib/inngest/functions/compose-site.ts` (the caller at line 254 per exploration), throw a clear `JabComposeError("project.wp_url is required to emit next.config.ts; project <id> has it set to <value>")` before invoking `emitNextConfigTs`. Mark the `site_builds` row `status: 'failed'` with `failed_phase: 'composing'`, a clear `error_text`, and `finished_at`.
2. **Refactor `emitNextConfigTs(wpUrl: string, extraHosts?: string[]): string`** (drop the optional). Throw on `new URL(wpUrl)` failure rather than the wildcard fallback. The `"**"` fallback at line 159 is wrong — Next.js validates remotePatterns and a bare `**` rejects; this was already producing broken output, not graceful degradation.
3. **Collect additional image hosts from data that Phase C actually has access to.** Do **not** scan an "emitted block JSON/page tree" inside `compose-site.ts`; the generated app calls `composeBlockTree()` at request time, so Phase C does not hold a materialized BlockNode tree. Choose one of these implementation paths after Phase 1 diagnosis:
   - Preferred if enough data is already persisted: collect image hosts during Phase A from page ability responses, block captures, `featured_image`, ACF image fields, and source DOM URLs; persist a `design_tokens.imageHosts` or build `config.imageHosts` array; pass that to `emitNextConfigTs`.
   - Acceptable targeted fix: in `compose-site.ts`, fetch the front-page record once during compose solely to extract image hosts, using the same ability metadata already resolved for `emitHomepageTsx`. This is less comprehensive for secondary routes but directly fixes the pilot homepage.
   - Defensive runtime fallback: update generated/platform image rendering to use plain `<img>` or `unoptimized` for hosts not present in config. This avoids blank/gray output, but should be paired with host capture so Next optimization works where possible.
4. **Diagnose and fix component-level placeholders.** Confirm Phase B platform shim (`apps/web/components/blocks/_platform/MediaImage.tsx`) uses `next/image` (it does), then inspect generated `components/blocks/*.tsx` for Two Roads sections. If a component hardcodes gray boxes or fails to read ACF/media fields, fix the Phase B prompt and/or field-summary helpers so image-shaped fields include their URL paths and expected binding examples. Track this as part of image rendering, not a separate cosmetic issue.

**Tests** (Vitest, colocated):
- `compose-site-emit.test.ts`: assert `emitNextConfigTs("https://tworoadsbrewing.com")` includes `hostname: "tworoadsbrewing.com"`; assert it throws on `""`, `null`, and `"not a url"`.
- `compose-site-emit.test.ts`: assert multi-host call (`emitNextConfigTs(wpHost, "i0.wp.com", "cdn.shopify.com")`) emits three `remotePatterns` entries.
- `compose-site.test.ts`: assert the Inngest function aborts cleanly with status `'failed'`, `failed_phase: 'composing'`, and a descriptive `error_text` when `wp_url` is null.
- Phase B/component test if placeholders are confirmed: assert the generated prompt context for image-shaped ACF fields includes URL-bearing paths, and/or a fixture component renders a real image when the fixture record contains an image URL.

**Verification:** re-run compose+deploy for Two Roads (`pnpm --filter @jab/web smoke-deploy-site` per `apps/web/scripts/smoke-deploy-site.ts`); curl the deployed site; confirm `next.config.ts` in the artifact tree includes the WP host; visually confirm hero/featured/event/news images all render.

### 2.2 Masthead brand color

**Conditional on Phase 1 diagnosis.**

**Case A — shellDom was empty (LLM skipped, fallback fired):**

The deterministic fallback at `apps/web/lib/ai/shell-prompts.ts:161-200` is brand-agnostic. Two-part fix:

1. **Teach the fallback about brand color.** Extend `shellDeterministicFallback` signature to accept `themeTokens: ThemeJsonTokens | null`. When `themeTokens.colorPalette` contains a recognizable brand color (priority: slug `"primary"` → slug `"brand"` → first entry with a slug not matching `/^(white|black|gray|grey)/i`), use that hex as the header `style={{ backgroundColor: '#hex' }}` (inline style is fine here — the Tailwind config tokens may or may not have a class for arbitrary palette entries). Same color for body text contrast (compute luminance, pick `text-white` vs `text-gray-900`).
2. **Harden Phase A capture so shellDom is rarely empty.** In `apps/web/lib/jab/discover-site.ts` (or wherever `shellDom` is captured per exploration), retry the homepage capture once with a different user-agent + longer `networkidle` timeout if header/footer come back empty. Log loudly to the build's structured log when this happens.

**Case B — shellDom was captured, LLM ran, output omitted color:**

The LLM only sees color slug names per `apps/web/lib/ai/shell-prompts.ts:57-65`. It cannot map source `background-color: #FDB813` to `bg-primary` without knowing primary's value.

1. **`renderTokenSection`: emit slug + hex.** Change `Colors: ${colors}` (currently `"primary, secondary, ..."`) to `Colors: primary (#FDB813), secondary (#1B3B5C), ...`. Same for fontFamilies (`display (Syne)`, `body (DM Sans)`).
2. **Add a system-prompt line:** "When the source DOM uses a literal color value (e.g. `background-color: #FDB813`), prefer the matching token class (`bg-primary`) over a Tailwind utility approximation."

**Tests:**
- `shell-prompts.test.ts`: assert `renderTokenSection` includes hex codes alongside slug names; assert `shellDeterministicFallback("header", menu, name, tokens)` with a `primary: "#FDB813"` palette entry emits inline yellow background.
- Snapshot test the system prompt body to lock in the new instruction.

**Verification:** download the regenerated `Header.tsx` from Storage; visually inspect; redeploy; screenshot vs source.

### 2.3 Footer full-bleed

**Likely same root cause as 2.2** (deterministic fallback or LLM not seeing source structure). If LLM ran on a captured `shellDom.footer`, the LLM should have produced a full-bleed footer — this is a prompt-quality issue, not a fallback issue.

**Changes:**

1. **Fallback fix:** in `shellDeterministicFallback("footer", ...)`, drop the inner `<div className="max-w-6xl mx-auto ...">` constraint; use `<div className="w-full px-6 lg:px-12 py-8 ...">` for edge-padded full-bleed. Match the source-site pattern.
2. **LLM prompt fix:** add to `sharedShellSystemPrompt` (line 91-102): "Footer width: if the source `<footer>` element has no explicit `max-width` style, render full-bleed (`w-full`) with edge padding only — do NOT add `max-w-*` containers."
3. **Apply the same brand-color treatment** from 2.2 to the footer fallback if the source footer has a dark background (Two Roads footer is dark navy with white text).

**Tests:** `shell-prompts.test.ts` — assert footer fallback no longer contains `max-w-6xl`; assert it has `w-full`.

### 2.4 Body fonts (lowest priority — wordmarks are images)

**Conditional on Phase 1 diagnosis.**

**If `theme.css` is empty** (Phase A capture failed):
- Add a fetch-retry in `apps/web/lib/jab/capture-theme-stylesheets.ts` (per exploration, lines 101-112). On `document.styleSheets` SecurityError or empty result, fall back to fetching the `<link rel="stylesheet">` URLs directly via `fetch()` rather than relying on the browser's CSSOM.
- Log loudly to the build log when sheets capture fails.

**If `theme.css` has `@font-face` rules but with relative URLs** (e.g. `src: url(../fonts/dm-sans.woff2)`):
- In `apps/web/lib/jab/compose-site-emit.ts:scopeCssToJabTheme` (line 252), add a transform: when emitting an `@font-face` rule, rewrite relative `url(...)` paths to absolute URLs using the source stylesheet's `href` as the base. The captured `ThemeStylesheetCapture` already has the original `href`; change `emitThemeCss` from `scopeCssToJabTheme(sheet.css)` to `scopeCssToJabTheme(sheet.css, sheet.href)` and thread that base through `scopeBlock` / at-rule handling so the transform has the base URL.

**If the source site uses Google Fonts via `<link>`:**
- Capture those `<link>` URLs in Phase A and emit them into `app/layout.tsx`'s `<head>` (one carve-out from the "no next/font" rule documented at compose-site-emit.ts:415). Or: switch the rule to "no next/font for *self-hosted* fonts; Google `<link>` tags allowed" and document why.

**Tests:** `compose-site-emit.test.ts` — assert `scopeCssToJabTheme` with an `@font-face` rule containing relative URLs and a base href produces absolute URLs in output.

**Verification:** open the deployed site, inspect computed font-family on a body paragraph, confirm it's the captured font (Syne / DM Sans / whatever Two Roads ships) not the OS sans-serif fallback.

---

## Critical files

**Read before editing:**
- [apps/web/lib/jab/compose-site-emit.ts](../../apps/web/lib/jab/compose-site-emit.ts) — the bulk of fixes 2.1 and 2.4 land here
- [apps/web/lib/ai/shell-prompts.ts](../../apps/web/lib/ai/shell-prompts.ts) — fixes 2.2 and 2.3 land here
- [apps/web/lib/inngest/functions/compose-site.ts](../../apps/web/lib/inngest/functions/compose-site.ts) — fix 2.1's caller-side hardening lands here (around line 254)
- [apps/web/lib/jab/discover-site.ts](../../apps/web/lib/jab/discover-site.ts) — Phase A retry for fix 2.2 Case A
- [apps/web/lib/jab/capture-theme-stylesheets.ts](../../apps/web/lib/jab/capture-theme-stylesheets.ts) — Phase A retry for fix 2.4
- [docs/saas-v2-component-pipeline.md](../saas-v2-component-pipeline.md) — architectural reference
- [packages/wp-plugin/README.md](../../packages/wp-plugin/README.md) — plugin changelog; image URL behavior in v0.6.x

**Existing utilities to reuse, not reinvent:**
- `downloadProjectTree` in `apps/web/lib/jab/` (used by Phase D) — same helper for the Phase 1 diagnostic file pulls
- `JabComposeError` (or whatever the existing compose-error type is — search before defining a new one)
- `scopeCssToJabTheme` / `scopeBlock` in `compose-site-emit.ts:252+` — extend in place rather than introducing a new scoper

---

## Verification

End-to-end:
1. After each fix lands, run `pnpm --filter @jab/web smoke-deploy-site` against Two Roads.
2. Visit the resulting Vercel preview URL.
3. Compare to source `tworoadsbrewing.com` using the side-by-side screenshots in this conversation.
4. The pass bar for v1 is: hero + featured beer cans + event cards + news thumbnails render real images; masthead has the yellow brand color; footer spans full width with dark background; body text uses Two Roads' chosen typeface. The wordmark images render automatically once the image fix lands (they're WP-hosted images, not fonts).

Per-fix tests:
- `pnpm --filter @jab/web test compose-site-emit` — assertions for 2.1, 2.3, 2.4
- `pnpm --filter @jab/web test shell-prompts` — assertions for 2.2, 2.3
- `pnpm --filter @jab/web test compose-site` — assertions for 2.1's Inngest-function hardening

Loud-errors regression test:
- Add a Vitest case that asserts `compose-site` Inngest function fails fast with a clear `error_text` when given a project with `wp_url = null` — locking in the convention so this class of silent-failure doesn't reappear.
