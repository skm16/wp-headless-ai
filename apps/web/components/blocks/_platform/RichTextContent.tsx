"use client";

import DOMPurify from "isomorphic-dompurify";
import type { BlockNode } from "@/lib/jab/ability-client";

/**
 * RichTextContent — sanitized passthrough for classic-editor / null-blockName
 * blocks and the `passthrough` tier fallback.
 *
 * DOMPurify with the default HTML profile strips <script>, on* handlers,
 * javascript: URLs, and other XSS vectors while preserving formatting markup.
 *
 * "use client" directive: DOMPurify depends on the DOM. The isomorphic build
 * stubs the DOM on the server via JSDOM, but the JSDOM startup cost per
 * server-render is meaningful; running it client-side instead keeps the
 * server fast. Mark "use client" to make the rendering context explicit.
 */

interface Props {
  block: BlockNode;
  className?: string;
}

export function RichTextContent({ block, className }: Props) {
  const sanitized = DOMPurify.sanitize(block.innerHTML, {
    USE_PROFILES: { html: true },
  });

  if (!sanitized.trim()) return null;

  return (
    <div
      className={["wp-block-passthrough", className].filter(Boolean).join(" ")}
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}
