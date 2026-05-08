-- ============================================================================
-- 0003_onboarding_credentials.sql — Phase C
-- ----------------------------------------------------------------------------
-- Adds encrypted credential storage + manifest snapshot to projects.
--
-- Design notes:
--   • Credentials are stored as `bytea` ciphertext produced by AES-256-GCM in
--     application code (`apps/web/lib/crypto/encrypt.ts`). The DB never sees
--     plaintext. Format: 12-byte IV ‖ 16-byte auth-tag ‖ ciphertext.
--   • `manifest` is a JSONB snapshot of @jab/core's Manifest type, captured
--     at probe time. Re-probing overwrites it.
--   • Phase B's RLS policies on projects already gate read/write/update by
--     tenant — these new columns inherit that protection. No new policies
--     needed.
-- ============================================================================

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS wp_username TEXT,
  ADD COLUMN IF NOT EXISTS wp_app_password_encrypted BYTEA,
  ADD COLUMN IF NOT EXISTS github_repo_full_name TEXT,
  ADD COLUMN IF NOT EXISTS github_pat_encrypted BYTEA,
  ADD COLUMN IF NOT EXISTS manifest JSONB,
  ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;

-- Allowed status values now include 'onboarding' and 'ready' (already
-- referenced in Phase B but never enforced). Keep open-ended for future
-- statuses (archived, error, etc.) — string column, no CHECK constraint.

COMMENT ON COLUMN public.projects.wp_app_password_encrypted IS
  'AES-256-GCM ciphertext: iv(12) || tag(16) || data. Plaintext is the WP application password.';
COMMENT ON COLUMN public.projects.github_pat_encrypted IS
  'AES-256-GCM ciphertext (same format). Plaintext is a fine-grained GitHub PAT scoped to github_repo_full_name.';
COMMENT ON COLUMN public.projects.manifest IS
  '@jab/core Manifest snapshot captured at probe time. Drives AI generation prompts in Phase D.';
