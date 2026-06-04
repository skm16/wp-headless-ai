/**
 * pg-error — narrow helpers over Postgres error codes as surfaced by
 * @supabase/supabase-js. DB-level errors arrive as a PostgrestError whose
 * `.code` carries the five-character SQLSTATE; a unique-violation is "23505".
 *
 * Used by triggerBuildAction + requestWorkspaceEditAction to translate the
 * 0031 one-active-build index's 23505 into a friendly 'active_build' error
 * instead of leaking a raw Postgres code to the user (e2e-loop §3.4 / §4).
 */

/** Postgres SQLSTATE for a unique-constraint / unique-index violation. */
export const UNIQUE_VIOLATION = "23505" as const;

/**
 * True when `err` is a Postgres unique-violation (SQLSTATE 23505) as surfaced
 * by supabase-js (`{ code: "23505", ... }`). Defensive against non-objects,
 * null/undefined, and errors without a `code`.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
