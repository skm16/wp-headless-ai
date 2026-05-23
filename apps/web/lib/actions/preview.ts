"use server";

import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import type { DesignAnalysis } from "@/lib/ai/scrape-agent";

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
        error: `Failed to dispatch worker: ${err instanceof Error ? err.message : String(err)}`,
        finished_at: new Date().toISOString(),
      })
      .eq("id", row.id);
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
    case "failed":
      return { status: "failed", error: data.error ?? "Unknown failure" };
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
