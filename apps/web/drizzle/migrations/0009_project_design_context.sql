-- ============================================================================
-- 0009_project_design_context.sql — design tokens + personality on projects
-- ----------------------------------------------------------------------------
-- Per transition doc §10 priority #3: after Stage 2 (post-signup probe with
-- WP credentials), run an async LLM extraction over the rendered WP homepage
-- and persist the structured design + personality output.
--
-- Why on `projects` (not a join table):
--   - One row per project: design tokens are project-scoped, not page-scoped
--   - Read-heavy at generation time; nested JSONB is cheap to fetch
--   - No version history needed (Stage 2 runs idempotently — latest wins)
--
-- Shape: mirrors `DesignAnalysis` from lib/ai/scrape-agent.ts. The personality
-- block lives on its own column because consumers may want it without the
-- color/typography weight (e.g. tone-only copy decisions in an iteration
-- prompt).
--
-- Asset path columns already added in 0008.
-- ============================================================================

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS design_tokens JSONB,
  ADD COLUMN IF NOT EXISTS personality   JSONB;

COMMENT ON COLUMN public.projects.design_tokens IS
  'DesignAnalysis output minus personality (colors, typography, logo, buttonPair). NULL until Stage 2 extraction completes.';
COMMENT ON COLUMN public.projects.personality IS
  'DesignAnalysis.personality block (tone, energy, audience) with confidence + reasoning. NULL until Stage 2 extraction completes.';
