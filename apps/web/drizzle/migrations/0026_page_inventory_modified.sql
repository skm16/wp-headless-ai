-- 0026_page_inventory_modified.sql — JAB app + plugin v0.7.x alignment
-- (2026-06-03 alignment epic, Phase 5).
--
-- Records each page's WP modified_gmt (from the v0.7.0 REQUIRED row field) so
-- builds can diff WP-side state and drive incremental re-sync (Phase 7). NULL
-- for rows written before this column existed or when the source row carried
-- no usable modified timestamp.

ALTER TABLE public.page_inventory
  ADD COLUMN IF NOT EXISTS source_modified_gmt TIMESTAMPTZ;

COMMENT ON COLUMN public.page_inventory.source_modified_gmt IS
  'WP modified_gmt of the source post at discovery time (v0.7.0 row field). Drives incremental re-sync change detection. NULL when unknown.';

-- ============================================================================
-- End 0026_page_inventory_modified.sql
-- ============================================================================
