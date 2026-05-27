import "server-only";

/**
 * paradigm-detection.ts — Phase A per-page classification.
 *
 * Pure functions, no I/O. The discoverSite worker calls these after every
 * jab/get-{cpt}-by-slug response to classify what content paradigm the
 * page is actually using (gutenberg / classic / acf_flex / acf_template /
 * unknown). Outputs drive paradigms persistence on page_inventory and
 * Phase B's inventory enrichment.
 *
 * Spec: docs/superpowers/specs/2026-05-27-paradigm-aware-discovery-design.md
 */

export type Paradigm = "gutenberg" | "classic" | "acf_flex" | "acf_template" | "unknown";

/**
 * Subset of JSON Schema we care about for ACF detection. The manifest's
 * outputSchema is typed as `Record<string, unknown>` because it's the raw
 * shape WP emits — we narrow ad-hoc as needed via runtime predicates.
 */
export type JsonSchema = Record<string, unknown>;

/**
 * Walk a CPT's ACF schema (the `acf` property under
 * `output_schema.properties.{wrapperKey}.oneOf[0].properties`) and return
 * the names of every flexible_content field. The flexible_content shape
 * is always:
 *   { type: "array", items: <variant> | { oneOf: [<variant>, ...] } }
 * where each variant has properties.acf_fc_layout with an enum (the
 * layout discriminator emitted by AcfSchema::flexible_content_variants).
 *
 * Returns [] for null / non-object inputs.
 */
export function findFlexibleContentFieldNames(cptAcfSchema: JsonSchema | null): string[] {
  if (!cptAcfSchema || typeof cptAcfSchema !== "object") return [];
  const props = (cptAcfSchema as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object") return [];

  const names: string[] = [];
  for (const [name, raw] of Object.entries(props)) {
    if (!raw || typeof raw !== "object") continue;
    const field = raw as { type?: unknown; items?: unknown };
    if (field.type !== "array") continue;
    if (!field.items || typeof field.items !== "object") continue;

    // Two shapes: items is a single variant, or items.oneOf is a list of variants.
    const items = field.items as { oneOf?: unknown; properties?: unknown };
    const variants: unknown[] = Array.isArray(items.oneOf)
      ? items.oneOf
      : [items];

    const allHaveDiscriminator = variants.every((v) => {
      if (!v || typeof v !== "object") return false;
      const variant = v as { properties?: Record<string, unknown> };
      const fcProp = variant.properties?.acf_fc_layout;
      if (!fcProp || typeof fcProp !== "object") return false;
      const fc = fcProp as { enum?: unknown };
      return Array.isArray(fc.enum);
    });

    // `every` on an empty array is vacuously true, so the explicit
    // length guard prevents treating `oneOf: []` as a flex field.
    if (variants.length > 0 && allHaveDiscriminator) names.push(name);
  }
  return names;
}
