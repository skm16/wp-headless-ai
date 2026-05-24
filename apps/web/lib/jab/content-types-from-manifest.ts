import "server-only";
import type { Manifest } from "@jab/core";
import type {
  OwnershipMode,
  WPContentType,
} from "@/components/ownership-picker";

/**
 * Heuristic — derive a WPContentType list from the manifest's ability names.
 *
 * **This is a fallback, not the primary source.** The primary source is the
 * plugin's `/wp-json/jab/v1/content-types` endpoint (see
 * `fetch-content-types.ts`). This helper runs only when that endpoint is
 * unreachable — typically because the install has v0.3.0 or earlier of the
 * plugin, before the endpoint existed.
 *
 * Filtering rules (designed to avoid the wizard's previous "Beer 2 by slug"
 * dedup bug):
 *
 *   • Only `jab/get-{plural}` / `jab/list-{plural}` ability names produce
 *     content-type entries. These are the plural list abilities the plugin
 *     registers per post type.
 *   • `jab/get-{singular}-by-slug` ability names are SKIPPED — they're an
 *     access pattern over the same post type, not a separate type.
 *   • `jab/get-{taxonomy}-terms` ability names are SKIPPED — taxonomies
 *     aren't standalone ownership decisions in the spec.
 *   • `jab/get-menus` is SKIPPED — fixed-name menus ability, not a content
 *     type the agency owns separately.
 *   • Dedup is by slug (set-based), so collision-suffixed names like
 *     `jab/get-beer-2-by-slug` get filtered out by the `-by-slug` suffix
 *     check before they hit the dedup set.
 *
 * Trade-offs vs the real endpoint:
 *   • count = 0 (no count info in the manifest).
 *   • pluralName is the humanized slug, not the WP label (`acf-event` →
 *     "Acf event" instead of "ACF Event Group" or whatever WP would say).
 *   • kindLabel is the generic "Content type" — no built-in vs CPT split.
 *
 * Acceptable for the fallback path; the real endpoint gives the user a
 * much better picker. Encourage users on old plugin versions to upgrade.
 */

const ALLOWED_SLUG_RE = /^[a-z0-9][a-z0-9-_]*$/;
const EXCLUDED_ABILITY_NAMES = new Set(["jab/get-menus"]);

const RECOMMENDED_OVERRIDES: Record<string, OwnershipMode> = {
  page: "jab-managed",
};

export function contentTypesFromManifest(manifest: Manifest): WPContentType[] {
  // Defensive: the manifest comes from JSONB roundtrip + a remote WP install
  // we don't fully control. If the shape isn't what we expect, return an
  // empty catalog rather than throwing — the caller can still complete
  // onboarding with defaults. The action's outer try/catch also catches
  // throws here, but returning empty keeps the failure mode quieter.
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !Array.isArray((manifest as { abilities?: unknown }).abilities)
  ) {
    return [];
  }
  const slugs = new Set<string>();
  for (const ability of manifest.abilities) {
    if (!ability || typeof ability.name !== "string") continue;
    if (EXCLUDED_ABILITY_NAMES.has(ability.name)) continue;
    // Skip the access-pattern variants the plugin registers alongside
    // each list ability — these would otherwise show up as duplicate
    // entries in the picker.
    if (ability.name.endsWith("-by-slug")) continue;
    if (ability.name.endsWith("-terms")) continue;
    const slug = extractSlug(ability.name);
    if (slug && ALLOWED_SLUG_RE.test(slug)) slugs.add(slug);
  }

  return Array.from(slugs)
    .sort()
    .map((slug): WPContentType => {
      const recommendedMode =
        RECOMMENDED_OVERRIDES[slug] ?? ("wp-managed" as const);
      return {
        slug,
        pluralName: humanize(slug),
        kindLabel: "Content type",
        count: 0,
        recommendedMode,
      };
    });
}

function extractSlug(abilityName: string): string | null {
  // jab/get-posts  → "posts"
  // jab/list-events → "events"
  // jab/get-acf-field-groups → "acf-field-groups"
  // Anything that doesn't match these two patterns is ignored.
  const match = abilityName.match(/^[a-z]+\/(get|list)-(.+)$/);
  return match ? match[2]! : null;
}

function humanize(slug: string): string {
  // posts → "Posts"
  // acf-field-groups → "Acf field groups"
  const spaced = slug.replace(/[-_]/g, " ").trim();
  if (!spaced) return slug;
  return spaced[0]!.toUpperCase() + spaced.slice(1);
}
