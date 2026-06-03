-- 0027_page_inventory_block_tree.sql — incremental skip-unchanged carry-forward
-- (2026-06-03 follow-up to the v0.7.x alignment epic, Phase 7 incremental sync).
--
-- Persists each page's raw WP block tree (the BlockNode[] returned by
-- jab/get-<cpt>-by-slug with include.blocks=true) so a later re-build can
-- re-aggregate block_inventory from the union of freshly-fetched changed pages
-- and carried-forward unchanged pages WITHOUT re-fetching the unchanged ones.
-- NULL for rows written before this column existed (those pages fall back to a
-- full re-fetch on the next incremental build).

ALTER TABLE public.page_inventory
  ADD COLUMN IF NOT EXISTS block_tree JSONB;

COMMENT ON COLUMN public.page_inventory.block_tree IS
  'Raw WP BlockNode[] for this page at discovery time. Source of truth for incremental carry-forward re-aggregation. NULL when unknown (pre-0027 rows).';

-- ============================================================================
-- End 0027_page_inventory_block_tree.sql
-- ============================================================================
