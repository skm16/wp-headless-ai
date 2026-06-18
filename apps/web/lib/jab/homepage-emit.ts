import { abilityMetaFor, listAbilityMetaFor, type ManifestShape } from "@/lib/jab/ability-meta";

/** Minimal page_inventory row shape the homepage decision needs. */
export interface HomepagePageRow {
  slug: string;
  post_type: string;
  route_path: string;
  paradigms: string[];
}

/** WP's blog index is always the built-in "post" type. */
export const BLOG_INDEX_POST_TYPE = "post";

/**
 * Blog-index render defaults. SHARED so the deployed emitBlogIndexTsx caller
 * (compose-site.ts) and the Live Draft renderer stay in lockstep — a drift
 * here would make the draft preview disagree with the published homepage.
 */
export const BLOG_INDEX_LIMIT = 12;
export const BLOG_INDEX_HEADING = "Latest Posts";

export type HomepageEmitDecision =
  | {
      kind: "static";
      frontPageSlug: string;
      postType: string;
      paradigms: string[];
      ability: { abilityName: string; wrapperKey: string };
      sitemapExtraRoutes: string[];
    }
  | {
      kind: "blogIndex";
      listAbility: string;
      wrapperKey: string;
      postType: string;
      frontPageSlug: null;
      sitemapExtraRoutes: string[];
    };

/**
 * Decide how compose emits app/page.tsx. show_on_front='posts' → blog index
 * (reuses the dynamic-list runtime); otherwise the existing static-page path,
 * reproduced verbatim (same fallbacks, same loud error messages). Pure +
 * fully tested so the compose worker is a dumb consumer.
 */
export function resolveHomepageEmit(
  buildConfig: unknown,
  pageRows: HomepagePageRow[],
  manifest: ManifestShape,
): HomepageEmitDecision {
  const cfg = (buildConfig ?? {}) as { show_on_front?: unknown; front_page_slug?: unknown };

  if (cfg.show_on_front === "posts") {
    const meta = listAbilityMetaFor(BLOG_INDEX_POST_TYPE, manifest);
    if (!meta) {
      throw new Error(
        "compose-site: blog-index front page (show_on_front='posts') requires a posts list ability (e.g. jab/get-posts) but none is registered in the manifest.",
      );
    }
    return {
      kind: "blogIndex",
      listAbility: meta.abilityName,
      wrapperKey: meta.wrapperKey,
      postType: BLOG_INDEX_POST_TYPE,
      frontPageSlug: null,
      sitemapExtraRoutes: ["/"],
    };
  }

  // Static front page — reproduces compose-site.ts:305-327 verbatim.
  const frontPageSlug = typeof cfg.front_page_slug === "string" ? cfg.front_page_slug : null;
  let frontPage = frontPageSlug
    ? pageRows.find((p) => p.slug === frontPageSlug && p.post_type === "page")
    : undefined;
  if (!frontPage) {
    frontPage = pageRows.find((p) => p.route_path === "/");
  }
  if (!frontPage) {
    throw new Error(
      frontPageSlug
        ? `compose-site: config.front_page_slug='${frontPageSlug}' but no matching page in page_inventory.`
        : "compose-site: no static front-page configured. Set site_builds.config.front_page_slug or ensure Phase A populates a row with route_path='/'.",
    );
  }
  const ability = abilityMetaFor(frontPage.post_type, manifest);
  if (!ability) {
    throw new Error(
      `no jab/get-<rest_base>-by-slug ability registered for front-page post_type '${frontPage.post_type}'`,
    );
  }
  return {
    kind: "static",
    frontPageSlug: frontPage.slug,
    postType: frontPage.post_type,
    paradigms: frontPage.paradigms,
    ability,
    sitemapExtraRoutes: [],
  };
}
