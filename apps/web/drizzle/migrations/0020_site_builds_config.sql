-- ============================================================================
-- 0020_site_builds_config.sql
-- ----------------------------------------------------------------------------
-- Per-build configuration jsonb. Phase C reads config.phase_c_emit_cpt_routes
-- to decide whether to emit app/{cpt}/* list+single routes (default false in
-- v1; flipping to true is the v1.1 deliverable per design doc §10).
--
-- Kept as a flat jsonb so Stage 4 (deploy) and Stage 7 (orchestration) can
-- add new flags without further migrations.
-- ============================================================================

ALTER TABLE public.site_builds
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.site_builds.config IS
  'Per-build feature flags + tuning knobs. v1 flags: phase_c_emit_cpt_routes (bool, default false).';
