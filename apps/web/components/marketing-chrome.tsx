import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * Marketing-site chrome (top nav + footer). Used by every public route — the
 * landing page, /preview, /pricing — so nav links stay in lockstep when the
 * marketing site grows.
 *
 * Keep this dumb. No client state, no auth-awareness — auth-aware nav lives
 * inside the (app)/* layout. If you find yourself wanting to conditionally
 * render a "Dashboard" link here based on the user, that means this should
 * be a layout component over the marketing routes, not this primitive.
 */

export function MarketingHeader() {
  return (
    <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
      <Link
        href="/"
        className="text-xl font-extrabold tracking-tight text-slate-900"
      >
        Jab
      </Link>
      <nav className="flex items-center gap-4 text-sm">
        <Link
          href="/pricing"
          className="font-medium text-slate-600 hover:text-slate-900"
        >
          Pricing
        </Link>
        <Link
          href="/sign-in"
          className="font-medium text-slate-600 hover:text-slate-900"
        >
          Sign in
        </Link>
        <Link href="/preview">
          <Button size="sm">Try it free</Button>
        </Link>
      </nav>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white px-6 py-8">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-3 text-xs text-slate-500 sm:flex-row">
        <span>© {new Date().getFullYear()} Jab. Built for WordPress agencies.</span>
        <div className="flex items-center gap-4">
          <Link href="/preview" className="hover:text-slate-900">
            Try it free
          </Link>
          <Link href="/pricing" className="hover:text-slate-900">
            Pricing
          </Link>
          <Link href="/sign-up" className="hover:text-slate-900">
            Create an account
          </Link>
          <Link href="/sign-in" className="hover:text-slate-900">
            Sign in
          </Link>
        </div>
      </div>
    </footer>
  );
}
