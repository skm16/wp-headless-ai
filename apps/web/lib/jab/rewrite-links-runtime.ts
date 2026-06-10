// EMITTED RUNTIME MODULE. Read verbatim by emitRewriteLinksTs() and written to
// the generated project at lib/jab/rewrite-links.ts. MUST stay self-contained
// (no "@/…" imports). Deliberately duplicates the host-match/asset-skip rules
// from rewrite-origin-links.ts (which is apps-side compose-time code and can't
// ship into the generated tree) — same convention as the toPascalCase copies.
//
// Why this exists: Passthrough innerHTML (and any other WP-fetched HTML) only
// materializes at REQUEST time on the deployed clone, so compose-time TSX
// rewriting can't reach it. The deployed app derives the source hosts from
// its own WP_URL env (already synced to Vercel by the deploy worker).

const ASSET_PATH_PREFIXES = ["/wp-content/", "/wp-includes/", "/wp-json/"];
const ASSET_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|xml|txt|docx|xlsx|pptx|csv|ics|json)([?#]|$)/i;

/** Bare + www host variants from a WP base URL; [] on missing/invalid. */
export function sourceHostsFromEnv(wpUrl: string | undefined): string[] {
  if (!wpUrl) return [];
  try {
    const host = new URL(wpUrl).hostname.toLowerCase();
    const bare = host.replace(/^www\./, "");
    return Array.from(new Set([bare, `www.${bare}`, host]));
  } catch {
    return [];
  }
}

// WP_URL is constant for the process lifetime; memoize so per-block renders
// don't re-parse the URL.
let _hostsCache: string[] | undefined;
export function getSourceHosts(): string[] {
  if (_hostsCache === undefined) _hostsCache = sourceHostsFromEnv(process.env.WP_URL);
  return _hostsCache;
}

/** Rewrite href="<source-origin>/path" attributes in an HTML string to relative paths. */
export function rewriteHtmlOriginLinks(html: string, hosts: string[]): string {
  if (hosts.length === 0) return html;
  const set = new Set(hosts.map((h) => h.toLowerCase().replace(/^www\./, "")));
  return html.replace(/href=(["'])(https?:\/\/[^"']+)\1/g, (match, quote: string, raw: string) => {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (!set.has(host)) return match;
      if (
        ASSET_PATH_PREFIXES.some((p) => url.pathname.startsWith(p)) ||
        ASSET_EXTENSIONS.test(url.pathname)
      ) {
        return match;
      }
      const path =
        url.pathname.length > 1 && url.pathname.endsWith("/")
          ? url.pathname.slice(0, -1)
          : url.pathname || "/";
      return `href=${quote}${path}${url.search}${url.hash}${quote}`;
    } catch {
      return match;
    }
  });
}
