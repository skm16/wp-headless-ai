import { MarketingHeader, MarketingFooter } from "@/components/marketing-chrome";
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
    <div className="min-h-screen bg-bg text-wht">
      <MarketingHeader />
      <main className="mx-auto max-w-4xl space-y-10 px-6 py-16 lg:px-[60px]">
        <div className="space-y-4 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-teal/20 bg-teal/[0.07] px-3.5 py-1 font-mono text-[11px] uppercase tracking-[0.16em] text-teal">
            <span className="h-1.5 w-1.5 rounded-full bg-teal" aria-hidden="true" />
            Free preview
          </span>
          <h1 className="font-display text-[40px] font-extrabold leading-[1.15] tracking-[-0.03em] text-wht sm:text-[48px]">
            See what your client&apos;s site could look like.
          </h1>
          <p className="mx-auto max-w-2xl text-base leading-[1.65] text-gry">
            Paste a WordPress URL. We&apos;ll generate a modern homepage from
            what&apos;s publicly visible — about a minute. No account needed
            until you want to save it.
          </p>
        </div>

        <PreviewFlow />
      </main>
      <MarketingFooter />
    </div>
  );
}
