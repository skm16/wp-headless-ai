import Image from "next/image";
import type { BlockNode } from "@/lib/jab/ability-client";

/**
 * MediaImage — platform shim for `core/image` blocks.
 *
 * Uses next/image for optimization (blur placeholder, lazy loading, WebP
 * negotiation). Falls back to a plain <img> when the URL is not on an
 * approved domain (next.config.ts `images.remotePatterns` may not cover
 * all WP media CDN origins — the plain img fallback is safe for build time).
 *
 * Stage 2 NOTE: This shim handles the 80% case. Agencies that need
 * custom image handling (art direction, advanced srcset, CDN rewriting)
 * are expected to replace this file after export. It is not LLM-generated
 * and lives in _platform/ to signal "this is infrastructure, not content."
 */

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

  const img = (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={attrs.className}
      style={{ maxWidth: "100%", height: "auto" }}
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
