-- 0025_projects_plugin_version.sql — JAB app + plugin v0.7.x alignment
-- (2026-06-03 alignment epic, Phase 2).
--
-- Captures the connected plugin's reported version at connect time so the app
-- can (a) gate v0.7.x-only features, (b) warn operators on outdated installs,
-- and (c) record version drift for debugging fidelity issues across sites.
-- Read from the REST /wp-json/jab/v1/manifest envelope via @jab/core
-- fetchManifest -> Manifest.pluginVersion -> probe -> connectWpAction.
--
-- Nullable: NULL means the plugin predates the plugin_version field or the
-- supplemental fetch failed (fail-soft). No backfill -- populated on the next
-- successful connect/probe.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS wp_plugin_version TEXT;

COMMENT ON COLUMN public.projects.wp_plugin_version IS
  'Plugin version reported by /wp-json/jab/v1/manifest at last successful connect. NULL when unreported (pre-v0.7.0 plugin or fetch failed).';

-- ============================================================================
-- End 0025_projects_plugin_version.sql
-- ============================================================================
