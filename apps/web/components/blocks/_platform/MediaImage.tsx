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
  const src = attrs.url ?? attrs.src;
  const alt = attrs.alt ?? "";
  const width = attrs.width ?? 800;
  const height = attrs.height ?? 600;
  const caption = attrs.caption;
  const href = attrs.href;

  if (!src) {
    return null;
  }

  const sameOrigin = isWpHostedImage(src, process.env.WP_URL);

  const img = sameOrigin ? (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={attrs.className}
      style={{ maxWidth: "100%", height: "auto" }}
    />
  ) : (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
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
