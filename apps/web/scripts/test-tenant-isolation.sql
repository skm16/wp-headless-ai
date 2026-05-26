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

-- ============================================================================
-- SaaS v2 tables — extended isolation gates
-- ----------------------------------------------------------------------------
-- Five new tables landed in migration 0014: site_builds, deployments,
-- block_inventory, page_inventory, fidelity_reports. All are tenant-scoped
-- via project_id → projects.tenant_id. Each gets the same boundary check:
-- user B cannot SELECT user A's rows. None of these tables have INSERT/UPDATE
-- policies for tenant users — workers write via service-role, mirroring the
-- generation_jobs precedent in migration 0004 (and the explicit Task 1
-- review-fix decision to remove the originally-proposed site_builds INSERT
-- and fidelity_reports UPDATE policies, which had column-tampering risk).
--
-- Run AS POSTGRES (the cleanup at the bottom needs unrestricted DELETE).
-- ============================================================================

-- ---- SETUP: insert a build + child rows owned by user A's tenant ----------
-- Reset role to postgres for the seed inserts so RLS doesn't get in the way.
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', NULL, true);

-- Get user A's project_id by name (created earlier in this script).
-- A real run inserts the row in the "INSERT as user A" block above; the
-- following uses the same name to look it up.
WITH a_proj AS (
  SELECT id, tenant_id
  FROM public.projects
  WHERE name = 'A''s secret project'
  LIMIT 1
), build AS (
  INSERT INTO public.site_builds (project_id, status)
  SELECT id, 'queued' FROM a_proj
  RETURNING id, project_id
)
INSERT INTO public.page_inventory (site_build_id, project_id, slug, post_type, route_path)
SELECT b.id, b.project_id, 'a-secret-slug', 'page', '/a-secret-slug'
FROM build b;

WITH a_proj AS (
  SELECT id FROM public.projects WHERE name = 'A''s secret project' LIMIT 1
), a_build AS (
  SELECT id FROM public.site_builds
  WHERE project_id = (SELECT id FROM a_proj)
  LIMIT 1
)
INSERT INTO public.deployments (site_build_id, project_id, environment, status)
SELECT (SELECT id FROM a_build), (SELECT id FROM a_proj), 'preview', 'pending'
WHERE (SELECT id FROM a_build) IS NOT NULL;

WITH a_proj AS (
  SELECT id FROM public.projects WHERE name = 'A''s secret project' LIMIT 1
), a_build AS (
  SELECT id FROM public.site_builds
  WHERE project_id = (SELECT id FROM a_proj)
  LIMIT 1
)
INSERT INTO public.block_inventory (site_build_id, project_id, block_name, occurrence_count, tier)
SELECT (SELECT id FROM a_build), (SELECT id FROM a_proj), 'core/heading', 3, 'trivial'
WHERE (SELECT id FROM a_build) IS NOT NULL;

WITH a_proj AS (
  SELECT id FROM public.projects WHERE name = 'A''s secret project' LIMIT 1
), a_build AS (
  SELECT id FROM public.site_builds
  WHERE project_id = (SELECT id FROM a_proj)
  LIMIT 1
), a_page AS (
  SELECT id FROM public.page_inventory
  WHERE site_build_id = (SELECT id FROM a_build)
  LIMIT 1
)
INSERT INTO public.fidelity_reports (site_build_id, project_id, page_inventory_id, score)
SELECT (SELECT id FROM a_build), (SELECT id FROM a_proj), (SELECT id FROM a_page), 0.87
WHERE (SELECT id FROM a_build) IS NOT NULL AND (SELECT id FROM a_page) IS NOT NULL;

-- ---- ASSERTIONS as user B --------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'user_b', true);

-- ❌ MUST RETURN 0 ROWS — every new table is invisible to user B.
SELECT id, status FROM public.site_builds
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');

SELECT id, environment, status FROM public.deployments
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');

SELECT id, block_name FROM public.block_inventory
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');

SELECT id, slug FROM public.page_inventory
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');

SELECT id, score FROM public.fidelity_reports
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');

-- ❌ MUST RAISE — no INSERT policy on site_builds for tenant users. The
-- Task 1 review fix removed the originally-proposed site_builds_tenant_insert
-- policy (state-machine-injection risk). Now site_builds is service-role-only
-- for writes; this user-context INSERT fails outright with an RLS violation.
INSERT INTO public.site_builds (project_id, status)
SELECT id, 'queued' FROM public.projects WHERE name = 'A''s secret project';

-- ❌ MUST RETURN 0 ROWS AFFECTED — no UPDATE policy on fidelity_reports for
-- tenant users (Task 1 review fix dropped the column-tampering-prone
-- fidelity_reports_tenant_update policy; the approval path is reserved for
-- a SECURITY DEFINER RPC to be designed in Phase F). The update has nothing
-- to operate on and no permission to perform the operation anyway.
UPDATE public.fidelity_reports
SET approval_status = 'approved'
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');

-- ---- TEARDOWN of v2 rows ---------------------------------------------------
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', NULL, true);

DELETE FROM public.fidelity_reports
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');
DELETE FROM public.block_inventory
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');
DELETE FROM public.page_inventory
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');
DELETE FROM public.deployments
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');
DELETE FROM public.site_builds
WHERE project_id IN (SELECT id FROM public.projects WHERE name = 'A''s secret project');

-- Clean up test data (run as postgres again).
DELETE FROM public.projects WHERE name IN (
  'A''s secret project',
  'B trying to inject',
  'B owns this now'
);

-- ============================================================================
-- If every "MUST RETURN 0 ROWS" assertion held, RLS is honest. Ship.
-- ============================================================================
