import "server-only";
import type { Manifest } from "@jab/core";
import type {
  OwnershipMode,
  WPContentType,
} from "@/components/ownership-picker";

/**
 * Heuristic — derive a WPContentType list from the manifest's ability names.
 *
 * The manifest is structured around abilities, not post types. Until either
 * the plugin exposes a /wp-json/jab/v1/content-types endpoint or the probe
 * does a separate REST enumeration, this parser is what we have:
 *
 *   • Matches `jab/get-{slug}` and `jab/list-{slug}` ability names.
 *   • Dedupes by slug.
 *   • Humanizes the slug into pluralName (`acf-event` → "Acf events").
 *   • count = 0 — manifest carries no count info; the OwnershipPicker
 *     just renders "· 0 items" today. Acceptable for the MVP wizard —
 *     real counts land with type enumeration (see spec §8).
 *   • recommendedMode follows the §10 #13 rule: `page` → jab-managed,
 *     everything else (collections, taxonomies) → wp-managed.
 *
 * Out of scope here:
 *   • Differentiating built-in post types vs CPTs vs taxonomies. The
 *     kindLabel is the catch-all "Content type" — the user sees an
 *     accurate slug list but not the WP-internal classification.
 *   • Filtering abilities that aren't content-fetch (e.g. menu-only).
 *     We accept some noise — over-listing is better than under-listing
 *     for an ownership picker.
 */

const ALLOWED_SLUG_RE = /^[a-z0-9][a-z0-9-_]*$/;

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
