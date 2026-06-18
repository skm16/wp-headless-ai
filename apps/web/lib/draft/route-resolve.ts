import { abilityMetaFor, listAbilityMetaFor, type ManifestShape } from "@/lib/jab/ability-meta";
import { postTypeMapEntriesFromPages } from "@/lib/jab/compose-site-emit";
import { BLOG_INDEX_POST_TYPE } from "@/lib/jab/homepage-emit";

/**
 * route-resolve — pure mirror of the EMITTED site's routing so the draft
 * preview and the deployed site agree on every URL:
 *   emitted app/page.tsx        → front-page row (route_path "/")
 *   emitted app/[...slug] logic → ROUTE_MAP[path], front-slug 308,
 *     fallback: len>=2 ? POST_TYPE_MAP[prefix] : POST_TYPE_MAP["page"]
 * (compose-site-emit.ts emitCatchAllPageTsx — keep in lockstep.)
 */
export interface DraftPageRow {
  slug: string;
  post_type: string;
  route_path: string;
  paradigms: string[];
}

export interface DraftRouteTarget {
  slug: string;
  postType: string;
  paradigms: string[];
  abilityName: string;
  wrapperKey: string;
}

export type DraftRouteResolution =
  | { kind: "page"; target: DraftRouteTarget }
  | { kind: "blogIndex"; listAbility: string; wrapperKey: string; postType: string }
  | { kind: "redirect"; to: "/" }
  | { kind: "not_found" };

/** Strip leading/trailing slashes; "" means the front page. */
function normalize(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

export function resolveDraftRoute(
  rawPath: string,
  pages: DraftPageRow[],
  manifest: ManifestShape,
  frontPageSlug: string | null,
  showOnFront?: "page" | "posts" | null,
): DraftRouteResolution {
  const path = normalize(rawPath);

  const toTarget = (slug: string, postType: string, paradigms: string[]): DraftRouteResolution => {
    const meta = abilityMetaFor(postType, manifest);
    if (!meta) return { kind: "not_found" };
    return {
      kind: "page",
      target: { slug, postType, paradigms, abilityName: meta.abilityName, wrapperKey: meta.wrapperKey },
    };
  };

  if (path === "") {
    // Posts-front (show_on_front='posts'): the homepage is a latest-posts list,
    // not a by-slug record. Mirror resolveHomepageEmit's posts branch. A missing
    // posts list ability is not_found (the deployed path throws loudly; the draft
    // surfaces it as a loud error result one layer up).
    if (showOnFront === "posts") {
      const meta = listAbilityMetaFor(BLOG_INDEX_POST_TYPE, manifest);
      if (!meta) return { kind: "not_found" };
      return {
        kind: "blogIndex",
        listAbility: meta.abilityName,
        wrapperKey: meta.wrapperKey,
        postType: BLOG_INDEX_POST_TYPE,
      };
    }
    const front =
      pages.find((p) => normalize(p.route_path) === "") ??
      (frontPageSlug ? pages.find((p) => p.slug === frontPageSlug) : undefined);
    if (!front) return { kind: "not_found" };
    return toTarget(front.slug, front.post_type, front.paradigms);
  }

  const segments = path.split("/");
  const leaf = segments[segments.length - 1];

  if (segments.length === 1 && frontPageSlug !== null && leaf === frontPageSlug) {
    return { kind: "redirect", to: "/" };
  }

  const mapped = pages.find(
    (p) => normalize(p.route_path) !== "" && normalize(p.route_path) === path,
  );
  if (mapped) return toTarget(mapped.slug, mapped.post_type, mapped.paradigms);

  // Fallback registry — derived by the SAME pure function compose uses for
  // POST_TYPE_MAP, so draft and deployed agree on unmapped URLs.
  const { entries } = postTypeMapEntriesFromPages(
    pages.map((p) => ({ post_type: p.post_type, paradigms: p.paradigms })),
    (postType) => abilityMetaFor(postType, manifest),
  );
  const fallbackKey = segments.length >= 2 ? segments.slice(0, -1).join("/") : "page";
  const entry = entries.find((e) => e.postType === fallbackKey);
  if (!entry) return { kind: "not_found" };
  return {
    kind: "page",
    target: {
      slug: leaf,
      postType: entry.postType,
      paradigms: entry.paradigms,
      abilityName: entry.abilityName,
      wrapperKey: entry.wrapperKey,
    },
  };
}
