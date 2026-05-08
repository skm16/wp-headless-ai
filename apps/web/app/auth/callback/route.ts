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
  }
  return NextResponse.redirect(`${origin}/sign-in?error=auth-callback-failed`);
}
