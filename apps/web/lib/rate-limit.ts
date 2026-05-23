import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Fixed-window rate-limit primitive backed by `public.rate_limits`.
 *
 * One round-trip per check via Postgres' `INSERT ... ON CONFLICT DO UPDATE`
 * with a CASE that resets the window if it's expired. Atomic — no SELECT
 * FOR UPDATE pessimism needed.
 *
 * Caller picks the key namespace. Suggested convention:
 *   "<surface>:<dimension>:<value>"
 * e.g. `"preview:ip:1.2.3.4"` or `"preview:session:abc-123"`.
 *
 * Two-keys-per-call pattern: call this twice in parallel with `Promise.all`
 * — once per IP, once per session — and reject if either is over its
 * limit. That way a session cookie alone can't outrun the IP limit, and
 * the IP limit can't be circumvented by rotating session cookies.
 */

export interface RateLimitResult {
  /** True if the call exceeded the limit (caller should reject). */
  limited: boolean;
  /** How many hits the bucket has used after this call, including this one. */
  hits: number;
  /** How many remain in the window (>=0, never goes below 0). */
  remaining: number;
  /** Window expiry — when hits resets. ISO string. */
  resetAt: string;
}

export interface RateLimitOptions {
  /** Max calls allowed within the window. */
  limit: number;
  /** Window length. Default 1 hour. The migration matches this. */
  windowSeconds?: number;
}

/**
 * Atomically increment the bucket for `key` and report whether the caller
 * is over `limit`. Resets the window if the previous window expired.
 *
 * On any DB error, we **fail open** — the call returns `limited=false` and
 * the caller proceeds. Rate-limiting is a best-effort backstop, and
 * outage of the rate-limit table should not take down the protected
 * surface. The DB error is logged for ops visibility.
 */
export async function checkRateLimit(
  key: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const windowSeconds = opts.windowSeconds ?? 3600;
  const supabase = createAdminClient();

  // Postgres-side: increment or reset in one statement. The CASE expressions
  // mean we don't need a transaction or a SELECT-then-UPDATE — race
  // conditions resolve to "whoever's UPDATE landed last," which is fine for
  // counting (off by at most 1 across concurrent calls).
  const { data, error } = await supabase.rpc("rate_limit_increment", {
    p_key: key,
    p_window_seconds: windowSeconds,
  });

  // `RETURNS TABLE` produces a row-set; supabase-js gives us an array of
  // one row. Defensive `?.[0]` for the empty-result-on-corrupt-state case.
  const rows = data as Array<{ hits: number; window_started_at: string }> | null;
  const row = rows?.[0];

  if (error || !row) {
    // Fail open. Don't block the surface because the rate-limit table is
    // unreachable. Log for ops.
    console.error(`[rate-limit] check failed for key=${key}:`, error?.message);
    return {
      limited: false,
      hits: 0,
      remaining: opts.limit,
      resetAt: new Date(Date.now() + windowSeconds * 1000).toISOString(),
    };
  }

  const hits = row.hits;
  const remaining = Math.max(0, opts.limit - hits);
  const resetAt = new Date(
    new Date(row.window_started_at).getTime() + windowSeconds * 1000,
  ).toISOString();

  return {
    limited: hits > opts.limit,
    hits,
    remaining,
    resetAt,
  };
}

/**
 * Extract a usable client IP from request headers. Returns `null` if no
 * meaningful IP is present — caller decides whether that's a "deny" or
 * "fail open" situation (the wow-preview path falls back to session-only
 * limiting if IP is missing).
 *
 * Headers checked in order:
 *   1. x-forwarded-for (Vercel sets this; we take the leftmost = client)
 *   2. x-real-ip
 *   3. cf-connecting-ip (Cloudflare)
 *
 * Caveat: an attacker behind a proxy can inject arbitrary x-forwarded-for
 * before our proxy adds the real client IP. The leftmost-IP convention
 * trusts the deployment infra to strip / overwrite it. Vercel does.
 */
export function extractClientIp(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = headers.get("x-real-ip");
  if (xri) return xri.trim();
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  return null;
}
