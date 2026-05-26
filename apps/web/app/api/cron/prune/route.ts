import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Daily prune for the unbounded `rate_limits` table — hourly windows reset
 * in-place, so any row older than 24h is from a stale IP/session that
 * hasn't returned.
 *
 * Stage 0 v2: dropped the `anonymous_previews` prune branch — that table
 * is gone with the preview path.
 *
 * Scheduled via `vercel.json` `crons`. Vercel adds an
 * `Authorization: Bearer <CRON_SECRET>` header on its scheduled invocation;
 * we require the same on every caller. Missing `CRON_SECRET` env returns
 * 503 — a deploy-config slip must not silently turn this into an open
 * delete endpoint.
 *
 * Local dev: set `CRON_SECRET=dev` in `.env.local` and invoke with
 *   curl -H "Authorization: Bearer dev" http://localhost:3000/api/cron/prune
 */

export const dynamic = "force-dynamic";

const RATE_LIMIT_STALE_HOURS = 24;

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("[cron/prune] CRON_SECRET is unset — refusing to run");
    return NextResponse.json(
      { error: "cron_secret_unconfigured" },
      { status: 503 },
    );
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const now = new Date();
  const rateLimitStaleBefore = new Date(
    now.getTime() - RATE_LIMIT_STALE_HOURS * 60 * 60 * 1000,
  ).toISOString();

  let rateLimitsPruned: number | null = null;
  const errors: string[] = [];

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
