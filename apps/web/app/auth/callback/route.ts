import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { promoteAnonymousPreviewIfPresent } from "@/lib/actions/promote-preview";

/**
 * Auth callback — handles email-confirmation redirects.
 *
 * Supabase Auth sends users to /auth/callback?code=… after they click a
 * confirmation/magic link. We exchange the code for a session, run the
 * promote-on-signup hook (idempotent — no-op if there's no preview to
 * claim), and redirect.
 *
 * Required even when "Confirm email" is OFF in Supabase Auth settings — some
 * flows (password reset, future OAuth) still hit this endpoint.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const rawNext = searchParams.get("next") ?? "/dashboard";

  // Validate `next` here too — the email link can be authored by anyone and
  // could carry `next=//evil.com`. Same allowlist shape as SignInForm.
  const next =
    rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Promote any anonymous_previews row tied to this browser's session
      // cookie to a real project owned by the new tenant. Returns null if
      // there's nothing to claim — the `next` redirect still wins. We
      // *don't* gate on `?from=preview` because the cookie is the
      // authoritative signal; the URL param can be stripped by clients.
      const promoted = await promoteAnonymousPreviewIfPresent();
      const destination = promoted
        ? `/projects/${promoted.projectId}`
        : next;
      return NextResponse.redirect(`${origin}${destination}`);
    }
    // Log the real Supabase reason server-side for debugging — usually
    // "redirect URL not in allow list" or "code expired". We do NOT forward
    // it to the client URL because that's an attacker-controlled phishing
    // vector: a shared link `/sign-in?error=<forged-text>` would render
    // verbatim in the sign-in banner. Instead we pass an opaque code that
    // the form maps to a hardcoded message catalog.
    console.error("auth callback exchangeCodeForSession failed:", error.message);
    return NextResponse.redirect(`${origin}/sign-in?error_code=exchange_failed`);
  }
  return NextResponse.redirect(`${origin}/sign-in?error_code=missing_code`);
}
