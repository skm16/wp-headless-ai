-- ============================================================================
-- 0012_preview_html_status.sql — track regeneration state of preview_html
-- ----------------------------------------------------------------------------
-- The wow-preview HTML carried over from anonymous_previews is a
-- public-scrape snapshot. After the user finishes onboarding, an Inngest
-- worker re-scrapes the connected WP install and regenerates the homepage
-- HTML with the user's *intent* (faithful / refresh / reimagine) baked
-- into the renderer prompt. While that worker runs the workspace needs to
-- know "this preview is being rebuilt" — that's what this column carries.
--
-- States:
--   NULL         — no regeneration has been triggered. Legacy + freshly-
--                  promoted projects start here; the workspace renders the
--                  promoted wow-preview HTML as-is.
--   'generating' — worker is in flight. Workspace shows a "Regenerating
--                  with [intent] treatment" panel instead of the iframe.
--   'ready'      — worker completed; `preview_html` reflects the connected
--                  homepage rendered against the user's intent. Workspace
--                  renders the new HTML in the iframe.
--   'failed'     — worker errored. Workspace shows a "Regeneration failed"
--                  panel + a manual retry button. The previous preview_html
--                  is left in place so the user isn't staring at a blank
--                  iframe just because the regen lost a round-trip.
--
-- A CHECK constraint enforces the value set so a typo in app code surfaces
-- at insert time rather than silently storing garbage. NULL is allowed —
-- it's the legacy state, not an "unknown" sentinel.
-- ============================================================================

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS preview_html_status TEXT
    CHECK (preview_html_status IN ('generating', 'ready', 'failed'));

COMMENT ON COLUMN public.projects.preview_html_status IS
  'Regeneration state of preview_html: NULL=legacy/promoted snapshot, generating=worker running, ready=intent-aware regen done, failed=worker errored (previous preview kept).';
