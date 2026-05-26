-- ============================================================================
-- 0015_inventory_kind_spec.sql — Stage 2 inventory extension
-- ----------------------------------------------------------------------------
-- Adds two columns to block_inventory needed by Phase B component generation:
--
--   kind TEXT — discriminates the entry type:
--     'block'        — standard core/* or acf/* block (existing entries)
--     'acf_flex'     — ACF Flexible Content layout variant
--                      block_name format: acf_flex/{cptSlug}/{fieldPath}/{layoutName}
--     'cpt_template' — Non-page CPT single-post template wrapper
--                      block_name format: cpt_template/{cptSlug}
--                      NOTE: page CPT is hard-excluded (bespoke content).
--
--   spec JSONB — optional structured context passed to the component prompt:
--     acf_flex:     the layout's sub_fields attr sample
--     cpt_template: JSON array of block name strings in the CPT template
--     block:        NULL (unused for standard blocks)
--
-- Additive-only migration. No existing rows are modified — they get
-- kind = 'block' (the default) and spec = NULL via the column defaults.
-- ============================================================================

ALTER TABLE public.block_inventory
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'block'
    CHECK (kind IN ('block', 'acf_flex', 'cpt_template')),
  ADD COLUMN IF NOT EXISTS spec JSONB;

COMMENT ON COLUMN public.block_inventory.kind IS
  'Entry discriminator: block (core/*/acf/* standard blocks), acf_flex (ACF Flexible Content layout variant), cpt_template (non-page CPT single-post template). page CPT is hard-excluded from cpt_template.';

COMMENT ON COLUMN public.block_inventory.spec IS
  'Structured context for the component generator. acf_flex: layout sub_fields attr sample; cpt_template: block name union array; block: NULL.';

-- ============================================================================
-- End 0015_inventory_kind_spec.sql
-- ============================================================================
