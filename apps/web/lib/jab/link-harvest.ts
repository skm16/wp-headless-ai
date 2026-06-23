/**
 * link-harvest.ts — pure helpers for the deployed-clone broken-internal-link
 * gate. The verify pass already launches a Chromium page per route; after the
 * 1280 screenshot it harvests `a[href]`s and hands the raw resolved hrefs here.
 *
 * Nothing in this file touches Playwright or the network — the worker
 * (verify-fidelity) supplies harvested hrefs + checkRoutes() results, and this
 * module decides which links are internal, which were never visited, which
 * resolved broken, and which page to blame. That keeps the gate logic
 * exhaustively unit-testable (the $$eval + fetch stay thin glue).
 *
 * Asset/origin classification is REUSED from rewrite-origin-links so the
 * "what counts as an internal page link" rules can never drift from the
 * compose-time rewriter that produced those links in the first place.
 */
import { isAssetPath, normalizePathname } from "./rewrite-origin-links";
import type { RouteCheckResult } from "./smoke-routes";

/**
 * Upper bound on how many unique unvisited internal links the verify pass will
 * resolve per build. checkRoutes is sequential with a 30s cap each; a
 * content-heavy site can surface hundreds of unique links, so we dedupe and cap
 * to keep verify wall-clock bounded — same bounding philosophy as
 * VISION_PER_BUILD_CAP. Links beyond the cap are silently not-checked (a
 * broken-link check is additive coverage, never a regression of existing gates).
 */
export const MAX_INTERNAL_LINK_CHECKS = 50;

/**
 * WP route families the generated clone deliberately does NOT implement — the
 * emitted app has only the front page, page_inventory routes, and the
 * `/<postType>/<slug>` post catch-all (no taxonomy / author / date / feed /
 * admin routes). Links to these (which the compose rewriter legitimately
 * origin-strips to root-relative) would 404 on the clone and, because they sit
 * in the shell nav/footer on EVERY page, would otherwise hard-zero the whole
 * site. They are an unimplemented-feature 404, not a broken-content defect, so
 * the broken-link gate exempts them — same posture as asset paths. Custom
 * taxonomy bases (not enumerable here) are caught by the fan-out collapse in
 * resolveBrokenLinkAttributions instead.
 */
// Base segments (no trailing slash) — matched as the whole path OR as a prefix
// segment (pre + "/..."), so "/wp-admin" and "/wp-admin/options.php" both hit
// while a real page like "/category-archive" does not.
const WP_NON_ROUTE_SEGMENTS = ["/category", "/tag", "/author", "/wp-admin"];
const WP_NON_ROUTE_EXACT = /^\/(wp-login\.php|xmlrpc\.php)$/;
const WP_FEED_RE = /(^|\/)feed$/; // "/feed", "/comments/feed", "/blog/feed"
const DATE_ARCHIVE_RE = /^\/\d{4}(\/\d{2}(\/\d{2})?)?$/; // "/2024", "/2024/06", "/2024/06/12"

export function isNonCloneRoutePath(pathname: string): boolean {
  const p = normalizePathname(pathname);
  return (
    WP_NON_ROUTE_SEGMENTS.some((seg) => p === seg || p.startsWith(`${seg}/`)) ||
    WP_NON_ROUTE_EXACT.test(p) ||
    WP_FEED_RE.test(p) ||
    DATE_ARCHIVE_RE.test(p)
  );
}

/**
 * Normalize raw resolved hrefs (anchor `.href`, i.e. browser-resolved absolute
 * URLs) harvested from the DEPLOYED clone into a deduped, sorted set of
 * internal, non-asset, root-relative route pathnames.
 *
 * Dropped: non-http(s) (mailto:/tel:/javascript:), other origins (external
 * links + WP-host media hotlinks), and asset paths. Query strings and hash
 * fragments are discarded — the gate checks the ROUTE, not the parameters.
 */
export function normalizeHarvestedLinks(
  rawHrefs: ReadonlyArray<string>,
  opts: { previewUrl: string },
): string[] {
  let previewOrigin: string;
  try {
    previewOrigin = new URL(opts.previewUrl).origin;
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const raw of rawHrefs) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue; // malformed / relative leftover — skip
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.origin !== previewOrigin) continue; // external host / asset hotlink
    if (isAssetPath(url.pathname)) continue;
    if (isNonCloneRoutePath(url.pathname)) continue; // unimplemented WP archive/system route
    // Decode percent-encoding so a non-ASCII slug (e.g. /caf%C3%A9) matches the
    // decoded page_inventory route_path (/café) and isn't re-checked as unvisited.
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // malformed escape — keep the raw pathname
    }
    out.add(normalizePathname(pathname));
  }
  return Array.from(out).sort();
}

/**
 * Harvested internal paths the verify pass did NOT already visit (i.e. not a
 * page_inventory route_path). Both sides are trailing-slash-normalized so a
 * known "/about/" still excludes a harvested "/about". Deduped and capped.
 */
export function partitionUnvisited(
  harvested: ReadonlyArray<string>,
  known: ReadonlyArray<string>,
  cap: number = MAX_INTERNAL_LINK_CHECKS,
): string[] {
  const knownSet = new Set(known.map(normalizePathname));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of harvested) {
    const path = normalizePathname(raw);
    if (knownSet.has(path) || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * A resolved route counts as a BROKEN link only on an UNAMBIGUOUS failure:
 * 404, 410, or any 5xx. Deliberately conservative — 401/403/429 and network
 * errors/timeouts are treated as INCONCLUSIVE, never broken, so a Vercel
 * auto-mitigation challenge (blanket 403s) or a cold-start blip can't
 * spuriously hard-zero (and block publish on) a page. The cost of a missed
 * broken link is a follow-up review; the cost of a false positive is a stranded
 * build, so we bias against false positives.
 *
 * Out of scope by design: a "soft 404" (a 200 whose BODY says not-found). The
 * clone returns a real 404 via notFound() for missing long-tail entries, so a
 * hard status is the right signal; soft-404 targets are not detected.
 */
export function isBrokenLinkResult(r: Pick<RouteCheckResult, "status">): boolean {
  return typeof r.status === "number" && (r.status === 404 || r.status === 410 || r.status >= 500);
}

export function selectBrokenLinks(results: ReadonlyArray<RouteCheckResult>): string[] {
  return results.filter(isBrokenLinkResult).map((r) => r.path);
}

export interface PageLinks {
  pageInventoryId: string;
  routePath: string;
  links: ReadonlyArray<string>;
}

export interface BrokenLinkAttribution {
  pageInventoryId: string;
  routePath: string;
  brokenPath: string;
}

/**
 * Blame each broken target on every page that links to it. One attribution per
 * (referencing page, broken target) so the review screen surfaces exactly which
 * page carries the dead link — the referencing page is what gets hard-zeroed.
 */
export function attributeBrokenLinks(
  pages: ReadonlyArray<PageLinks>,
  brokenPaths: ReadonlyArray<string>,
): BrokenLinkAttribution[] {
  const broken = new Set(brokenPaths);
  const out: BrokenLinkAttribution[] = [];
  for (const page of pages) {
    const seen = new Set<string>();
    for (const link of page.links) {
      if (!broken.has(link) || seen.has(link)) continue;
      seen.add(link);
      out.push({ pageInventoryId: page.pageInventoryId, routePath: page.routePath, brokenPath: link });
    }
  }
  return out;
}

/** A broken link appears on at least this FRACTION of pages → treated as global. */
export const GLOBAL_LINK_FANOUT_RATIO = 0.5;
/** ...but never fewer than this many pages (so tiny sites don't over-trigger). */
export const MIN_GLOBAL_FANOUT = 3;

export interface ResolvedBrokenLinkAttribution extends BrokenLinkAttribution {
  /** True when the broken target is a shell/nav link present site-wide. */
  siteWide: boolean;
}

/**
 * Like attributeBrokenLinks, but collapses fan-out: a broken target referenced
 * by a large fraction of pages is a SHELL/nav link (header/footer renders on
 * every page), so attributing it to all N pages would hard-zero the whole site
 * for one dead nav link. Such links are attributed ONCE to a representative
 * page (preferring the home route) with siteWide=true; genuinely page-local
 * broken links (the POST_TYPE_MAP long-tail case — referenced by few pages)
 * still attribute to each referencing page.
 */
export function resolveBrokenLinkAttributions(
  pages: ReadonlyArray<PageLinks>,
  brokenPaths: ReadonlyArray<string>,
  totalPages: number,
  opts?: { fanoutRatio?: number; minFanout?: number },
): ResolvedBrokenLinkAttribution[] {
  const ratio = opts?.fanoutRatio ?? GLOBAL_LINK_FANOUT_RATIO;
  const minFanout = opts?.minFanout ?? MIN_GLOBAL_FANOUT;
  const threshold = Math.max(minFanout, Math.ceil(totalPages * ratio));
  const out: ResolvedBrokenLinkAttribution[] = [];
  for (const brokenPath of new Set(brokenPaths)) {
    const refs = pages.filter((p) => p.links.includes(brokenPath));
    if (refs.length === 0) continue;
    if (refs.length >= threshold) {
      const rep = refs.find((r) => r.routePath === "/") ?? refs[0];
      out.push({ pageInventoryId: rep.pageInventoryId, routePath: rep.routePath, brokenPath, siteWide: true });
    } else {
      for (const ref of refs) {
        out.push({ pageInventoryId: ref.pageInventoryId, routePath: ref.routePath, brokenPath, siteWide: false });
      }
    }
  }
  return out;
}
