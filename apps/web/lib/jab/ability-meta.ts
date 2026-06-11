import { abilityWrapperKeyFromSchema } from "@/lib/jab/ability-client";

export interface ManifestAbility {
  name: string;
  /** camelCase — matches the persisted @jab/core Manifest shape. */
  outputSchema?: {
    required?: unknown;
  };
  /** Tolerated defensively for legacy/direct-REST rows; prefer outputSchema. */
  output_schema?: {
    required?: unknown;
  };
  [k: string]: unknown;
}

export interface ManifestShape {
  abilities?: ManifestAbility[];
  [k: string]: unknown;
}

/**
 * Resolves the registered ability name for a CPT's single-by-slug fetch.
 * JAB plugin convention is jab/get-{post_type}-by-slug — singular form
 * regardless of plural rest_base (verified against Two Roads manifest:
 * jab/get-page-by-slug, jab/get-beer-by-slug, etc.). Pluralized form
 * kept as a defensive fallback in case a custom plugin variant emits it.
 * Returns null if no matching ability is registered — caller treats that
 * as a hard error (homepage) or a warn+skip (route-map entries).
 */
export function abilityMetaFor(
  postType: string,
  manifest: ManifestShape,
): { abilityName: string; wrapperKey: string } | null {
  const abilities = manifest.abilities ?? [];
  const plural = postType.endsWith("s") ? postType : postType + "s";
  for (const candidate of [
    `jab/get-${postType}-by-slug`,
    `jab/get-${plural}-by-slug`,
  ]) {
    const ability = abilities.find((a) => a.name === candidate);
    if (ability) {
      const wrapperKey =
        abilityWrapperKeyFromSchema(ability) ?? postType.replace(/-/g, "_");
      return { abilityName: candidate, wrapperKey };
    }
  }
  return null;
}
