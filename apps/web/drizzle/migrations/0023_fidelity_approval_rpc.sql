-- 0023_fidelity_approval_rpc.sql — Phase 5 of the 2026-06-02 SaaS-app
-- internal-pilot completion plan.
--
-- The 0014 schema deliberately omitted an UPDATE policy on fidelity_reports
-- because a row-level policy can't restrict which columns get written —
-- a tenant member with raw UPDATE access could overwrite score / issues /
-- generated_screenshot_paths (worker-owned). The approval path therefore
-- needs a SECURITY DEFINER RPC that only updates the three approval
-- columns and only when the caller is a tenant member of the parent
-- project.
--
-- Status values mirror the existing CHECK constraint on
-- fidelity_reports.approval_status:
--   pending, approved, approved_with_issues, rejected
--
-- Re-running the function on an already-approved row is allowed (the
-- review screen lets reviewers downgrade an approval — e.g. flip
-- approved → rejected). approved_at + approved_by_user_id always update
-- to the latest action.

CREATE OR REPLACE FUNCTION public.approve_fidelity_report(
  p_build_id UUID,
  p_page_inventory_id UUID,
  p_status TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_uid UUID;
  v_project_id UUID;
  v_tenant_id UUID;
BEGIN
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'approve_fidelity_report: not authenticated';
  END IF;

  IF p_status NOT IN ('pending', 'approved', 'approved_with_issues', 'rejected') THEN
    RAISE EXCEPTION 'approve_fidelity_report: invalid status %', p_status;
  END IF;

  -- Resolve the project + tenant for membership check. SECURITY DEFINER
  -- means this read bypasses RLS, but we filter by the caller-supplied
  -- buildId so an attacker can only resolve projects via their own buildIds.
  SELECT sb.project_id, p.tenant_id
    INTO v_project_id, v_tenant_id
    FROM public.site_builds sb
    JOIN public.projects p ON p.id = sb.project_id
   WHERE sb.id = p_build_id;

  IF v_project_id IS NULL THEN
    RAISE EXCEPTION 'approve_fidelity_report: build % not found', p_build_id;
  END IF;

  -- Membership check: the caller must belong to the project's tenant.
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_members
     WHERE tenant_id = v_tenant_id
       AND user_id = v_caller_uid
  ) THEN
    RAISE EXCEPTION 'approve_fidelity_report: caller is not a member of the project tenant';
  END IF;

  UPDATE public.fidelity_reports
     SET approval_status = p_status,
         approved_by_user_id = v_caller_uid,
         approved_at = NOW()
   WHERE site_build_id = p_build_id
     AND page_inventory_id = p_page_inventory_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'approve_fidelity_report: no fidelity row for build % / page %',
      p_build_id, p_page_inventory_id;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.approve_fidelity_report(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_fidelity_report(UUID, UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION public.approve_fidelity_report(UUID, UUID, TEXT) IS
  'Phase 5 review-gate writer. Tenant members call this RPC to flip a per-page approval; raw UPDATE on fidelity_reports stays locked off because it cannot enforce the column-level restriction.';

-- ============================================================================
-- End 0023_fidelity_approval_rpc.sql
-- ============================================================================
