import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client. **Bypasses RLS.**
 *
 * Use ONLY for system operations that legitimately need to act outside any
 * tenant scope:
 *   - Cron jobs / scheduled tasks
 *   - Administrative tooling
 *   - The future (Phase C) onboarding flow when storing encrypted credentials
 *
 * NEVER call from a route handler that takes user input without manually
 * re-checking tenant scope in code. This client is the one knife in the
 * kitchen that can cut through every safety boundary, and the `server-only`
 * import above makes it a build error if it ever gets imported into a
 * Client Component.
 *
 * Audit every call site as part of code review — each one needs an explicit
 * comment justifying why bypass is safe.
 */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
