"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

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

export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/dashboard";
  // ?error=... lands here from /auth/callback when the code exchange fails.
  const callbackError = searchParams.get("error");

  const [mode, setMode] = useState<Mode>("sign-in");
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
            // Required so the email-confirm link sends users to our callback
            // route (which exchanges the code for a session). Without this,
            // Supabase falls back to the project's Site URL.
            emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
          },
        });
        if (signUpError) throw signUpError;
        // When "Confirm email" is ON in Supabase Auth, signUp returns the
        // user but no session — they have to click the email link first.
        // Surface that state instead of optimistically redirecting.
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
      // Refresh so middleware re-evaluates auth state on the redirect.
      router.replace(next);
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
        <button
          type="button"
          onClick={() => {
            setConfirmationSentTo(null);
            setMode("sign-in");
          }}
          className="text-sm font-medium text-slate-900 underline-offset-2 hover:underline"
        >
          ← Back to sign in
        </button>
      </div>
    );
  }

  const otherMode = mode === "sign-in" ? "sign-up" : "sign-in";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-900">
        {mode === "sign-in" ? "Sign in" : "Create account"}
      </h2>

      <div>
        <label htmlFor="email" className="block text-sm font-medium text-slate-700">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium text-slate-700">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={8}
          autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending
          ? "Working…"
          : mode === "sign-in"
            ? "Sign in"
            : "Create account"}
      </button>

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
