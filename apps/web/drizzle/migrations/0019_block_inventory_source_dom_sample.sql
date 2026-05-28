-- ============================================================================
-- 0019_block_inventory_source_dom_sample.sql
-- ----------------------------------------------------------------------------
-- Closes the brand-grounding loop for downstream LLM prompts. Before this,
-- Phase A captured block trees (semantic) + screenshots (pixels) + theme
-- stylesheets (CSS) but had no bridge from "this block in inventory" to
-- "those DOM classes on the rendered page" — leaving the LLM to guess at
-- which CSS rules style which block.
--
-- This column stores a representative outerHTML snippet per block. The
-- aggregator in lib/jab/aggregate-dom-samples.ts walks Phase A's per-page
-- Playwright DOM captures and correlates by block kind:
--   - core/* + acf/* blocks via the standard `wp-block-{name}` class
--   - acf_flex/* layouts via positional correlation (Nth ACF flex entry
--     → Nth direct child of <main>)
--   - cpt_template/* wrappers via the page's <article> / <main> outer HTML
--
-- Storage: plain TEXT. Capped to 50 KB per row in the aggregator. Sites
-- with pathological DOM (deeply nested theme markup) lose the tail.
-- NULL when correlation was ambiguous — better to omit than emit wrong.
-- ============================================================================

ALTER TABLE public.block_inventory
  ADD COLUMN IF NOT EXISTS source_dom_sample TEXT;

COMMENT ON COLUMN public.block_inventory.source_dom_sample IS
  'Representative outerHTML for this block from one of its source pages. NULL when DOM correlation was ambiguous or no rendered occurrence was captured (custom-themed sites without wp-block-* classes, layouts unmatched by positional heuristic, etc.). Capped at 50 KB.';
