import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Auth callback — handles email-confirmation redirects.
 *
 * Supabase Auth sends users to /auth/callback?code=… after they click a
 * confirmation/magic link. We exchange the code for a session and redirect
 * to `next` (default /dashboard).
 *
 * Stage 0 v2: dropped the `promoteAnonymousPreviewIfPresent` hop — the
 * pre-auth preview funnel is retired, so there's no anonymous draft to
 * promote on signup.
 *
 * Required even when "Confirm email" is OFF in Supabase Auth — some flows
 * (password reset, future OAuth) still land here.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const rawNext = searchParams.get("next") ?? "/dashboard";

  const next =
    rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    console.error("auth callback exchangeCodeForSession failed:", error.message);
    return NextResponse.redirect(`${origin}/sign-in?error_code=exchange_failed`);
  }
  return NextResponse.redirect(`${origin}/sign-in?error_code=missing_code`);
}
