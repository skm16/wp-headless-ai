-- 0033_page_inventory_link.sql — 2026-06-10 faithful-clone campaign (Track 2).
--
-- The absolute source permalink (WP get_permalink) for each discovered page.
-- Fetched at discovery since v2 Phase A (PostListRow.link) but dropped at
-- persist. Needed to build the compose-time sourcePathname -> route_path map
-- that lets the origin-link rewriter map diverged paths (nested pages, CPT
-- rewrite bases) onto real clone routes instead of guessing.
ALTER TABLE public.page_inventory ADD COLUMN IF NOT EXISTS link text;
COMMENT ON COLUMN public.page_inventory.link IS
  'Absolute source permalink captured at discovery. NULL for pre-0033 rows. Drives buildRoutePathMap (2026-06-10 faithful-clone campaign).';
