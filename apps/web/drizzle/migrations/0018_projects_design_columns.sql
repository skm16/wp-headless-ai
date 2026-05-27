-- ============================================================================
-- 0018_projects_design_columns.sql
-- ----------------------------------------------------------------------------
-- Backfill the projects columns that 0008 + 0009 declared but never landed
-- on the remote DB. Phase A's fetch-global-styles + extract-project-design
-- workers have been silently no-op'ing on these UPDATE calls for months
-- because Supabase silently ignores updates to nonexistent columns when
-- using the JS client's `.update({...})` (it returns no error, just zero
-- rows affected). This unblocks Phase C — the shell LLM calls need the
-- logo and theme.json tokens to produce brand-grounded header/footer
-- components.
--
-- 0008's anonymous_previews columns are intentionally skipped — that
-- table was retired in the Stage 0 SaaS v2 cleanup and no longer exists.
-- 0009's full migration is reproduced here verbatim (idempotent ADDs).
-- ============================================================================

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS design_tokens         JSONB,
  ADD COLUMN IF NOT EXISTS personality           JSONB,
  ADD COLUMN IF NOT EXISTS logo_storage_path     TEXT,
  ADD COLUMN IF NOT EXISTS favicon_storage_path  TEXT,
  ADD COLUMN IF NOT EXISTS og_image_storage_path TEXT;

COMMENT ON COLUMN public.projects.design_tokens IS
  'Merged design output: { themeJson?, scrapedDesign?, ... }. Populated by Phase A fetch-global-styles (themeJson sub-key) and the extract-project-design worker (scrapedDesign sub-key). NULL until either runs successfully.';
COMMENT ON COLUMN public.projects.personality IS
  'DesignAnalysis.personality block (tone, energy, audience). NULL until extract-project-design runs.';
COMMENT ON COLUMN public.projects.logo_storage_path IS
  'Bucket-relative path in `project-assets`. Populated by extract-project-design. NULL if scrape failed or no logo identified.';
COMMENT ON COLUMN public.projects.favicon_storage_path IS
  'Bucket-relative path in `project-assets`. NULL if capture failed.';
COMMENT ON COLUMN public.projects.og_image_storage_path IS
  'Bucket-relative path in `project-assets`. NULL if no og:image / twitter:image found.';
