/**
 * Edge middleware — runs on every request matched by `config.matcher`.
 *
 * Two responsibilities:
 *   1. Refresh Supabase session cookies before they expire. @supabase/ssr
 *      requires this for cookie-based auth to keep working across requests.
 *   2. Gate (app)/* routes: redirect unauthenticated requests to /sign-in
 *      with `?next=<original_path>` so post-login can route the user back.
 *
 * Public routes (the marketing landing, sign-in, auth callback) skip the
 * gate but still get session refresh — important for the auth-callback
 * handler which needs a refreshed session to issue the post-login redirect.
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Webhook endpoints are authenticated by signature (Inngest signing key in
// prod; nothing in dev — Inngest dev queue runs locally) — they must never
// be auth-gated by user session, or external services hit a redirect to
// /sign-in and assume the route doesn't exist.
const PUBLIC_ROUTES = [
  "/",
  "/sign-in",
  "/sign-up",
  "/pricing",
  "/auth/callback",
  "/api/inngest",
];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_ROUTES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (!isPublic) {
    // getUser() validates the JWT against Supabase Auth — more secure than
    // getSession() which trusts whatever's in cookies. Slightly slower; worth
    // it for the gating path.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      const url = request.nextUrl.clone();
      url.pathname = "/sign-in";
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  // Skip Next.js internals and static assets — every other route gets session
  // refresh + the gate above.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
