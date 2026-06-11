/**
 * Draft-runtime stand-in for next/link: a plain anchor. The entry's global
 * click interceptor (entry.tsx) handles same-site navigation via pushState,
 * so no per-link behavior is needed here.
 */
import type { AnchorHTMLAttributes, ReactElement, ReactNode } from "react";

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string | { pathname?: string };
  children?: ReactNode;
  prefetch?: boolean;
  scroll?: boolean;
  replace?: boolean;
}

export default function Link({ href, children, prefetch, scroll, replace, ...rest }: LinkProps): ReactElement {
  void prefetch; void scroll; void replace;
  const resolved = typeof href === "string" ? href : href?.pathname ?? "#";
  return (
    <a href={resolved} {...rest}>
      {children}
    </a>
  );
}
