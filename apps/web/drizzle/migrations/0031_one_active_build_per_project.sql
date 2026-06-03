-- 0031_one_active_build_per_project.sql — S4, e2e-loop design §3.4.
--
-- The hard backstop against two genuinely-concurrent ACTIVE builds for one
-- project. A partial unique index on project_id, scoped to the active phases
-- EXCLUDING 'queued'. Excluding queued is deliberate (spec §3.4):
--   - Two racing inserts both land as 'queued' (no constraint violation), so
--     the app-level isActiveBuildStatus check arbitrates the FRIENDLY path
--     instead of one insert throwing a raw 23505 at the user.
--   - A crashed worker (retries:0 + process death) can leave a row stuck in an
--     active phase; excluding 'queued' plus a documented operator-recovery path
--     (UPDATE the wedged row to 'failed') avoids a permanently un-buildable
--     project.
-- The index is the hard backstop; the app check is the friendly fast path.
--
-- triggerBuildAction and requestWorkspaceEditAction both catch 23505 from this
-- index and translate to a friendly 'active_build' error.

CREATE UNIQUE INDEX IF NOT EXISTS site_builds_one_active_per_project_idx
  ON public.site_builds (project_id)
  WHERE status IN ('discovering', 'components', 'composing', 'building', 'verifying');

COMMENT ON INDEX public.site_builds_one_active_per_project_idx IS
  'At most one ACTIVE (non-queued, non-terminal) build per project. Excludes queued so racing inserts arbitrate at the app level (spec §3.4). Recovery for a wedged active row: operator UPDATE site_builds SET status=''failed'' WHERE id=<wedged>.';

-- ============================================================================
-- End 0031_one_active_build_per_project.sql
-- ============================================================================
