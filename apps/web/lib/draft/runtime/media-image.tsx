/**
 * Draft-runtime MediaImage: same dispatcher contract as the emitted
 * components/blocks/_platform/MediaImage.tsx (props { block }), but always
 * renders a plain <img> — no next/image host validation needed in a draft.
 * Resolution order mirrors the emitted shim: structured attrs first, then
 * the first <img> found in innerHTML.
 */
import type { ReactElement } from "react";

interface BlockLike {
  blockName: string | null;
  attrs: Record<string, unknown>;
  innerHTML?: string;
  [k: string]: unknown;
}

export function parseImgFromInnerHTML(html: string): { src: string; alt: string } | null {
  const tag = html.match(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i);
  if (!tag) return null;
  const alt = tag[0].match(/\balt=["']([^"']*)["']/i);
  return { src: tag[1], alt: alt?.[1] ?? "" };
}

export function MediaImage({ block }: { block: BlockLike }): ReactElement | null {
  const attrs = block.attrs ?? {};
  const url = typeof attrs.url === "string" ? attrs.url : undefined;
  const alt = typeof attrs.alt === "string" ? attrs.alt : "";
  if (url) {
    return <img src={url} alt={alt} className="h-auto max-w-full" />;
  }
  const html = block.innerHTML ?? "";
  const parsed = parseImgFromInnerHTML(html);
  if (parsed) {
    return <img src={parsed.src} alt={parsed.alt} className="h-auto max-w-full" />;
  }
  // No extractable image — render nothing in the draft (deployed site would
  // render the raw innerHTML, but that path is handled by _passthrough in
  // the bundle which uses the same opaque-origin sandbox isolation).
  return null;
}
