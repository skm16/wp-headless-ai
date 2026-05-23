import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Daily prune for the two unbounded-by-default tables:
 *
 *   - `anonymous_previews`: rows past `expires_at` that were never promoted.
 *     Promoted rows persist so the analytics link from preview → project
 *     stays queryable.
 *   - `rate_limits`: rows not updated in 24h+. Hourly windows reset
 *     in-place, so any row older than that is from a stale IP/session
 *     that hasn't returned.
 *
 * Scheduled via `vercel.json` `crons`. Vercel adds an `Authorization:
 * Bearer <CRON_SECRET>` header on its scheduled invocation; we require
 * the same header on every caller, ALWAYS — there is no env-driven
 * bypass. A missing or empty `CRON_SECRET` returns 503; that's
 * intentional, so a deploy-config slip can't silently turn this into
 * an open delete endpoint that any HTTP client can drain.
 *
 * Local dev: set `CRON_SECRET=dev` in `.env.local` and invoke with
 *   curl -H "Authorization: Bearer dev" http://localhost:3000/api/cron/prune
 *
 * Logs counts so ops can graph table growth over time.
 */

export const dynamic = "force-dynamic";

const RATE_LIMIT_STALE_HOURS = 24;

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail closed. Production missing this env var is a deploy-config
    // bug, NOT a license to delete data without auth.
    console.error("[cron/prune] CRON_SECRET is unset — refusing to run");
    return NextResponse.json(
      { error: "cron_secret_unconfigured" },
      { status: 503 },
    );
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${expected}`) {
    // Don't leak the existence of a secret — same 401 either way.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const now = new Date();
  const rateLimitStaleBefore = new Date(
    now.getTime() - RATE_LIMIT_STALE_HOURS * 60 * 60 * 1000,
  ).toISOString();

  let previewsPruned: number | null = null;
  let rateLimitsPruned: number | null = null;
  const errors: string[] = [];

  // Anonymous previews — expired and never promoted.
  // `count: 'exact'` adds a roundtrip but lets us log how much got cleaned.
  const previewsResult = await supabase
    .from("anonymous_previews")
    .delete({ count: "exact" })
    .lt("expires_at", now.toISOString())
    .is("promoted_to_project_id", null);
  if (previewsResult.error) {
    errors.push(`anonymous_previews: ${previewsResult.error.message}`);
  } else {
    previewsPruned = previewsResult.count ?? 0;
  }

  // Rate-limit buckets — stale (>24h since last hit). The active hourly
  // window is shorter, so anything older than 24h is from an IP/session
  // that didn't come back.
  const rateLimitResult = await supabase
    .from("rate_limits")
    .delete({ count: "exact" })
    .lt("updated_at", rateLimitStaleBefore);
  if (rateLimitResult.error) {
    errors.push(`rate_limits: ${rateLimitResult.error.message}`);
  } else {
    rateLimitsPruned = rateLimitResult.count ?? 0;
  }

  const payload = {
    previewsPruned,
    rateLimitsPruned,
    ran_at: now.toISOString(),
    errors: errors.length > 0 ? errors : undefined,
  };

  if (errors.length > 0) {
    console.error("[cron/prune] partial failure:", payload);
    return NextResponse.json(payload, { status: 500 });
  }
  console.log("[cron/prune]", payload);
  return NextResponse.json(payload);
}
