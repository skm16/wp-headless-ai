import NextLink from "next/link";
import type { BlockNode } from "@/lib/jab/ability-client";

/**
 * Link — platform shim for `core/button` blocks.
 *
 * Routes internal URLs through next/link for client-side navigation;
 * external URLs render as plain <a target="_blank"> with safe rel attrs.
 * Hand-written platform component (not LLM-generated).
 */

interface CoreButtonAttrs {
  url?: string;
  text?: string;
  linkTarget?: string;
  rel?: string;
  className?: string;
  backgroundColor?: string;
  textColor?: string;
}

interface Props {
  block: BlockNode;
}

function isInternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "" || parsed.pathname.startsWith("/");
  } catch {
    return true;
  }
}

export function Link({ block }: Props) {
  const attrs = block.attrs as CoreButtonAttrs;
  const url = attrs.url ?? "#";
  const text = attrs.text ?? block.innerHTML.replace(/<[^>]+>/g, "").trim();
  const external = attrs.linkTarget === "_blank" || !isInternalUrl(url);

  const className = [
    "wp-block-button__link",
    attrs.className,
  ]
    .filter(Boolean)
    .join(" ");

  if (external) {
    return (
      <div className="wp-block-button">
        <a
          href={url}
          className={className}
          target="_blank"
          rel={attrs.rel ?? "noopener noreferrer"}
          dangerouslySetInnerHTML={{ __html: text }}
        />
      </div>
    );
  }

  return (
    <div className="wp-block-button">
      <NextLink
        href={url}
        className={className}
        dangerouslySetInnerHTML={{ __html: text }}
      />
    </div>
  );
}
