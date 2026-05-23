import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Auth callback — handles email-confirmation redirects.
 *
 * Supabase Auth sends users to /auth/callback?code=… after they click a
 * confirmation/magic link. We exchange the code for a session, then redirect
 * to the destination encoded in `?next=` (or /dashboard by default).
 *
 * Required even when "Confirm email" is OFF in Supabase Auth settings — some
 * flows (password reset, future OAuth) still hit this endpoint.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
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
