import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

/**
 * Marketing-site chrome (top nav + footer). Used by every public route —
 * the landing page, /preview, /pricing — so nav links stay in lockstep
 * when the marketing site grows.
 *
 * Auth-aware: the nav reads the current user via the Supabase server
 * client and swaps the "Sign in / Try it free" pair for a "Dashboard"
 * link when a session exists. Marketing routes are public (no middleware
 * gating), so the read is purely cosmetic — a stale-cookie user still
 * gets the unauthenticated CTAs and ends up at /sign-in if they try to
 * open the dashboard.
 *
 * Both `MarketingHeader` and `MarketingFooter` are async Server
 * Components. Consumers don't need to know — `await` works in
 * Server-Component JSX.
 */

async function getCurrentUserEmail(): Promise<string | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user?.email ?? null;
  } catch {
    // Marketing pages must never crash on an auth lookup. If supabase is
    // misconfigured at runtime the page still renders — just always in the
    // signed-out state.
    return null;
  }
}

export async function MarketingHeader() {
  const userEmail = await getCurrentUserEmail();
  const signedIn = Boolean(userEmail);
  return (
    <nav className="sticky top-0 z-50 flex h-16 items-center justify-between border-b border-bord bg-bg/90 px-6 backdrop-blur-xl lg:px-[60px]">
      <Link href="/" className="flex items-center gap-2.5 text-wht no-underline">
        <JabLogoMark size={30} />
        <strong className="font-display text-[19px] font-extrabold">JAB</strong>
      </Link>
      <div className="flex items-center gap-5 lg:gap-7">
        <Link href="/#how" className="hidden text-sm text-gry transition-colors hover:text-wht sm:inline">
          How it works
        </Link>
        <Link href="/#features" className="hidden text-sm text-gry transition-colors hover:text-wht sm:inline">
          Features
        </Link>
        <Link href="/pricing" className="text-sm text-gry transition-colors hover:text-wht">
          Pricing
        </Link>
        <div className="hidden h-5 w-px bg-bord sm:block" />
        {signedIn ? (
          <Link
            href="/dashboard"
            className="whitespace-nowrap rounded-md bg-teal px-5 py-2 text-sm font-semibold text-bg transition-[filter] hover:brightness-110"
          >
            Open dashboard
          </Link>
        ) : (
          <>
            <Link href="/sign-in" className="text-sm text-gry transition-colors hover:text-wht">
              Sign in
            </Link>
            <Link
              href="/preview"
              className="whitespace-nowrap rounded-md bg-teal px-5 py-2 text-sm font-semibold text-bg transition-[filter] hover:brightness-110"
            >
              Try it free
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}

export async function MarketingFooter() {
  const userEmail = await getCurrentUserEmail();
  const signedIn = Boolean(userEmail);
  return (
    <footer className="border-t border-bord px-6 pb-10 pt-16 lg:px-[60px]">
      <div className="mx-auto max-w-[1260px]">
        <div className="mb-12 grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-[2.2fr_1fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <JabLogoMark size={30} />
              <strong className="font-display text-lg font-extrabold text-wht">JAB</strong>
            </div>
            <p className="mt-3.5 max-w-[280px] text-sm leading-relaxed text-gry">
              Ship fast. Stay WordPress. Built for agencies who want the speed
              of the modern web without abandoning the CMS they rely on.
            </p>
            <div className="mt-3.5 font-mono text-[11px] text-gry-d">
              v1.0 · jab.dev
            </div>
          </div>
          <FooterCol title="Product" links={[
            { label: "How it works", href: "/#how" },
            { label: "Features", href: "/#features" },
            { label: "Pricing", href: "/pricing" },
            { label: "Docs", href: "#" },
            { label: "Changelog", href: "#" },
          ]} />
          <FooterCol title="Company" links={[
            { label: "About", href: "#" },
            { label: "Blog", href: "#" },
            { label: "Careers", href: "#" },
            { label: "Contact", href: "#" },
          ]} />
          <FooterCol title="Legal" links={[
            { label: "Privacy", href: "#" },
            { label: "Terms", href: "#" },
            { label: "Security", href: "#" },
          ]} />
        </div>
        <div className="flex flex-col items-start justify-between gap-3 border-t border-bord pt-6 sm:flex-row sm:items-center">
          <div className="font-mono text-xs text-gry-d">
            © {new Date().getFullYear()} JAB. Built for WordPress agencies.
          </div>
          <div className="flex items-center gap-6">
            {signedIn ? (
              <>
                <Link href="/dashboard" className="text-[13px] text-gry-d transition-colors hover:text-gry">
                  Dashboard
                </Link>
                <Link href="/pricing" className="text-[13px] text-gry-d transition-colors hover:text-gry">
                  Pricing
                </Link>
              </>
            ) : (
              <>
                <Link href="/preview" className="text-[13px] text-gry-d transition-colors hover:text-gry">
                  Try it free
                </Link>
                <Link href="/pricing" className="text-[13px] text-gry-d transition-colors hover:text-gry">
                  Pricing
                </Link>
                <Link href="/sign-in" className="text-[13px] text-gry-d transition-colors hover:text-gry">
                  Sign in
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({
  title,
  links,
}: {
  title: string;
  links: { label: string; href: string }[];
}) {
  return (
    <div>
      <h4 className="mb-4 font-mono text-[11px] uppercase tracking-[0.15em] text-gry-d">
        {title}
      </h4>
      {links.map((link) => (
        <Link
          key={`${title}-${link.label}`}
          href={link.href}
          className="mb-2.5 block text-sm text-gry no-underline transition-colors hover:text-wht"
        >
          {link.label}
        </Link>
      ))}
    </div>
  );
}

/**
 * The brand mark — a small dark-elev rounded square with `J›` in display
 * font, the J in teal and the chevron faded white. Same SVG as the
 * sidebar/auth/site-icon variations, parameterized only by size so each
 * surface can opt to a slightly larger or smaller mark.
 */
export function JabLogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="7" fill="rgb(15 32 64)" stroke="rgb(26 49 88)" />
      <text x="4" y="23" fontFamily="var(--font-display), sans-serif" fontWeight="800" fontSize="18">
        <tspan fill="rgb(0 201 167)">J</tspan>
        <tspan fill="rgb(240 244 248)" opacity="0.22">›</tspan>
      </text>
    </svg>
  );
}
