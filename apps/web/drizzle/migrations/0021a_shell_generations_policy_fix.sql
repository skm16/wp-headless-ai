-- ============================================================================
-- 0021a_shell_generations_policy_fix.sql
-- ----------------------------------------------------------------------------
-- Followup to 0021. Replaces the inline tenant_members join in the SELECT
-- policy with the established public.current_user_tenant_ids() helper used
-- by every other tenant-scoped policy (see 0004 / 0014). Behavior is
-- identical; this aligns naming + structure with the codebase convention so
-- future changes to the membership query land in one place.
-- ============================================================================

DROP POLICY IF EXISTS shell_generations_tenant_read ON public.shell_generations;

CREATE POLICY "shell_generations_tenant_select" ON public.shell_generations
  FOR SELECT
  USING (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
  );
