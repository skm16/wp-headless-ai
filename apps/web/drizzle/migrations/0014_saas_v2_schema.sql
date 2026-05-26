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
      'discovering', 'components', 'composing', 'building', 'verifying'
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
  -- Denormalized from site_builds.project_id for RLS performance + simpler queries.
  -- Invariant (not DB-enforced): equals site_builds.project_id for the parent build.
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
  -- Denormalized from site_builds.project_id for RLS performance + simpler queries.
  -- Invariant (not DB-enforced): equals site_builds.project_id for the parent build.
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
  -- Denormalized from site_builds.project_id for RLS performance + simpler queries.
  -- Invariant (not DB-enforced): equals site_builds.project_id for the parent build.
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
  -- Denormalized from site_builds.project_id for RLS performance + simpler queries.
  -- Invariant (not DB-enforced): equals site_builds.project_id for the parent build.
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  page_inventory_id UUID NOT NULL REFERENCES public.page_inventory(id) ON DELETE CASCADE,
  -- 0.0 (worst) → 1.0 (best). NULL if the page wasn't scored.
  score NUMERIC(4,3)
    CHECK (score IS NULL OR (score >= 0.0 AND score <= 1.0)),
  -- Pixel-divergence ratio from pixelmatch. Always present once Phase E ran.
  pixel_diff NUMERIC(6,5)
    CHECK (pixel_diff IS NULL OR (pixel_diff >= 0.0 AND pixel_diff <= 1.0)),
  -- Phase E's structured issue list. Shape:
  --   [{ block_name: string, severity: 'low'|'medium'|'high', description: string }]
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Per-page approval state for Phase F's pre-publish gate.
  approval_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending', 'approved', 'approved_with_issues', 'rejected')),
  -- No FK to auth.users — cross-schema FK to auth.users creates user-deletion
  -- hazards (CASCADE drops historical approvals; SET NULL loses audit trail).
  -- The application records who approved at the time; user-existence is not
  -- a referential integrity concern.
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
-- Posture: SELECT-only via RLS; INSERT, UPDATE, DELETE all go through the
-- service-role workers / orchestrator (matching the deployments table).
--
-- The Phase F per-page approval path on fidelity_reports will be exposed via
-- a SECURITY DEFINER RPC (to be designed in the Phase F sub-plan) that
-- restricts writes to the approval columns only. A blanket UPDATE policy
-- cannot enforce that column-level restriction, so it is intentionally absent.

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

-- No INSERT policy — site_builds rows are always written by the orchestrator
-- server action / build worker (service-role). Tenant members must not be
-- able to fabricate a row with status='ready' and bypass the worker state
-- machine + Phase F approval gate. Same posture as deployments below.

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

-- No UPDATE policy — a tenant-scoped UPDATE policy with a WITH CHECK that only
-- verifies project ownership cannot prevent column-level tampering (a member
-- could overwrite score, pixel_diff, issues, or generated_screenshot_paths,
-- all of which are worker-owned). The Phase F approval path will be exposed
-- via a SECURITY DEFINER RPC that accepts only the approval columns
-- (approval_status, approved_by_user_id, approved_at). Reserved for Phase F.

-- ============================================================================
-- End 0014_saas_v2_schema.sql
-- ============================================================================
