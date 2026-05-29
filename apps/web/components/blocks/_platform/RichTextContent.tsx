import type { BlockNode } from "@/lib/jab/ability-client";

/**
 * RichTextContent - passthrough for classic-editor / null-blockName blocks
 * and the passthrough tier fallback.
 *
 * HTML originates from the site's own WordPress database. WordPress kses
 * filters sanitize at write time; adding a DOM sanitizer here pulls DOM
 * polyfills into server bundles and can trip CJS/ESM dependency boundaries.
 */

interface Props {
  block: BlockNode;
  className?: string;
}

export function RichTextContent({ block, className }: Props) {
  const html = block.innerHTML ?? "";

  if (!html.trim()) return null;

  return (
    <div
      className={["wp-block-passthrough", className].filter(Boolean).join(" ")}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
