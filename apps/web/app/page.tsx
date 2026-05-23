import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MarketingHeader, MarketingFooter } from "@/components/marketing-chrome";

/**
 * Marketing landing — Phase 0 interim rewrite.
 *
 * Rewrites the original "WordPress is just a blog" headline (inaccurate +
 * slightly insulting to the WP-agency audience) around the actual customer:
 * small/medium marketing agencies that ship WordPress sites for clients and
 * have no React/Next.js developers. CTA defaults to sign-up, not sign-in.
 *
 * Real screenshots / customer logos arrive once Phase 0 concierge engagements
 * land — the placeholder block holds the slot. See docs/concierge-runbook.md.
 */
export default function Home() {
  return (
    <div className="min-h-screen bg-slate-50">
      <MarketingHeader />
      <main>
        <Hero />
        <HowItWorks />
        <DemoBlock />
        <ClosingCta />
      </main>
      <MarketingFooter />
    </div>
  );
}

function Hero() {
  return (
    <section className="mx-auto max-w-3xl px-6 py-20 text-center">
      <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
        Fast, modern websites from your client&apos;s WordPress.{" "}
        <span className="text-brand">No developer required.</span>
      </h1>
      <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-600">
        Keep building the WordPress sites your clients already know how to edit.
        We turn each one into a fast, modern frontend — AI does the design work,
        we handle the hosting, and the site stays in sync whenever WordPress
        changes.
      </p>
      <div className="mt-10 flex items-center justify-center gap-3">
        <Link href="/preview">
          <Button size="lg">Try it with your client&apos;s site</Button>
        </Link>
        <Link href="/sign-up">
          <Button size="lg" variant="ghost">
            Create an account
          </Button>
        </Link>
      </div>
      <p className="mt-4 text-xs text-slate-500">
        See a generated homepage in about a minute. No account needed to try.
      </p>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: "1",
      title: "Connect WordPress",
      body: "Drop in your client's WordPress URL and an application password. We read its content types automatically — posts, pages, custom fields, the works.",
    },
    {
      n: "2",
      title: "Generate the site",
      body: "AI builds the homepage and templates around your client's real content. You watch a live preview URL come up while it works.",
    },
    {
      n: "3",
      title: "Publish to a real URL",
      body: "Promote the preview to production. Refine in plain English — 'make the hero bigger', 'use their brand blue'. Connect a custom domain when you're ready.",
    },
  ];
  return (
    <section className="border-y border-slate-200 bg-white py-20">
      <div className="mx-auto max-w-5xl px-6">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight text-slate-900">
            How it works
          </h2>
          <p className="mt-3 text-base text-slate-600">
            Three steps from a fresh WordPress install to a live, modern
            client-facing site.
          </p>
        </div>
        <ol className="mt-12 grid gap-6 md:grid-cols-3">
          {steps.map((step) => (
            <li
              key={step.n}
              className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-muted text-sm font-semibold text-brand-strong">
                {step.n}
              </span>
              <h3 className="text-base font-semibold text-slate-900">
                {step.title}
              </h3>
              <p className="text-sm text-slate-600">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function DemoBlock() {
  return (
    <section className="mx-auto max-w-5xl px-6 py-20">
      <div className="text-center">
        <h2 className="text-3xl font-bold tracking-tight text-slate-900">
          See it in action
        </h2>
        <p className="mt-3 text-base text-slate-600">
          A real before/after from a Two Roads Brewing pilot is coming soon.
        </p>
      </div>
      <div className="mt-10 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <span className="h-3 w-3 rounded-full bg-slate-300" />
          <span className="h-3 w-3 rounded-full bg-slate-300" />
          <span className="h-3 w-3 rounded-full bg-slate-300" />
          <span className="ml-3 truncate rounded bg-white px-3 py-1 text-xs text-slate-500">
            client.jabwp.app/acme-coffee/
          </span>
        </div>
        <div className="flex h-64 items-center justify-center bg-gradient-to-br from-brand-muted via-white to-slate-50">
          <p className="text-sm text-slate-500">Live preview demo coming soon</p>
        </div>
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="bg-slate-900 py-16 text-center">
      <div className="mx-auto max-w-2xl px-6">
        <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Ready to ship faster WordPress sites?
        </h2>
        <p className="mt-3 text-base text-slate-300">
          Generate a homepage from one of your client&apos;s sites and see for
          yourself. About a minute, no account needed.
        </p>
        <div className="mt-8">
          <Link href="/preview">
            <Button size="lg">Try it free</Button>
          </Link>
        </div>
      </div>
    </section>
  );
}

