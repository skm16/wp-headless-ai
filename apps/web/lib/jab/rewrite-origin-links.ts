/**
 * rewrite-origin-links.ts — deterministic compose-time URL-identity layer.
 *
 * Generated TSX (shell, block components) copies absolute hrefs from the
 * captured source-site DOM, which point at the ORIGINAL WordPress origin.
 * Prompting alone is provably insufficient (the model keeps the origin on
 * links it itself classifies internal, and invents wrong paths when it does
 * relativize). This pure pass rewrites source-host URLs to root-relative
 * paths so they resolve on the clone, whatever domain it deploys to.
 *
 * Asset URLs are deliberately EXEMPT: the clone hotlinks WP media
 * (next.config whitelists the WP host) — origin-stripping an <img src>
 * or CSS url() would break every image.
 */

const ASSET_PATH_PREFIXES = ["/wp-content/", "/wp-includes/", "/wp-json/"];
const ASSET_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|xml|txt)([?#]|$)/i;

/** Bare + www host variants for a WP base URL (lowercased). */
export function hostVariants(wpUrl: string): string[] {
  const host = new URL(wpUrl).hostname.toLowerCase();
  const bare = host.replace(/^www\./, "");
  return Array.from(new Set([bare, `www.${bare}`, host]));
}

export function isAssetPath(pathname: string): boolean {
  return (
    ASSET_PATH_PREFIXES.some((p) => pathname.startsWith(p)) ||
    ASSET_EXTENSIONS.test(pathname)
  );
}

/** Strip a trailing slash (Next.js 308s them anyway); "" → "/". */
export function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname || "/";
}

// Absolute http(s) URL inside source text. Terminates on quotes, whitespace,
// backticks, and closing delimiters so it works in string literals, JSX
// attributes, and template strings without swallowing surrounding code.
const ABSOLUTE_URL_RE = /https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?(?:\/[^\s"'`<>\\)\]}]*)?/g;

export interface RewriteOriginOptions {
  /** Host names (bare and/or www) considered the SOURCE origin. */
  sourceHosts: string[];
  /**
   * Exact sourcePathname → clone route_path overrides (built from
   * page_inventory.link). Looked up with the trailing-slash-normalized
   * pathname; unmapped paths fall back to the origin-stripped pathname.
   */
  routePathMap?: Record<string, string>;
}

export function rewriteWpOriginUrls(source: string, opts: RewriteOriginOptions): string {
  if (opts.sourceHosts.length === 0) return source;
  const hosts = new Set(opts.sourceHosts.map((h) => h.toLowerCase().replace(/^www\./, "")));
  return source.replace(ABSOLUTE_URL_RE, (raw) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return raw;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!hosts.has(host)) return raw;
    if (isAssetPath(url.pathname)) return raw;
    const normalized = normalizePathname(url.pathname);
    const pathname = opts.routePathMap?.[normalized] ?? normalized;
    return `${pathname}${url.search}${url.hash}`;
  });
}

/**
 * sourcePathname → route_path map from page_inventory rows (the `link`
 * column added by migration 0033). Rows without a link (pre-0033 builds)
 * are skipped — the rewriter then falls back to plain origin-stripping,
 * which is correct for WP pages (route IS /<slug>) and an at-worst on-site
 * 404 for diverged paths.
 */
export function buildRoutePathMap(
  pages: Array<{ link: string | null; route_path: string }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of pages) {
    if (!p.link) continue;
    try {
      map[normalizePathname(new URL(p.link).pathname)] = p.route_path;
    } catch {
      // invalid permalink — skip
    }
  }
  return map;
}
