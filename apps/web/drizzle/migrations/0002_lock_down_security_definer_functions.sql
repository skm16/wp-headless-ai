-- ============================================================================
-- 0002_lock_down_security_definer_functions.sql
-- ----------------------------------------------------------------------------
-- Hide handle_new_user() from the PostgREST RPC surface. It's a trigger
-- function — only `auth.users` inserts should invoke it, never an HTTP call.
--
-- Triggers run as the function owner (postgres) regardless of REVOKE on the
-- calling roles, so the auth.users INSERT path keeps working.
--
-- current_user_tenant_ids() is left callable: it only returns tenant IDs the
-- caller already knows (their own), and RLS policies depend on every
-- authenticated user being able to invoke it. Lint warnings on it are noise.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM authenticated;
