import Link from "next/link";
import { PreviewFlow } from "./preview-flow";

/**
 * Public preview surface — steps 1-2 of the §12 wow-before-friction flow.
 *
 * No auth, no account, no plugin install. Paste a URL, get a generated
 * homepage. Save button → /sign-up promotes the anonymous draft to a tenant.
 *
 * Today this uses a hardcoded mock generator (see preview-flow.tsx). The
 * real lib/ai/scrape-agent.ts arrives as an engineering ticket; the visual
 * flow stays identical.
 */
export default function PreviewPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <Link
            href="/"
            className="text-xl font-extrabold tracking-tight text-slate-900"
          >
            Jab
          </Link>
          <Link
            href="/sign-in"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-8 px-6 py-12">
        <div className="space-y-3 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            See what your client&apos;s site could look like.
          </h1>
          <p className="mx-auto max-w-2xl text-base text-slate-600">
            Paste a WordPress URL. We&apos;ll generate a modern homepage from
            what&apos;s publicly visible — about a minute. No account needed
            until you want to save it.
          </p>
        </div>

        <PreviewFlow />
      </main>
    </div>
  );
}
