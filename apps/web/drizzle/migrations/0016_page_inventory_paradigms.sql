-- ============================================================================
-- 0016_page_inventory_paradigms.sql — paradigm-aware discovery
-- ----------------------------------------------------------------------------
-- Adds a paradigms column to page_inventory so Phase C knows how to render
-- each page. Detected by Phase A's per-page paradigm classifier.
--
--   paradigms TEXT[] — ordered list of detected content paradigms:
--     acf_flex / acf_template (frame) → gutenberg / classic (content) → unknown
--   - Multi-paradigm pages list all applicable paradigms in render order
--   - `unknown` is exclusive (never combined)
--   - Empty array = detection hasn't run (e.g. legacy builds before 0016)
--
-- Additive-only migration. Existing rows get [] via the default; the next
-- discoverSite run populates them when re-triggered for that build.
--
-- Spec: docs/superpowers/specs/2026-05-27-paradigm-aware-discovery-design.md
-- ============================================================================

ALTER TABLE public.page_inventory
  ADD COLUMN IF NOT EXISTS paradigms TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN public.page_inventory.paradigms IS
  'Detected content paradigms for this page in render order: acf_flex / acf_template (frame) then gutenberg / classic (content) then unknown (fallback). Multi-paradigm pages list all that apply. unknown is exclusive (never combined). Empty array means detection has not run (e.g. legacy builds before migration 0016).';

-- ============================================================================
-- End 0016_page_inventory_paradigms.sql
-- ============================================================================
