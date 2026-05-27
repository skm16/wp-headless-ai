-- ============================================================================
-- 0017_block_inventory_kind_comment.sql — fix stale column comment
-- ----------------------------------------------------------------------------
-- Migration 0015 stated "page CPT is hard-excluded from cpt_template" in the
-- COMMENT ON COLUMN block_inventory.kind. Task 6 of the paradigm-aware
-- discovery work (commit 8a82179) replaced the hard-exclude with a conditional
-- rule — `cpt_template/page` rows ARE generated when at least one sampled
-- page CPT post has paradigm `acf_template`. Pure-gutenberg pages still
-- never produce a cpt_template/page entry.
--
-- This migration only updates the column comment to reflect current behavior.
-- No structural change.
-- ============================================================================

COMMENT ON COLUMN public.block_inventory.kind IS
  'Entry discriminator: block (core/*/acf/* standard blocks), acf_flex (ACF Flexible Content layout variant), cpt_template (CPT single-post template). cpt_template/page rows are emitted when a sampled page has paradigm acf_template; pure-gutenberg pages never produce cpt_template entries.';

-- ============================================================================
-- End 0017_block_inventory_kind_comment.sql
-- ============================================================================
