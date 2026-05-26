# JAB SaaS v2 — Component-Pipeline Implementation Roadmap

> **For agentic workers:** This is a **roadmap**, not a single executable plan. The work spans six independent subsystems (Phases A–F per the design doc). Per the `superpowers:writing-plans` scope-check guidance, each stage gets its own TDD-grained sub-plan written and executed when that stage is ready. The roadmap defines the sequencing, deliverables, and success criteria.
>
> **Sub-plan workflow:** When ready to execute a stage, dispatch a fresh session to write the sub-plan in `docs/superpowers/plans/2026-05-25-saas-v2-phase-{x}-{name}.md`. Use the `superpowers:writing-plans` skill. The handoff prompt for each stage is included below.

**Goal:** Re-platform `apps/web` from a homepage-focused HTML-blob generator into a **component-by-component, whole-site migration pipeline** that produces a real Next.js project per client WordPress site, with measurable fidelity and a mandatory pre-publish review gate.

**Architecture:** Six-phase pipeline (Discover → Components → Compose → Build → Verify → Review) keyed off the v0.6.0 plugin's typed `BlockNode[]` schema. One LLM call per unique block type (not per page). Deterministic page composition via block-tree walking. Connected WP is a precondition; the public scrape becomes a one-shot design-tokens signal at onboarding. Full design rationale in [`docs/saas-v2-component-pipeline.md`](../../saas-v2-component-pipeline.md).

**Tech Stack:** Next.js 15 App Router, TypeScript, Tailwind, Inngest (workers), Supabase (Postgres + Storage + Auth), `@jab/core` MCP client, `@anthropic-ai/sdk` (Sonnet 4.6 + Haiku 4.5 + vision), Playwright (headless Chromium), DOMPurify (sanitized HTML passthrough), Vercel deploy API. Plugin floor: v0.6.0.

---

## Roadmap structure

```
Stage 0 — Prerequisites + teardown
   ↓
Stage 1 — Phase A: Discovery
   ↓
Stage 2 — Phase B: Components
   ↓
Stage 3 — Phase C: Compose & Shell        ┐
Stage 4 — Phase D: Build & Deploy         │ Stages 3+4 can run in parallel
   ↓                                       ┘ with the latter half of Stage 2
Stage 5 — Phase E: Verify
   ↓
Stage 6 — Phase F: Review + Publish gate
   ↓
Stage 7 — Orchestration + UX polish
```

Stages 0–2 are strictly serial. Stage 3 can begin once Stage 2 has a working component-generation prototype (even for one block type). Stage 4 is mostly extending existing `lib/jab/scaffold.ts` work. Stages 5–7 layer on top.

---

## Stage 0 — Prerequisites + teardown

**Goal:** Remove the preview path, lay down the new database schema, and prepare the codebase for Stage 1.

**Pre-flight decision required:** Sean confirms the preview drop (Decision #1 in the design doc §10).

**Deliverables:**
- Drop `/preview` route, `preview-flow.tsx`, `anonymous_previews` table, and all preview-only workers (`scrape-preview.ts`)
- Decommission `runScrapeAgent`'s content pass; keep only the design-tokens output of the design pass
- Drop `regenerateHomepage.ts` (will be replaced by `buildSite` in Stage 7 orchestration)
- Drop `preview_html` + `preview_html_status` + `usage` columns from `projects`
- New tables: `site_builds`, `deployments`, `block_inventory`, `page_inventory`, `fidelity_reports`
- Update `connectWpAction` to require successful manifest probe + plugin v0.6.0+ (hard precondition, not best-effort)
- Update onboarding wizard step copy to match: URL → account → plugin → connect → ownership → build (no more "preview" wording)
- Storage bucket scaffolding: `screenshots/<project_id>/<build_id>/source/<viewport>/<slug>.png` + `screenshots/<project_id>/<build_id>/generated/<viewport>/<slug>.png`

**Success criteria:**
- `pnpm tsc` clean across `apps/web`
- `next build` clean
- Tenant-isolation test from `saas-mvp-transition.md` Phase 1 SEC-1 still passes against the new tables
- Onboarding wizard can be walked end-to-end against a real WP install — outcome is a project row marked "ready to build" (no preview generated)
- No reference to `preview_html` remains in the codebase (`grep` check)

**Risks:**
- Existing projects in dev/staging with `preview_html` data — migration drops the column. Document the migration as destructive; coordinate with anyone holding active sessions.
- The onboarding wizard's "wow moment" is the homepage preview. Removing it without replacement makes onboarding feel duller. Mitigation: surface the block inventory (Stage 1 output) as the new mid-onboarding wow moment — "we found 47 pages and 28 block types in your site." Land that copy alongside the wizard changes.

**Handoff prompt for Stage 0 sub-plan:**

> Read [`docs/saas-v2-component-pipeline.md`](../../saas-v2-component-pipeline.md) §2, §8, §9 in full. Read this roadmap's Stage 0 section. Write a TDD-grained plan at `docs/superpowers/plans/2026-05-25-saas-v2-phase-0-teardown.md` that:
> 1. Removes the preview path file-by-file with `grep` verification at each step
> 2. Lands the new tables as a single migration `apps/web/drizzle/0014_saas_v2_schema.sql` with the column comments from the design doc §8
> 3. Hardens `connectWpAction` to require the manifest probe success (currently best-effort)
> 4. Updates the wizard copy + flow per the new precondition model
> Use the existing migration in `apps/web/drizzle/0013_*` as the format reference. Tests against the new tables go in `apps/web/scripts/test-tenant-isolation.sql` extension.

---

## Stage 1 — Phase A: Discovery

**Goal:** Given a `project_id` with completed onboarding, produce a complete `block_inventory` + `page_inventory` + persisted source screenshots + computed-CSS aggregates + theme.json + confirmed design tokens.

**Deliverables:**
- New Inngest worker: `lib/inngest/functions/discover-site.ts` triggered by `site/build.requested` event (or directly as `site/discover.requested` if the orchestrator is built incrementally)
- New ability-client extensions in `lib/jab/ability-client.ts`: `getMenus()`, `listPostTypes()`, `listPostType(cpt, opts)`, `getPostBySlug(cpt, slug, includeBlocks)`, `getGlobalStyles()`
- New module: `lib/jab/playwright-discovery.ts` — given a list of `{slug, post_type, url}`, runs headless Chromium and produces screenshots, bounding rects, and computed styles per block
- New module: `lib/jab/inventory.ts` — walks BlockNode[] trees, accumulates `attr_samples`, computes `occurrence_count`, assigns initial tier per §6.4 heuristics
- Persistence: writes to `block_inventory`, `page_inventory` tables; uploads screenshots to Storage
- Design-tokens one-shot: reuses existing `extractProjectDesign` but scoped to design pass only (content pass already removed in Stage 0)

**Success criteria:**
- Against the Two Roads Brewing pilot WP install, the discovery worker:
  - Completes in ≤ 2 minutes
  - Produces a `block_inventory` with ≥ 20 rows
  - Produces a `page_inventory` covering every published page + post
  - Stores 3 viewport screenshots per page in the project's Storage bucket
  - Captures computed CSS for ≥ 95% of inventoried block instances
  - The Inngest run trace is debuggable (each ability call shows in step output)
- A SQL query against `block_inventory` ordered by `occurrence_count desc` returns a sensible ranked list with tiers assigned

**Risks:**
- **Playwright in Inngest's serverless runtime** — may not work reliably. Mitigation: if it doesn't, deploy a dedicated worker (Fly / Railway) that Inngest calls via HTTP. Decision boundary lives in this stage.
- **WP sites that block headless browsers** — Cloudflare bot protection, hostile WAF rules. Mitigation: identify with the user agent, fall back to "skip screenshots, use scrape-extract only" for the affected pages, and flag the project as having limited fidelity inputs.
- **Bounding-rect-to-block mapping** — WP themes don't always render block class names predictably. The plugin can emit `data-jab-block-id` attributes from the parser side as a fast-follow if the heuristics-based mapping in v1 misses too often.

**Handoff prompt for Stage 1 sub-plan:**

> Read [`docs/saas-v2-component-pipeline.md`](../../saas-v2-component-pipeline.md) §4 Phase A, §6.1, §6.3, §6.4 (tier heuristics seed list), §8 (the persistence layer). Read this roadmap's Stage 1 section. Read [`apps/web/lib/jab/ability-client.ts`](../../../apps/web/lib/jab/ability-client.ts) and [`apps/web/lib/inngest/functions/extract-project-design.ts`](../../../apps/web/lib/inngest/functions/extract-project-design.ts) for the existing patterns to follow.
>
> Write a TDD-grained plan at `docs/superpowers/plans/2026-05-25-saas-v2-phase-a-discovery.md` that covers each new ability-client method, the Playwright module (with the Inngest-vs-dedicated-worker decision as an explicit task), the inventory builder, persistence to the new tables (from Stage 0), and a smoke test against the Two Roads pilot install. Reference the existing Inngest worker style (step.run boundaries, retries: 0, fail-soft warns) from `extractProjectDesign`.

---

## Stage 2 — Phase B: Components

**Goal:** Given a populated `block_inventory` and `design_tokens`, generate one typed React component per unique non-passthrough block type. Output is a set of `.tsx` files ready to be assembled in Stage 3.

**Deliverables:**
- New module: `lib/ai/model-client.ts` — `ModelClient` interface + `AnthropicClient` + `GeminiClient` (trivial tier) implementations. Per-tier config table maps tier → provider+model. Wires prompt caching for Anthropic calls (per design doc §6.7a) and Batch API for Phase B's parallel generation (§6.7b).
- New module: `lib/ai/generate-block-component.ts` — single-block generator with tier routing (visual / standard / trivial) via `ModelClient`
- New module: `lib/ai/component-prompts.ts` — per-tier system prompts (with cache markers); component-shaped Faithful intent contract (replaces the page-shaped `INTENT_BRIEFS`); per-call schema slimming per design doc §6.7c
- New Inngest worker: `lib/inngest/functions/generate-components.ts` — orchestrates the batch generation with parallelism (batches of 10 via Anthropic Batch API for visual/standard, direct calls to Gemini for trivial), compile gating, retry-then-passthrough fallback
- New module: `lib/jab/tailwind-config-emit.ts` — deterministic `tailwind.config.ts` emitter from theme.json + design tokens
- New module: `lib/jab/dispatcher-emit.ts` — emits the block dispatcher (BlockNode → component map) — referenced by Stage 3 but lives here since it depends on the generated component file list
- Persistence: emitted component files written to Supabase Storage under `builds/<build_id>/components/` for Stage 3 to consume; metadata (per-block model used, provider used, cached/uncached input tokens, compile status) recorded against `block_inventory` rows for cost telemetry

**Success criteria:**
- Against the Two Roads block inventory, the component generator:
  - Completes in ≤ 5 minutes
  - Produces a `.tsx` file per non-passthrough block (≥ 20 components for Two Roads)
  - Every emitted file passes `tsc --noEmit` standalone (the compile gate)
  - Visual-tier components reference the design tokens (validated by simple regex check for `tailwind.config` token names)
  - Component file size is bounded (no runaway generations — cap at e.g. 8KB per file, retry if exceeded)
- A "regenerate single component" path exists end-to-end (used by Stage 6 Phase F)

**Risks:**
- **Per-component compile failures cascade** — if every 5th component fails to compile and retries, total time balloons past 10 minutes. Mitigation: cap the retry count at 1, then mark the block as passthrough; the build completes with degraded coverage instead of timing out.
- **Tailwind token drift** — components reference `tailwind.config` keys that don't exist. Mitigation: emit the full token set first (Stage 2 step 1, deterministic), then expose the available token list to every component prompt so the LLM picks from the real set.
- **Block prop type mismatch with BlockNode variant** — generated component prop type doesn't match what the dispatcher will hand it. Mitigation: include the exact BlockNode variant TypeScript snippet from `@jab/core`'s generated types in every prompt, and post-process the emitted file to verify the prop type signature with `tsc`.

**Handoff prompt for Stage 2 sub-plan:**

> Read [`docs/saas-v2-component-pipeline.md`](../../saas-v2-component-pipeline.md) §3 Decision 2, §4 Phase B, §6.4 (tier table). Read [`docs/ai-prompt-modes.md`](../../ai-prompt-modes.md) §4 (Faithful contract) to understand the preservation requirements; the component-generator prompts must honor these.
>
> Read this roadmap's Stage 2 section. Read [`apps/web/lib/ai/preview-renderer.ts`](../../../apps/web/lib/ai/preview-renderer.ts) (the existing creative-LLM-call pattern, including the `MAX_OUTPUT_TOKENS` lesson) and [`apps/web/lib/ai/client.ts`](../../../apps/web/lib/ai/client.ts) (the shared Anthropic singleton).
>
> Write a TDD-grained plan at `docs/superpowers/plans/2026-05-25-saas-v2-phase-b-components.md`. Cover each tier prompt, the batching worker, the compile gate, the tailwind config emitter, and a smoke test that generates the Two Roads `core/heading` component end-to-end (trivial tier, lowest risk, validates the full path).

---

## Stage 3 — Phase C: Compose & Shell

**Goal:** Given the generated component files + page inventory, emit the full Next.js project file tree: page routes, block dispatcher, site header/footer, layout, sitemap, robots, package.json, configs.

**Deliverables:**
- Extension of `lib/jab/scaffold.ts` to emit the new file tree shape (or a parallel `lib/jab/scaffold-v2.ts` if the v1 scaffold survives for a transition period — recommend the parallel route, retire v1 in Stage 7)
- New modules: `lib/jab/emit-page-routes.ts`, `lib/jab/emit-block-dispatcher.ts`, `lib/jab/emit-app-layout.ts`
- LLM-backed shell generators: `lib/ai/generate-site-header.ts`, `lib/ai/generate-site-footer.ts` — consume menu data + logo, emit React components (visual tier, with header-region screenshot input)
- New Inngest worker: `lib/inngest/functions/compose-site.ts` — assembles the full file tree from component files + page inventory + shell components
- Persistence: full file tree uploaded to Storage at `builds/<build_id>/source/` ready for Stage 4's deploy

**Success criteria:**
- Output file tree contains:
  - `app/page.tsx` (homepage, deterministically composed from front-page blocks)
  - `app/[...slug]/page.tsx` (catch-all for all other pages — resolves slug via SDK, walks blocks, dispatches)
  - `app/{cpt}/page.tsx` + `app/{cpt}/[slug]/page.tsx` for each public CPT (note: v1.1 per design doc §9, but the scaffolder should support emit-or-skip from day one)
  - `components/blocks/<BlockName>.tsx` for each generated component
  - `components/blocks/_dispatcher.tsx` mapping block names to components, with passthrough fallback for unknowns
  - `components/site/Header.tsx` + `components/site/Footer.tsx`
  - `app/layout.tsx` composing header + footer + fonts
  - `tailwind.config.ts` from Stage 2
  - `app/not-found.tsx`, `app/robots.ts`, `app/sitemap.ts`
  - `lib/sdk/` from `@jab/core`'s existing emit logic
  - `next.config.ts`, `package.json`, `.env.example`, `tsconfig.json`
- The emitted file tree compiles standalone with `next build` (Stage 4 verifies)

**Risks:**
- **Page-composition runtime failures** — the catch-all route resolves a slug, but the SDK call fails or the block dispatcher hits an unknown block name. The dispatcher must have a safe fallback (passthrough with sanitization per Decision 3); the route must have an error boundary that renders a useful "this page is being rebuilt" message rather than a crash.
- **CPT routes added but no CPT components generated** — design doc §9 punts CPT templates to v1.1. The scaffolder should *conditionally* emit CPT routes based on whether v1.1 has shipped. Keep the emit logic in but gate it behind a config flag for now.

**Handoff prompt for Stage 3 sub-plan:**

> Read [`docs/saas-v2-component-pipeline.md`](../../saas-v2-component-pipeline.md) §4 Phase C, §8 (Add section). Read this roadmap's Stage 3 section. Read [`apps/web/lib/jab/scaffold.ts`](../../../apps/web/lib/jab/scaffold.ts) for the existing scaffold pattern. Read [`packages/cli/src/commands/generate.ts`](../../../packages/cli/src/commands/generate.ts) — the CLI emits a similar file tree shape and the patterns are reusable.
>
> Write a TDD-grained plan at `docs/superpowers/plans/2026-05-25-saas-v2-phase-c-compose-shell.md` covering the page-route emitters, the dispatcher, the shell LLM calls, and full-tree assembly. Include a test that produces a file tree and runs `next build` against it in a temp directory (the Stage 4 gate validated locally before the real deploy).

---

## Stage 4 — Phase D: Build & Deploy

**Goal:** Given an assembled file tree, run `next build` and deploy the output to Vercel as an immutable preview URL.

**Deliverables:**
- New module: `lib/deploy/deploy-provider.ts` — `DeployProvider` interface per `hosting.md` (single Vercel implementation in v1)
- New module: `lib/deploy/vercel.ts` — Vercel-specific adapter (uses Vercel REST API, project + deployment endpoints)
- New Inngest worker: `lib/inngest/functions/build-and-deploy.ts` — runs `next build` against the assembled tree, captures the build artifact, deploys to Vercel, captures the immutable preview URL
- Persistence: writes to `deployments` table with build_id reference, preview URL, status
- Build failure handling: a failed `next build` flips the `site_builds` row to `failed` with the build log captured (truncated to e.g. 64KB) for surfacing in the UI

**Success criteria:**
- Against a Stage 3 file tree, the worker:
  - Runs `next build` and captures success or failure
  - On success, deploys to Vercel and captures the preview URL (e.g. `*.vercel.app`)
  - Records both URLs (build artifact location + preview URL) on the `deployments` row
  - Surfaces build failures with a useful log snippet, not just "failed"
- An end-to-end smoke test against the Two Roads pilot produces a clickable preview URL — every public page resolves; every nav link works; passthrough blocks render with sanitized HTML

**Risks:**
- **Build time on large sites** — `next build` for 200 routes can hit 5+ minutes. Mitigation per design doc §4: top-N pages use `generateStaticParams`; rest are dynamically rendered. Specifically: don't try to pre-render every page; the ISR floor handles the long tail.
- **Vercel API rate limits** — multiple agencies kicking off builds at once. Mitigation: a per-tenant concurrency limit (already wired by `COST-1` from `saas-mvp-transition.md` Phase 1 audit).
- **Build worker memory** — `next build` is memory-hungry. Inngest's runtime may not allocate enough. Mitigation: same decision-boundary as Stage 1 Playwright — fall back to a dedicated worker if needed.

**Handoff prompt for Stage 4 sub-plan:**

> Read [`docs/hosting.md`](../../hosting.md) for the DeployProvider rationale + Vercel-first / Cloudflare-later sequencing. Read [`docs/saas-v2-component-pipeline.md`](../../saas-v2-component-pipeline.md) §4 Phase D, §8 (deployments + site_builds tables).
>
> Read this roadmap's Stage 4 section. Note: the original `lib/github/push.ts` referenced in `saas-mvp-transition.md` Phase 2 was deleted in commit `75d485a`; you're building this from scratch, not adapting from it. Use the Vercel REST API directly — `@vercel/sdk` is acceptable if it's actively maintained at implementation time, otherwise raw fetch.
>
> Write a TDD-grained plan at `docs/superpowers/plans/2026-05-25-saas-v2-phase-d-build-deploy.md`. Cover the DeployProvider seam, the Vercel adapter, the build worker, and a smoke test that takes the Stage 3 output and deploys to a Vercel test project.

---

## Stage 5 — Phase E: Verify

**Goal:** Given a deployed preview URL, capture output screenshots, diff against source screenshots from Stage 1, run vision-LLM scoring on flagged pages, persist per-page fidelity reports.

**Deliverables:**
- New module: `lib/jab/playwright-verify.ts` — given a base URL + list of page slugs + viewports, captures output screenshots (mirrors Stage 1's discovery Playwright structure, reusable infrastructure)
- New module: `lib/ai/fidelity-score.ts` — pixel-diff using `pixelmatch`, then vision LLM scoring for pages above threshold
- New module: `lib/ai/fidelity-prompts.ts` — vision LLM prompt + structured output schema (Zod)
- New Inngest worker: `lib/inngest/functions/verify-fidelity.ts`
- Persistence: writes to `fidelity_reports` table per page per build

**Success criteria:**
- Against a Stage 4 deployment of the Two Roads pilot:
  - Output screenshots captured at 3 viewports per page
  - Pixel-diff completes for every page (< 30s total for ~50 pages)
  - Vision LLM scoring runs only on flagged pages (default threshold: > 0.10 pixel divergence)
  - `fidelity_reports` table populated with per-page scores + structured issue lists
  - The total Phase E wall-clock stays within the 2–3 min budget

**Risks:**
- **Pixel-diff is too coarse** — fonts render slightly differently in headless Chromium vs. real browsers, producing spurious diffs that all then go to expensive vision LLM scoring. Mitigation: tune the threshold empirically; explore SSIM (structural similarity) as a less font-sensitive alternative if pixelmatch produces too many false positives.
- **Vision LLM cost overruns** — every page goes to vision scoring if the threshold is too sensitive. Mitigation: hard cap on vision calls per build (e.g. max 15 pages); the rest are reported as "high pixel diff, not LLM-scored" with a manual review prompt.

**Handoff prompt for Stage 5 sub-plan:**

> Read [`docs/saas-v2-component-pipeline.md`](../../saas-v2-component-pipeline.md) §4 Phase E, §6.5. Read [`apps/web/lib/ai/preview-renderer.ts`](../../../apps/web/lib/ai/preview-renderer.ts) for the existing vision-capable Sonnet 4.6 pattern (it's not vision today but the API surface is the same). Read the Stage 1 sub-plan output (whatever Playwright module landed there) for the reusable infrastructure.
>
> Write a TDD-grained plan at `docs/superpowers/plans/2026-05-25-saas-v2-phase-e-verify.md`. Cover screenshot capture against a deployed URL, the pixel-diff library choice (pixelmatch vs. SSIM — recommend trying pixelmatch first), the vision scoring with structured output via Zod, persistence to `fidelity_reports`, and a smoke test against the Two Roads pilot deployment.

---

## Stage 6 — Phase F: Review + Publish gate

**Goal:** Surface the per-page fidelity reports in a review UI that the agency must walk through before publish. Wire per-page approve / per-component regenerate actions.

**Deliverables:**
- New page route: `app/(app)/projects/[id]/builds/[buildId]/review/page.tsx` — the review surface
- New components: `components/build-review/site-review-table.tsx`, `page-comparison.tsx`, `regenerate-component-action.tsx`
- New server actions: `lib/actions/build-review.ts` — `approvePageAction`, `requestComponentRegenAction`, `publishBuildAction`
- New Inngest worker: `lib/inngest/functions/regenerate-component.ts` — handles single-component regeneration triggered from the review screen; reuses Stage 2's `generate-block-component` module
- Worker: `lib/inngest/functions/publish-build.ts` — promotes a `deployments` row from preview → production (sets the project's production URL to the build's preview URL); blocked by app logic until all pages are approved or explicitly approved-with-issues

**Success criteria:**
- A user can navigate to a completed build's review screen and see every page with source + generated thumbnails side by side
- Per-page approve action moves the row to `approved`
- Per-component regen action triggers a single-component regeneration that produces a new build_id (re-uses cached blocks for unaffected pages) and routes the user to the new build's review screen on completion
- Publish action is disabled until every page is approved (or explicitly approved-with-issues)
- Publish action successfully promotes the preview URL to production (project's `production_url` field) and updates the project status

**Risks:**
- **Regenerate-one-component triggers a full Stage 3 + Stage 4 re-emit** — this is the right behavior (consistency requires it) but the UX must communicate the 2–3 min wait. Mitigation: surface the regen progress on the review screen with the same Inngest-step-visibility pattern as the main build.
- **Approved-with-issues record-keeping** — if a flagged page is published with an explicit override, the SaaS should track who overrode and when, for future "did agencies trust the AI too much" analysis. Mitigation: add an `approval_override` field on `fidelity_reports` with user_id + timestamp.

**Handoff prompt for Stage 6 sub-plan:**

> Read [`docs/saas-v2-component-pipeline.md`](../../saas-v2-component-pipeline.md) §4 Phase F, §6.6. Read [`docs/jab-brand.md`](../../jab-brand.md) — the review surface lands in the authenticated product chrome and must follow the JAB dark brand (palette, typography, tone) per the brand guardrail in CLAUDE.md.
>
> Read the existing site-detail page at [`apps/web/app/(app)/projects/[id]/page.tsx`](../../../apps/web/app/(app)/projects/[id]/page.tsx) for the pattern. Read [`apps/web/lib/actions/onboarding.ts`](../../../apps/web/lib/actions/onboarding.ts) for the existing server-action style.
>
> Write a TDD-grained plan at `docs/superpowers/plans/2026-05-25-saas-v2-phase-f-review.md`. Cover the review-screen UI, server actions, the regen-single-component worker, the publish gate, and a Playwright UI test that walks the full review → regen → re-review → publish flow.

---

## Stage 7 — Orchestration + UX polish

**Goal:** Tie the six phases together into a single user-triggered `buildSite` flow with progressive-disclosure UX. Polish the wait-state to match the §5 timeline in the design doc.

**Deliverables:**
- New top-level Inngest workflow: `lib/inngest/functions/build-site.ts` — dispatches Phase A → B → C → D → E in sequence (with Phase B's homepage-first ordering producing the intermediate Phase C₁ deploy)
- New page route: `app/(app)/projects/[id]/builds/[buildId]/progress/page.tsx` — the live build progress surface (per §5)
- Real-time progress UI: streams Inngest step events to the client via Supabase Realtime (or polling fallback) for the timeline display
- Surface the "homepage ready" milestone as an in-progress clickable link
- New server action: `triggerBuildAction` — gated by tenant concurrency + plan limits (wires Stage 0's preconditions to the build trigger)
- Sunset: delete `regenerateHomepage` worker (was deferred from Stage 0 to let parallel work continue), remove `lib/jab/scaffold.ts` v1 (if Stage 3 chose the parallel-route option)

**Success criteria:**
- Sean (or an internal pilot agency) can take a fresh connected WP project, click "Build site," and end up at a published live site within 10–13 minutes
- The progress screen accurately reflects each phase's state in real-time
- The intermediate "homepage preview ready" milestone appears at ~T+4–5 minutes and is clickable
- The fidelity report at T+10 is meaningful (real per-page scores, not all 1.0 or all 0.5)
- A Loom recording of the end-to-end flow can serve as the Two Roads pilot demo asset (the original Two Roads Day 10 deliverable from CLAUDE.md)

**Risks:**
- **Real-time progress flake** — Inngest event → DB → realtime → UI is a fragile chain. Mitigation: polling fallback at 2s interval if the realtime channel doesn't subscribe within 5s.
- **Concurrency under multiple agencies** — Phase A's Playwright run, Phase B's parallel LLM calls, and Phase D's `next build` all compete for worker resources. Mitigation: per-tenant single-build serialization + cross-tenant concurrency limits set per the deploy infrastructure.

**Handoff prompt for Stage 7 sub-plan:**

> Read [`docs/saas-v2-component-pipeline.md`](../../saas-v2-component-pipeline.md) §5 (Progressive disclosure UX). Read this roadmap's Stage 7 section. Read the existing wait-state pattern in [`apps/web/components/`](../../../apps/web/components/) if any progress-surface conventions have landed.
>
> Write a TDD-grained plan at `docs/superpowers/plans/2026-05-25-saas-v2-phase-7-orchestration.md`. Cover the `buildSite` Inngest workflow that chains Phases A–E, the real-time progress UI, the homepage-ready intermediate-link affordance, sunset of `regenerateHomepage` and v1 scaffold, and a full end-to-end smoke test against the Two Roads pilot.

---

## Dependency graph

```
Stage 0 (teardown + schema)
  │
  ├──► Stage 1 (Phase A: Discovery)
  │       │
  │       └──► Stage 2 (Phase B: Components) ────┐
  │                                                │
  │       (Stage 2 partial unblocks Stage 3 & 4)   │
  │                                                ▼
  │           ┌─► Stage 3 (Phase C: Compose & Shell) ┐
  │           │                                       │
  │           └─► Stage 4 (Phase D: Build & Deploy) ──┤
  │                                                   │
  │                                Stage 5 (Phase E: Verify)
  │                                                   │
  │                                Stage 6 (Phase F: Review + Publish)
  │                                                   │
  └────────────────────────────────► Stage 7 (Orchestration + UX)
```

Notes:
- Stages 3 and 4 can be worked in parallel by separate engineers once Stage 2 has produced *any* valid component output (a single working component is enough to exercise the scaffold + build path).
- Stage 5 needs a real Stage 4 deployment to test against. Its development can begin against any deployed Next.js site (doesn't have to be a JAB-generated one) using a placeholder fidelity comparison, then swap in the real source screenshots once Stage 1 + 4 are integrated.
- Stage 6 needs Stage 5's outputs but the UI can be scaffolded against mocked fidelity reports during early development.

---

## First move

The pragmatic place to start is **Stage 0**, because:
1. It unblocks every subsequent stage
2. The teardown is self-contained — no LLM work, no architectural ambiguity
3. The schema changes are the single source of truth that every later stage builds on
4. It surfaces the "preview drop" decision early — if Sean flips on that, the entire roadmap re-shapes and we want to know now

Dispatch a fresh session with the Stage 0 handoff prompt to produce `docs/superpowers/plans/2026-05-25-saas-v2-phase-0-teardown.md`, then execute it.

**Parallel pre-work (recommended, while Stage 0 sub-plan is being written):**
- Sean: confirm preview drop (Decision #1 in design doc §10)
- Sean: review proposed tier-assignment seed list (Decision #2)
- Sean: confirm pixel-diff threshold + fidelity acceptance floor defaults (Decision #3)
- Engineering: spike on Playwright-in-Inngest viability (Decision #5) — this is the single highest-risk infrastructure question across the whole roadmap, worth de-risking before Stage 1's sub-plan is written

---

## Risks + open questions

Carried over from design doc §10 — these need answers before the corresponding stages can finalize:

| Risk / question | Affects | Owner | Status |
|---|---|---|---|
| Confirm preview drop | Stage 0 framing | Sean | Open — assumed confirmed in this roadmap |
| Tier-assignment heuristics seed list | Stage 1 (writes inventory tiers) + Stage 2 (reads them) | Sean | Open — propose seed list with Stage 1 sub-plan |
| Pixel-diff threshold + fidelity floor | Stage 5 + Stage 6 | Sean | Open — propose defaults with Stage 5 sub-plan |
| DeployProvider implementation choice | Stage 4 | Sean | Open — Vercel for v1 is recommended in `hosting.md`; Cloudflare adapter timing open |
| Playwright runtime (Inngest vs dedicated worker) | Stage 1 + Stage 5 | Engineering | Open — pre-spike before Stage 1 sub-plan |
| Component cache strategy for regen | Stage 6 (regen affects what's recomputed vs reused) | Engineering | Open — defer to Stage 6 sub-plan |

---

## What to do when this roadmap goes stale

Edit it. The shape of v1 will shift as evidence comes in from each stage's first execution. If a stage's deliverables change materially, update the stage's section and re-issue the handoff prompt for any unwritten sub-plans. Mark superseded sections with a strike or a callout note (mirror the pattern used in `saas-mvp-transition.md`).
