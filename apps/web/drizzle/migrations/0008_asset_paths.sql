-- ============================================================================
-- 0008_asset_paths.sql — captured-asset references for the wow flow
-- ----------------------------------------------------------------------------
-- Per transition doc §10 priority #2: save logo / favicon / OG image as
-- FILES (not URLs that can 404). The scrape-preview worker fetches each
-- asset URL extracted from the source page, uploads to Supabase Storage
-- under `previews/<previewId>/<name>.<ext>`, and persists the storage
-- path on the row.
--
-- On promote-on-signup the worker MOVEs the files from `previews/...` to
-- `projects/<projectId>/...` and copies the paths over to `projects`.
--
-- Storage layer: a public bucket named `project-assets`. The URLs end up
-- as srcDoc references in an iframe — they have to load without auth.
-- We're caching public images anyway; the original URLs were public.
--
-- Paths are stored bucket-relative (e.g. "previews/<uuid>/logo.png"); the
-- caller composes the full public URL via the Supabase project URL +
-- "/storage/v1/object/public/project-assets/" prefix at render time.
-- ============================================================================

ALTER TABLE public.anonymous_previews
  ADD COLUMN IF NOT EXISTS logo_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS favicon_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS og_image_storage_path TEXT;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS logo_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS favicon_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS og_image_storage_path TEXT;

COMMENT ON COLUMN public.anonymous_previews.logo_storage_path IS
  'Bucket-relative path in `project-assets`. NULL if capture failed or no logo was identified.';
COMMENT ON COLUMN public.anonymous_previews.favicon_storage_path IS
  'Bucket-relative path in `project-assets`. NULL if capture failed.';
COMMENT ON COLUMN public.anonymous_previews.og_image_storage_path IS
  'Bucket-relative path in `project-assets`. NULL if no og:image / twitter:image was found.';
