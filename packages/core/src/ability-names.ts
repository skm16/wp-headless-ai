/**
 * Ability-name derivation: from "jab/get-posts" → "GetPosts" / "getPosts"
 * + boolean flags about input shape.
 *
 * Used by the SDK emitters (abilities.ts, claude_md.ts) to produce the
 * camelCase wrapper functions and PascalCase type names. Lives in core
 * because both the CLI and the SaaS worker need it — formerly in
 * `commands/generate.ts`.
 */
import type { AbilityManifestEntry } from "./types/manifest.js";

/** Per-ability name bundle used by the abilities/claude_md emitters. */
export interface AbilityNameMap {
  /** Original ability identifier as registered in WP (e.g. "jab/get-posts"). */
  abilityName: string;
  /** PascalCase root used for type names. */
  pascal: string;
  /** camelCase function name for the abilities.ts wrapper (e.g. "getPosts"). */
  camel: string;
  /** True when the ability's input schema accepts no properties. */
  hasNoInput: boolean;
  /** True when the input schema declares one or more required properties. */
  hasRequiredInput: boolean;
  /**
   * For taxonomy-terms abilities only: the underlying WP taxonomy slug.
   * Surfaced via the plugin's `meta.jab.taxonomy_slug` so the SDK can
   * emit a JSDoc tying the wrapper key (derived from the plural label,
   * e.g. `work_type`) back to the slug (`work`) that CPT-list rows
   * actually use as their per-post taxonomy field key.
   */
  taxonomySlug?: string;
}

export function makeAbilityNames(ability: AbilityManifestEntry): AbilityNameMap {
  const pascal = abilityNameToPascal(ability.name);
  return {
    abilityName: ability.name,
    pascal,
    camel: pascal[0]!.toLowerCase() + pascal.slice(1),
    hasNoInput: !hasInputProperties(ability.inputSchema),
    hasRequiredInput: hasRequiredInputProperties(ability.inputSchema),
    taxonomySlug: extractTaxonomySlug(ability.meta),
  };
}

function extractTaxonomySlug(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const jab = (meta as { jab?: unknown }).jab;
  if (!jab || typeof jab !== "object") return undefined;
  const slug = (jab as { taxonomy_slug?: unknown }).taxonomy_slug;
  return typeof slug === "string" && slug.length > 0 ? slug : undefined;
}

/**
 * Convert an ability name to a PascalCase identifier.
 *
 *   jab/get-posts -> GetPosts
 *   jab/get-menus -> GetMenus
 */
export function abilityNameToPascal(name: string): string {
  const tail = name.includes("/") ? name.split("/").slice(1).join("-") : name;
  const words = tail.split(/[-_/\s]+/).filter(Boolean);
  if (words.length === 0) {
    throw new Error(`Cannot derive PascalCase name from ability "${name}"`);
  }
  return words
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

function hasInputProperties(schema: Record<string, unknown>): boolean {
  const props = schema.properties;
  return typeof props === "object" && props !== null && Object.keys(props as object).length > 0;
}

function hasRequiredInputProperties(schema: Record<string, unknown>): boolean {
  const required = schema.required;
  return Array.isArray(required) && required.length > 0;
}
