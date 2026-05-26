import NextLink from "next/link";
import type { BlockNode } from "@/lib/jab/ability-client";

/**
 * Nav — platform shim for `core/navigation` blocks.
 *
 * In Gutenberg, navigation blocks reference a wp_navigation post via the
 * `ref` attribute. Phase A's jab/get-menus call resolves these into a flat
 * NavItem[] which Phase C injects as a prop. When the prop is absent
 * (e.g. catch-all dynamic route that didn't pre-fetch), renders an empty
 * <nav> — keeps the markup valid without throwing.
 *
 * Hand-written platform component (not LLM-generated). One generic
 * implementation tokens-driven via Tailwind; mega-menus / mobile drawers
 * are deferred until pilot evidence demands a variant.
 */

interface CoreNavigationAttrs {
  ref?: number;
  overlayMenu?: string;
  className?: string;
  textColor?: string;
  backgroundColor?: string;
}

interface NavItem {
  id: number;
  title: string;
  url: string;
  target?: string;
  parent_id: number;
  order: number;
}

interface Props {
  block: BlockNode;
  /**
   * Pre-resolved menu items injected by the page composition layer (Phase C).
   * When absent (e.g. catch-all dynamic route that didn't pre-fetch menus),
   * the Nav renders an empty <nav> to avoid hydration errors.
   */
  items?: NavItem[];
}

export function Nav({ block, items = [] }: Props) {
  const attrs = block.attrs as CoreNavigationAttrs;
  const topLevel = items.filter((item) => item.parent_id === 0).sort((a, b) => a.order - b.order);

  return (
    <nav
      className={["wp-block-navigation", attrs.className].filter(Boolean).join(" ")}
      aria-label="Site navigation"
    >
      <ul className="wp-block-navigation__container">
        {topLevel.map((item) => (
          <li key={item.id} className="wp-block-navigation-item">
            <NextLink
              href={item.url}
              className="wp-block-navigation-item__content"
              target={item.target || undefined}
            >
              {item.title}
            </NextLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
