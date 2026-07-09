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

  // Fail-soft: a truthy-but-malformed persisted manifest (legacy/partial write:
  // {}, { abilities: null }, non-array abilities) would make resolveCptAbilityMeta
  // / extractCptAcfSchema throw on `.abilities.find`. Normalize to null so those
  // helpers take their documented `if (!manifest)` fail-soft path.
  const safeManifest =
    manifest && Array.isArray((manifest as { abilities?: unknown }).abilities) ? manifest : null;

  if (src.kind === "direct-acf") {
    const lines = Object.keys(src.sample)
      .filter((k) => k !== "acf_fc_layout")
      .slice(0, 30)
      .map((k) => `- ${k}`);
    if (lines.length === 0) return "";
    return `\n\n## Runtime data shape\nThis block's own fields (bind these directly):\n${lines.join("\n")}`;
  }

  if (src.kind === "direct-cpt") {
    const meta = resolveCptAbilityMeta(safeManifest, { slug: src.cptSlug, rest_base: src.cptSlug });
    const schema = extractCptAcfSchema(safeManifest, {
      bySlugAbilityName: meta.bySlugAbilityName,
      bySlugWrapperKey: meta.bySlugWrapperKey,
    });
    const summary = summarizeAcfFields(schema);
    if (!summary) return "";
    return `\n\n## Runtime data shape\nThis component renders a "${src.cptSlug}" record. Bind these ACF fields (nested under \`.acf\`):\n${summary}`;
  }

  if (src.kind === "relation") {
    // Derive the target CPT's by-slug ability + wrapper the EXACT way the render
    // path does (related-posts-runtime.ts:109-111) — pure snake/kebab of the
    // post_type, NOT the manifest's custom required[0] key. If a site uses a
    // custom wrapper key the render itself can't hydrate under, this correctly
    // yields no section instead of claiming fields the render never merges.
    const bySlugAbilityName = `jab/get-${src.postType.toLowerCase().replace(/[\s_]+/g, "-")}-by-slug`;
    const bySlugWrapperKey = src.postType.toLowerCase().replace(/[\s-]+/g, "_");
    const schema = extractCptAcfSchema(safeManifest, { bySlugAbilityName, bySlugWrapperKey });
    const summary = summarizeAcfFields(schema);
    if (!summary) return "";
    return `\n\n## Related-post fields (hydrated at render)\nThe \`${src.fieldName}\` array holds related "${src.postType}" posts. At render each item is hydrated with the FULL record (\`{ ...ref, ...record }\`), so besides \`post_title\`/\`post_name\`/\`featured_image\` each item exposes these ACF fields under \`item.acf\`:\n${summary}\nBind them as \`item.acf.<field>\` (e.g. \`item.acf.description\`). Guard for missing values. Do NOT invent a placeholder container for data you cannot find here.`;
  }

  return "";
}
