-- ============================================================================
-- 0007_promote_preview.sql — atomic claim-and-create for the wow-flow
-- ----------------------------------------------------------------------------
-- Without an atomic primitive, two near-simultaneous auth events from the
-- same browser (e.g. the user opens the email confirmation in one tab while
-- the password sign-in tab is still pending) both pass the
-- `promoted_to_project_id IS NULL` check, each insert a `projects` row,
-- and the user lands with a duplicate draft they never created.
--
-- This function makes the claim atomic: a `UPDATE ... WHERE ... IS NULL`
-- is the serialization point — only one caller succeeds; the other gets
-- `NOT FOUND` and returns null.
--
-- Ordering:
--   1. Pre-generate the project id (gen_random_uuid) so we can write it
--      into anonymous_previews FIRST and reject race-losers cheaply.
--   2. UPDATE anonymous_previews — fails fast if already promoted.
--   3. INSERT projects with the pre-allocated id.
--
-- If step 3 fails (FK violation, etc.) the row will have a dangling
-- promoted_to_project_id. Acceptable: re-running the action sees
-- `promoted_to_project_id IS NOT NULL` and skips, so we don't double-
-- charge the user; the project just never materialized. Rare enough we
-- accept it for now; a sweeper can NULL out dangling claims if it
-- becomes a real pattern.
--
-- NOT SECURITY DEFINER — service-role caller has direct write access to
-- both tables (RLS bypassed). SECURITY INVOKER avoids the elevated-
-- privilege footgun documented in 0002_lock_down_security_definer_functions.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.promote_anonymous_preview(
  p_preview_id UUID,
  p_tenant_id UUID,
  p_project_name TEXT,
  p_wp_url TEXT
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_project_id UUID;
  v_claimed_count INTEGER;
BEGIN
  v_project_id := gen_random_uuid();

  UPDATE public.anonymous_previews
  SET promoted_to_project_id = v_project_id
  WHERE id = p_preview_id
    AND promoted_to_project_id IS NULL
    AND expires_at > NOW();

  GET DIAGNOSTICS v_claimed_count = ROW_COUNT;

  IF v_claimed_count = 0 THEN
    -- Already promoted (race lost), or row vanished / expired between the
    -- caller's read and this UPDATE. Either way, no project should be
    -- created.
    RETURN NULL;
  END IF;

  INSERT INTO public.projects (id, tenant_id, name, wp_url, status)
  VALUES (v_project_id, p_tenant_id, p_project_name, p_wp_url, 'draft');

  RETURN v_project_id;
END;
$$;

COMMENT ON FUNCTION public.promote_anonymous_preview IS
  'Atomic wow-flow claim-and-create. UPDATE is the serialization point. Returns NULL on race-lost / already-promoted / expired.';
