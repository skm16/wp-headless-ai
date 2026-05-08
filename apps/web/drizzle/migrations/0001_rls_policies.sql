-- ============================================================================
-- 0001_rls_policies.sql
-- ----------------------------------------------------------------------------
-- Row-Level Security policies for the multi-tenant boundary.
--
-- Model: every table either filters by tenant membership (via the
-- current_user_tenant_ids() helper) or by self-reference (auth.uid() = id).
-- Default-deny: ENABLE ROW LEVEL SECURITY without a matching policy means
-- the role can't access the table at all.
--
-- Service-role key bypasses RLS — used only by lib/supabase/admin.ts for
-- system operations. Audit any new admin client usage carefully.
-- ============================================================================

-- Helper: tenant_ids the current authenticated user belongs to.
-- SECURITY DEFINER so it can read tenant_members regardless of RLS — without
-- this, the policy on tenant_members would create a chicken-and-egg loop.
CREATE OR REPLACE FUNCTION public.current_user_tenant_ids()
RETURNS SETOF UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM public.tenant_members
  WHERE user_id = auth.uid()
$$;

-- Lock everything down by default.
ALTER TABLE public.profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects        ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- profiles: each user reads/updates their own row only.
-- No INSERT policy — handle_new_user trigger handles insertion (security definer).
-- No DELETE policy — cascades from auth.users.
-- ----------------------------------------------------------------------------
CREATE POLICY "profiles: own read"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "profiles: own update"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

-- ----------------------------------------------------------------------------
-- tenants: members can read tenants they belong to.
-- Phase B: trigger creates the default tenant; no app-side INSERT/UPDATE/DELETE.
-- ----------------------------------------------------------------------------
CREATE POLICY "tenants: member read"
  ON public.tenants FOR SELECT
  USING (id IN (SELECT public.current_user_tenant_ids()));

-- ----------------------------------------------------------------------------
-- tenant_members: members can see fellow members of shared tenants.
-- ----------------------------------------------------------------------------
CREATE POLICY "tenant_members: shared read"
  ON public.tenant_members FOR SELECT
  USING (tenant_id IN (SELECT public.current_user_tenant_ids()));

-- ----------------------------------------------------------------------------
-- projects: full CRUD scoped to the user's tenants.
-- WITH CHECK on INSERT/UPDATE prevents tenant_id swap attacks (e.g., a user
-- updating a project to set tenant_id to another tenant they don't belong to).
-- ----------------------------------------------------------------------------
CREATE POLICY "projects: tenant read"
  ON public.projects FOR SELECT
  USING (tenant_id IN (SELECT public.current_user_tenant_ids()));

CREATE POLICY "projects: tenant insert"
  ON public.projects FOR INSERT
  WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));

CREATE POLICY "projects: tenant update"
  ON public.projects FOR UPDATE
  USING (tenant_id IN (SELECT public.current_user_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));

CREATE POLICY "projects: tenant delete"
  ON public.projects FOR DELETE
  USING (tenant_id IN (SELECT public.current_user_tenant_ids()));
