-- 0022_phase_d_deploy.sql — Phase D Build & Deploy
-- Adds the Vercel-side bookkeeping the deploy-site worker needs.
--
-- projects: vercel_project_id is the durable link to the Vercel project
-- we lazy-create on the first Phase D run for this JAB project.
-- vercel_project_name stores the slug we actually registered with Vercel
-- (lowercased, dashed) so renames of projects.name don't drift.
--
-- site_builds: preview_url is the per-build vercel.app URL Phase E
-- screenshots and Phase F previews. vercel_deployment_id is the durable
-- handle for log-fetching and (Phase F) production-alias binding.
-- build_log_storage_path points at builds/<id>/build-log.txt when the
-- deployment fails — NULL on success (we don't pay storage for successful
-- builds' logs; Vercel keeps them on their side).

ALTER TABLE public.projects
  ADD COLUMN vercel_project_id TEXT,
  ADD COLUMN vercel_project_name TEXT;

ALTER TABLE public.site_builds
  ADD COLUMN preview_url TEXT,
  ADD COLUMN vercel_deployment_id TEXT,
  ADD COLUMN build_log_storage_path TEXT;
