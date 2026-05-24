-- ============================================================================
-- 0011_project_onboarding_state.sql — wizard state on projects
-- ----------------------------------------------------------------------------
-- Backs the post-pivot onboarding wizard (§2 of docs/saas-mvp-transition.md).
-- Three columns:
--
--   • intent             — the user's project intent (Faithful / Refresh /
--                          Reimagine). NULL until step 0 of the wizard
--                          completes.
--   • content_ownership  — per-content-type ownership map. JSONB shape:
--                          { "<slug>": "wp-managed" | "jab-managed" }. NULL
--                          until step 3 of the wizard completes.
--   • preview_html       — the wow HTML rendered at /preview, copied here
--                          on signup-promote so the workspace and the
--                          wizard's right-rail can show the user the thing
--                          they just saved. The first real deploy will
--                          supersede it.
--
-- intent uses a CHECK constraint rather than a pg_enum so a future fourth
-- intent (or a rename) is a constraint update, not a schema migration. The
-- three values mirror the union type in `apps/web/components/intent-picker.tsx`.
--
-- content_ownership is JSONB (not a join table) because the keys are WP
-- post-type slugs we don't have a canonical list for — they vary per WP
-- install. JSONB sidesteps a schema-by-customer modeling problem.
--
-- preview_html is TEXT (no size cap). The renderer caps output at
-- MAX_OUTPUT_TOKENS = 16384 (lib/ai/preview-renderer.ts), comfortably under
-- any practical TEXT limit.
-- ============================================================================

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS intent            TEXT
    CHECK (intent IN ('faithful', 'refresh', 'reimagine')),
  ADD COLUMN IF NOT EXISTS content_ownership JSONB,
  ADD COLUMN IF NOT EXISTS preview_html      TEXT;

COMMENT ON COLUMN public.projects.intent IS
  'Project intent (Faithful / Refresh / Reimagine). NULL until the user finishes step 0 of onboarding.';
COMMENT ON COLUMN public.projects.content_ownership IS
  'Per-content-type ownership map { "<slug>": "wp-managed" | "jab-managed" }. NULL until the user finishes step 3 of onboarding.';
COMMENT ON COLUMN public.projects.preview_html IS
  'Promoted-from-anonymous-previews wow HTML. Rendered in the workspace preview card and in the wizard preview pane until the first real deploy supersedes it.';
