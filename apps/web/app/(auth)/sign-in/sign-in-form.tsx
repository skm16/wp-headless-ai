"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PRICING_TIERS, TRIAL_SUMMARY, type TierId } from "@/lib/pricing";
import { promoteAnonymousPreviewIfPresent } from "@/lib/actions/promote-preview";

/**
 * Combined sign-in / sign-up form (Client Component).
 *
 * Handles both flows for "Confirm email" ON and OFF:
 *   - OFF: signUp returns a session immediately → redirect to dashboard.
 *   - ON: signUp returns user but session=null → show "check inbox" state.
 *     The email link must come back to /auth/callback (via emailRedirectTo)
 *     to exchange the code and establish the session.
 *
 * On success the handle_new_user trigger has already created the profile +
 * default tenant + owner membership server-side.
 */
type Mode = "sign-in" | "sign-up";

/**
 * Hardcoded server-defined messages for auth-callback failures. The callback
 * route at `/auth/callback` redirects with `?error_code=<key>` from this
 * allowlist; any other code (or a tampered URL) renders no banner at all.
 *
 * Don't extend this with caller-supplied strings — that re-opens the
 * phishing vector. New error states get a new code here AND a matching
 * `error_code=` write in the callback route.
 */
const CALLBACK_ERROR_MESSAGES: Record<string, string> = {
  missing_code:
    "That sign-in link is missing required data. Try signing in again.",
  exchange_failed:
    "We couldn't finish signing you in. The link may have expired — try again.",
};

export interface SignInFormProps {
  initialMode?: Mode;
}

export function SignInForm({ initialMode = "sign-in" }: SignInFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Validate `next` to prevent open-redirect. Must be a relative path; reject
  // protocol-relative URLs (`//evil.com`) which the browser resolves against
  // the current origin's scheme — they look local but aren't.
  const rawNext = searchParams.get("next") ?? "/dashboard";
  const next =
    rawNext.startsWith("/") && !rawNext.startsWith("//")
      ? rawNext
      : "/dashboard";
  // Auth callback errors arrive as `?error_code=<code>` (NOT free-form text).
  // We map the code to a hardcoded message catalog — a shared link with an
  // unknown code renders no banner at all, which is the correct failure mode
  // for what would otherwise be a phishing surface.
  const callbackError =
    CALLBACK_ERROR_MESSAGES[searchParams.get("error_code") ?? ""] ?? null;
  // Plan preselect from /pricing CTAs. Validated against the canonical tier
  // list so user-controlled query becomes a *selector key*, not display text —
  // we render the server-defined tier name, not raw `?plan=` input.
  const planParam = searchParams.get("plan");
  const selectedTier = PRICING_TIERS.find((t) => t.id === planParam) ?? null;

  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(callbackError);
  const [pending, setPending] = useState(false);
  const [confirmationSentTo, setConfirmationSentTo] = useState<string | null>(
    null,
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const supabase = createClient();
    try {
      if (mode === "sign-up") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
          },
        });
        if (signUpError) throw signUpError;
        if (!data.session) {
          setConfirmationSentTo(email);
          return;
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) throw signInError;
      }
      // Auth succeeded with an immediate session (email confirmation OFF, or
      // password sign-in). Promote any anonymous_previews row tied to this
      // browser's session cookie. Idempotent — null if nothing to claim,
      // in which case the original `next` redirect wins. The email-
      // confirmation path runs the same hook in /auth/callback.
      const promoted = await promoteAnonymousPreviewIfPresent();
      router.replace(promoted ? `/projects/${promoted.projectId}` : next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  if (confirmationSentTo) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-slate-900">Check your inbox</h2>
        <p className="text-sm text-slate-600">
          We sent a confirmation link to{" "}
          <span className="font-medium text-slate-900">{confirmationSentTo}</span>.
          Click it to finish creating your account — you&apos;ll land back here
          signed in.
        </p>
        <p className="text-xs text-slate-500">
          Email not arriving? Check your spam folder, then verify the Supabase
          dashboard has{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5">
            {typeof window !== "undefined" ? window.location.origin : ""}/auth/callback
          </code>{" "}
          in Authentication → URL Configuration → Redirect URLs.
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setConfirmationSentTo(null);
            setMode("sign-in");
          }}
        >
          ← Back to sign in
        </Button>
      </div>
    );
  }

  const otherMode = mode === "sign-in" ? "sign-up" : "sign-in";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-900">
        {mode === "sign-in" ? "Sign in" : "Create account"}
      </h2>

      {mode === "sign-up" && selectedTier && (
        <TierPreselectBanner tierId={selectedTier.id} tierName={selectedTier.name} />
      )}

      <Field
        label="Email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <Field
        label="Password"
        type="password"
        required
        minLength={8}
        autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      {error && <Alert tone="danger">{error}</Alert>}

      <Button
        type="submit"
        loading={pending}
        loadingText="Working…"
        className="w-full"
      >
        {mode === "sign-in" ? "Sign in" : "Create account"}
      </Button>

      <p className="pt-2 text-center text-sm text-slate-600">
        {mode === "sign-in" ? "New here?" : "Already have an account?"}{" "}
        <button
          type="button"
          onClick={() => {
            setMode(otherMode);
            setError(null);
          }}
          className="font-medium text-slate-900 underline-offset-2 hover:underline"
        >
          {otherMode === "sign-up" ? "Create one" : "Sign in"}
        </button>
      </p>

      <p className="pt-1 text-center text-xs text-slate-400">
        <Link href="/">← Back to home</Link>
      </p>
    </form>
  );
}

function TierPreselectBanner({
  tierId,
  tierName,
}: {
  tierId: TierId;
  tierName: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-brand/30 bg-brand-muted px-4 py-3 text-sm text-brand-strong">
      <Badge tone="brand" className="shrink-0">
        {tierName}
      </Badge>
      <div className="min-w-0">
        <p className="font-medium">
          Starting with the {tierName} plan trial.
        </p>
        <p className="mt-0.5 text-xs">
          {TRIAL_SUMMARY.durationDays} days · {TRIAL_SUMMARY.siteLimit} site ·{" "}
          {TRIAL_SUMMARY.generationsIncluded} generations · no card required.
          You can switch plans any time.
        </p>
        {/* Engineering ticket: persist the chosen tier on the signup so the
            post-trial conversion pre-selects this plan in the upgrade modal.
            Today the param is logged for analytics; the value here is the
            expectation calibration, not the binding selection. */}
        <input type="hidden" name="selectedTier" value={tierId} />
      </div>
    </div>
  );
}
