/**
 * postgres-errors — narrow helpers for distinguishing Postgres error
 * shapes that the Supabase client surfaces as plain objects with a
 * `code` string. Used by the trigger-build + edit-site paths to
 * translate unique-violation (23505) on the partial indexes from
 * migration 0025 into application-level errors.
 */

export function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "23505";
}
