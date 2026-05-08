-- ============================================================================
-- test-tenant-isolation.sql
-- ----------------------------------------------------------------------------
-- Phase B Task 11 — acceptance gate.
--
-- The static checks (RLS enabled, every table has policies) are run
-- automatically on every migration via the Supabase MCP. This file holds
-- the DYNAMIC isolation test: prove a second tenant cannot see, insert
-- into, update, or delete the first tenant's projects.
--
-- HOW TO RUN
-- 1. Sign up two test accounts in dev (different emails, e.g.
--    test-a@example.com and test-b@example.com).
-- 2. From Supabase Studio → SQL Editor, query auth.users for each:
--      SELECT id, email FROM auth.users WHERE email LIKE 'test-%@example.com';
-- 3. Replace USER_A_ID and USER_B_ID below with the real UUIDs.
-- 4. Run as the postgres role (default in Studio).
--
-- Each "❌ MUST RETURN 0 ROWS" assertion is the gate. If any assertion
-- leaks, RLS is broken — DO NOT ship and DO NOT proceed to Phase C until
-- the policy is fixed.
-- ============================================================================

-- ---- SETUP -----------------------------------------------------------------
-- Replace these two UUIDs with values from auth.users:
\set user_a '11111111-1111-1111-1111-111111111111'
\set user_b '22222222-2222-2222-2222-222222222222'

-- Sanity: each test user got exactly one tenant + one membership from the
-- handle_new_user trigger.
SELECT
  user_id,
  COUNT(*) AS membership_count
FROM public.tenant_members
WHERE user_id IN (:'user_a'::uuid, :'user_b'::uuid)
GROUP BY user_id;
-- Expected: each user → 1 row.

-- Insert a project as user A (using their tenant_id from the trigger).
INSERT INTO public.projects (tenant_id, name, client_name, wp_url)
SELECT tenant_id, 'A''s secret project', 'Confidential Client', 'https://a.example.com'
FROM public.tenant_members
WHERE user_id = :'user_a'::uuid;

-- ---- ASSERTIONS as user B --------------------------------------------------
-- Switch to the authenticated role + simulate user B's JWT.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'user_b', true);

-- ❌ MUST RETURN 0 ROWS: user B should not see user A's project.
SELECT id, name, client_name FROM public.projects WHERE name = 'A''s secret project';

-- ❌ MUST RETURN 0 ROWS: user B should not see user A's tenant.
SELECT id, name FROM public.tenants
WHERE id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = :'user_a'::uuid);

-- ❌ MUST RAISE / 0 ROWS AFFECTED: user B inserting into user A's tenant
-- should be blocked by the WITH CHECK clause on the projects insert policy.
INSERT INTO public.projects (tenant_id, name, client_name, wp_url)
SELECT tenant_id, 'B trying to inject', 'pwned', 'https://b.example.com'
FROM public.tenant_members
WHERE user_id = :'user_a'::uuid;

-- ❌ MUST RETURN 0 ROWS AFFECTED: user B updating user A's project.
UPDATE public.projects SET name = 'B owns this now' WHERE name = 'A''s secret project';

-- ❌ MUST RETURN 0 ROWS AFFECTED: user B deleting user A's project.
DELETE FROM public.projects WHERE name = 'A''s secret project';

-- ---- TEARDOWN --------------------------------------------------------------
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', NULL, true);

-- Clean up test data (run as postgres again).
DELETE FROM public.projects WHERE name IN (
  'A''s secret project',
  'B trying to inject',
  'B owns this now'
);

-- ============================================================================
-- If every "MUST RETURN 0 ROWS" assertion held, RLS is honest. Ship.
-- ============================================================================
