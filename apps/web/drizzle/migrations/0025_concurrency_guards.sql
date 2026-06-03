-- 0025_concurrency_guards.sql — Code-review fix F1 + F4.
--
-- Two partial unique indexes:
--
--   1. site_builds: one active build per project. Closes the check-then-
--      insert race in triggerBuildAction (lib/actions/trigger-build.ts) and
--      the parallel bypass in editSite.create-result-build (lib/inngest/
--      functions/edit-site.ts). The application-level "latest is active"
--      query remains as a friendly pre-check; this index is the source of
--      truth and turns a race into a 23505 unique violation the actions
--      can translate to "active_build".
--
--   2. deployments: one production+ready deployment per project. Sets up
--      F4's idempotent publish path — the RPC in 0026 supersedes prior
--      ready rows in the same transaction as the insert, and this index
--      catches concurrent publishes that would otherwise commit two
--      "ready" production rows.
--
-- Both are partial — terminal site_builds rows (ready, failed, cancelled)
-- and non-ready / non-production deployment rows are unconstrained, so the
-- historical table doesn't collapse under the new constraint.
--
-- The active-status list mirrors ACTIVE_PHASES in lib/jab/build-status.ts
-- and the CHECK constraint in 0014_saas_v2_schema.sql. Keep all three in sync.

CREATE UNIQUE INDEX site_builds_active_project_idx
  ON public.site_builds (project_id)
  WHERE status IN (
    'queued', 'discovering', 'components', 'composing', 'building', 'verifying'
  );

COMMENT ON INDEX public.site_builds_active_project_idx IS
  'F1: one active build per project. Insert raises 23505 if another active row exists; actions translate to TriggerBuildError("active_build").';

CREATE UNIQUE INDEX deployments_production_ready_project_idx
  ON public.deployments (project_id)
  WHERE environment = 'production' AND status = 'ready';

COMMENT ON INDEX public.deployments_production_ready_project_idx IS
  'F4: one ready production deployment per project. The 0026 RPC supersedes prior rows inside the same transaction as the insert; concurrent publishes race on this index and the second commit fails.';

-- ============================================================================
-- End 0025_concurrency_guards.sql
-- ============================================================================
