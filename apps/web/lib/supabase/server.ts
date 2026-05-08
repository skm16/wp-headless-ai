import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Supabase client for SERVER contexts (Server Components, route handlers,
 * server actions). Uses the public anon key — RLS policies apply via the
 * user's session JWT decoded from cookies.
 *
 * The setAll() handler tolerates the "cookies can only be modified in a
 * server action or route handler" exception that Next.js throws when called
 * from a Server Component. The middleware refreshes session cookies on every
 * request, so missing the write here doesn't break anything — the next
 * request picks up the refreshed value.
 */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Expected in RSC — middleware handles cookie refresh on the
            // request that triggered this RSC render.
          }
        },
      },
    },
  );
}
