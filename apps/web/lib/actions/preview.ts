"use server";

import { cookies, headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import type { DesignAnalysis } from "@/lib/ai/scrape-agent";
import { parsePublicError, serializePublicError } from "@/lib/ai/scrape-errors";
import { checkRateLimit, extractClientIp } from "@/lib/rate-limit";

/**
 * Pre-auth `/preview` server actions.
 *
 * The /preview surface fires before signup, so these actions are deliberately
 * NOT tenant-scoped. State lives in `anonymous_previews` keyed by a session
 * cookie set on first visit. The same cookie value resurfaces the user's
 * previews if they come back via the email link from /sign-up?from=preview.
 *
 * Security posture:
 *   - URL is HTTPS-validated here AND in scrape-fetch (defense in depth).
 *   - Server actions use the service-role client because the table has no
 *     RLS policies — anon/authenticated can't read it directly under any
 *     circumstance. The session-cookie check is the access control.
 *   - Rate limiting: not implemented in v1. The next abuse vector to watch
 *     is "spam this endpoint to drain Anthropic budget." Add a per-IP token
 *     bucket before this surface goes from concierge-traffic to public-
 *     traffic scale.
 */

const SESSION_COOKIE = "jab_preview_session";
const SESSION_COOKIE_MAX_AGE_S = 24 * 60 * 60;

// Public unauthenticated endpoint with LLM cost exposure (~$0.15/call). The
// limits below are calibrated for "real agency exploring 2-3 client sites"
// not "real launch traffic" — bump them after we have user behavior data.
// Both limits apply: a session is bound by both its own cookie quota and
// the IP quota of whatever network it came from.
const RATE_LIMIT_PER_HOUR_IP = 10;
const RATE_LIMIT_PER_HOUR_SESSION = 5;

export type TriggerPreviewResult =
  | { ok: true; previewId: string }
  | { ok: false; error: string };

const TriggerInput = z.object({
  url: z
    .string()
    .trim()
    .min(1, "URL is required")
    .url("Not a valid URL")
    .refine((v) => /^https:\/\//i.test(v), "URL must use https://"),
});

export async function triggerPreviewScrapeAction(
  rawUrl: string,
): Promise<TriggerPreviewResult> {
  const parsed = TriggerInput.safeParse({ url: rawUrl });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const sessionId = await ensureSessionCookie();

  // Rate limit BEFORE the DB insert + Inngest dispatch — refusing here
  // costs us nothing. Check IP + session in parallel; a hit on either
  // rejects the call. Fail-open behavior lives inside checkRateLimit, so
  // a rate-limit table outage doesn't take down /preview.
  const reqHeaders = await headers();
  const ip = extractClientIp(reqHeaders);
  const limitChecks = await Promise.all([
    ip
      ? checkRateLimit(`preview:ip:${ip}`, { limit: RATE_LIMIT_PER_HOUR_IP })
      : Promise.resolve(null),
    checkRateLimit(`preview:session:${sessionId}`, {
      limit: RATE_LIMIT_PER_HOUR_SESSION,
    }),
  ]);
  if (limitChecks.some((r) => r?.limited)) {
    return {
      ok: false,
      error:
        "You've generated a lot of previews recently. Wait a few minutes and try again, or sign up to keep going.",
    };
  }

  const supabase = createAdminClient();

  const { data: row, error: insertError } = await supabase
    .from("anonymous_previews")
    .insert({
      session_id: sessionId,
      source_url: parsed.data.url,
      status: "queued",
    })
    .select("id")
    .single();

  if (insertError || !row) {
    return {
      ok: false,
      error:
        insertError?.message ??
        "Failed to enqueue preview — please try again.",
    };
  }

  try {
    await inngest.send({
      name: "preview/scrape.requested",
      data: { previewId: row.id, url: parsed.data.url, sessionId },
    });
  } catch (err) {
    // Best-effort cleanup — without this the row stays at 'queued' forever.
    await supabase
      .from("anonymous_previews")
      .update({
        status: "failed",
        error: serializePublicError({
          code: "unknown",
          message: "Couldn't start the preview job. Please try again.",
        }),
        finished_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    console.error(
      `[triggerPreviewScrape] Inngest dispatch failed for previewId=${row.id}:`,
      err instanceof Error ? err.message : String(err),
    );
    return {
      ok: false,
      error: "Couldn't start the preview job. Please try again.",
    };
  }

  return { ok: true, previewId: row.id };
}

// ---------------------------------------------------------------------------
// getPreviewStatus — called by the client every few seconds while polling
// ---------------------------------------------------------------------------

export type PreviewStatus =
  | { status: "queued" | "running" }
  | {
      status: "succeeded";
      sourceUrl: string;
      finalUrl: string;
      generatedHtml: string;
      design: DesignAnalysis | null;
      contentMarkdown: string | null;
    }
  | { status: "failed"; error: string }
  | { status: "not_found" }
  | { status: "forbidden" };

export async function getPreviewStatusAction(
  previewId: string,
): Promise<PreviewStatus> {
  if (!isUuid(previewId)) return { status: "not_found" };

  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId) return { status: "forbidden" };

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("anonymous_previews")
    .select(
      "id, session_id, status, error, source_url, final_url, generated_html, design, content_markdown",
    )
    .eq("id", previewId)
    .maybeSingle();

  if (error || !data) return { status: "not_found" };

  // Cookie-keyed access check — anyone who guesses a UUID still can't read
  // someone else's preview without their session cookie.
  if (data.session_id !== sessionId) return { status: "forbidden" };

  switch (data.status) {
    case "queued":
    case "running":
      return { status: data.status };
    case "failed": {
      // Worker writes errors via serializePublicError → safe to parse and
      // surface verbatim. Rows that pre-date the public-error mapping (or
      // any DB-direct edits) get a generic message via the parser's
      // tolerance branch.
      const parsed = parsePublicError(data.error ?? "");
      return { status: "failed", error: parsed.message };
    }
    case "succeeded":
      if (!data.generated_html) {
        // Worker marked succeeded but didn't write the HTML — defensive
        // fallback. Treat as failed; surface a useful error.
        return {
          status: "failed",
          error: "Worker finished but produced no preview. Please try again.",
        };
      }
      return {
        status: "succeeded",
        sourceUrl: data.source_url,
        finalUrl: data.final_url ?? data.source_url,
        generatedHtml: data.generated_html,
        design: (data.design as DesignAnalysis | null) ?? null,
        contentMarkdown: (data.content_markdown as string | null) ?? null,
      };
    default:
      return {
        status: "failed",
        error: `Unknown worker status: ${data.status}`,
      };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function ensureSessionCookie(): Promise<string> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(SESSION_COOKIE)?.value;
  if (existing && isUuid(existing)) return existing;

  const sessionId = randomUUID();
  cookieStore.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_COOKIE_MAX_AGE_S,
    path: "/",
  });
  return sessionId;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
