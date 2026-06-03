-- 0026_publish_build_promote_rpc.sql — Code-review fix F4.
--
-- The publishBuildAction (Phase 5 in the 2026-06-02 SaaS-app completion
-- plan) does two DB writes after the Vercel promote network call:
--
--   1. INSERT a production 'ready' deployments row.
--   2. UPDATE prior production 'ready' rows to 'superseded'.
--
-- These used to run as two separate Supabase round-trips. A double-submit
-- or a transient failure between them could leave the table with two ready
-- production rows for one project, or a fresh row with no supersede sweep.
--
-- This RPC bundles both writes into one Postgres transaction. The partial
-- unique index from 0025 (deployments_production_ready_project_idx) is the
-- backstop against concurrent invocations: two parallel callers both run
-- the supersede UPDATE (a no-op for the second), then INSERT — the second
-- commit fails with 23505 and the caller sees a clear error rather than a
-- divergent table state.
--
-- ORDERING NOTE: the supersede UPDATE must run BEFORE the INSERT. Postgres
-- partial unique indexes cannot be DEFERRABLE, so if the INSERT ran first
-- it would collide with the still-'ready' prior row and abort the whole
-- transaction. Superseding first clears the index slot the INSERT needs.
--
-- The Vercel network call (vercel.requestPromote) still happens BEFORE this
-- RPC. Vercel's promote is idempotent — re-promoting the same preview
-- deployment id to production is a no-op — so a publish that fails on the
-- RPC and is retried is safe.
--
-- Auth: SECURITY DEFINER + the same tenant_members membership check the
-- approve_fidelity_report RPC (migration 0023) uses.

CREATE OR REPLACE FUNCTION public.promote_build_to_production(
  p_build_id UUID,
  p_provider_deployment_id TEXT,
  p_url TEXT,
  p_promoted_from_deployment_id UUID
) RETURNS TABLE (
  deployment_id UUID,
  superseded_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_uid UUID;
  v_project_id UUID;
  v_tenant_id UUID;
  v_new_id UUID;
  v_superseded INTEGER;
BEGIN
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'promote_build_to_production: not authenticated';
  END IF;

  IF p_provider_deployment_id IS NULL OR length(p_provider_deployment_id) = 0 THEN
    RAISE EXCEPTION 'promote_build_to_production: provider_deployment_id is required';
  END IF;

  -- Resolve project + tenant for the membership check. The RPC is SECURITY
  -- DEFINER, so this read bypasses RLS, but we filter by the caller-supplied
  -- build id so an attacker can only resolve projects via their own build ids.
  SELECT sb.project_id, p.tenant_id
    INTO v_project_id, v_tenant_id
    FROM public.site_builds sb
    JOIN public.projects p ON p.id = sb.project_id
   WHERE sb.id = p_build_id;
  IF v_project_id IS NULL THEN
    RAISE EXCEPTION 'promote_build_to_production: build % not found', p_build_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_members
     WHERE tenant_id = v_tenant_id
       AND user_id = v_caller_uid
  ) THEN
    RAISE EXCEPTION 'promote_build_to_production: caller is not a member of the project tenant';
  END IF;

  -- Step 1 (intra-transaction): supersede prior ready production rows.
  -- MUST run before the INSERT so the partial unique index doesn't raise
  -- 23505 against a row this same transaction is about to retire.
  UPDATE public.deployments
     SET status = 'superseded'
   WHERE project_id = v_project_id
     AND environment = 'production'
     AND status = 'ready';
  GET DIAGNOSTICS v_superseded = ROW_COUNT;

  -- Step 2: insert the new ready production row.
  INSERT INTO public.deployments (
    site_build_id,
    project_id,
    environment,
    status,
    provider,
    provider_deployment_id,
    url,
    promoted_from_deployment_id,
    ready_at
  ) VALUES (
    p_build_id,
    v_project_id,
    'production',
    'ready',
    'vercel',
    p_provider_deployment_id,
    p_url,
    p_promoted_from_deployment_id,
    NOW()
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT v_new_id, v_superseded;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.promote_build_to_production(UUID, TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.promote_build_to_production(UUID, TEXT, TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION public.promote_build_to_production(UUID, TEXT, TEXT, UUID) IS
  'F4: atomic publish — supersedes prior ready production deployments and inserts the new one in one transaction. Partial unique index deployments_production_ready_project_idx (0025) is the backstop against concurrent calls.';

-- ============================================================================
-- End 0026_publish_build_promote_rpc.sql
-- ============================================================================
