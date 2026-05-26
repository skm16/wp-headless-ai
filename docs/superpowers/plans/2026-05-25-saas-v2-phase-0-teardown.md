# JAB SaaS v2 — Stage 0 (Teardown + Schema-Prep) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tear down the anonymous `/preview` path, drop the dead `preview_html` columns and `anonymous_previews` table, decommission the scrape-agent **content pass** (keep the design pass for one-shot design-token extraction), land a single migration that adds the five v2 tables (`site_builds`, `deployments`, `block_inventory`, `page_inventory`, `fidelity_reports`) including the cost-telemetry columns Stage 2 will write, harden `connectWpAction` so a successful manifest probe + plugin v0.6.0+ detection are a hard precondition for onboarding completion, and reshape the onboarding wizard's copy + flow around "ready to build" instead of "preview ready."

**Architecture:** Two-pronged structural change. (A) **Subtraction:** remove every preview-only artifact (route, server actions, Inngest worker, library module, marketing CTAs, signup promote helper, prune cron entry, DB columns, DB table) in a grep-verified sweep. (B) **Addition:** one new migration `0014_saas_v2_schema.sql` introducing five tenant-scoped tables (`site_builds`, `deployments`, `block_inventory` with full cost-telemetry columns per design doc §6.4 + §6.7, `page_inventory`, `fidelity_reports`), all with matching Drizzle definitions in `lib/db/schema.ts` and tenant-isolation tests appended to `scripts/test-tenant-isolation.sql`. The Stage 0 surface contract: a project that completes onboarding lands in `status = 'ready'` with `manifest IS NOT NULL`, with **no** preview HTML side effects, and surfaces the discovered post-type / content-type count as the new wow moment.

**Tech Stack:** TypeScript 5 (strict), Next.js 15 App Router, Drizzle ORM (Postgres), Supabase (RLS + service role), Inngest, `@anthropic-ai/sdk`, `@jab/core` MCP client, Zod, pnpm. Design-doc reference: [`docs/saas-v2-component-pipeline.md`](../../saas-v2-component-pipeline.md). Roadmap: [`docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md`](./2026-05-25-saas-v2-roadmap.md).

---

## File Structure

**Created (new):**
- `apps/web/drizzle/migrations/0014_saas_v2_schema.sql` — destructive drop of preview columns + table, plus five new tables with full RLS policies. Single migration so the schema transition is atomic.

**Modified:**
- `apps/web/lib/db/schema.ts` — remove `anonymousPreviews` table export, remove `previewHtml`, `previewHtmlStatus`, and `usage` columns from `projects`, add five new tables with Drizzle definitions matching the SQL.
- `apps/web/lib/actions/onboarding.ts` — `connectWpAction` becomes hard-precondition; `completeOnboardingAction` no longer touches preview columns or dispatches `project/homepage.requested`; `regenerateHomepageAction` is deleted.
- `apps/web/components/onboarding-wizard.tsx` — copy + flow reshape: no "preview" wording in steps, finish-step shows post-connect summary ("We found N pages across M post types"), the `aside` slot stops accepting `PreviewFrame`, the final step copy ends with "ready to build."
- `apps/web/app/(app)/projects/[id]/onboard/page.tsx` — drop `preview_html` selection + `previewHtml` prop pass-through; drop the redirect-on-ready logic stays intact.
- `apps/web/app/(app)/projects/[id]/onboard/onboarding-wizard-client.tsx` — drop the `PreviewFrame` aside, drop `previewHtml` prop; no other callback change.
- `apps/web/app/(app)/projects/[id]/page.tsx` — strip `preview_html`, `preview_html_status` from the project select; remove `HeroPreview`, `RegeneratingPanel`, `RegenerationFailedBanner`, `RegenerateButton` blocks; replace the "Homepage preview" hero with a "Ready to build" panel that surfaces the post-type catalog from `manifest`.
- `apps/web/app/api/inngest/route.ts` — drop `scrapePreview` + `regenerateHomepage` registrations; keep `extractProjectDesign` (now design-pass-only behaviorally — actual scoping happens in step where `scrape-agent.ts` is gutted).
- `apps/web/lib/ai/scrape-agent.ts` — remove `runContentPass`, content-pass fallback, `contentMarkdown` field on `ScrapeAgentResult`, and the parallel `Promise.allSettled` orchestrator's content branch; rename `runScrapeAgent` to `runDesignTokenScrape`; downstream `extractProjectDesign` updated to consume the new signature.
- `apps/web/lib/inngest/functions/extract-project-design.ts` — call site updated for the renamed `runDesignTokenScrape`; the worker's other behavior (capture-assets, persist) is unchanged.
- `apps/web/middleware.ts` — drop `/preview` from `PUBLIC_ROUTES`.
- `apps/web/components/marketing-chrome.tsx` — rewrite both `/preview` links: header "Try it free" → `/sign-up`, footer "Try it free" → `/pricing`.
- `apps/web/app/page.tsx` — Hero CTA "/preview" → "/sign-up"; supporting copy under it updated to match.
- `apps/web/app/pricing/page.tsx` — `ClosingCta` "/preview" → "/sign-up".
- `apps/web/app/(app)/dashboard/page.tsx` — empty-state CTA "/preview" → "/projects/new"; copy reshaped to drop "preview" wording.
- `apps/web/components/projects-list-view.tsx` — default `previewHref` removed; empty-state CTA copy reshaped to "Connect your first client site"; copy + steps no longer mention preview.
- `apps/web/components/onboarding-wizard.tsx` props — `previewHtml` aside support gone; `initialContentTypes` and `initialOwnership` stay (used at resume).
- `apps/web/app/auth/callback/route.ts` — drop the `promoteAnonymousPreviewIfPresent` call; route lands users at `next` unconditionally.
- `apps/web/app/(auth)/sign-in/sign-in-form.tsx` — drop the `promoteAnonymousPreviewIfPresent` import + call; `router.replace(next)` after auth succeeds.
- `apps/web/app/api/cron/prune/route.ts` — drop the `anonymous_previews` delete branch + its log line; keep `rate_limits` pruning.
- `apps/web/scripts/test-tenant-isolation.sql` — append isolation tests for the five new tables.

**Deleted (entire file):**
- `apps/web/app/preview/page.tsx`
- `apps/web/app/preview/preview-flow.tsx`
- `apps/web/lib/inngest/functions/scrape-preview.ts`
- `apps/web/lib/inngest/functions/regenerate-homepage.ts`
- `apps/web/lib/ai/preview-renderer.ts`
- `apps/web/lib/actions/preview.ts`
- `apps/web/lib/actions/promote-preview.ts`
- `apps/web/lib/ai/scrape-prompts.ts` — only the **content-system + content-user** exports are used by the now-dead content pass; the design-system + design-user prompts move into `scrape-agent.ts` (extracted in Task 4 below) so the file can be deleted whole. (Verified: no other importer.)
- `apps/web/app/preview/` directory itself (empty after the above two files leave).

**Untouched (deliberate):**
- `INTENT_BRIEFS`, the intent-picker UI, `projects.intent` column — per decision #2, Refresh/Reimagine code paths stay intact in Stage 0; they are dead-end in v1 but their teardown belongs to Stage 2.
- `lib/ai/render-prompts.ts` — referenced by `preview-renderer.ts` (deleted) and nothing else; we **do not** delete it in Stage 0 because Stage 2's component-shaped prompts will land in its place. Leaving the file means the import graph still resolves cleanly while every other v1 reference disappears. (A grep at the end of Stage 0 will confirm zero `import.*render-prompts` remain — if so, leaving the file is dead-weight that Stage 2's first task will pick up.)
- `lib/ai/scrape-design-deterministic.ts`, `scrape-fetch.ts`, `scrape-extract.ts`, `scrape-errors.ts`, `text-utils.ts`, `sanitize.ts`, `asset-capture.ts`, `validators.ts`, `model.ts`, `client.ts`, `ssrf-guard.ts` — all still used by `extractProjectDesign` (the design-pass-only path).
- `lib/jab/probe.ts`, `lib/jab/content-types-from-manifest.ts`, `lib/jab/fetch-content-types.ts`, `lib/jab/ability-client.ts` — all still used by `connectWpAction` and Stage 1 (Discovery) consumers.
- `migration 0007_promote_preview.sql`'s `promote_anonymous_preview` Postgres function — dropped explicitly inside the new migration's destructive block (the table it referenced is going, the function would dangle).

---

## Task 1: Land the new migration `0014_saas_v2_schema.sql`

**Files:**
- Create: `apps/web/drizzle/migrations/0014_saas_v2_schema.sql`

**★ Why one combined migration ─**
Destructive drops and the new tables share a single transactional boundary. A two-migration split (drop first, add second) leaves a window where a fresh migration run on a clean database executes the drops against absent objects — `IF EXISTS` carries that case fine, but interleaved drops + creates inside one migration also matches the destructive-and-additive shape of every other v2 schema change to come, so the migration log stays legible.
`────────────────────────────────────────────────`

- [ ] **Step 1: Create the migration file**

Write the full SQL below to `apps/web/drizzle/migrations/0014_saas_v2_schema.sql`:

```sql
-- ============================================================================
-- 0014_saas_v2_schema.sql — SaaS v2 component-pipeline schema
-- ----------------------------------------------------------------------------
-- Stage 0 of the v2 roadmap (see docs/superpowers/plans/2026-05-25-saas-v2-
-- roadmap.md). Two halves, executed in one transaction:
--
--   PART A — DESTRUCTIVE TEARDOWN of the preview path.
--   PART B — ADDITIVE creation of the five v2 tables.
--
-- Destructive by design. Pre-pivot dev/staging projects carrying preview_html
-- and anonymous_previews data are NOT preserved — those flows are gone, and
-- the data only meant something to the wow-preview pipeline being retired.
-- This is dev/staging data only.
--
-- Foreign-key cascade story:
--   - anonymous_previews.promoted_to_project_id → projects.id (deferrable FK
--     from migration 0010). Dropping anonymous_previews first removes the FK
--     by association — no orphaned constraint.
--   - promote_anonymous_preview() function from migration 0007 references
--     both tables; we DROP FUNCTION IF EXISTS it explicitly to avoid a
--     dangling reference to anonymous_previews.
-- ============================================================================

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ PART A — DESTRUCTIVE TEARDOWN                                            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- The atomic claim-and-create function from migration 0007 only meant
-- something while the anonymous_previews table existed. Drop it first so the
-- table drop below doesn't leave a function referencing a missing relation.
DROP FUNCTION IF EXISTS public.promote_anonymous_preview(UUID, UUID, TEXT, TEXT);

-- Anonymous previews table — entire pre-auth funnel went away.
DROP TABLE IF EXISTS public.anonymous_previews;

-- The wow-preview columns on projects. preview_html (TEXT) carried the wow
-- HTML snapshot; preview_html_status was the regen state machine; usage was
-- per-pass token telemetry tied to the regenerate-homepage worker. All
-- three are dead with the preview path retired.
ALTER TABLE public.projects
  DROP COLUMN IF EXISTS preview_html,
  DROP COLUMN IF EXISTS preview_html_status,
  DROP COLUMN IF EXISTS usage;

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ PART B — NEW TABLES                                                      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ----------------------------------------------------------------------------
-- site_builds — one row per build attempt (Phases A → D execution record).
-- ----------------------------------------------------------------------------
-- Status machine:
--   queued       — orchestrator dispatched; no worker started yet
--   discovering  — Phase A in flight (inventory + screenshots + design tokens)
--   components   — Phase B in flight (per-block-type component generation)
--   composing    — Phase C in flight (scaffold + dispatcher emit)
--   building     — Phase D in flight (next build + Vercel deploy)
--   verifying    — Phase E in flight (screenshot diff + fidelity scoring)
--   ready        — all phases complete, awaiting Phase F review
--   failed       — any phase threw fatally (error captured in `error_text`)
--   cancelled    — operator cancelled mid-flight
--
-- A new build is always strictly tenant-scoped through project_id → projects.
-- The Inngest worker dispatch carries (project_id, build_id, tenant_id) so
-- service-role writes can defence-in-depth filter by tenant_id too.
-- ----------------------------------------------------------------------------
CREATE TABLE public.site_builds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'discovering', 'components', 'composing',
      'building', 'verifying', 'ready', 'failed', 'cancelled'
    )),
  -- The phase that produced the failure, if any. NULL otherwise.
  failed_phase TEXT
    CHECK (failed_phase IS NULL OR failed_phase IN (
      'discover', 'components', 'compose', 'build', 'verify'
    )),
  error_text TEXT,
  -- Counts populated as each phase completes — surfaced in the progress UI
  -- without needing aggregation queries against block_inventory etc.
  page_count INTEGER,
  block_type_count INTEGER,
  component_count INTEGER,
  -- Average fidelity score across all pages in this build — populated by
  -- Phase E. NULL until verification finishes. Range [0.0, 1.0].
  fidelity_avg NUMERIC(4,3)
    CHECK (fidelity_avg IS NULL OR (fidelity_avg >= 0.0 AND fidelity_avg <= 1.0)),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX site_builds_project_id_idx ON public.site_builds (project_id);
CREATE INDEX site_builds_status_idx ON public.site_builds (status);

COMMENT ON TABLE public.site_builds IS
  'One row per build attempt. Workers write via service-role; tenant members read via RLS scoped through project_id.';

-- ----------------------------------------------------------------------------
-- deployments — preview + production URL tracking, one row per deploy.
-- ----------------------------------------------------------------------------
-- A build can produce many deployments over its lifetime: the immediate
-- post-build preview deploy, a publish-promotion that moves a preview to
-- production, and any rollback-to-prior-build affordance Phase F adds later.
-- environment is the strong discriminator; status is the deploy lifecycle.
-- ----------------------------------------------------------------------------
CREATE TABLE public.deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_build_id UUID NOT NULL REFERENCES public.site_builds(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  environment TEXT NOT NULL
    CHECK (environment IN ('preview', 'production')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'failed', 'superseded')),
  url TEXT,
  -- Provider-specific deployment id (e.g. Vercel's deployment uid). Useful
  -- for log-fetching + cancel API calls. NULL while pending.
  provider TEXT
    CHECK (provider IS NULL OR provider IN ('vercel', 'cloudflare')),
  provider_deployment_id TEXT,
  build_log_excerpt TEXT,
  promoted_from_deployment_id UUID REFERENCES public.deployments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at TIMESTAMPTZ
);

CREATE INDEX deployments_site_build_id_idx ON public.deployments (site_build_id);
CREATE INDEX deployments_project_id_idx ON public.deployments (project_id);
CREATE INDEX deployments_env_status_idx ON public.deployments (environment, status);

COMMENT ON TABLE public.deployments IS
  'Preview + production URL tracking. site_build_id ties back to the build that produced this artifact.';

-- ----------------------------------------------------------------------------
-- block_inventory — per-build catalog of unique block types found in the WP
-- site, with tier assignment + cost telemetry written by Stage 2.
-- ----------------------------------------------------------------------------
-- Populated by Phase A's inventory worker. One row per unique block_name
-- within a single build. Stage 2 (Phase B component generation) reads tier +
-- attr_samples + computed_styles and writes back the cost-telemetry columns
-- as each per-block-type LLM call completes.
--
-- The cost-telemetry columns (model_used, provider_used, *_tokens, compile_*)
-- are added in Stage 0 — not in a follow-up migration — to keep Stage 2's
-- execution unblocked and to surface a single coherent block-inventory shape
-- to Phase F surfaces that join on it.
-- ----------------------------------------------------------------------------
CREATE TABLE public.block_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_build_id UUID NOT NULL REFERENCES public.site_builds(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  block_name TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  -- Slugs of pages this block appears on. Capped by application code to keep
  -- the array bounded — typically ≤50 entries even for the most-reused block.
  page_slugs TEXT[] NOT NULL DEFAULT '{}',
  -- Sample attrs payloads (1..N) for the LLM to learn the attribute surface.
  -- Application caps to ~5 distinct shapes per row.
  attr_samples JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Aggregated computed CSS per design doc §6.1. Shape:
  --   { median: {prop: value}, range: {prop: [min, max]}, viewports: {...} }
  computed_styles JSONB,
  -- Stage 1 assigns one of: visual | standard | trivial | passthrough.
  tier TEXT
    CHECK (tier IS NULL OR tier IN ('visual', 'standard', 'trivial', 'passthrough')),

  -- ── Cost telemetry — written by Stage 2 per design doc §6.4 + §6.7 ──
  -- The model + provider the component-generation LLM call landed on.
  -- Both NULL for passthrough blocks (no LLM call).
  model_used TEXT,
  provider_used TEXT
    CHECK (provider_used IS NULL OR provider_used IN ('anthropic', 'google', 'openai')),
  -- Cached input tokens (Anthropic prompt-caching read) vs. uncached input.
  input_tokens_cached INTEGER,
  input_tokens_uncached INTEGER,
  output_tokens INTEGER,
  -- Per-component compile gate outcome. compile_status one of:
  --   ok        — first or retried compile succeeded
  --   failed    — both attempts failed → fell back to passthrough
  --   skipped   — never compiled (passthrough tier or generation skipped)
  compile_status TEXT
    CHECK (compile_status IS NULL OR compile_status IN ('ok', 'failed', 'skipped')),
  compile_attempt_count SMALLINT
    CHECK (compile_attempt_count IS NULL OR (compile_attempt_count >= 0 AND compile_attempt_count <= 5)),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX block_inventory_site_build_id_idx ON public.block_inventory (site_build_id);
CREATE INDEX block_inventory_project_id_idx ON public.block_inventory (project_id);
-- Unique block-name-per-build — two rows for `core/heading` in the same build
-- would be a worker bug; the unique constraint forces the upsert path.
CREATE UNIQUE INDEX block_inventory_build_block_name_idx
  ON public.block_inventory (site_build_id, block_name);

COMMENT ON TABLE public.block_inventory IS
  'Per-build catalog of unique block types. Phase A populates discovery columns; Phase B writes cost-telemetry columns per design doc §6.4 + §6.7.';

-- ----------------------------------------------------------------------------
-- page_inventory — per-build list of pages to render.
-- ----------------------------------------------------------------------------
-- Phase A enumerates every public page + post + CPT entry via the plugin's
-- ability roster. One row per page, keyed by slug + post_type (a single slug
-- can collide across post types — e.g. /about as both `page` and `cpt_X` —
-- so the unique constraint pairs them).
-- ----------------------------------------------------------------------------
CREATE TABLE public.page_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_build_id UUID NOT NULL REFERENCES public.site_builds(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  post_type TEXT NOT NULL,
  title TEXT,
  -- The URL the catch-all route should resolve to. Persisted so a downstream
  -- regen doesn't have to re-derive routing.
  route_path TEXT NOT NULL,
  -- Counts of blocks on this page — useful for Phase F sorting + ordering.
  block_count INTEGER NOT NULL DEFAULT 0,
  -- Per-page screenshot bucket paths. Shape:
  --   { source: { "1440": "...", "768": "...", "375": "..." } }
  source_screenshot_paths JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Indicates whether this page is rendered statically (generateStaticParams)
  -- or via dynamic catch-all. Defaults dynamic; Stage 3 sets static for top-N.
  rendering TEXT NOT NULL DEFAULT 'dynamic'
    CHECK (rendering IN ('static', 'dynamic')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX page_inventory_site_build_id_idx ON public.page_inventory (site_build_id);
CREATE INDEX page_inventory_project_id_idx ON public.page_inventory (project_id);
CREATE UNIQUE INDEX page_inventory_build_slug_type_idx
  ON public.page_inventory (site_build_id, slug, post_type);

COMMENT ON TABLE public.page_inventory IS
  'Per-build list of pages to render. Phase A captures source screenshots; Phase D references for route emission; Phase E references for diff capture.';

-- ----------------------------------------------------------------------------
-- fidelity_reports — per-page-per-build fidelity score + structured issues.
-- ----------------------------------------------------------------------------
-- Phase E writes one row per page that was scored (pixel-diff or vision-LLM).
-- Pages that pixel-diffed below threshold get a score-only row (no issues).
-- Pages flagged by pixel diff get a vision-LLM scoring + issues list.
-- ----------------------------------------------------------------------------
CREATE TABLE public.fidelity_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_build_id UUID NOT NULL REFERENCES public.site_builds(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  page_inventory_id UUID NOT NULL REFERENCES public.page_inventory(id) ON DELETE CASCADE,
  -- 0.0 (worst) → 1.0 (best). NULL if the page wasn't scored.
  score NUMERIC(4,3)
    CHECK (score IS NULL OR (score >= 0.0 AND score <= 1.0)),
  -- Pixel-divergence ratio from pixelmatch. Always present once Phase E ran.
  pixel_diff NUMERIC(6,5),
  -- Phase E's structured issue list. Shape:
  --   [{ block_name: string, severity: 'low'|'medium'|'high', description: string }]
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Per-page approval state for Phase F's pre-publish gate.
  approval_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending', 'approved', 'approved_with_issues', 'rejected')),
  approved_by_user_id UUID,
  approved_at TIMESTAMPTZ,
  -- Generated screenshot bucket paths captured in Phase E. Mirrors
  -- page_inventory.source_screenshot_paths shape.
  generated_screenshot_paths JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX fidelity_reports_site_build_id_idx ON public.fidelity_reports (site_build_id);
CREATE INDEX fidelity_reports_project_id_idx ON public.fidelity_reports (project_id);
CREATE UNIQUE INDEX fidelity_reports_build_page_idx
  ON public.fidelity_reports (site_build_id, page_inventory_id);

COMMENT ON TABLE public.fidelity_reports IS
  'Per-page-per-build fidelity score + structured issue list. Workers write via service-role; tenant members read + approve via RLS scoped through project_id.';

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ PART C — RLS                                                             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Every new table is tenant-scoped through project_id → projects.tenant_id.
-- Pattern mirrors generation_jobs (migration 0004): SELECT + INSERT via RLS;
-- UPDATE + DELETE reserved for service-role workers.
--
-- The exception: fidelity_reports gets an UPDATE policy so tenant members
-- can record per-page approvals from the Phase F review UI. Workers writing
-- non-approval columns (score, issues, screenshots) still go through service-
-- role — the RLS UPDATE policy only matters for the user-facing approve path.

ALTER TABLE public.site_builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.block_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.page_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fidelity_reports ENABLE ROW LEVEL SECURITY;

-- ── site_builds ──
CREATE POLICY "site_builds_tenant_select"
  ON public.site_builds FOR SELECT
  USING (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
  );

CREATE POLICY "site_builds_tenant_insert"
  ON public.site_builds FOR INSERT
  WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
  );

-- ── deployments ──
CREATE POLICY "deployments_tenant_select"
  ON public.deployments FOR SELECT
  USING (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
  );

-- No INSERT policy — deployments are always written by the build worker
-- (service-role). Same posture as generation_jobs.

-- ── block_inventory ──
CREATE POLICY "block_inventory_tenant_select"
  ON public.block_inventory FOR SELECT
  USING (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
  );

-- ── page_inventory ──
CREATE POLICY "page_inventory_tenant_select"
  ON public.page_inventory FOR SELECT
  USING (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
  );

-- ── fidelity_reports ──
CREATE POLICY "fidelity_reports_tenant_select"
  ON public.fidelity_reports FOR SELECT
  USING (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
  );

-- UPDATE policy — tenant members can record per-page approvals from Phase F.
-- The WITH CHECK restricts which columns matter for the boundary: project_id
-- can't be swapped in an update (only the approval columns are user-mutable
-- in practice; service-role bypasses for everything else).
CREATE POLICY "fidelity_reports_tenant_update"
  ON public.fidelity_reports FOR UPDATE
  USING (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
  )
  WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
  );

-- ============================================================================
-- End 0014_saas_v2_schema.sql
-- ============================================================================
```

- [ ] **Step 2: Verify the migration file exists**

Run:

```bash
ls -la apps/web/drizzle/migrations/0014_saas_v2_schema.sql
```

Expected: file present, ~12-13 KB.

- [ ] **Step 3: Apply the migration via Supabase MCP**

Apply the migration to the dev project. Use the Supabase MCP tool `apply_migration`:

```
name: 0014_saas_v2_schema
query: <paste the full contents of apps/web/drizzle/migrations/0014_saas_v2_schema.sql>
```

Expected: MCP returns success. The five new tables now exist in the live dev project.

- [ ] **Step 4: Sanity-check the dropped columns are gone**

Use the Supabase MCP `execute_sql` tool with this query:

```sql
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'projects'
  AND column_name IN ('preview_html', 'preview_html_status', 'usage')
ORDER BY column_name;
```

Expected: zero rows.

- [ ] **Step 5: Sanity-check the new tables exist with RLS enabled**

Use the Supabase MCP `execute_sql` tool with this query:

```sql
SELECT table_name, row_security
FROM information_schema.tables t
JOIN pg_tables pt ON pt.tablename = t.table_name
WHERE t.table_schema = 'public'
  AND t.table_name IN ('site_builds','deployments','block_inventory','page_inventory','fidelity_reports')
ORDER BY t.table_name;
```

Run a follow-up to confirm RLS is on:

```sql
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('site_builds','deployments','block_inventory','page_inventory','fidelity_reports')
ORDER BY relname;
```

Expected: all five tables present; `relrowsecurity = true` for each.

- [ ] **Step 6: Commit**

```bash
git add apps/web/drizzle/migrations/0014_saas_v2_schema.sql
git commit -m "feat(web): saas v2 schema — drop preview path, add build pipeline tables (0014)"
```

---

## Task 2: Sync the Drizzle schema (`lib/db/schema.ts`)

**Files:**
- Modify: `apps/web/lib/db/schema.ts`

**★ Why the schema TS must drift with the SQL ─**
The schema file is the type source-of-truth for app-layer Supabase queries via `.from("...").select(...)` chains. If we leave `previewHtml` on `projects` in TS while the SQL has dropped it, every consumer that references it builds clean and crashes at runtime against the missing column. Drift is silent; this step closes it.
`────────────────────────────────────────────────`

- [ ] **Step 1: Open `apps/web/lib/db/schema.ts` and replace the `projects` definition body**

Replace the `projects` table definition (lines 59–115 in the current file) with this exact block. The diff: drop `previewHtml`, `previewHtmlStatus`, `usage`; add `siteBuilds` foreign key implied via the new table; no other change.

```ts
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    clientName: text("client_name"),
    wpUrl: text("wp_url"),
    // 'draft' | 'onboarding' | 'ready' | 'archived'
    status: text("status").notNull().default("draft"),
    wpUsername: text("wp_username"),
    wpAppPasswordEncrypted: bytea("wp_app_password_encrypted"),
    githubRepoFullName: text("github_repo_full_name"),
    githubPatEncrypted: bytea("github_pat_encrypted"),
    manifest: jsonb("manifest"),
    onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
    // Captured-asset paths populated by the design-token extraction worker
    // (extractProjectDesign). NULL until that worker has run.
    logoStoragePath: text("logo_storage_path"),
    faviconStoragePath: text("favicon_storage_path"),
    ogImageStoragePath: text("og_image_storage_path"),
    // Design-extraction output (one-shot at onboarding completion).
    // DesignAnalysis minus the personality block, which lives on its own
    // column. NULL until the post-probe worker completes.
    designTokens: jsonb("design_tokens"),
    personality: jsonb("personality"),
    // Onboarding wizard state. NULL until the corresponding wizard step
    // completes. intent retained per Stage 0 decision #2 — retirement
    // happens in Stage 2 alongside the component-shaped prompts.
    intent: text("intent"),
    contentOwnership: jsonb("content_ownership"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ tenantIdx: index("projects_tenant_id_idx").on(t.tenantId) }),
);
```

- [ ] **Step 2: Delete the `anonymousPreviews` export entirely**

Find the `export const anonymousPreviews = pgTable(...)` block (lines 140–172 in the current file). Delete the whole block (including the leading docblock comment that introduces it on line 132+).

- [ ] **Step 3: Append the five v2 tables**

Add these five table exports at the end of `apps/web/lib/db/schema.ts` (after the existing `generationJobs` definition):

```ts
/**
 * site_builds — one row per build attempt. Mirrors migration 0014.
 *
 * Status machine values are enforced by the SQL CHECK constraint and the
 * client-side union type `SiteBuildStatus`; Drizzle doesn't model CHECKs.
 */
export const siteBuilds = pgTable(
  "site_builds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    failedPhase: text("failed_phase"),
    errorText: text("error_text"),
    pageCount: integer("page_count"),
    blockTypeCount: integer("block_type_count"),
    componentCount: integer("component_count"),
    // NUMERIC(4,3) — stored as string by node-postgres unless cast. We type
    // as string in TS and parse at the call site to avoid floating-point
    // surprises.
    fidelityAvg: text("fidelity_avg"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectIdx: index("site_builds_project_id_idx").on(t.projectId),
    statusIdx: index("site_builds_status_idx").on(t.status),
  }),
);

/**
 * deployments — preview + production URL tracking. Mirrors migration 0014.
 */
export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteBuildId: uuid("site_build_id")
      .notNull()
      .references(() => siteBuilds.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environment: text("environment").notNull(),
    status: text("status").notNull().default("pending"),
    url: text("url"),
    provider: text("provider"),
    providerDeploymentId: text("provider_deployment_id"),
    buildLogExcerpt: text("build_log_excerpt"),
    promotedFromDeploymentId: uuid("promoted_from_deployment_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
  },
  (t) => ({
    siteBuildIdx: index("deployments_site_build_id_idx").on(t.siteBuildId),
    projectIdx: index("deployments_project_id_idx").on(t.projectId),
    envStatusIdx: index("deployments_env_status_idx").on(t.environment, t.status),
  }),
);

/**
 * block_inventory — per-build unique block-type catalog with cost telemetry.
 * Cost-telemetry columns are written by Stage 2 (per design doc §6.4 + §6.7).
 */
export const blockInventory = pgTable(
  "block_inventory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteBuildId: uuid("site_build_id")
      .notNull()
      .references(() => siteBuilds.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    blockName: text("block_name").notNull(),
    occurrenceCount: integer("occurrence_count").notNull().default(0),
    // text[] mapping — drizzle's `text("name").array()` materializes as text[].
    pageSlugs: text("page_slugs").array().notNull().default([]),
    attrSamples: jsonb("attr_samples").notNull().default([]),
    computedStyles: jsonb("computed_styles"),
    tier: text("tier"),
    modelUsed: text("model_used"),
    providerUsed: text("provider_used"),
    inputTokensCached: integer("input_tokens_cached"),
    inputTokensUncached: integer("input_tokens_uncached"),
    outputTokens: integer("output_tokens"),
    compileStatus: text("compile_status"),
    // SMALLINT — drizzle's smallint helper returns number.
    compileAttemptCount: integer("compile_attempt_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteBuildIdx: index("block_inventory_site_build_id_idx").on(t.siteBuildId),
    projectIdx: index("block_inventory_project_id_idx").on(t.projectId),
  }),
);

/**
 * page_inventory — per-build list of pages to render.
 */
export const pageInventory = pgTable(
  "page_inventory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteBuildId: uuid("site_build_id")
      .notNull()
      .references(() => siteBuilds.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    postType: text("post_type").notNull(),
    title: text("title"),
    routePath: text("route_path").notNull(),
    blockCount: integer("block_count").notNull().default(0),
    sourceScreenshotPaths: jsonb("source_screenshot_paths").notNull().default({}),
    rendering: text("rendering").notNull().default("dynamic"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteBuildIdx: index("page_inventory_site_build_id_idx").on(t.siteBuildId),
    projectIdx: index("page_inventory_project_id_idx").on(t.projectId),
  }),
);

/**
 * fidelity_reports — per-page-per-build fidelity score + structured issues.
 */
export const fidelityReports = pgTable(
  "fidelity_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteBuildId: uuid("site_build_id")
      .notNull()
      .references(() => siteBuilds.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageInventoryId: uuid("page_inventory_id")
      .notNull()
      .references(() => pageInventory.id, { onDelete: "cascade" }),
    // NUMERIC stored as string — see siteBuilds.fidelityAvg note.
    score: text("score"),
    pixelDiff: text("pixel_diff"),
    issues: jsonb("issues").notNull().default([]),
    approvalStatus: text("approval_status").notNull().default("pending"),
    approvedByUserId: uuid("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    generatedScreenshotPaths: jsonb("generated_screenshot_paths").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteBuildIdx: index("fidelity_reports_site_build_id_idx").on(t.siteBuildId),
    projectIdx: index("fidelity_reports_project_id_idx").on(t.projectId),
  }),
);
```

- [ ] **Step 4: Run `pnpm tsc` to verify schema-side type-correctness**

```bash
cd apps/web
pnpm tsc --noEmit
```

Expected: there will still be errors elsewhere in the codebase (the dependent files haven't been updated yet — that's Tasks 4+). **Specifically expected errors:** references to `anonymousPreviews`, `previewHtml`, `previewHtmlStatus`, `usage` in the soon-to-be-deleted/updated files. Do **not** try to silence them here — they get fixed when each consumer is updated in the right task below.

Confirm there are **no** new errors inside `lib/db/schema.ts` itself (e.g. mistyped imports, bad column helpers).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/db/schema.ts
git commit -m "feat(web): sync drizzle schema with 0014 — drop preview columns + table, add 5 v2 tables"
```

---

## Task 3: Delete the `/preview` route surface

**Files:**
- Delete: `apps/web/app/preview/page.tsx`
- Delete: `apps/web/app/preview/preview-flow.tsx`
- Delete: `apps/web/app/preview/` directory

- [ ] **Step 1: Grep BEFORE — confirm the route's reach**

```bash
cd apps/web
grep -rn "/preview" app/ components/ lib/ middleware.ts | grep -v "/preview/" | sort
```

Expected: matches in `middleware.ts`, `app/page.tsx`, `app/pricing/page.tsx`, `app/(app)/dashboard/page.tsx`, `components/marketing-chrome.tsx`, `components/projects-list-view.tsx`, `app/(app)/projects/[id]/onboard/page.tsx` (comment only), `app/(app)/projects/[id]/page.tsx` (comment only), `app/(app)/projects/new/page.tsx` (comment only). Several library files comment-reference the route — Tasks 4+ pick those up.

- [ ] **Step 2: Delete the route files**

```bash
cd apps/web
rm app/preview/page.tsx
rm app/preview/preview-flow.tsx
rmdir app/preview
```

(`rmdir` will succeed only if no other files remain in the directory — verify with `ls app/preview` returning "No such file or directory".)

- [ ] **Step 3: Grep AFTER — confirm the route is gone**

```bash
cd apps/web
ls app/preview 2>&1 | head -2
```

Expected: `ls: cannot access 'app/preview': No such file or directory` (or PowerShell equivalent).

- [ ] **Step 4: Commit**

```bash
git add -A apps/web/app/preview
git commit -m "feat(web): remove /preview route + flow client"
```

---

## Task 4: Delete `lib/ai/preview-renderer.ts` + content-pass cleanup in `scrape-agent.ts`

**Files:**
- Delete: `apps/web/lib/ai/preview-renderer.ts`
- Delete: `apps/web/lib/ai/scrape-prompts.ts`
- Modify: `apps/web/lib/ai/scrape-agent.ts`

**★ Why deleting scrape-prompts.ts is safe ─**
The file exports four functions: `getContentSystem`, `buildContentUserPrompt`, `getDesignSystem`, `buildDesignUserPrompt`. The content-* pair is referenced only by the soon-to-be-gone `runContentPass` inside `scrape-agent.ts`. The design-* pair is referenced only by `runDesignPass` — also inside `scrape-agent.ts`. Both call sites live in the same file. Inlining the design prompts into `scrape-agent.ts` while we're rewriting it eliminates a single-call-site dependency.
`────────────────────────────────────────────────`

- [ ] **Step 1: Read the existing scrape-prompts.ts to extract the design-system + design-user prompts**

```bash
cd apps/web
cat lib/ai/scrape-prompts.ts
```

Note the two functions we need to keep: `getDesignSystem()` and `buildDesignUserPrompt(extract)`. Copy their bodies verbatim into the rewritten `scrape-agent.ts` below.

- [ ] **Step 2: Rewrite `apps/web/lib/ai/scrape-agent.ts`**

Replace the entire file with this version. Key changes: content pass + `contentMarkdown` + `models.content` are gone, the design prompts are inlined, and the exported orchestrator is renamed `runDesignTokenScrape` to clarify its purpose:

```ts
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { fetchHtmlSafely, ScrapeFetchError } from "./scrape-fetch";
import { extractFromHtml, type ScrapeExtract } from "./scrape-extract";
import { getModelFor, type AllowedModel } from "./model";
import { pickColors, pickLogo } from "./scrape-design-deterministic";
import { getAnthropicClient } from "./client";

/**
 * Design-token scrape agent. One-shot pass against the WP homepage at
 * onboarding-completion time, captures the brand-design signals the
 * downstream pipeline needs (primary/secondary/accent colors, headline /
 * body typography, logo, button-pair labels, brand personality).
 *
 * Pre-v2 this file also ran a `runContentPass` that summarized the page as
 * markdown for the (now retired) wow-preview renderer. The content pass is
 * gone with the preview path; only the design pass survives.
 *
 * Pipeline:
 *   1. fetchHtmlSafely — SSRF-guarded, size-capped HTTPS GET.
 *   2. extractFromHtml — Cheerio DOM → deterministic signals.
 *   3. Deterministic color + logo pick.
 *   4. One LLM pass — typography + buttonPair + personality.
 *   5. Compose + return.
 */

const MAX_OUTPUT_TOKENS = 4096;

export class ScrapeAgentError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "fetch_failed"
      | "extract_failed"
      | "design_pass_failed"
      | "design_parse_failed",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ScrapeAgentError";
  }
}

function isRetryableOnFallback(err: unknown): boolean {
  return (
    err instanceof ScrapeAgentError && err.code === "design_parse_failed"
  );
}

const FALLBACK_MODEL: AllowedModel = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

const ConfidenceFieldSchema = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    value: value,
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(1),
  });

export const DesignAnalysisSchema = z.object({
  colors: z.object({
    primary: ConfidenceFieldSchema(z.string().regex(/^#[0-9a-fA-F]{6}$/)),
    secondary: ConfidenceFieldSchema(
      z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
    ),
    accent: ConfidenceFieldSchema(
      z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
    ),
  }),
  typography: z.object({
    heading: ConfidenceFieldSchema(z.string().min(1).nullable()),
    body: ConfidenceFieldSchema(z.string().min(1).nullable()),
  }),
  logo: z.object({
    src: z.string().url().nullable(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(1),
  }),
  buttonPair: z.object({
    primary: ConfidenceFieldSchema(z.string().min(1).nullable()),
    secondary: ConfidenceFieldSchema(z.string().min(1).nullable()),
  }),
  personality: z.object({
    tone: ConfidenceFieldSchema(z.string().min(1)),
    energy: ConfidenceFieldSchema(z.enum(["low", "medium", "high"])),
    audience: ConfidenceFieldSchema(z.string().min(1)),
  }),
});

export type DesignAnalysis = z.infer<typeof DesignAnalysisSchema>;

const LlmDesignSubsetSchema = DesignAnalysisSchema.omit({
  colors: true,
  logo: true,
});
type LlmDesignSubset = z.infer<typeof LlmDesignSubsetSchema>;

export interface DesignTokenScrapeResult {
  /** The final URL after redirects. */
  url: string;
  fetchedAt: string;
  byteSize: number;
  extract: ScrapeExtract;
  design: DesignAnalysis;
  usage: { design: Anthropic.Messages.Usage };
  models: { design: AllowedModel };
}

export interface DesignTokenScrapeInput {
  url: string;
  fetchOptions?: Parameters<typeof fetchHtmlSafely>[1];
  label?: string;
}

function getClient(): Anthropic {
  try {
    return getAnthropicClient();
  } catch (err) {
    throw new ScrapeAgentError(
      err instanceof Error ? err.message : String(err),
      "design_pass_failed",
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runDesignTokenScrape(
  input: DesignTokenScrapeInput,
): Promise<DesignTokenScrapeResult> {
  // 1) Fetch
  let fetched: Awaited<ReturnType<typeof fetchHtmlSafely>>;
  try {
    fetched = await fetchHtmlSafely(input.url, input.fetchOptions);
  } catch (err) {
    if (err instanceof ScrapeFetchError) {
      throw new ScrapeAgentError(err.message, "fetch_failed", err);
    }
    throw new ScrapeAgentError(
      `Unexpected fetch error: ${err instanceof Error ? err.message : String(err)}`,
      "fetch_failed",
      err,
    );
  }

  // 2) Extract
  let extract: ScrapeExtract;
  try {
    extract = extractFromHtml(fetched.html, fetched.finalUrl);
  } catch (err) {
    throw new ScrapeAgentError(
      `DOM extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      "extract_failed",
      err,
    );
  }

  // 3) Design pass (deterministic + LLM)
  const designOutcome = await runDesignPass(extract, input.label);

  return {
    url: fetched.finalUrl,
    fetchedAt: new Date().toISOString(),
    byteSize: fetched.byteSize,
    extract,
    design: designOutcome.design,
    usage: { design: designOutcome.usage },
    models: { design: designOutcome.model },
  };
}

// ---------------------------------------------------------------------------
// Design pass
// ---------------------------------------------------------------------------

async function runDesignPass(
  extract: ScrapeExtract,
  label?: string,
): Promise<{ design: DesignAnalysis; usage: Anthropic.Messages.Usage; model: AllowedModel }> {
  const colors = pickColors(extract);
  const logo = pickLogo(extract.images);

  const primary = getModelFor("design");
  let llmResult: { subset: LlmDesignSubset; usage: Anthropic.Messages.Usage; model: AllowedModel };
  try {
    llmResult = await runDesignPassOnce(extract, primary);
  } catch (err) {
    if (isRetryableOnFallback(err) && primary !== FALLBACK_MODEL) {
      const tag = label ? `[scrape-agent ${label}]` : "[scrape-agent]";
      console.warn(
        `${tag} design pass falling back ${primary} → ${FALLBACK_MODEL}: ${err instanceof Error ? err.message : String(err)}`,
      );
      llmResult = await runDesignPassOnce(extract, FALLBACK_MODEL);
    } else {
      throw err;
    }
  }

  return {
    design: { colors, logo, ...llmResult.subset },
    usage: llmResult.usage,
    model: llmResult.model,
  };
}

async function runDesignPassOnce(
  extract: ScrapeExtract,
  model: AllowedModel,
): Promise<{ subset: LlmDesignSubset; usage: Anthropic.Messages.Usage; model: AllowedModel }> {
  const client = getClient();

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: getDesignSystem(),
      messages: [{ role: "user", content: buildDesignUserPrompt(extract) }],
    });
  } catch (err) {
    throw new ScrapeAgentError(
      `Design-pass Anthropic call failed (model=${model}): ${err instanceof Error ? err.message : String(err)}`,
      "design_pass_failed",
      err,
    );
  }

  const fullText = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const jsonStr = extractJsonBlock(fullText);
  if (!jsonStr) {
    throw new ScrapeAgentError(
      `Design-pass response did not include a json code block (stop_reason=${response.stop_reason}). First 200 chars: ${fullText.slice(0, 200)}`,
      "design_parse_failed",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new ScrapeAgentError(
      `Design-pass JSON.parse failed: ${err instanceof Error ? err.message : String(err)}. First 200 chars: ${jsonStr.slice(0, 200)}`,
      "design_parse_failed",
      err,
    );
  }

  const result = LlmDesignSubsetSchema.safeParse(parsed);
  if (!result.success) {
    throw new ScrapeAgentError(
      `Design-pass JSON failed schema validation: ${result.error.message}`,
      "design_parse_failed",
      result.error,
    );
  }

  return { subset: result.data, usage: response.usage, model };
}

function extractJsonBlock(text: string): string | null {
  const re = /```json\s*\n([\s\S]*?)\n\s*```/i;
  const m = text.match(re);
  if (m) return m[1]!.trim();
  const reAny = /```\s*\n(\{[\s\S]*?\})\n\s*```/i;
  const mAny = text.match(reAny);
  return mAny ? mAny[1]!.trim() : null;
}

// ---------------------------------------------------------------------------
// Design prompts (inlined from the deleted lib/ai/scrape-prompts.ts so this
// file has no scrape-prompts dependency to drag along)
// ---------------------------------------------------------------------------

function getDesignSystem(): string {
  return `You are a brand-design analyst inspecting a WordPress homepage's deterministic extract. Return a single fenced json block describing:

- typography.heading: the headline-typeface family name (or null + confidence 0 if unclear)
- typography.body: the body-copy typeface family name (or null + confidence 0 if unclear)
- buttonPair.primary: the literal primary CTA label visible on the page (or null + confidence 0 if no clear primary CTA)
- buttonPair.secondary: the literal secondary CTA label (or null + confidence 0 if no secondary)
- personality.tone: a short adjective phrase ("warm + community-focused", "precise + minimalist")
- personality.energy: one of "low" | "medium" | "high"
- personality.audience: who this site is talking to ("local craft-beer drinkers", "enterprise procurement leaders")

Every field carries confidence (0..1) and one-sentence reasoning. If the extract contains no signal for a field, set value to null, confidence to 0, and reasoning to a short note about what was missing. Wrap your output in a single \`\`\`json fenced block; no prose outside it.`;
}

function buildDesignUserPrompt(extract: ScrapeExtract): string {
  return `Deterministic extract from the WordPress homepage:

\`\`\`json
${JSON.stringify(extract, null, 2)}
\`\`\`

Respond with the JSON object described in the system prompt.`;
}
```

- [ ] **Step 3: Delete `lib/ai/preview-renderer.ts` and `lib/ai/scrape-prompts.ts`**

```bash
cd apps/web
rm lib/ai/preview-renderer.ts
rm lib/ai/scrape-prompts.ts
```

- [ ] **Step 4: Grep AFTER — confirm no consumer references the deleted symbols**

```bash
cd apps/web
grep -rn "renderPreviewHtml\|preview-renderer\|scrape-prompts\|runScrapeAgent\|runContentPass\|contentMarkdown" app/ components/ lib/ scripts/ 2>&1 | grep -v "^Binary"
```

Expected matches at this stage (all to be fixed in the next tasks):

- `lib/inngest/functions/scrape-preview.ts` (about to be deleted in Task 5)
- `lib/inngest/functions/regenerate-homepage.ts` (about to be deleted in Task 5)
- `lib/inngest/functions/extract-project-design.ts` (Task 5 updates the call site)

There must be NO matches in `app/`, `components/`, or `scripts/`.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/lib/ai/
git commit -m "feat(web): drop preview-renderer + content-pass; rename scrape-agent → runDesignTokenScrape"
```

---

## Task 5: Delete the dead Inngest workers; rewire `extract-project-design`

**Files:**
- Delete: `apps/web/lib/inngest/functions/scrape-preview.ts`
- Delete: `apps/web/lib/inngest/functions/regenerate-homepage.ts`
- Modify: `apps/web/lib/inngest/functions/extract-project-design.ts`
- Modify: `apps/web/app/api/inngest/route.ts`

- [ ] **Step 1: Delete the two preview workers**

```bash
cd apps/web
rm lib/inngest/functions/scrape-preview.ts
rm lib/inngest/functions/regenerate-homepage.ts
```

- [ ] **Step 2: Update `lib/inngest/functions/extract-project-design.ts`**

Open the file and apply two surgical edits:

(a) Change the import line at the top:

```ts
import { runScrapeAgent } from "@/lib/ai/scrape-agent";
```

to:

```ts
import { runDesignTokenScrape } from "@/lib/ai/scrape-agent";
```

(b) Change the call site inside the `scrape` step (around line 51):

```ts
    const scrape = await step.run("scrape", async () => {
      return runScrapeAgent({
        url: wpUrl,
        label: `extractProjectDesign ${projectId}`,
      });
    });
```

to:

```ts
    const scrape = await step.run("scrape", async () => {
      return runDesignTokenScrape({
        url: wpUrl,
        label: `extractProjectDesign ${projectId}`,
      });
    });
```

All other references inside this file (`scrape.design.logo.src`, `scrape.extract.faviconUrl`, `scrape.design`, `personality` destructure) survive unchanged — the new `DesignTokenScrapeResult` keeps those exact field paths.

- [ ] **Step 3: Update `app/api/inngest/route.ts`**

Replace the file contents with:

```ts
import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { extractProjectDesign } from "@/lib/inngest/functions/extract-project-design";

/**
 * Inngest webhook endpoint. Discovers our registered functions for the dev
 * + cloud runtimes via GET/PUT/POST exposed by `serve()`.
 *
 * Stage 0 v2: dropped `scrapePreview` (preview path retired) and
 * `regenerateHomepage` (homepage-blob path retired). Future builds dispatch
 * `siteBuild` (Stage 7) which fans out into the per-phase workers.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [extractProjectDesign],
});
```

- [ ] **Step 4: Grep AFTER — confirm no orphan references**

```bash
cd apps/web
grep -rn "scrapePreview\|regenerateHomepage\b\|preview/scrape.requested\|project/homepage.requested" app/ components/ lib/ scripts/ 2>&1 | grep -v "^Binary"
```

Expected: zero matches in `app/`, `components/`, `scripts/`. Allowed: a comment match inside `extract-project-design.ts` if any reference exists (none should — the worker stands alone).

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/lib/inngest/ apps/web/app/api/inngest/
git commit -m "feat(web): drop scrapePreview + regenerateHomepage workers; rewire extract-project-design to runDesignTokenScrape"
```

---

## Task 6: Delete the preview server actions + signup-promote helper

**Files:**
- Delete: `apps/web/lib/actions/preview.ts`
- Delete: `apps/web/lib/actions/promote-preview.ts`
- Modify: `apps/web/app/auth/callback/route.ts`
- Modify: `apps/web/app/(auth)/sign-in/sign-in-form.tsx`

- [ ] **Step 1: Delete the two server-action files**

```bash
cd apps/web
rm lib/actions/preview.ts
rm lib/actions/promote-preview.ts
```

- [ ] **Step 2: Update `app/auth/callback/route.ts`**

Replace the entire file with:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Auth callback — handles email-confirmation redirects.
 *
 * Supabase Auth sends users to /auth/callback?code=… after they click a
 * confirmation/magic link. We exchange the code for a session and redirect
 * to `next` (default /dashboard).
 *
 * Stage 0 v2: dropped the `promoteAnonymousPreviewIfPresent` hop — the
 * pre-auth preview funnel is retired, so there's no anonymous draft to
 * promote on signup.
 *
 * Required even when "Confirm email" is OFF in Supabase Auth — some flows
 * (password reset, future OAuth) still land here.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const rawNext = searchParams.get("next") ?? "/dashboard";

  const next =
    rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    console.error("auth callback exchangeCodeForSession failed:", error.message);
    return NextResponse.redirect(`${origin}/sign-in?error_code=exchange_failed`);
  }
  return NextResponse.redirect(`${origin}/sign-in?error_code=missing_code`);
}
```

- [ ] **Step 3: Update `app/(auth)/sign-in/sign-in-form.tsx`**

Apply two edits:

(a) Remove the import line (around line 12):

```ts
import { promoteAnonymousPreviewIfPresent } from "@/lib/actions/promote-preview";
```

(b) Replace the post-auth redirect block (around lines 106-121) which currently reads:

```ts
      // Auth succeeded with an immediate session (email confirmation OFF, or
      // password sign-in). Promote any anonymous_previews row tied to this
      // browser's session cookie. Idempotent — null if nothing to claim,
      // in which case the original `next` redirect wins.
      //
      // Promoted projects route through the onboarding wizard, NOT the
      // workspace — a fresh draft has no manifest / intent / ownership yet,
      // so the workspace would show mocked data on a not-yet-set-up site.
      // The wizard's `initialStepIndex` derivation handles a user who later
      // returns mid-wizard. The email-confirmation path applies the same
      // rule in /auth/callback.
      const promoted = await promoteAnonymousPreviewIfPresent();
      router.replace(
        promoted ? `/projects/${promoted.projectId}/onboard` : next,
      );
      router.refresh();
```

with the simpler form:

```ts
      // Auth succeeded with an immediate session (email confirmation OFF, or
      // password sign-in). Stage 0 v2 dropped the anonymous-draft promote
      // hop — the user lands directly at `next` (default /dashboard).
      router.replace(next);
      router.refresh();
```

- [ ] **Step 4: Grep AFTER — confirm zero references to the deleted actions**

```bash
cd apps/web
grep -rn "promoteAnonymousPreviewIfPresent\|triggerPreviewScrapeAction\|getPreviewStatusAction\|lib/actions/preview\|lib/actions/promote-preview" app/ components/ lib/ scripts/ 2>&1 | grep -v "^Binary"
```

Expected: zero matches.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/lib/actions/ apps/web/app/auth/callback/route.ts "apps/web/app/(auth)/sign-in/sign-in-form.tsx"
git commit -m "feat(web): drop preview actions + signup-promote helper; sign-in lands at next directly"
```

---

## Task 7: Strip preview state from `onboarding.ts` server actions

**Files:**
- Modify: `apps/web/lib/actions/onboarding.ts`

This task removes `regenerateHomepageAction` entirely, strips the preview-side-effects from `completeOnboardingAction`, and prepares `connectWpAction` for the hardening in Task 8. We do **not** change validation behavior of `connectWpAction` here — that lands as a single coherent diff in Task 8.

- [ ] **Step 1: Update `completeOnboardingAction`**

Find the block inside `completeOnboardingAction` that updates the row (around lines 477-498) which currently reads:

```ts
  const supabase = await createClient();
  const { data: updatedRow, error: updateErr } = await supabase
    .from("projects")
    .update({
      content_ownership: parsed.data.ownership,
      status: "ready",
      onboarded_at: new Date().toISOString(),
      // Pre-emptively mark the preview as regenerating so the workspace
      // renders the "regenerating" panel from the very first visit —
      // there's a small window between this UPDATE and the worker
      // picking up the event where the user could otherwise see the
      // stale promoted preview with no indication it's about to change.
      preview_html_status: "generating",
    })
    .eq("id", parsed.data.projectId)
    .select("id, tenant_id")
    .single();
  if (updateErr || !updatedRow) {
    return {
      error: `Couldn't finalize onboarding: ${updateErr?.message ?? "project not found"}`,
    };
  }
```

Replace with:

```ts
  const supabase = await createClient();
  const { data: updatedRow, error: updateErr } = await supabase
    .from("projects")
    .update({
      content_ownership: parsed.data.ownership,
      status: "ready",
      onboarded_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.projectId)
    .select("id, tenant_id")
    .single();
  if (updateErr || !updatedRow) {
    return {
      error: `Couldn't finalize onboarding: ${updateErr?.message ?? "project not found"}`,
    };
  }
```

- [ ] **Step 2: Delete the `project/homepage.requested` dispatch from `completeOnboardingAction`**

Immediately after the updated `updatedRow` block above, the file currently has:

```ts
  // Fire-and-forget the intent-aware homepage regeneration. If the
  // dispatch fails (Inngest unreachable, malformed payload) we log
  // and continue — the workspace surfaces a 'failed' status if the
  // worker never runs, and the manual "Regenerate" button is a
  // recovery path. We do NOT block the wizard's finish on this.
  try {
    await inngest.send({
      name: "project/homepage.requested",
      data: {
        projectId: parsed.data.projectId,
        tenantId: updatedRow.tenant_id,
      },
    });
  } catch (dispatchErr) {
    console.error(
      `[completeOnboarding ${parsed.data.projectId}] homepage-regen dispatch failed:`,
      dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
    );
  }
```

Delete the entire `try { await inngest.send({ name: "project/homepage.requested", ... }); } catch ...` block (including the leading docblock comment). The `revalidatePath` and `redirect` calls immediately below it stay.

- [ ] **Step 3: Delete the `regenerateHomepageAction` export**

Find the entire `regenerateHomepageAction` block (starting at the `// ──────────────────────────────────────────────────────────────` divider with header "regenerateHomepageAction" and the `const RegenerateInput = z.object({ projectId: z.string().uuid() });` declaration, through the closing brace of the function). Delete the whole block — divider, header docblock, schema constant, and function body. Roughly lines 525-590 in the current file; check the actual range when editing.

- [ ] **Step 4: Verify `connectWpAction` still leaves the `project/design.requested` dispatch intact**

The `connectWpAction` body should still contain its `inngest.send({ name: "project/design.requested", ... })` block — this is the design-pass dispatch, and it's the correct surviving Stage 2 entry point. No edit needed in this step; just verify it's still there before committing.

- [ ] **Step 5: Confirm the file type-checks against the updated schema**

```bash
cd apps/web
pnpm tsc --noEmit lib/actions/onboarding.ts 2>&1 | head -40
```

Expected: clean against this file (errors in other files still allowed — those land in later tasks).

- [ ] **Step 6: Grep AFTER — confirm cleanup**

```bash
cd apps/web
grep -n "regenerateHomepageAction\|preview_html_status\|project/homepage.requested" lib/actions/onboarding.ts
```

Expected: zero matches.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/actions/onboarding.ts
git commit -m "feat(web): strip preview side-effects from completeOnboarding; drop regenerateHomepageAction"
```

---

## Task 8: Harden `connectWpAction` — manifest probe + plugin v0.6.0+ is a hard precondition

**Files:**
- Modify: `apps/web/lib/actions/onboarding.ts`
- Modify: `apps/web/lib/jab/probe.ts`

**★ Why we extend `probe.ts` instead of inlining the version check ─**
The "is the plugin at v0.6.0 or higher" question has two reasonable answers depending on what the plugin exposes: either a dedicated version field in the manifest (preferred long-term, not yet there) or an inferred check from the ability roster ("does the manifest contain `jab/get-menus`, which only exists in v0.6.0+?"). Keeping that decision inside `probe.ts` means consumers (`connectWpAction` today, the build worker later) ask one question — "is this manifest acceptable for v2?" — without leaking the heuristic into every call site.
`────────────────────────────────────────────────`

- [ ] **Step 1: Extend `lib/jab/probe.ts` with a v2 acceptance check**

Replace the entire `apps/web/lib/jab/probe.ts` file with:

```ts
import "server-only";
import { fetchManifest, McpClientError, type Manifest } from "@jab/core";

/**
 * Probe a WordPress install for the Jab plugin and fetch its manifest.
 *
 * Wraps `@jab/core`'s `fetchManifest` with a UI-friendly result shape.
 *
 * Stage 0 v2 hardening: `probeWordPress` ALSO validates the discovered
 * manifest against `MANIFEST_V2_REQUIREMENTS` — currently that the plugin
 * exposes the `jab/get-menus` ability, which first shipped in plugin
 * v0.6.0 alongside the typed-block moat. v1's "best-effort" probe (any
 * manifest accepted) is gone; a manifest that omits a required ability
 * surfaces as `{ ok: false, error: "...plugin v0.6.0+..." }` to the caller.
 *
 * Errors that surface to the user are now:
 *   - "MCP endpoint not reachable" → URL wrong, plugin inactive, TLS issue
 *   - "Authentication failed" → bad app password
 *   - "No abilities matched prefix jab/" → plugin's old enough that no
 *     abilities are registered under the jab/ namespace
 *   - "Plugin too old — upgrade to v0.6.0 or later." → manifest discovered
 *     but missing the v2 baseline ability roster
 */
export type ProbeResult =
  | {
      ok: true;
      manifest: Manifest;
      abilityCount: number;
    }
  | { ok: false; error: string };

export interface ProbeInput {
  wpUrl: string;
  username: string;
  appPassword: string;
  /** Ability-name filter. Defaults to "jab/". Pass "" to fetch all abilities. */
  prefix?: string;
}

/**
 * The ability names the SaaS v2 component pipeline minimum-requires. If any
 * of these are absent from a freshly-fetched manifest, the plugin is older
 * than v0.6.0 and the v2 build pipeline can't run against it.
 *
 * `jab/get-menus` is the canonical v0.6.0+ shibboleth — it was added in
 * v0.6.0 alongside the typed-block moat and is not present in v0.5.x or
 * earlier. If/when the plugin starts exposing a dedicated version field
 * in the manifest, this list collapses into a single semver compare.
 */
const MANIFEST_V2_REQUIREMENTS = ["jab/get-menus"] as const;

export async function probeWordPress(input: ProbeInput): Promise<ProbeResult> {
  let manifest: Manifest;
  try {
    manifest = await fetchManifest({
      wpUrl: input.wpUrl,
      user: input.username,
      password: input.appPassword,
      prefix: input.prefix,
    });
  } catch (err) {
    if (err instanceof McpClientError) {
      return { ok: false, error: err.message };
    }
    if (err instanceof Error) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: String(err) };
  }

  // v2 acceptance gate. The fetch succeeded — auth and transport both
  // work — but the plugin is too old to drive the component pipeline.
  const abilityNames = new Set(manifest.abilities.map((a) => a.name));
  const missing = MANIFEST_V2_REQUIREMENTS.filter((name) => !abilityNames.has(name));
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `Plugin too old — upgrade to v0.6.0 or later. ` +
        `The connected install is missing required abilities: ${missing.join(", ")}.`,
    };
  }

  return {
    ok: true,
    manifest,
    abilityCount: manifest.abilities.length,
  };
}
```

- [ ] **Step 2: Verify `connectWpAction`'s URL validation already enforces HTTPS-only**

Open `apps/web/lib/actions/onboarding.ts` and find the `ConnectInput` zod schema (around line 61):

```ts
const ConnectInput = z.object({
  projectId: z.string().uuid(),
  wpUrl: z
    .string()
    .trim()
    .url("Must be a valid URL")
    .refine((v) => /^https?:\/\//i.test(v), "Must start with http:// or https://"),
  wpUsername: z.string().trim().min(1, "Username required").max(100),
  wpAppPassword: z.string().trim().min(1, "App password required"),
});
```

Tighten the URL refinement to **HTTPS-only** (per Stage 0 hard-precondition spec — Application Passwords transit credentials in clear, HTTPS isn't optional for v2):

```ts
const ConnectInput = z.object({
  projectId: z.string().uuid(),
  wpUrl: z
    .string()
    .trim()
    .url("Must be a valid URL")
    .refine((v) => /^https:\/\//i.test(v), "Must use https:// (Application Passwords transit credentials in clear)"),
  wpUsername: z.string().trim().min(1, "Username required").max(100),
  wpAppPassword: z.string().trim().min(1, "App password required"),
});
```

- [ ] **Step 3: Verify the probe error gate is hard in `connectWpAction`**

Around line 139 in `apps/web/lib/actions/onboarding.ts`, find:

```ts
    const probe = await probeWordPress({
      wpUrl: data.wpUrl,
      username: data.wpUsername,
      appPassword: normalizedPassword,
    });
    if (!probe.ok) return { ok: false, error: probe.error };
```

This is already a hard gate (`return { ok: false, ... }` halts execution). No code change needed — the hardening here is `probeWordPress`'s new behavior (Step 1 above) refusing v0.5.x manifests; the call site already honors a non-ok result correctly.

Add this docblock comment immediately ABOVE the `probeWordPress` call so a future reader understands that the v2-acceptance check lives inside it:

```ts
    // Hard precondition for Stage 0 v2: a successful manifest probe AND a
    // plugin version that meets MANIFEST_V2_REQUIREMENTS (currently
    // "jab/get-menus" must be present, which gates v0.6.0+). probeWordPress
    // returns `{ ok: false, error: "...plugin too old..." }` for older
    // plugins; the gate below halts onboarding before any DB write.
```

- [ ] **Step 4: Run `pnpm tsc` on the touched files**

```bash
cd apps/web
pnpm tsc --noEmit
```

Expected: errors in the still-untouched UI files (Tasks 9-11) but no errors inside `lib/jab/probe.ts` or `lib/actions/onboarding.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/probe.ts apps/web/lib/actions/onboarding.ts
git commit -m "feat(web): harden connectWp — HTTPS-only, plugin v0.6.0+ manifest gate is hard precondition"
```

---

## Task 9: Reshape the onboarding wizard copy + flow

**Files:**
- Modify: `apps/web/components/onboarding-wizard.tsx`
- Modify: `apps/web/app/(app)/projects/[id]/onboard/page.tsx`
- Modify: `apps/web/app/(app)/projects/[id]/onboard/onboarding-wizard-client.tsx`

- [ ] **Step 1: Update `OnboardingWizardProps` — drop the `aside` slot**

Open `apps/web/components/onboarding-wizard.tsx`. In the `OnboardingWizardProps` interface (around line 33–110), delete the `aside` field:

```ts
  /**
   * Optional aside slot forwarded to `OnboardingShell` — the
   * `/projects/[id]/onboard` route uses this to render the saved /preview
   * HTML as a sticky right-rail thumbnail while the user walks the wizard.
   */
  aside?: React.ReactNode;
```

And remove `aside` from the function destructure parameters (around line 138) and from the `<OnboardingShell ... aside={aside} ...>` call inside the JSX. The shell still accepts an `aside` prop, we just stop passing one.

- [ ] **Step 2: Reshape the wizard's `description` and final-step copy**

In `OnboardingWizard`'s returned `<OnboardingShell>` element, change the `description` prop currently:

```ts
      description={
        <>
          Four quick steps for{" "}
          <code className="rounded bg-elev px-1.5 py-0.5 font-mono text-sm text-wht">
            {displayHost}
          </code>
          : intent, install the plugin, connect, then decide where each
          content type lives.
        </>
      }
```

to:

```ts
      description={
        <>
          Four steps for{" "}
          <code className="rounded bg-elev px-1.5 py-0.5 font-mono text-sm text-wht">
            {displayHost}
          </code>
          : intent, install the plugin, connect, then decide where each
          content type lives. When you finish, this project is ready to build.
        </>
      }
```

- [ ] **Step 3: Update the connect-step body copy**

Around line 369 in the file, change the StepFrame's body for step 2 (Connect) from:

```ts
          body="The application password authenticates against the plugin's endpoints. Generate one at Users → Profile → Application Passwords in wp-admin. After this we'll have the full content catalog and you can assign ownership."
```

to:

```ts
          body="The application password authenticates against the plugin's endpoints. Generate one at Users → Profile → Application Passwords in wp-admin. We'll verify the plugin is v0.6.0 or later and read your full content catalog — that's how we know your site is ready to build."
```

- [ ] **Step 4: Update the ownership-step ✓ connection summary to surface the catalog count as the wow moment**

Around line 426 in the file, change the success line on the Ownership step from:

```ts
          <p className="rounded-md border border-teal/30 bg-teal/10 px-3 py-2 text-xs text-teal">
            ✓ Connected to {displayHost}. We found{" "}
            {contentTypes.length} content type
            {contentTypes.length === 1 ? "" : "s"} — including drafts and
            custom fields.
          </p>
```

to:

```ts
          <p className="rounded-md border border-teal/30 bg-teal/10 px-3 py-2 text-xs text-teal">
            ✓ Connected to {displayHost}. We found{" "}
            <strong className="font-semibold">{contentTypes.length} content type
            {contentTypes.length === 1 ? "" : "s"}</strong> across your install — including
            drafts and custom fields. Pick where each lives and we'll be ready to build.
          </p>
```

- [ ] **Step 5: Update the finish-button label**

In the same Ownership-step StepFrame (around line 416), change:

```ts
          primaryLabel="Finish setup →"
```

to:

```ts
          primaryLabel="Finish setup — ready to build →"
```

And the loadingText similarly stays `"Saving…"` (already accurate).

- [ ] **Step 6: Update `app/(app)/projects/[id]/onboard/page.tsx`**

Open the file. Apply two edits:

(a) Change the project select (around line 41) from:

```ts
  const { data: project, error } = await supabase
    .from("projects")
    .select(
      "id, name, wp_url, intent, manifest, content_ownership, status, preview_html",
    )
    .eq("id", id)
    .single();
```

to:

```ts
  const { data: project, error } = await supabase
    .from("projects")
    .select(
      "id, name, wp_url, intent, manifest, content_ownership, status",
    )
    .eq("id", id)
    .single();
```

(b) Remove the `previewHtml={project.preview_html ?? null}` line from the `<OnboardingWizardClient ... />` JSX (around line 75). The final element should read:

```tsx
  return (
    <OnboardingWizardClient
      projectId={project.id}
      wpUrl={project.wp_url ?? ""}
      initialIntent={initialIntent}
      initialStepIndex={initialStepIndex}
      initialContentTypes={initialContentTypes}
      initialOwnership={initialOwnership}
    />
  );
```

- [ ] **Step 7: Update `app/(app)/projects/[id]/onboard/onboarding-wizard-client.tsx`**

Replace the entire file with:

```tsx
"use client";

import { OnboardingWizard } from "@/components/onboarding-wizard";
import type {
  OwnershipMode,
  WPContentType,
} from "@/components/ownership-picker";
import type { ProjectIntent } from "@/components/intent-picker";
import {
  completeOnboardingAction,
  connectWpAction,
  saveIntentAction,
  verifyPluginAction,
} from "@/lib/actions/onboarding";

export interface OnboardingWizardClientProps {
  projectId: string;
  wpUrl: string;
  initialIntent: ProjectIntent;
  initialStepIndex: 0 | 1 | 2 | 3;
  initialContentTypes?: WPContentType[];
  initialOwnership?: Record<string, OwnershipMode>;
}

/**
 * Client wrapper bridging the OnboardingWizard's typed callbacks to the
 * four server actions. Each action is RLS-scoped via the user's session;
 * the projectId is closed over from the route's server-side read so the
 * client can't substitute it.
 *
 * Stage 0 v2: no `previewHtml` aside — the preview path is gone. The new
 * wow moment is the "we found N content types" surface inside the wizard's
 * Ownership step (rendered by OnboardingWizard, not here).
 */
export function OnboardingWizardClient({
  projectId,
  wpUrl,
  initialIntent,
  initialStepIndex,
  initialContentTypes,
  initialOwnership,
}: OnboardingWizardClientProps) {
  return (
    <OnboardingWizard
      wpUrl={wpUrl}
      initialIntent={initialIntent}
      initialStepIndex={initialStepIndex}
      initialContentTypes={initialContentTypes}
      initialOwnership={initialOwnership}
      onSaveIntent={async (intent) => {
        const result = await saveIntentAction(projectId, intent);
        if (result?.error) throw new Error(result.error);
      }}
      onConnect={async (creds) => {
        const result = await connectWpAction(projectId, creds);
        if (result.ok) return { ok: true, contentTypes: result.contentTypes };
        return { ok: false, error: result.error };
      }}
      onVerifyPlugin={() => verifyPluginAction(projectId)}
      onComplete={async ({ ownership }) => {
        const result = await completeOnboardingAction(projectId, ownership);
        if (result?.error) throw new Error(result.error);
      }}
    />
  );
}
```

- [ ] **Step 8: Grep AFTER — confirm the wizard plumbing is preview-free**

```bash
cd apps/web
grep -n "PreviewFrame\|preview_html\|previewHtml\|aside" components/onboarding-wizard.tsx "app/(app)/projects/[id]/onboard/page.tsx" "app/(app)/projects/[id]/onboard/onboarding-wizard-client.tsx"
```

Expected: zero matches. (`aside` is removed from these three files; the `OnboardingShell` component still accepts the prop generally — that's intentional and out of scope.)

- [ ] **Step 9: Commit**

```bash
git add apps/web/components/onboarding-wizard.tsx "apps/web/app/(app)/projects/[id]/onboard/page.tsx" "apps/web/app/(app)/projects/[id]/onboard/onboarding-wizard-client.tsx"
git commit -m "feat(web): reshape onboarding wizard — drop preview aside, surface content-type count, copy ends at 'ready to build'"
```

---

## Task 10: Rewrite the project workspace hero — drop the HeroPreview, surface a "Ready to build" panel

**Files:**
- Modify: `apps/web/app/(app)/projects/[id]/page.tsx`

The current workspace renders `HeroPreview` + `NextStepsPanel` for setup-complete-but-not-live projects. Both reference `preview_html`, `preview_html_status`, the `regenerateHomepageAction`, and intent-shaped copy. Replace the HeroPreview with a "Ready to build" panel keyed on `manifest`.

- [ ] **Step 1: Strip preview columns from the project select**

Find the project select around line 53:

```ts
  const { data: project, error } = await supabase
    .from("projects")
    .select(
      "id, name, client_name, wp_url, status, created_at, intent, manifest, content_ownership, preview_html, preview_html_status, onboarded_at",
    )
    .eq("id", id)
    .single();
```

Change to:

```ts
  const { data: project, error } = await supabase
    .from("projects")
    .select(
      "id, name, client_name, wp_url, status, created_at, intent, manifest, content_ownership, onboarded_at",
    )
    .eq("id", id)
    .single();
```

- [ ] **Step 2: Remove the import of `regenerateHomepageAction`**

Near the top of the file (around line 5):

```ts
import { regenerateHomepageAction } from "@/lib/actions/onboarding";
```

Delete this line.

- [ ] **Step 3: Remove the `PreviewHtmlStatus` type alias and the `INTENT_LABEL` map**

Around lines 7-14:

```ts
type PreviewHtmlStatus = "generating" | "ready" | "failed" | null;
type ProjectIntent = "faithful" | "refresh" | "reimagine";

const INTENT_LABEL: Record<ProjectIntent, string> = {
  faithful: "faithful",
  refresh: "refresh",
  reimagine: "reimagine",
};
```

Delete the entire block.

- [ ] **Step 4: Replace the `HeroPreview` call in the JSX**

Around line 217:

```tsx
        {setupComplete && !live && (
          <HeroPreview
            previewHtml={project.preview_html}
            previewHtmlStatus={project.preview_html_status as PreviewHtmlStatus}
            intent={project.intent as "faithful" | "refresh" | "reimagine" | null}
            displayDomain={displayDomain}
            projectId={project.id}
            hasManifest={hasManifest}
          />
        )}
```

Replace with:

```tsx
        {setupComplete && !live && (
          <ReadyToBuildPanel
            displayDomain={displayDomain}
            projectId={project.id}
            hasManifest={hasManifest}
            contentTypeCount={contentTypeCountFrom(project.content_ownership)}
          />
        )}
```

- [ ] **Step 5: Delete every preview-related component function**

Search the file for and delete the entire function bodies (including their docblock comments) of:

- `HeroPreview` (around line 351)
- `RegeneratingPanel` (around line 464)
- `RegenerationFailedBanner` (around line 486)
- `RegenerateButton` (around line 503)
- `NextStepsPanel` (around line 542)
- `NextStep` (around line 584)
- `PreviewCard` (around line 781) — only used inside the `live` branch which still references it. **Keep this one** if it's still imported; otherwise delete. Verify: search the file for `<PreviewCard` — if the only call is inside `if (live)` and that branch references `project.preview_html` (which we just deleted from the select), we need to either delete `PreviewCard` or replace its `previewHtml` arg. Since `live` is hardcoded `false` today, the `<PreviewCard ... previewHtml={project.preview_html}>` reference is dead code that doesn't even compile against the new select. Delete the entire `PreviewCard` function AND the JSX that calls it (the `{live && <PreviewCard ... />}` block around line 234).
- `PerfItem` (around line 869) — used by `PreviewCard`, so delete alongside it.

The remaining preserved component functions: `OnboardingResumeBanner`, `SetupCompleteBanner`, `Breadcrumb`, `ChevronRight`, `StatusChip`, `SiteStat`, `ActiveTab`, `InactiveTab`, `WordPressConnectionCard`, `WpRow`, `DeployHistoryCard`, `DeployHistoryRow`, `CheckIcon`, `XIcon`, `AiUpdateCard`, `AiHistoryRow`, `headerStatusFor`, `realWpConnectionFrom`.

- [ ] **Step 6: Add the new `ReadyToBuildPanel` and `contentTypeCountFrom` helper**

Append the following inside the file, placed just below the `SetupCompleteBanner` definition (so the panel-flavored components stay grouped):

```tsx
/* ─────────────────── Ready-to-build panel ──────────────────── */

/**
 * Replaces the v1 HeroPreview. With the preview path gone, the post-
 * onboarding workspace's hero is a confidence anchor instead of a
 * generated artifact — it tells the user the platform sees their site
 * and is ready to build it, surfacing the content-type count discovered
 * at connect time as the proof point.
 *
 * The "Build site" affordance lands in Stage 7 (orchestration); the
 * placeholder button here is disabled with explanatory text so the surface
 * doesn't pretend to do more than it can.
 */
function ReadyToBuildPanel({
  displayDomain,
  projectId,
  hasManifest,
  contentTypeCount,
}: {
  displayDomain: string;
  projectId: string;
  hasManifest: boolean;
  contentTypeCount: number;
}) {
  return (
    <div className="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="overflow-hidden rounded-lg border border-bord bg-bg">
        <div className="flex items-center justify-between gap-3 border-b border-bord px-5 py-3.5">
          <div className="text-sm font-bold leading-snug text-wht">
            Ready to build
          </div>
          <span className="font-mono text-[11px] text-gry-d">{displayDomain}</span>
        </div>
        <div className="space-y-4 px-6 py-7">
          <div className="space-y-1.5">
            <p className="text-base font-bold text-wht">
              Your WordPress site is connected and discoverable.
            </p>
            <p className="text-sm leading-relaxed text-gry">
              {hasManifest
                ? `We can see ${contentTypeCount} content type${contentTypeCount === 1 ? "" : "s"} on this site. When you trigger a build, the pipeline will discover every page, generate a typed React component per unique WordPress block, and deploy a real Next.js site to a preview URL.`
                : "Once the WordPress plugin is connected we'll have the full picture: every content type, every block, every page."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled
              title="Build trigger lands in the orchestration stage"
              className="inline-flex h-9 items-center gap-2 rounded-md bg-teal px-4 text-[13px] font-semibold text-bg transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Build site
            </button>
            <Link
              href={`/projects/${projectId}/onboard`}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-bord px-3.5 text-[13px] font-medium text-wht transition-colors hover:border-teal hover:text-teal"
            >
              Adjust setup
            </Link>
          </div>
        </div>
      </div>
      <ReadyNextSteps projectId={projectId} hasManifest={hasManifest} />
    </div>
  );
}

function ReadyNextSteps({
  projectId,
  hasManifest,
}: {
  projectId: string;
  hasManifest: boolean;
}) {
  const steps: Array<{
    status: "now" | "next-release" | "blocked";
    title: string;
    body: string;
    actionLabel?: string;
    actionHref?: string;
  }> = [
    {
      status: hasManifest ? "now" : "blocked",
      title: "Adjust content ownership",
      body: "Change which content types live in WordPress vs. Jab any time.",
      actionLabel: "Open setup",
      actionHref: `/projects/${projectId}/onboard`,
    },
    {
      status: "next-release",
      title: "Trigger your first build",
      body: "The 6-phase pipeline produces a typed component library + page routes + a preview URL.",
    },
    {
      status: "next-release",
      title: "Review fidelity + publish",
      body: "Per-page fidelity reports gate publish. Regenerate any component that drifts.",
    },
  ];
  return (
    <div className="overflow-hidden rounded-lg border border-bord bg-bg">
      <div className="flex items-center justify-between gap-3 border-b border-bord px-5 py-3.5">
        <div className="text-sm font-bold leading-snug text-wht">
          What&apos;s next
        </div>
      </div>
      <ol className="divide-y divide-bord">
        {steps.map((step) => (
          <ReadyNextStep key={step.title} {...step} />
        ))}
      </ol>
    </div>
  );
}

function ReadyNextStep({
  status,
  title,
  body,
  actionLabel,
  actionHref,
}: {
  status: "now" | "next-release" | "blocked";
  title: string;
  body: string;
  actionLabel?: string;
  actionHref?: string;
}) {
  const STATUS_META: Record<
    "now" | "next-release" | "blocked",
    { dot: string; chip: string; chipClass: string }
  > = {
    now: {
      dot: "bg-teal",
      chip: "Ready",
      chipClass: "border-teal/20 bg-teal/10 text-teal",
    },
    "next-release": {
      dot: "bg-amb",
      chip: "Next release",
      chipClass: "border-amb/20 bg-amb/10 text-amb",
    },
    blocked: {
      dot: "bg-gry-d",
      chip: "Blocked",
      chipClass: "border-bord bg-elev text-gry-d",
    },
  };
  const meta = STATUS_META[status];
  return (
    <li className="flex flex-col gap-1.5 px-5 py-3.5">
      <div className="flex items-center gap-2.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} aria-hidden="true" />
        <span className="flex-1 truncate text-[13px] font-semibold text-wht">{title}</span>
        <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${meta.chipClass}`}>
          {meta.chip}
        </span>
      </div>
      <p className="pl-4 text-[12px] leading-snug text-gry">{body}</p>
      {actionLabel && actionHref && (
        <div className="pl-4">
          <Link
            href={actionHref}
            className="inline-flex h-7 items-center rounded-md border border-bord px-2.5 text-[11px] font-medium text-wht transition-colors hover:border-teal hover:text-teal"
          >
            {actionLabel} →
          </Link>
        </div>
      )}
    </li>
  );
}

/**
 * Derive the post-type / content-ownership count from the persisted map.
 * Used by ReadyToBuildPanel as the wow-moment proof point ("we can see N
 * content types on this site"). Falls back to 0 when nothing is persisted
 * — the panel's copy handles that case explicitly.
 */
function contentTypeCountFrom(
  ownership: Record<string, "wp-managed" | "jab-managed"> | null,
): number {
  if (!ownership) return 0;
  return Object.keys(ownership).length;
}
```

- [ ] **Step 7: Run `pnpm tsc` against the workspace page**

```bash
cd apps/web
pnpm tsc --noEmit
```

Expected: no errors from `app/(app)/projects/[id]/page.tsx`. Errors may still surface in Tasks 11-13's targets.

- [ ] **Step 8: Grep AFTER — confirm the workspace is preview-free**

```bash
cd apps/web
grep -n "preview_html\|HeroPreview\|RegeneratingPanel\|RegenerateButton\|regenerateHomepageAction\|PreviewCard\|NextStepsPanel" "app/(app)/projects/[id]/page.tsx"
```

Expected: zero matches.

- [ ] **Step 9: Commit**

```bash
git add "apps/web/app/(app)/projects/[id]/page.tsx"
git commit -m "feat(web): replace HeroPreview with ReadyToBuildPanel; drop preview state from workspace"
```

---

## Task 11: Repoint marketing CTAs away from `/preview`

**Files:**
- Modify: `apps/web/middleware.ts`
- Modify: `apps/web/components/marketing-chrome.tsx`
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/app/pricing/page.tsx`
- Modify: `apps/web/app/(app)/dashboard/page.tsx`
- Modify: `apps/web/components/projects-list-view.tsx`
- Modify: `apps/web/components/caveats-banner.tsx`

- [ ] **Step 1: `middleware.ts` — drop `/preview` from public routes**

Open `apps/web/middleware.ts` and find:

```ts
const PUBLIC_ROUTES = [
  "/",
  "/sign-in",
  "/sign-up",
  "/preview",
  "/pricing",
  "/auth/callback",
  "/api/inngest",
];
```

Remove the `"/preview",` line:

```ts
const PUBLIC_ROUTES = [
  "/",
  "/sign-in",
  "/sign-up",
  "/pricing",
  "/auth/callback",
  "/api/inngest",
];
```

- [ ] **Step 2: `components/marketing-chrome.tsx` — repoint both header + footer CTAs**

In `MarketingHeader`, find (around line 68):

```ts
            <Link
              href="/preview"
              className="whitespace-nowrap rounded-md bg-teal px-5 py-2 text-sm font-semibold text-bg transition-[filter] hover:brightness-110"
            >
              Try it free
            </Link>
```

Change to:

```ts
            <Link
              href="/sign-up"
              className="whitespace-nowrap rounded-md bg-teal px-5 py-2 text-sm font-semibold text-bg transition-[filter] hover:brightness-110"
            >
              Start free trial
            </Link>
```

In `MarketingFooter`, find (around line 136):

```ts
                <Link href="/preview" className="text-[13px] text-gry-d transition-colors hover:text-gry">
                  Try it free
                </Link>
```

Change to:

```ts
                <Link href="/pricing" className="text-[13px] text-gry-d transition-colors hover:text-gry">
                  Pricing
                </Link>
```

(Pricing already appears later in the footer signed-out group; removing the duplicate is a tiny copy bug but acceptable — Stage 0's job is correctness, not micro-polish.)

- [ ] **Step 3: `app/page.tsx` — change hero CTA target + body copy**

Find the hero CTA block (around line 81-95):

```tsx
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Link
              href="/preview"
              className="inline-flex items-center gap-2 rounded-md bg-teal px-6 py-3 text-[15px] font-semibold text-bg no-underline transition-[filter] hover:brightness-110"
            >
              Try JAB for your agency
              <ArrowRight />
            </Link>
            <Link
              href="#demo"
              className="inline-flex items-center gap-2 rounded-md border-[1.5px] border-bord bg-transparent px-6 py-3 text-[15px] font-medium text-wht no-underline transition-colors hover:border-gry"
            >
              Watch the demo
            </Link>
          </div>
          <p className="font-mono text-[13px] text-gry-d">
            See a generated homepage in about a minute. No account needed to try.
          </p>
```

Replace with:

```tsx
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Link
              href="/sign-up"
              className="inline-flex items-center gap-2 rounded-md bg-teal px-6 py-3 text-[15px] font-semibold text-bg no-underline transition-[filter] hover:brightness-110"
            >
              Start your free trial
              <ArrowRight />
            </Link>
            <Link
              href="#demo"
              className="inline-flex items-center gap-2 rounded-md border-[1.5px] border-bord bg-transparent px-6 py-3 text-[15px] font-medium text-wht no-underline transition-colors hover:border-gry"
            >
              Watch the demo
            </Link>
          </div>
          <p className="font-mono text-[13px] text-gry-d">
            Connect a client&apos;s WordPress, build a modern frontend in minutes.
          </p>
```

- [ ] **Step 4: `app/pricing/page.tsx` — repoint the closing CTA**

Find (around line 148):

```ts
          <Link
            href="/preview"
            className="inline-flex items-center gap-2 rounded-md bg-teal px-6 py-3 text-[15px] font-semibold text-bg no-underline transition-[filter] hover:brightness-110"
          >
            Try it free
          </Link>
```

Change to:

```ts
          <Link
            href="/sign-up"
            className="inline-flex items-center gap-2 rounded-md bg-teal px-6 py-3 text-[15px] font-semibold text-bg no-underline transition-[filter] hover:brightness-110"
          >
            Start free trial
          </Link>
```

Also update the surrounding copy (around line 137-146) to drop the "no card, no account, about a minute" preview line. Replace:

```tsx
        <span className="mb-5 inline-block font-mono text-[11px] uppercase tracking-[0.2em] text-teal">
          Try it first
        </span>
        <h2 className="font-display text-[36px] font-extrabold leading-[1.2] tracking-[-0.03em] text-wht sm:text-[48px]">
          See it on a real client site first.
        </h2>
        <p className="mt-4 text-[17px] leading-[1.6] text-gry">
          Generate a preview before you pick a plan — no card, no account, about
          a minute.
        </p>
```

with:

```tsx
        <span className="mb-5 inline-block font-mono text-[11px] uppercase tracking-[0.2em] text-teal">
          Pick a plan
        </span>
        <h2 className="font-display text-[36px] font-extrabold leading-[1.2] tracking-[-0.03em] text-wht sm:text-[48px]">
          Bring your first client site over.
        </h2>
        <p className="mt-4 text-[17px] leading-[1.6] text-gry">
          Connect a WordPress install, finish onboarding, and build your first modern frontend on the trial.
        </p>
```

- [ ] **Step 5: `app/(app)/dashboard/page.tsx` — repoint the empty-state CTA**

Find the empty-state block (around line 41-58):

```tsx
  if (!projects || projects.length === 0) {
    return (
      <EmptyState
        title="No projects yet"
        description="Start with one of your client's WordPress URLs — generate a homepage preview in about a minute. No credentials needed for the first look."
        action={
          <div className="flex items-center gap-2">
            <Link href="/preview">
              <Button>Try with a client&apos;s site →</Button>
            </Link>
            <Link href="/projects/new">
              <Button variant="ghost">Or set up from scratch</Button>
            </Link>
          </div>
        }
      />
    );
  }
```

Replace with:

```tsx
  if (!projects || projects.length === 0) {
    return (
      <EmptyState
        title="No projects yet"
        description="Connect a client's WordPress site and finish a four-step onboarding — that's everything we need to build."
        action={
          <Link href="/projects/new">
            <Button>Connect your first site →</Button>
          </Link>
        }
      />
    );
  }
```

- [ ] **Step 6: `components/projects-list-view.tsx` — drop the preview-flavored empty state**

Replace the entire file with:

```tsx
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  ProjectCard,
  type ProjectListEntry,
} from "@/components/project-card";

export interface ProjectsListViewProps {
  projects: ProjectListEntry[];
  /** Where the empty-state CTA points. Default `/projects/new`. */
  newProjectHref?: string;
  /** Where each card links into. Default `/projects`. */
  projectHrefBase?: string;
}

/**
 * Projects-list home. Two states:
 *   - Populated: header with action + responsive grid of `ProjectCard`s.
 *   - Empty: "no projects yet" hero with one CTA pointing at the
 *     new-project flow.
 *
 * Stage 0 v2 dropped the pre-auth `/preview` flow — the empty-state copy
 * no longer dual-paths through a wow-preview teaser. New projects start
 * at `/projects/new` and walk the four-step onboarding wizard.
 */
export function ProjectsListView({
  projects,
  newProjectHref = "/projects/new",
  projectHrefBase = "/projects",
}: ProjectsListViewProps) {
  if (projects.length === 0) {
    return <EmptyProjectsList newProjectHref={newProjectHref} />;
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-wht">Projects</h1>
          <p className="mt-0.5 text-sm text-gry">
            One per client WordPress site you&apos;ve connected.
          </p>
        </div>
        <Link href={newProjectHref}>
          <Button>New project</Button>
        </Link>
      </header>

      <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {projects.map((project) => (
          <li key={project.id}>
            <ProjectCard project={project} hrefBase={projectHrefBase} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyProjectsList({ newProjectHref }: { newProjectHref: string }) {
  const steps = [
    {
      title: "Connect a client's WordPress",
      body: "Drop in a URL, install the plugin, and authenticate with an application password. We'll verify the plugin is current.",
    },
    {
      title: "Assign content ownership",
      body: "Decide which content types live in WordPress (collections like blog posts) vs. Jab (bespoke marketing pages). You can change this later.",
    },
    {
      title: "Build + publish",
      body: "Trigger the build, review per-page fidelity, regenerate anything that drifts, then publish to a preview URL.",
    },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-10 py-10 text-center">
      <header className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight text-wht">
          Connect your first client site
        </h1>
        <p className="mx-auto max-w-xl text-base text-gry">
          Each project pairs Jab with one WordPress install. Onboarding takes
          about ten minutes — no developer required.
        </p>
      </header>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link href={newProjectHref}>
          <Button size="lg">Start a project →</Button>
        </Link>
      </div>

      <ol className="grid gap-4 sm:grid-cols-3">
        {steps.map((step, idx) => (
          <li
            key={step.title}
            className="rounded-lg border border-bord bg-bg p-5 text-left shadow-sm"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-teal/10 text-xs font-semibold text-teal">
              {idx + 1}
            </span>
            <h3 className="mt-3 text-sm font-semibold text-wht">
              {step.title}
            </h3>
            <p className="mt-1 text-sm text-gry">{step.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
```

- [ ] **Step 7: `components/caveats-banner.tsx` — drop the preview-context language**

Open the file. Replace the `DEFAULT_FOOTER` constant (around line 25):

```ts
const DEFAULT_FOOTER =
  "These come in once you connect WordPress. We'll walk you through it after you save your preview.";
```

with:

```ts
const DEFAULT_FOOTER =
  "These come in once you connect WordPress through the onboarding flow.";
```

And update the docblock comment for the component (around line 28-33):

```ts
/**
 * Informational banner explaining the limits of the public-scrape generator.
 * Lives under PreviewFrame on /preview (§12 step 2) and re-appears in the
 * project workspace pre-plugin-connect. Tone is encouragement, not warning —
 * the gaps are "you ain't seen nothin' yet," not "your preview is broken."
 */
```

Replace with:

```ts
/**
 * Informational banner explaining the limits of the public-scrape generator.
 * Surfaces in the workspace pre-plugin-connect. Tone is encouragement, not
 * warning — the gaps are "you ain't seen nothin' yet," not "your data is
 * broken."
 */
```

- [ ] **Step 8: Grep AFTER — confirm no surviving `/preview` link or `previewHref` consumer**

```bash
cd apps/web
grep -rn 'href=.*"/preview"\|previewHref' app/ components/ lib/ 2>&1 | grep -v "^Binary"
```

Expected: zero matches. (The `lib/db/schema.ts` references were already cleared in Task 2; the only remaining matches might be inside `app/ui-kit/...` demo files — those are dev-only and intentionally out of Stage 0 scope.)

If any `app/ui-kit/` matches surface, **leave them** — the UI-kit demos are isolated from production routes and Stage 0 explicitly is not retreading that surface. Note them in the deviations section at the end of the plan.

- [ ] **Step 9: Commit**

```bash
git add apps/web/middleware.ts apps/web/components/marketing-chrome.tsx apps/web/app/page.tsx apps/web/app/pricing/page.tsx "apps/web/app/(app)/dashboard/page.tsx" apps/web/components/projects-list-view.tsx apps/web/components/caveats-banner.tsx
git commit -m "feat(web): repoint marketing + dashboard CTAs from /preview to /sign-up + /projects/new"
```

---

## Task 12: Drop the `anonymous_previews` branch from the cron prune

**Files:**
- Modify: `apps/web/app/api/cron/prune/route.ts`

- [ ] **Step 1: Replace the route file**

Open `apps/web/app/api/cron/prune/route.ts` and replace its entirety with:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Daily prune for the unbounded `rate_limits` table — hourly windows reset
 * in-place, so any row older than 24h is from a stale IP/session that
 * hasn't returned.
 *
 * Stage 0 v2: dropped the `anonymous_previews` prune branch — that table
 * is gone with the preview path.
 *
 * Scheduled via `vercel.json` `crons`. Vercel adds an
 * `Authorization: Bearer <CRON_SECRET>` header on its scheduled invocation;
 * we require the same on every caller. Missing `CRON_SECRET` env returns
 * 503 — a deploy-config slip must not silently turn this into an open
 * delete endpoint.
 *
 * Local dev: set `CRON_SECRET=dev` in `.env.local` and invoke with
 *   curl -H "Authorization: Bearer dev" http://localhost:3000/api/cron/prune
 */

export const dynamic = "force-dynamic";

const RATE_LIMIT_STALE_HOURS = 24;

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("[cron/prune] CRON_SECRET is unset — refusing to run");
    return NextResponse.json(
      { error: "cron_secret_unconfigured" },
      { status: 503 },
    );
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const now = new Date();
  const rateLimitStaleBefore = new Date(
    now.getTime() - RATE_LIMIT_STALE_HOURS * 60 * 60 * 1000,
  ).toISOString();

  let rateLimitsPruned: number | null = null;
  const errors: string[] = [];

  const rateLimitResult = await supabase
    .from("rate_limits")
    .delete({ count: "exact" })
    .lt("updated_at", rateLimitStaleBefore);
  if (rateLimitResult.error) {
    errors.push(`rate_limits: ${rateLimitResult.error.message}`);
  } else {
    rateLimitsPruned = rateLimitResult.count ?? 0;
  }

  const payload = {
    rateLimitsPruned,
    ran_at: now.toISOString(),
    errors: errors.length > 0 ? errors : undefined,
  };

  if (errors.length > 0) {
    console.error("[cron/prune] partial failure:", payload);
    return NextResponse.json(payload, { status: 500 });
  }
  console.log("[cron/prune]", payload);
  return NextResponse.json(payload);
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/api/cron/prune/route.ts
git commit -m "feat(web): drop anonymous_previews prune branch — table is gone"
```

---

## Task 13: Extend the tenant-isolation tests to cover the five new tables

**Files:**
- Modify: `apps/web/scripts/test-tenant-isolation.sql`

- [ ] **Step 1: Append a new "SaaS v2 isolation" block**

Open `apps/web/scripts/test-tenant-isolation.sql`. The existing tests cover `projects`, `tenants`, and `tenant_members`. Append the following at the end of the file, BEFORE the final `===` banner line. The block extends the existing pattern: seed a build (and child rows) for user A, switch to user B's JWT, prove every isolation gate holds.

```sql
-- ============================================================================
-- SaaS v2 tables — extended isolation gates
-- ----------------------------------------------------------------------------
-- Five new tables landed in migration 0014: site_builds, deployments,
-- block_inventory, page_inventory, fidelity_reports. All are tenant-scoped
-- via project_id → projects.tenant_id. Each gets the same boundary check:
-- user B cannot SELECT user A's rows. site_builds INSERT-via-RLS is also
-- gated; the other tables are insert-via-service-role only (consistent
-- with generation_jobs in migration 0004 — the worker writes, the user
-- reads). For those, this block proves the SELECT boundary holds.
--
-- Run AS POSTGRES (the cleanup at the bottom needs unrestricted DELETE).
-- ============================================================================

-- ---- SETUP: insert a build + child rows owned by user A's tenant ----------
-- Reset role to postgres for the seed inserts so RLS doesn't get in the way.
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', NULL, true);

-- Get user A's project_id by name (created earlier in this script).
-- A real run inserts the row in the "INSERT as user A" block above; the
-- following uses the same name to look it up.
WITH a_proj AS (
  SELECT id, tenant_id
  FROM public.projects
  WHERE name = 'A''s secret project'
  LIMIT 1
), build AS (
  INSERT INTO public.site_builds (project_id, status)
  SELECT id, 'queued' FROM a_proj
  RETURNING id, project_id
)
INSERT INTO public.page_inventory (site_build_id, project_id, slug, post_type, route_path)
SELECT b.id, b.project_id, 'a-secret-slug', 'page', '/a-secret-slug'
FROM build b;

WITH a_proj AS (
  SELECT id FROM public.projects WHERE name = 'A''s secret project' LIMIT 1
), a_build AS (
  SELECT id FROM public.site_builds
  WHERE project_id = (SELECT id FROM a_proj)
  LIMIT 1
)
INSERT INTO public.deployments (site_build_id, project_id, environment, status)
SELECT (SELECT id FROM a_build), (SELECT id FROM a_proj), 'preview', 'pending'
WHERE (SELECT id FROM a_build) IS NOT NULL;

WITH a_proj AS (
  SELECT id FROM public.projects WHERE name = 'A''s secret project' LIMIT 1
), a_build AS (
  SELECT id FROM public.site_builds
  WHERE project_id = (SELECT id FROM a_proj)
  LIMIT 1
)
INSERT INTO public.block_inventory (site_build_id, project_id, block_name, occurrence_count, tier)
SELECT (SELECT id FROM a_build), (SELECT id FROM a_proj), 'core/heading', 3, 'trivial'
WHERE (SELECT id FROM a_build) IS NOT NULL;

WITH a_proj AS (
  SELECT id FROM public.projects WHERE name = 'A''s secret project' LIMIT 1
), a_build AS (
  SELECT id FROM public.site_builds
  WHERE project_id = (SELECT id FROM a_proj)
  LIMIT 1
), a_page AS (
  SELECT id FROM public.page_inventory
  WHERE site_build_id = (SELECT id FROM a_build)
  LIMIT 1
)
INSERT INTO public.fidelity_reports (site_build_id, project_id, page_inventory_id, score)
SELECT (SELECT id FROM a_build), (SELECT id FROM a_proj), (SELECT id FROM a_page), 0.87
WHERE (SELECT id FROM a_build) IS NOT NULL AND (SELECT id FROM a_page) IS NOT NULL;

-- ---- ASSERTIONS as user B --------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'user_b', true);

-- ❌ MUST RETURN 0 ROWS — every new table is invisible to user B.
SELECT id, status FROM public.site_builds
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');

SELECT id, environment, status FROM public.deployments
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');

SELECT id, block_name FROM public.block_inventory
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');

SELECT id, slug FROM public.page_inventory
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');

SELECT id, score FROM public.fidelity_reports
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');

-- ❌ MUST RAISE / 0 ROWS AFFECTED — user B insert into user A's site_build.
-- The WITH CHECK on the insert policy blocks the cross-tenant write.
INSERT INTO public.site_builds (project_id, status)
SELECT id, 'queued' FROM public.projects WHERE name = 'A''s secret project';

-- ❌ MUST RETURN 0 ROWS AFFECTED — user B update an approval state on A's
-- fidelity_report. fidelity_reports has an UPDATE policy but it's still
-- tenant-scoped, so a wrong-tenant UPDATE no-ops.
UPDATE public.fidelity_reports
SET approval_status = 'approved'
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');

-- ---- TEARDOWN of v2 rows ---------------------------------------------------
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', NULL, true);

DELETE FROM public.fidelity_reports
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');
DELETE FROM public.block_inventory
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');
DELETE FROM public.page_inventory
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');
DELETE FROM public.deployments
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');
DELETE FROM public.site_builds
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');
```

- [ ] **Step 2: Reorder the projects-row teardown**

The original script's bottom block deletes the test projects:

```sql
DELETE FROM public.projects WHERE name IN (
  'A''s secret project',
  'B trying to inject',
  'B owns this now'
);
```

Move the v2 teardown block ABOVE this projects DELETE so the cascade ordering is right (v2 rows have FK references to projects with `ON DELETE CASCADE`, so the projects DELETE would clean them too — but explicit teardown above keeps the run idempotent in the partial-success case).

If the v2 block was appended at the end (Step 1), simply ensure the existing projects DELETE remains the last destructive statement. Visually verify the order: v2 cleanup, then `DELETE FROM public.projects WHERE name IN (...)`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/scripts/test-tenant-isolation.sql
git commit -m "test(web): extend tenant-isolation script with v2 table boundaries"
```

---

## Task 14: Final verification gate

**Files:**
- None modified — this task only runs commands and confirms outputs.

- [ ] **Step 1: `pnpm tsc` clean across `apps/web`**

```bash
cd apps/web
pnpm tsc --noEmit
```

Expected: zero errors.

**If errors surface:** locate the file in the error, decide which earlier task owned it, fix the regression there (don't band-aid in a new task). The most likely sources of late-stage error:
- A surviving `import { regenerateHomepageAction }` (Task 7 missed it) → search and remove.
- A surviving `project.preview_html` access (Task 10 missed a copy) → search and remove.
- A surviving `runScrapeAgent` reference (Task 5 missed a caller) → search, rename to `runDesignTokenScrape`.

- [ ] **Step 2: `next build` clean**

```bash
cd apps/web
pnpm next build
```

Expected: build completes without TypeScript errors and without unresolved imports. The build will skip any pages that depend on env vars; do NOT add env-var bypasses here — the build's job is to assert the import graph + type graph resolves.

- [ ] **Step 3: Grep — `preview_html` returns zero**

```bash
cd apps/web
grep -rn "preview_html" . 2>&1 | grep -v node_modules | grep -v ".next" | grep -v "^Binary"
```

Expected: zero matches.

- [ ] **Step 4: Grep — `anonymous_previews` returns zero**

```bash
cd apps/web
grep -rn "anonymous_previews" . 2>&1 | grep -v node_modules | grep -v ".next" | grep -v "^Binary"
```

Expected: zero matches. (The migration `0005_anonymous_previews.sql` still exists in the migrations folder — that's historical, the file is now superseded by 0014's `DROP TABLE`. The grep above will match the historical migration filename + the migration 0007 + 0008 + 0010 + 0011 references. **Allowed exceptions:** any references INSIDE files under `drizzle/migrations/0005`, `0007`, `0008`, `0010`, `0011` are historical migration text and must not be rewritten — those files are an append-only audit log of schema changes. Filter the grep result manually to confirm every surviving match is inside `drizzle/migrations/` AND is migration 0005, 0007, 0008, 0010, or 0011.)

A tighter check that excludes the migration history:

```bash
cd apps/web
grep -rn "anonymous_previews" . 2>&1 | grep -v node_modules | grep -v ".next" | grep -v "^Binary" | grep -v "drizzle/migrations/00[5-9]\|drizzle/migrations/001[01]"
```

Expected: zero matches.

- [ ] **Step 5: Grep — `renderPreviewHtml`, `scrapePreview`, `regenerateHomepage` return zero**

```bash
cd apps/web
grep -rn "renderPreviewHtml\|scrapePreview\|regenerateHomepage" . 2>&1 | grep -v node_modules | grep -v ".next" | grep -v "^Binary"
```

Expected: zero matches in app code. Migrations and the deleted-files history won't show because they're gone.

- [ ] **Step 6: Run the tenant-isolation script**

Sean / the executing engineer must run `apps/web/scripts/test-tenant-isolation.sql` in the Supabase SQL Editor against the dev project. Substitute real UUIDs for `USER_A_ID` / `USER_B_ID` per the script's setup block.

Expected: every `❌ MUST RETURN 0 ROWS` block returns zero rows; every isolation assertion holds.

- [ ] **Step 7: Smoke-test the onboarding flow end-to-end**

Manual walk against a real WP install:

1. Sign up a new test user.
2. Click "Start a project" / "New project" → fill in name + WP URL + client name.
3. Walk the wizard: Intent → Install plugin → Connect (use a real WP install with plugin v0.6.0+ installed) → Ownership.
4. Confirm: Connect step accepts the credentials and the plugin probe succeeds. Try an obviously-old plugin (v0.5.x or earlier) — confirm the connect step REJECTS with "Plugin too old — upgrade to v0.6.0 or later."
5. Confirm: Ownership step's success banner reads "We found N content types across your install — including drafts and custom fields. Pick where each lives and we'll be ready to build."
6. Finish setup. Confirm the redirect lands at `/projects/<id>` with the "Ready to build" hero panel — **no** iframe, **no** preview HTML, **no** regenerate button.
7. Confirm `projects.preview_html`, `projects.preview_html_status`, `projects.usage` are absent (re-run the `information_schema.columns` check from Task 1 Step 4).

- [ ] **Step 8: Final commit (no code change — confirms the gate held)**

If any verification turned up a regression that required a code edit, that edit is its own commit at the right task above (re-run subsequent verification steps after fixing). If every check passed first time, no final commit is needed.

---

## Self-Review Output

**Spec coverage:**

- Drop `/preview` route + flow → Task 3
- Drop `preview_html` + `preview_html_status` columns → Task 1 (migration), Task 2 (schema TS), Task 10 (workspace), Task 9 (wizard)
- Drop `anonymous_previews` table → Task 1 (migration), Task 2 (schema TS)
- Drop `scrape-preview.ts` worker → Task 5
- Drop `regenerate-homepage.ts` worker → Task 5
- Drop `preview-renderer.ts` → Task 4
- Decommission `runScrapeAgent` content pass; retain design pass as `runDesignTokenScrape` → Task 4 (rewrite), Task 5 (call-site update)
- Drop `usage` column → Task 1 (migration), Task 2 (schema TS), Task 10 (workspace select)
- Drop `regenerateHomepageAction` + `project/homepage.requested` dispatch → Task 7
- Land 5 new tables (`site_builds`, `deployments`, `block_inventory`, `page_inventory`, `fidelity_reports`) with full RLS → Task 1, Task 2
- Cost-telemetry columns on `block_inventory` (per decision #3: `model_used`, `provider_used`, `input_tokens_cached`, `input_tokens_uncached`, `output_tokens`, `compile_status`, `compile_attempt_count`) → Task 1
- Harden `connectWpAction` to require HTTPS + manifest probe + plugin v0.6.0+ as hard precondition → Task 8 (probe extension + URL refine)
- Update onboarding wizard: drop "preview" wording, surface block-inventory / content-type count, end at "ready to build" → Task 9
- Drop `promote-preview.ts` + auth-callback + sign-in plumbing → Task 6
- Drop preview entries from middleware public routes → Task 11 (Step 1)
- Repoint marketing CTAs (`marketing-chrome`, `page.tsx`, `pricing/page.tsx`, `dashboard/page.tsx`, `projects-list-view.tsx`) → Task 11
- Drop `anonymous_previews` branch from cron prune → Task 12
- Extend tenant-isolation tests to cover 5 new tables → Task 13
- Final verification gate (tsc clean, next build clean, grep checks, isolation script) → Task 14

**Placeholder scan:** none. Every step has either exact code, exact commands, or exact grep expectations.

**Type / signature consistency:**

- `runDesignTokenScrape(DesignTokenScrapeInput): Promise<DesignTokenScrapeResult>` — defined Task 4, called Task 5 with matching shape.
- `probeWordPress(ProbeInput): Promise<ProbeResult>` — shape unchanged from v1; v2-acceptance check is internal to the function. Existing call site in `connectWpAction` honors the `{ ok: false, error }` shape unchanged.
- `MANIFEST_V2_REQUIREMENTS = ["jab/get-menus"]` — single source of truth in `probe.ts`. Stage 1 (Discovery) can extend this list as new abilities become required without touching call sites.
- `siteBuilds` / `deployments` / `blockInventory` / `pageInventory` / `fidelityReports` exports — added Task 2 with column types matching the SQL exactly (NUMERIC stored as `text` in TS per the comment justifying it).
- `contentTypeCountFrom(ownership: Record<string, "wp-managed" | "jab-managed"> | null): number` — defined and called in Task 10's `ReadyToBuildPanel`.

**Risks deliberately accepted in Stage 0 (called out for the executing engineer):**

- `lib/ai/render-prompts.ts` is left in place. Per the File Structure section, the file has zero importers after Task 4 lands but the file is deleted by Stage 2's first task (when component-shaped prompts replace it). A grep at Task 14 Step 5 confirms no consumer remains — the orphan file is dead weight but not broken.
- The `INTENT_BRIEFS`, `IntentPicker`, and `projects.intent` column survive Stage 0 per decision #2. Retirement happens in Stage 2.
- `app/ui-kit/...` demo files may still reference `/preview` and `PreviewFrame`. Task 11 Step 8 calls this out — those demos are intentionally out of Stage 0 scope. Cleanup land when the UI-kit page itself gets a v2-shape refresh (out of Stage 0).

**Deferred:**

- Stage 1 (Discovery) — populates the new `site_builds`, `page_inventory`, `block_inventory` tables.
- Stage 2 (Components) — writes the cost-telemetry columns on `block_inventory` rows landed in this stage.
- Stage 5/6 (Verify/Review) — writes the `fidelity_reports` rows landed in this stage.
- Stage 7 — adds back a `siteBuild` Inngest worker registration in `app/api/inngest/route.ts` (the registration list is one-entry-shorter as of Stage 0 by design).

---

## Deviations from the original plan

_(Engineer: fill this in after execution if anything had to change. Mirror the v0.6.0 plan's pattern — short numbered list of what shipped differently and why.)_

1. _(Reserved for late-stage discoveries.)_
