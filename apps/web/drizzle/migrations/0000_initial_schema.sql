-- ============================================================================
-- 0000_initial_schema.sql
-- ----------------------------------------------------------------------------
-- The four base tables for the Jab SaaS multi-tenant model + the
-- handle_new_user trigger that auto-provisions a default tenant + owner
-- membership when Supabase Auth creates a new user.
--
-- Mirrors apps/web/lib/db/schema.ts. Keep them in sync; drift is invisible
-- until production.
--
-- Applied via the Supabase MCP (apply_migration) — recorded in
-- supabase_migrations.schema_migrations.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tenant_members (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL,
  role      TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  client_name TEXT,
  wp_url      TEXT,
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_tenant_id_idx ON public.projects(tenant_id);

-- ============================================================================
-- Foreign keys to auth.users — Drizzle can't introspect the auth schema, so
-- these go in raw SQL.
-- ============================================================================

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_id_fkey
  FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.tenant_members
  ADD CONSTRAINT tenant_members_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- ============================================================================
-- handle_new_user — fires AFTER INSERT on auth.users. Creates:
--   1. A profile row mirroring the auth user.
--   2. A default tenant named after the user's display name or email.
--   3. A tenant_members row making the user the owner of that tenant.
--
-- SECURITY DEFINER because auth.users insert fires before any user session
-- (and therefore RLS context) exists. The function runs as the postgres role,
-- which can write across schemas. search_path is locked down to prevent
-- search-path-based privilege escalation.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_tenant_id UUID;
  display TEXT;
BEGIN
  display := COALESCE(new.raw_user_meta_data->>'display_name', new.email);

  -- 1. Profile row mirrors auth metadata.
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (new.id, new.email, display);

  -- 2. Default tenant. User can rename later in their settings.
  INSERT INTO public.tenants (name) VALUES (display)
  RETURNING id INTO new_tenant_id;

  -- 3. Membership as owner.
  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  VALUES (new_tenant_id, new.id, 'owner');

  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
