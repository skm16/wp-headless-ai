import type { Manifest } from "@jab/core";
import type { BlockDataSource } from "@/lib/jab/resolve-block-data-source";
import { summarizeAcfFields } from "./component-generator";
import { extractCptAcfSchema } from "@/lib/jab/paradigm-detection";
import { resolveCptAbilityMeta } from "@/lib/jab/ability-client";

/**
 * patch-data-shape — pure builder turning a resolved BlockDataSource + the
 * persisted manifest into a compact "## Runtime data shape" prompt section.
 * Fail-soft: returns "" whenever the fields can't be surfaced (no manifest,
 * unknown CPT, empty schema) — the patch proceeds without the section rather
 * than fabricating fields. Reuses summarizeAcfFields (capped at 30 fields).
 */
export function buildDataShapeSection(src: BlockDataSource, manifest: Manifest | null): string {
  if (src.kind === "none") return "";

  if (src.kind === "direct-acf") {
    const lines = Object.keys(src.sample)
      .filter((k) => k !== "acf_fc_layout")
      .slice(0, 30)
      .map((k) => `- ${k}`);
    if (lines.length === 0) return "";
    return `\n\n## Runtime data shape\nThis block's own fields (bind these directly):\n${lines.join("\n")}`;
  }

  if (src.kind === "direct-cpt") {
    const meta = resolveCptAbilityMeta(manifest, { slug: src.cptSlug, rest_base: src.cptSlug });
    const schema = extractCptAcfSchema(manifest, {
      bySlugAbilityName: meta.bySlugAbilityName,
      bySlugWrapperKey: meta.bySlugWrapperKey,
    });
    const summary = summarizeAcfFields(schema);
    if (!summary) return "";
    return `\n\n## Runtime data shape\nThis component renders a "${src.cptSlug}" record. Bind these ACF fields (nested under \`.acf\`):\n${summary}`;
  }

  // relation — filled in Phase 3b (Task 6). Until then, no section.
  return "";
}
