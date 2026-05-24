import Link from "next/link";
import { MarketingHeader, MarketingFooter } from "@/components/marketing-chrome";

/**
 * Marketing landing — JAB dark brand implementation.
 *
 * Audience: small/medium marketing agencies that ship WordPress sites for
 * clients and have no React/Next.js developers. The original "WordPress
 * is just a blog" headline (inaccurate + slightly insulting to that
 * audience) is gone — this lands on "Fast, modern websites from your
 * client's WordPress" with the eyebrow framing "Headless WordPress for
 * agencies".
 *
 * Real screenshots / customer logos arrive once Phase 0 concierge
 * engagements land — the trust-bar names + the demo browser placeholder
 * hold those slots. See `docs/concierge-runbook.md`.
 *
 * Primary CTAs route to `/preview` (anonymous wow path that promotes on
 * sign-up) and `/sign-up`. Nav "Try it free" routes to `/sign-up` to
 * match the design's intent; the in-hero primary keeps the heavier-touch
 * `/preview` CTA visible.
 */
export default function Home() {
  return (
    <div className="min-h-screen bg-bg text-wht">
      <MarketingHeader />
      <main>
        <Hero />
        <TrustBar />
        <HowItWorks />
        <Features />
        <Demo />
        <ClosingCta />
      </main>
      <MarketingFooter />
    </div>
  );
}

/* ────────────────────────── Hero ────────────────────────── */

function Hero() {
  return (
    <section className="relative flex min-h-[calc(100vh-64px)] items-center overflow-hidden px-6 py-20 lg:px-[60px]">
      <DotsBackground />
      <div
        className="pointer-events-none absolute -right-20 -top-44 h-[800px] w-[800px]"
        style={{
          background:
            "radial-gradient(circle, rgba(0,201,167,0.08) 0%, transparent 65%)",
        }}
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-32 -left-44 h-[700px] w-[700px]"
        style={{
          background:
            "radial-gradient(circle, rgba(37,99,255,0.05) 0%, transparent 65%)",
        }}
        aria-hidden="true"
      />

      <div className="relative z-10 mx-auto grid w-full max-w-[1260px] grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-20">
        <div>
          <span className="mb-7 inline-flex items-center gap-2 rounded-full border border-teal/20 bg-teal/[0.07] px-3.5 py-1 font-mono text-[11px] uppercase tracking-[0.16em] text-teal">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-teal" aria-hidden="true" />
            Headless WordPress for agencies
          </span>
          <h1 className="mb-7 font-display text-[44px] font-extrabold leading-[1.15] tracking-[-0.03em] text-wht sm:text-[56px] lg:text-[64px]">
            Fast, modern
            <br />
            websites from
            <br />
            your client&apos;s{" "}
            <em className="not-italic text-teal">WordPress.</em>
          </h1>
          <p className="mb-9 max-w-[460px] text-[17px] leading-[1.65] text-gry">
            Keep building the WordPress sites your clients already know how to
            edit. We turn each one into a fast, modern frontend — AI does the
            design work, we handle the hosting, the site stays in sync whenever
            WordPress changes.
          </p>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Link
              href="/preview"
              className="inline-flex items-center gap-2 rounded-md bg-teal px-6 py-3 text-[15px] font-semibold text-bg no-underline transition-[filter] hover:brightness-110"
            >
              Try it with your client&apos;s site
              <ArrowRight />
            </Link>
            <Link
              href="/sign-up"
              className="inline-flex items-center gap-2 rounded-md border-[1.5px] border-bord bg-transparent px-6 py-3 text-[15px] font-medium text-wht no-underline transition-colors hover:border-gry"
            >
              Create an account
            </Link>
          </div>
          <p className="font-mono text-[13px] text-gry-d">
            See a generated homepage in about a minute. No account needed to try.
          </p>
        </div>

        <Terminal />
      </div>
    </section>
  );
}

function Terminal() {
  return (
    <div
      className="overflow-hidden rounded-2xl border border-bord bg-bg"
      style={{ boxShadow: "0 40px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.025)" }}
    >
      <div className="flex items-center gap-1.5 border-b border-bord bg-surf px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#ff5f57" }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#febc2e" }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#28c840" }} />
        <span className="ml-2 font-mono text-xs text-gry-d">Terminal</span>
      </div>
      <div className="space-y-1 px-7 py-7 font-mono text-[13px] leading-loose">
        <div><span className="text-teal">$ </span>npx create-jab-app acme-coffee</div>
        <div>&nbsp;</div>
        <TermLine ok>Connected to WordPress</TermLine>
        <TermLine ok>
          Detected <Num>8</Num> content types
        </TermLine>
        <TermLine ok>
          Pulled <Num>47</Num> content items
        </TermLine>
        <TermLine ok>AI generating homepage…</TermLine>
        <div>&nbsp;</div>
        <div><span className="text-teal">$ </span>jab deploy --prod</div>
        <div>&nbsp;</div>
        <TermLine ok>
          Built in <Num>2.1s</Num>
        </TermLine>
        <TermLine ok>
          Deployed to edge (<Num>14</Num> regions)
        </TermLine>
        <TermLine ok>
          Lighthouse score: <Num>94</Num> / 100
        </TermLine>
        <div>&nbsp;</div>
        <div>
          <span className="text-gry-d">→ </span>
          <span className="text-gry">Live at </span>
          <span className="text-blue">acme-coffee.jabwp.app</span>
        </div>
        <div>&nbsp;</div>
        <div>
          <span className="text-teal">$ </span>
          <span
            className="inline-block h-3.5 w-2 align-text-bottom bg-teal animate-blink"
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
}

function TermLine({ ok, children }: { ok?: boolean; children: React.ReactNode }) {
  return (
    <div>
      {ok && <span className="text-teal">✓</span>} <span className="text-gry">{children}</span>
    </div>
  );
}

function Num({ children }: { children: React.ReactNode }) {
  return <span className="text-amb">{children}</span>;
}

/* ─────────────────────── Trust bar ──────────────────────── */

function TrustBar() {
  const logos = [
    "Two Roads Brewing",
    "Harbor Dental",
    "Nordic Home",
    "Westfield Law",
    "Blue Ridge Bakery",
  ];
  return (
    <div className="border-y border-bord bg-surf px-6 py-7 lg:px-[60px]">
      <div className="mx-auto flex max-w-[1260px] flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-5">
        <span className="whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.15em] text-gry-d">
          Trusted by agencies building for
        </span>
        <div className="hidden h-[18px] w-px shrink-0 bg-bord sm:block" />
        <div className="flex flex-1 flex-wrap items-center gap-x-10 gap-y-3">
          {logos.map((l) => (
            <span
              key={l}
              className="font-display text-sm font-bold text-gry-d"
            >
              {l}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────── How it works ───────────────────── */

function HowItWorks() {
  return (
    <Section id="how" tag="01 — How it works" title="Three steps to live." description="From a fresh WordPress install to a live, modern client-facing site. No developer required.">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StepCard
          n="01"
          title="Connect WordPress"
          body="Drop in your client's WordPress URL and an application password. We read its content types automatically — posts, pages, custom fields, the works."
          icon={
            <svg width="32" height="32" viewBox="0 0 48 48" fill="none">
              <rect x="4" y="8" width="40" height="32" rx="4" stroke="rgb(var(--teal))" strokeWidth="1.5" />
              <path d="M12 20L20 24L12 28" stroke="rgb(var(--teal))" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M22 28H32" stroke="rgb(var(--teal))" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          }
        />
        <StepCard
          n="02"
          title="Generate the site"
          body="AI builds the homepage and templates around your client's real content. You watch a live preview URL come up while it works."
          icon={
            <svg width="32" height="32" viewBox="0 0 48 48" fill="none">
              <path d="M24 8l2 12 12 4-12 4-2 12-2-12-12-4 12-4z" stroke="rgb(var(--teal))" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          }
        />
        <StepCard
          n="03"
          title="Publish to a real URL"
          body={
            <>
              Promote the preview to production. Refine in plain English — &ldquo;make the hero bigger&rdquo;. Connect a custom domain when you&apos;re ready.
            </>
          }
          icon={
            <svg width="32" height="32" viewBox="0 0 48 48" fill="none">
              <circle cx="24" cy="24" r="18" stroke="rgb(var(--teal))" strokeWidth="1.5" />
              <path d="M24 6C18 14 18 34 24 42M24 6C30 14 30 34 24 42" stroke="rgb(var(--teal))" strokeWidth="1.5" />
              <path d="M6 24H42" stroke="rgb(var(--teal))" strokeWidth="1.5" />
            </svg>
          }
        />
      </div>
    </Section>
  );
}

function StepCard({
  n,
  title,
  body,
  icon,
}: {
  n: string;
  title: string;
  body: React.ReactNode;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-bord bg-elev p-8 transition-[border-color,box-shadow] duration-200 hover:border-teal/25 hover:shadow-[0_8px_32px_rgba(0,0,0,0.3)]">
      <div className="mb-6 inline-block rounded-md border border-bord bg-bg px-2 py-1 font-mono text-[11px] text-gry-d">
        {n}
      </div>
      <div className="mb-5">{icon}</div>
      <h3 className="mb-2.5 font-display text-[21px] font-bold leading-snug text-wht">
        {title}
      </h3>
      <p className="text-[14.5px] leading-[1.65] text-gry">{body}</p>
    </div>
  );
}

/* ───────────────────────── Features ─────────────────────── */

function Features() {
  return (
    <Section id="features" tag="02 — Features" title="Built for agencies." description="Everything you need to deliver modern sites without hiring a frontend developer." alt>
      <div className="overflow-hidden rounded-2xl border border-bord">
        <div className="grid grid-cols-1 gap-px bg-bord md:grid-cols-2">
          <FeatureCard
            icon={<svg width="22" height="22" viewBox="0 0 48 48" fill="none"><path d="M28 6L16 26h8l-4 16L34 22h-8z" stroke="rgb(var(--teal))" strokeWidth="1.5" strokeLinejoin="round" /></svg>}
            title="Edge performance"
            body="Sub-100ms TTFB globally. Static pages served from 14 edge regions. Your client gets a Lighthouse score in the 90s without you touching a line of code."
            tag="< 100ms TTFB globally"
          />
          <FeatureCard
            icon={<svg width="22" height="22" viewBox="0 0 48 48" fill="none"><path d="M24 8l2 12 12 4-12 4-2 12-2-12-12-4 12-4z" stroke="rgb(var(--teal))" strokeWidth="1.5" strokeLinejoin="round" /></svg>}
            title="AI content updates"
            body={
              <>
                Update your frontend in plain English — &ldquo;make the hero bigger&rdquo;, &ldquo;use their brand blue&rdquo;. JAB translates your prompt into a deploy. No back-and-forth with devs.
              </>
            }
            tag={'$ jab prompt "Update hero copy"'}
          />
          <FeatureCard
            icon={<svg width="22" height="22" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="18" stroke="rgb(var(--teal))" strokeWidth="1.5" /><path d="M24 6C18 14 18 34 24 42M24 6C30 14 30 34 24 42" stroke="rgb(var(--teal))" strokeWidth="1.5" /><path d="M6 24H42" stroke="rgb(var(--teal))" strokeWidth="1.5" /></svg>}
            title="WordPress stays the CMS"
            body="Your client keeps editing in WordPress. No migration. No retraining. Content syncs automatically whenever they publish — the frontend updates in seconds."
            tag="Real-time sync"
          />
          <FeatureCard
            icon={<svg width="22" height="22" viewBox="0 0 48 48" fill="none"><rect x="8" y="12" width="32" height="24" rx="3" stroke="rgb(var(--teal))" strokeWidth="1.5" /><path d="M14 20h20M14 26h14M14 32h8" stroke="rgb(var(--teal))" strokeWidth="1.5" strokeLinecap="round" /></svg>}
            title="White-label ready"
            body="Custom domains on every site. Client-facing dashboards with your agency branding. Resell JAB as your own modern web platform — we stay invisible."
            tag="Custom domains included"
          />
        </div>
      </div>
    </Section>
  );
}

function FeatureCard({
  icon,
  title,
  body,
  tag,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  tag: string;
}) {
  return (
    <div className="bg-surf p-11 transition-colors duration-200 hover:bg-elev">
      <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl border border-teal/15 bg-teal/[0.09]">
        {icon}
      </div>
      <h3 className="mb-2.5 font-display text-[23px] font-bold leading-snug text-wht">
        {title}
      </h3>
      <p className="text-[15px] leading-[1.65] text-gry">{body}</p>
      <span className="mt-3.5 inline-block rounded-sm border border-teal/15 bg-teal/[0.09] px-2.5 py-0.5 font-mono text-[11px] text-teal">
        {tag}
      </span>
    </div>
  );
}

/* ───────────────────────── Demo ─────────────────────────── */

function Demo() {
  return (
    <Section id="demo" tag="03 — Demo" title="See it in action." description="A real before/after from a Two Roads Brewing pilot — same WordPress backend, brand new frontend.">
      <div
        className="overflow-hidden rounded-2xl border border-bord bg-surf"
        style={{ boxShadow: "0 24px 48px rgba(0,0,0,0.4)" }}
      >
        <div className="flex items-center gap-3 border-b border-bord bg-bg px-4 py-3">
          <div className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#ff5f57" }} />
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#febc2e" }} />
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#28c840" }} />
          </div>
          <div className="flex flex-1 items-center gap-1.5 rounded-md border border-bord bg-elev px-3 py-1.5 font-mono text-xs text-gry">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--teal))" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            client.jabwp.app/two-roads-brewing/
          </div>
        </div>
        <div className="relative flex h-[420px] items-center justify-center overflow-hidden">
          <DotsBackground opacity={0.15} />
          <div className="relative z-10 text-center font-mono text-[13px] text-gry-d">
            <svg width="28" height="28" viewBox="0 0 48 48" fill="none" className="mx-auto mb-2.5 opacity-20">
              <circle cx="24" cy="24" r="18" stroke="rgb(var(--gry))" strokeWidth="1.5" />
              <path d="M24 6C18 14 18 34 24 42M24 6C30 14 30 34 24 42" stroke="rgb(var(--gry))" strokeWidth="1.5" />
              <path d="M6 24H42" stroke="rgb(var(--gry))" strokeWidth="1.5" />
            </svg>
            Live preview demo coming soon
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ─────────────────────── Closing CTA ────────────────────── */

function ClosingCta() {
  return (
    <section id="cta" className="border-t border-bord bg-surf px-6 py-24 text-center lg:px-[60px]">
      <div className="mx-auto max-w-[1260px]">
        <span className="mb-5 inline-block font-mono text-[11px] uppercase tracking-[0.2em] text-teal">
          Ready to ship?
        </span>
        <h2 className="mb-4 font-display text-[40px] font-extrabold leading-[1.2] tracking-[-0.03em] text-wht sm:text-[48px] lg:text-[56px]">
          Ready to ship faster
          <br />
          WordPress sites?
        </h2>
        <p className="mb-9 text-[17px] leading-[1.6] text-gry">
          Generate a homepage from one of your client&apos;s sites and see for yourself.
          <br className="hidden sm:block" />
          {" "}About a minute. No account needed.
        </p>
        <Link
          href="/preview"
          className="inline-flex items-center gap-2 rounded-md bg-teal px-9 py-4 text-base font-semibold text-bg no-underline transition-[filter] hover:brightness-110"
        >
          Try it free
          <ArrowRight />
        </Link>
      </div>
    </section>
  );
}

/* ─────────────────────── Shared ─────────────────────────── */

function Section({
  id,
  tag,
  title,
  description,
  alt,
  children,
}: {
  id?: string;
  tag: string;
  title: string;
  description: string;
  alt?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={`border-t border-bord px-6 py-24 lg:px-[60px] ${alt ? "bg-surf" : ""}`}
    >
      <div className="mx-auto max-w-[1260px]">
        <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.2em] text-teal">
          {tag}
        </div>
        <h2 className="mb-4 font-display text-[36px] font-extrabold leading-[1.2] tracking-[-0.025em] text-wht sm:text-[44px] lg:text-[52px]">
          {title}
        </h2>
        <p className="mb-13 max-w-[540px] text-[17px] leading-[1.65] text-gry" style={{ marginBottom: "52px" }}>
          {description}
        </p>
        {children}
      </div>
    </section>
  );
}

function DotsBackground({ opacity = 0.22 }: { opacity?: number }) {
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage: "radial-gradient(circle, #1e3a5f 1px, transparent 1px)",
        backgroundSize: "40px 40px",
        opacity,
      }}
      aria-hidden="true"
    />
  );
}

function ArrowRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );
}
