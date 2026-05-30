import Image from "next/image";
import type { BlockNode } from "@/lib/jab/ability-client";

/**
 * MediaImage — platform shim for `core/image` blocks.
 *
 * Uses next/image for same-origin (primary WP_URL host) sources and a
 * plain <img> for everything else. Background: next/image validates each
 * src against `next.config.ts` `images.remotePatterns` at request time
 * and throws when the host isn't whitelisted. Compose-time host
 * harvesting (harvestImageHosts in compose-site-emit.ts) populates
 * remotePatterns with hosts found in captured shellDom + theme CSS, but
 * runtime can still surface URLs the harvester missed (block attrs
 * coming from posts captured after Phase A, ACF media injected by
 * runtime hooks, etc.). The plain <img> fallback is the safety net so
 * the page renders even when the host isn't on the whitelist.
 *
 * Detection: same-origin = URL hostname matches `process.env.WP_URL`
 * (server-only env var, resolved at render time since this is an RSC
 * with no "use client" directive). When WP_URL is unset OR can't be
 * parsed (dev/test), we treat every src as foreign and use plain <img>
 * — pessimistic but harmless.
 *
 * Stage 2 NOTE: This shim handles the 80% case. Agencies that need
 * custom image handling (art direction, advanced srcset, CDN rewriting)
 * are expected to replace this file after export. It is not LLM-generated
 * and lives in _platform/ to signal "this is infrastructure, not content."
 */

/**
 * Return true when the image src is hosted on the same origin as the
 * configured WP_URL — safe to render through next/image. Anything else
 * (CDN-rewritten URLs from optimization plugins, external photo hosts,
 * deliberately remote media library swaps) routes to plain <img> to
 * avoid the next.config.ts remotePatterns rejection.
 *
 * Exported only for testing; production callers use it implicitly.
 */
export function isWpHostedImage(src: string, wpUrl: string | undefined): boolean {
  if (!wpUrl) return false;
  try {
    return new URL(src).hostname === new URL(wpUrl).hostname;
  } catch {
    return false;
  }
}

/**
 * Parse an `<img>` tag out of the block's `innerHTML` string and return
 * its `src` / `alt` / `width` / `height`. WordPress's core/image block
 * stores `{id, sizeSlug, linkDestination}` in `attrs` but the actual
 * `<img src="…">` markup lives in `innerHTML` (sourced attributes per
 * BlockTypeSchema.php). Without this fallback the shim returned null
 * for the common WP attrs-don't-carry-url shape and the page rendered
 * literally no image for every core/image block.
 *
 * Returns null when no `<img>` tag or no `src` attribute is found.
 * Exported for unit testing.
 */
export function parseImgFromInnerHTML(html: string): {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
} | null {
  if (!html) return null;
  const imgMatch = html.match(/<img\b[^>]*>/i);
  if (!imgMatch) return null;
  const tag = imgMatch[0];
  const get = (name: string): string | undefined => {
    const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
    return m ? m[1] : undefined;
  };
  const src = get("src");
  if (!src) return null;
  const widthStr = get("width");
  const heightStr = get("height");
  const width = widthStr && /^\d+$/.test(widthStr) ? Number(widthStr) : undefined;
  const height = heightStr && /^\d+$/.test(heightStr) ? Number(heightStr) : undefined;
  return { src, alt: get("alt"), width, height };
}

interface CoreImageAttrs {
  url?: string;
  src?: string;
  alt?: string;
  width?: number;
  height?: number;
  caption?: string;
  linkDestination?: string;
  href?: string;
  className?: string;
}

interface Props {
  block: BlockNode;
}

export function MediaImage({ block }: Props) {
  const attrs = block.attrs as CoreImageAttrs;
  const html = (block.innerHTML ?? "") as string;
  let src = attrs.url ?? attrs.src;
  let alt = attrs.alt;
  let width = attrs.width;
  let height = attrs.height;
  const caption = attrs.caption;
  const href = attrs.href;

  // Stage 2: when structured attrs don't carry url/src (the common case
  // for WP-parsed core/image blocks — sourced attributes per the plugin's
  // BlockTypeSchema.php), extract src/alt/width/height from the <img>
  // tag in innerHTML.
  if (!src && html) {
    const parsed = parseImgFromInnerHTML(html);
    if (parsed) {
      src = parsed.src;
      alt = alt ?? parsed.alt;
      width = width ?? parsed.width;
      height = height ?? parsed.height;
    }
  }

  // Stage 3: if neither the structured attrs nor the innerHTML parse give
  // us a usable src, but innerHTML carries SOMETHING, render it raw. WP's
  // REST layer sanitizes innerHTML; this preserves the markup the source
  // site rendered (figure wrapper, captions, multiple imgs) instead of
  // emitting nothing. Stage-1/2 still take precedence so the same-origin
  // / cross-origin optimization branching applies whenever we can extract
  // a clean src.
  if (!src) {
    if (html.trim().length > 0) {
      return (
        <figure
          className="wp-block-image wp-block-image--passthrough"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    return null;
  }

  const finalAlt = alt ?? "";
  const finalWidth = width ?? 800;
  const finalHeight = height ?? 600;
  const sameOrigin = isWpHostedImage(src, process.env.WP_URL);

  const img = sameOrigin ? (
    <Image
      src={src}
      alt={finalAlt}
      width={finalWidth}
      height={finalHeight}
      className={attrs.className}
      style={{ maxWidth: "100%", height: "auto" }}
    />
  ) : (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={src}
      alt={finalAlt}
      width={finalWidth}
      height={finalHeight}
      className={attrs.className}
      style={{ maxWidth: "100%", height: "auto" }}
      loading="lazy"
      decoding="async"
    />
  );

  return (
    <figure className="wp-block-image">
      {href ? (
        <a href={href} rel="noreferrer">
          {img}
        </a>
      ) : (
        img
      )}
      {caption && (
        <figcaption
          className="wp-element-caption"
          // WP REST API sanitizes captions; safe to render
          dangerouslySetInnerHTML={{ __html: caption }}
        />
      )}
    </figure>
  );
}
