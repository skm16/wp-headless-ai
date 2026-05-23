"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { ProgressSteps } from "@/components/ui/progress-steps";
import { PreviewFrame } from "@/components/preview-frame";
import { CaveatsBanner } from "@/components/caveats-banner";
import {
  getPreviewStatusAction,
  triggerPreviewScrapeAction,
} from "@/lib/actions/preview";

type PreviewState =
  | { kind: "idle" }
  | { kind: "starting" }
  | {
      kind: "generating";
      previewId: string;
      step: 0 | 1 | 2 | 3;
      sourceUrl: string;
    }
  | { kind: "done"; sourceUrl: string; srcDoc: string }
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

const POLL_INTERVAL_MS = 2500;
// The backend's `running` status doesn't tell us which sub-phase (scrape vs
// render) the worker is in. The UX step labels are interpolated from elapsed
// time as a rough ETA — total job is ~30-60s in practice. We never *skip
// backwards* — if elapsed-time says step 1 but the row is already succeeded,
// the success path overrides.
const STEP_ETA_MS = [4_000, 12_000, 22_000] as const;
// Give up after this long — the worker crashed between mark-running and
// any other step, or Inngest is down. Surfaces "took too long" copy
// instead of polling forever. 3 min comfortably covers the 95th percentile
// of real generations (typically ≤60s).
const POLL_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Public preview flow. POST URL → server action enqueues a row in
 * `anonymous_previews` and dispatches an Inngest event → worker runs
 * scrape-agent (fetch + 2 LLM passes) + preview-renderer (3rd LLM call) →
 * this component polls `getPreviewStatusAction` for the result.
 *
 * Session is cookie-keyed (server action sets it on first call). Result rows
 * have a 24h TTL; the engineering prune cron is filed in the design plan §11.
 */
export function PreviewFlow() {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<PreviewState>({ kind: "idle" });
  const [pending, startTransition] = useTransition();
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stepTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const giveUpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Becomes false on unmount or when the active generation ends, so an
  // in-flight `getPreviewStatusAction()` resolving late can't setState on
  // a stale generation. Without this, React 18 silently no-ops post-
  // unmount but logs a strict-mode warning; more importantly a generation
  // that resolves after the user has navigated away or started a new one
  // would clobber the new state.
  const aliveRef = useRef(true);

  // Always-on cleanup — both poll + step timers stop on unmount or
  // whenever the active generation ends.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      stopAllTimers();
    };
  }, []);

  function stopAllTimers() {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (giveUpTimerRef.current !== null) {
      clearTimeout(giveUpTimerRef.current);
      giveUpTimerRef.current = null;
    }
    for (const t of stepTimersRef.current) clearTimeout(t);
    stepTimersRef.current = [];
  }

  function scheduleStepAdvances(previewId: string) {
    STEP_ETA_MS.forEach((etaMs, idx) => {
      const target = (idx + 1) as 1 | 2 | 3;
      const t = setTimeout(() => {
        if (!aliveRef.current) return;
        setState((prev) => {
          if (prev.kind !== "generating" || prev.previewId !== previewId) {
            return prev;
          }
          if (prev.step >= target) return prev;
          return { ...prev, step: target };
        });
      }, etaMs);
      stepTimersRef.current.push(t);
    });
  }

  function startPolling(previewId: string, sourceUrl: string) {
    // Hard ceiling — if the worker never reports succeeded/failed within
    // POLL_TIMEOUT_MS, give up and surface a recoverable error rather
    // than spinning forever.
    giveUpTimerRef.current = setTimeout(() => {
      if (!aliveRef.current) return;
      stopAllTimers();
      setState({
        kind: "failed",
        reason:
          "This preview is taking longer than expected. Try again, or contact us if it keeps happening.",
      });
    }, POLL_TIMEOUT_MS);

    const tick = async () => {
      let result: Awaited<ReturnType<typeof getPreviewStatusAction>>;
      try {
        result = await getPreviewStatusAction(previewId);
      } catch (err) {
        if (!aliveRef.current) return;
        stopAllTimers();
        setState({
          kind: "failed",
          reason:
            err instanceof Error
              ? `Couldn't reach the preview server: ${err.message}`
              : "Couldn't reach the preview server.",
        });
        return;
      }

      // Late-resolution guard — if we unmounted or already settled the
      // generation while this fetch was in flight, drop the result.
      if (!aliveRef.current) return;

      if (result.status === "succeeded") {
        stopAllTimers();
        setState({
          kind: "done",
          sourceUrl,
          srcDoc: result.generatedHtml,
        });
        return;
      }
      if (result.status === "failed") {
        stopAllTimers();
        setState({ kind: "failed", reason: result.error });
        return;
      }
      if (result.status === "not_found" || result.status === "forbidden") {
        stopAllTimers();
        setState({
          kind: "failed",
          reason:
            result.status === "forbidden"
              ? "We couldn't verify your preview session. Try refreshing the page."
              : "That preview couldn't be found.",
        });
        return;
      }

      // queued / running — keep polling.
      pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const submitted = url.trim();
    if (!submitted) return;

    setState({ kind: "starting" });
    startTransition(async () => {
      const normalized = normalizeUrl(submitted);
      const result = await triggerPreviewScrapeAction(normalized);
      if (!result.ok) {
        setState({ kind: "failed", reason: result.error });
        return;
      }
      scheduleStepAdvances(result.previewId);
      setState({
        kind: "generating",
        previewId: result.previewId,
        step: 0,
        sourceUrl: normalized,
      });
      startPolling(result.previewId, normalized);
    });
  }

  function reset() {
    stopAllTimers();
    setState({ kind: "idle" });
  }

  const generating = state.kind === "generating" || state.kind === "starting";

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
                disabled={generating}
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
                loading={generating || pending}
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
            url={state.sourceUrl}
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
