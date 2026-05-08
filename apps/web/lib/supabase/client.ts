"use client";
import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase client for the BROWSER context (Client Components, "use client"
 * boundaries). Uses the public anon key — RLS policies apply to every query
 * via the user's session JWT carried in cookies.
 *
 * Don't import from Server Components — use `lib/supabase/server.ts` instead.
 * The split exists because cookie reading/writing rules differ between RSC
 * and CSR; @supabase/ssr enforces that with separate factory functions.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
