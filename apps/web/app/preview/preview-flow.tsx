"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { ProgressSteps } from "@/components/ui/progress-steps";
import { PreviewFrame } from "@/components/preview-frame";
import { CaveatsBanner } from "@/components/caveats-banner";

type PreviewState =
  | { kind: "idle" }
  | { kind: "generating"; step: 0 | 1 | 2 | 3 }
  | { kind: "done"; url: string; srcDoc: string }
  | { kind: "failed"; reason: string };

const PROGRESS_LABELS = [
  {
    label: "Reading your WordPress content",
    description: "Looking at what's on the homepage right now",
  },
  {
    label: "Designing your homepage",
    description: "This is the slow part — usually about a minute",
  },
  { label: "Building the site", description: "Laying out the page" },
  { label: "Going live on your preview URL", description: "Almost there" },
];

const MOCK_STEP_MS = 1000;

/**
 * Mock generation flow for the public preview surface. Lives at /preview.
 *
 * Today the state machine + progress timing is hardcoded — the real
 * scrape-agent codepath (lib/ai/scrape-agent.ts) is engineering work that
 * lands separately. Swapping the timer chain for a real Inngest subscription
 * is a single useEffect change; the visible UX stays identical so we can
 * design and validate the flow without waiting on the backend.
 */
export function PreviewFlow() {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<PreviewState>({ kind: "idle" });
  /**
   * Tracks every pending timeout from the mock generation chain so we can
   * cancel them on unmount. Without this, a fast tab-close mid-generation
   * fires setState on an unmounted component. React discards the update
   * silently in 18, but the real Inngest-backed codepath will reuse this
   * structure for live polling, and stale closures there will read outdated
   * state.
   */
  const timeoutsRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(() => {
    return () => {
      timeoutsRef.current.forEach(clearTimeout);
      timeoutsRef.current = [];
    };
  }, []);

  function schedule(fn: () => void, ms: number) {
    const id = setTimeout(fn, ms);
    timeoutsRef.current.push(id);
  }

  function startMockGeneration(submittedUrl: string) {
    const normalized = normalizeUrl(submittedUrl);
    setState({ kind: "generating", step: 0 });
    let step: 0 | 1 | 2 | 3 = 0;
    const tick = () => {
      step = (step + 1) as 1 | 2 | 3;
      if (step <= 3) {
        setState({ kind: "generating", step });
        schedule(tick, MOCK_STEP_MS);
      } else {
        setState({
          kind: "done",
          url: normalized,
          srcDoc: buildMockHomepage(extractBrandName(normalized)),
        });
      }
    };
    schedule(tick, MOCK_STEP_MS);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    startMockGeneration(url.trim());
  }

  function reset() {
    setState({ kind: "idle" });
  }

  return (
    <div className="space-y-8">
      {state.kind !== "done" && (
        <Card>
          <CardBody>
            <form onSubmit={handleSubmit} className="space-y-4">
              <Field
                label="Your client's WordPress site"
                placeholder="https://clientsite.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={state.kind === "generating"}
                required
                autoFocus
                hint="We'll generate a homepage preview from what's publicly visible. No account needed yet."
              />
              {state.kind === "failed" && (
                <Alert tone="danger">{state.reason}</Alert>
              )}
              <Button
                type="submit"
                size="lg"
                loading={state.kind === "generating"}
                loadingText="Generating preview…"
                disabled={!url.trim()}
              >
                Generate preview
              </Button>
            </form>
          </CardBody>
        </Card>
      )}

      {state.kind === "generating" && (
        <Card>
          <CardBody>
            <ProgressSteps
              steps={PROGRESS_LABELS.map((s, idx) => ({
                ...s,
                status:
                  idx < state.step
                    ? "done"
                    : idx === state.step
                      ? "current"
                      : "pending",
              }))}
            />
          </CardBody>
        </Card>
      )}

      {state.kind === "done" && (
        <div className="space-y-6">
          <PreviewFrame
            url={state.url}
            srcDoc={state.srcDoc}
            status="live"
            caption="This is what your client will see. Save it to keep iterating."
            title="Generated preview"
          />

          <Card>
            <CardBody>
              <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:justify-between sm:text-left">
                <div>
                  <p className="text-base font-semibold text-slate-900">
                    Like what you see?
                  </p>
                  <p className="text-sm text-slate-600">
                    Save it to your account. We&apos;ll set up live editing,
                    publishing, and a real URL for your client.
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button variant="ghost" onClick={reset}>
                    Try another site
                  </Button>
                  {/*
                    `?from=preview` is consumed post-signup to promote the
                    anonymous_previews row (keyed by session cookie) to a
                    real project owned by the new tenant. Engineering ticket
                    in §11 of the design plan; today the param is recorded
                    for future use and ignored by SignInForm.
                  */}
                  <Link href="/sign-up?from=preview">
                    <Button size="md">Save your preview →</Button>
                  </Link>
                </div>
              </div>
            </CardBody>
          </Card>

          <CaveatsBanner />
        </div>
      )}
    </div>
  );
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function extractBrandName(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, "");
    const root = host.split(".")[0];
    return root
      .split("-")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ");
  } catch {
    return "Your Site";
  }
}

function buildMockHomepage(brandName: string): string {
  const safeName = escapeHtml(brandName);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeName}</title>
    <style>
      *,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
      html { color-scheme: light; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1e293b; line-height: 1.5; }
      nav { display: flex; justify-content: space-between; align-items: center; padding: 1rem 2rem; border-bottom: 1px solid #e2e8f0; }
      nav .brand { font-weight: 800; font-size: 1.125rem; color: #4f46e5; letter-spacing: -0.01em; }
      nav ul { display: flex; gap: 1.5rem; list-style: none; }
      nav a { color: #475569; text-decoration: none; font-size: 0.875rem; }
      nav a:hover { color: #0f172a; }
      .hero { padding: 6rem 2rem 5rem; text-align: center; background: linear-gradient(180deg, #eef2ff 0%, #ffffff 100%); }
      .hero h1 { font-size: 3rem; line-height: 1.1; letter-spacing: -0.025em; margin-bottom: 1rem; color: #0f172a; }
      .hero p { font-size: 1.125rem; color: #64748b; max-width: 34rem; margin: 0 auto 2rem; }
      .hero .cta { display: inline-block; background: #4f46e5; color: #ffffff; padding: 0.875rem 1.75rem; border-radius: 0.5rem; text-decoration: none; font-weight: 500; font-size: 0.9375rem; }
      .hero .cta:hover { background: #4338ca; }
      .features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem; padding: 4rem 2rem; max-width: 64rem; margin: 0 auto; }
      .feature { padding: 1.5rem; border: 1px solid #e2e8f0; border-radius: 0.75rem; background: #ffffff; }
      .feature h3 { font-size: 1rem; font-weight: 600; margin-bottom: 0.5rem; color: #0f172a; }
      .feature p { color: #64748b; font-size: 0.875rem; }
      footer { border-top: 1px solid #e2e8f0; padding: 2rem; text-align: center; color: #94a3b8; font-size: 0.875rem; }
      @media (max-width: 720px) {
        nav ul { display: none; }
        .hero h1 { font-size: 2rem; }
        .features { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <nav>
      <span class="brand">${safeName}</span>
      <ul>
        <li><a href="#">About</a></li>
        <li><a href="#">Services</a></li>
        <li><a href="#">Contact</a></li>
      </ul>
    </nav>
    <section class="hero">
      <h1>Welcome to ${safeName}.</h1>
      <p>A faster, modern home for everything your team already publishes in WordPress. Same content, fresh design.</p>
      <a href="#" class="cta">Get in touch</a>
    </section>
    <section class="features">
      <div class="feature">
        <h3>Built from your content</h3>
        <p>Generated from your site's existing structure and pages. Nothing made up.</p>
      </div>
      <div class="feature">
        <h3>Stays in sync</h3>
        <p>Edit in WordPress like you always have. The new site updates automatically.</p>
      </div>
      <div class="feature">
        <h3>Refine in plain English</h3>
        <p>Want bigger headlines or a different palette? Just say so — we'll regenerate.</p>
      </div>
    </section>
    <footer>© ${new Date().getFullYear()} ${safeName} · Powered by Jab</footer>
  </body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
