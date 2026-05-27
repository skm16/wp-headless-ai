"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Manifest } from "@jab/core";
import { encryptToBytea } from "@/lib/crypto/encrypt";
import { probeWordPress } from "@/lib/jab/probe";
import { contentTypesFromManifest } from "@/lib/jab/content-types-from-manifest";
import { fetchContentTypes } from "@/lib/jab/fetch-content-types";
import { assertHostnameSafe, SsrfError } from "@/lib/ai/ssrf-guard";
import { createClient } from "@/lib/supabase/server";
import { inngest } from "@/lib/inngest/client";
import type { WPContentType } from "@/components/ownership-picker";

/**
 * Post-pivot onboarding server actions.
 *
 * Four actions, all RLS-gated via the user's Supabase session. Mirrors the
 * four-step wizard at `components/onboarding-wizard.tsx`:
 *
 *   step 0: saveIntentAction       — auto-saves before advancing past step 0
 *   step 1: (no action)            — install plugin is instructional
 *   step 1: verifyPluginAction     — optional "Verify install" affordance
 *   step 2: connectWpAction        — connects WP, persists manifest
 *   step 3: completeOnboardingAction — persists ownership, flips status=ready
 *
 * Auto-save-per-step means a user can close the tab mid-wizard and return
 * to the same step on next sign-in. The wizard's `initialStepIndex` is
 * derived purely from which of (intent, manifest, content_ownership) are
 * already non-null on the project row — no separate progress column.
 *
 * Actions return `{ error?: string }` for useActionState consumers and
 * client-component callers; completeOnboardingAction redirects on success.
 */

export type OnboardingActionState = { error?: string } | null;

// ----------------------------------------------------------------------------
// connectWpAction — step 2 of the wizard
// ----------------------------------------------------------------------------
// Probes the WP install, persists encrypted credentials + manifest, and
// returns the derived content-types catalog so the wizard can advance to
// ownership without a second roundtrip.
//
// Security: `wpUrl` is user-controlled (even when it came from a previously
// saved project row — the user can edit it on this form). `assertHostnameSafe`
// blocks RFC-1918 / loopback / metadata addresses BEFORE the probe issues
// any outbound fetch. `@jab/core`'s fetchManifest has no SSRF guard of its
// own, so this is the canonical defence.
//
// Whitespace tolerance: WP shows app passwords as `xxxx xxxx xxxx xxxx xxxx
// xxxx` in wp-admin — users copy-paste with spaces. WP itself normalizes by
// stripping all non-alphanumerics before comparing. We do the same up-front
// (`normalizeAppPassword`) so the value we store + the value we use for
// Basic auth + the value WP compares against are all identical. Without
// this, a paste-with-spaces could authenticate successfully but the encrypted
// at-rest copy would carry the spaces — confusing audit trails and breaking
// any future client that strict-compares the persisted password.

const ConnectInput = z.object({
  projectId: z.string().uuid(),
  wpUrl: z
    .string()
    .trim()
    .url("Must be a valid URL")
    .refine((v) => /^https:\/\//i.test(v), "Must use https:// (Application Passwords transit credentials in clear)"),
  wpUsername: z.string().trim().min(1, "Username required").max(100),
  wpAppPassword: z.string().trim().min(1, "App password required"),
});

export type ConnectWpResult =
  | { ok: true; contentTypes: WPContentType[] }
  | { ok: false; error: string };

/**
 * Strip all whitespace from a WP application password. Mirrors WP core's
 * own normalization in `wp_authenticate_application_password()` which does
 * `preg_replace('/[^a-z\\d]/i', '', $password)` before comparing.
 *
 * Accepts both formats users encounter:
 *   - With spaces (wp-admin display):   "aBcD eFgH IjKl MnOp QrSt UvWx"
 *   - Without spaces (some pwd managers): "aBcDeFgHIjKlMnOpQrStUvWx"
 *
 * Both normalize to the same 24-char value.
 */
function normalizeAppPassword(raw: string): string {
  return raw.replace(/\s+/g, "");
}

export async function connectWpAction(
  projectId: string,
  credentials: {
    wpUrl: string;
    wpUsername: string;
    wpAppPassword: string;
  },
): Promise<ConnectWpResult> {
  // Wrap the whole body so an unexpected throw produces a Vercel-logged
  // diagnostic + a safe message to the user, rather than a generic 500
  // that surfaces in the client as "fails silently." Every branch below
  // is supposed to RETURN — the catch is the safety net for anything
  // that's missed (env var unset, library throws, etc).
  try {
    const parsed = ConnectInput.safeParse({ projectId, ...credentials });
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.errors.map((e) => e.message).join("; "),
      };
    }
    const data = parsed.data;
    const normalizedPassword = normalizeAppPassword(data.wpAppPassword);
    if (!normalizedPassword) {
      return { ok: false, error: "App password required" };
    }

    // SSRF guard — block private/loopback/metadata addresses before issuing
    // the probe's outbound fetch. The URL parsing here also catches a
    // malformed input that snuck past the zod refine (defence in depth).
    let parsedWpUrl: URL;
    try {
      parsedWpUrl = new URL(data.wpUrl);
    } catch {
      return { ok: false, error: "WordPress URL is malformed." };
    }
    try {
      await assertHostnameSafe(parsedWpUrl.hostname);
    } catch (err) {
      if (err instanceof SsrfError) {
        return {
          ok: false,
          error: "WordPress URL points at a restricted address.",
        };
      }
      return { ok: false, error: "Couldn't resolve the WordPress URL." };
    }

    // Hard precondition for Stage 0 v2: a successful manifest probe AND a
    // plugin version that meets MANIFEST_V2_REQUIREMENTS (currently
    // "jab/get-menus" must be present, which gates v0.6.0+). probeWordPress
    // returns `{ ok: false, error: "...plugin too old..." }` for older
    // plugins; the gate below halts onboarding before any DB write.
    const probe = await probeWordPress({
      wpUrl: data.wpUrl,
      username: data.wpUsername,
      appPassword: normalizedPassword,
    });
    if (!probe.ok) return { ok: false, error: probe.error };

    // Encrypt OUTSIDE the .update() payload. Doing it inline meant any
    // throw here (e.g. JAB_ENCRYPTION_KEY missing in prod) escaped past
    // the error-return paths because there's no try/catch around the
    // update call itself. Lifting it out gives us a clean failure point.
    let encryptedPassword: string;
    try {
      encryptedPassword = encryptToBytea(normalizedPassword);
    } catch (encryptErr) {
      console.error(
        `[connectWp ${data.projectId}] encrypt failed:`,
        encryptErr instanceof Error ? encryptErr.message : String(encryptErr),
      );
      return {
        ok: false,
        error:
          "Server can't store credentials right now — encryption is misconfigured. Contact support.",
      };
    }

    // Read-then-update so we know the project's current status. `ready`
    // projects keep their status (the route-level guard normally blocks
    // re-entry to the wizard for ready projects, but a direct call from
    // another surface would otherwise demote them back to onboarding).
    const supabase = await createClient();
    const { data: existing, error: readErr } = await supabase
      .from("projects")
      .select("id, status")
      .eq("id", data.projectId)
      .single();
    if (readErr) {
      if (readErr.code === "PGRST116")
        return { ok: false, error: "Project not found" };
      return { ok: false, error: readErr.message };
    }

    const { data: updatedRow, error: updateErr } = await supabase
      .from("projects")
      .update({
        wp_url: data.wpUrl,
        wp_username: data.wpUsername,
        wp_app_password_encrypted: encryptedPassword,
        manifest: probe.manifest,
        // Only bump status if the project is still in setup. `ready` projects
        // stay `ready`; `archived` stays `archived`. Drift guard against a
        // future direct caller bypassing the route's status='ready' redirect.
        status: existing.status === "draft" ? "onboarding" : existing.status,
      })
      .eq("id", data.projectId)
      .select("id, tenant_id")
      .single();
    if (updateErr || !updatedRow) {
      return {
        ok: false,
        error: `Couldn't save: ${updateErr?.message ?? "project not found"}`,
      };
    }

    // Fire-and-forget design extraction. The Stage 2 worker persists
    // design_tokens + personality + cached asset paths on the project.
    // Onboarding does NOT block on it — generation falls back to ad-hoc HTML
    // extraction if the worker hasn't completed yet. `tenantId` lets the
    // worker filter its service-role UPDATE by both projectId AND tenantId
    // as a belt-and-suspenders guard against stray dispatch payloads.
    try {
      await inngest.send({
        name: "project/design.requested",
        data: {
          projectId: data.projectId,
          tenantId: updatedRow.tenant_id,
          wpUrl: data.wpUrl,
        },
      });
    } catch (dispatchErr) {
      console.error(
        `[connectWp ${data.projectId}] design-extraction dispatch failed:`,
        dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
      );
    }

    revalidatePath(`/projects/${data.projectId}/onboard`);
    revalidatePath(`/projects/${data.projectId}`);

    // Prefer the plugin's /jab/v1/content-types endpoint — it returns a
    // canonical post-type catalog with real counts and proper labels.
    // Falls back to the manifest heuristic for older plugin versions
    // (which 404 the endpoint) or any non-200 from the new endpoint.
    let contentTypes: WPContentType[] | null = null;
    try {
      contentTypes = await fetchContentTypes({
        wpUrl: data.wpUrl,
        user: data.wpUsername,
        password: normalizedPassword,
      });
    } catch (fetchErr) {
      console.warn(
        `[connectWp ${data.projectId}] fetchContentTypes threw:`,
        fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
      );
      // contentTypes remains null → falls through to the manifest fallback.
    }

    if (contentTypes === null) {
      try {
        contentTypes = contentTypesFromManifest(probe.manifest as Manifest);
      } catch (deriveErr) {
        console.error(
          `[connectWp ${data.projectId}] contentTypesFromManifest threw:`,
          deriveErr instanceof Error ? deriveErr.message : String(deriveErr),
        );
        // Both real source and fallback unavailable. Project state is
        // correctly persisted — we just couldn't derive the type list.
        // OwnershipPicker handles types.length === 0 with an EmptyState.
        contentTypes = [];
      }
    }

    return { ok: true, contentTypes };
  } catch (unexpectedErr) {
    // Diagnostic — fires for anything not caught above. The actual stack
    // shows up in Vercel function logs; the client sees a user-safe
    // generic message rather than a Next.js 500 page.
    console.error(
      `[connectWp ${projectId}] unhandled error:`,
      unexpectedErr instanceof Error
        ? `${unexpectedErr.name}: ${unexpectedErr.message}\n${unexpectedErr.stack}`
        : String(unexpectedErr),
    );
    return {
      ok: false,
      error:
        "Something went wrong on our side. Try again, and contact support if it persists.",
    };
  }
}

// ----------------------------------------------------------------------------
// saveIntentAction — step 0 of the wizard
// ----------------------------------------------------------------------------
// Auto-saved before advancing past step 0 (Intent). Idempotent — re-saving
// the same value is a no-op write; changing the value is allowed (user can
// step back in the wizard).
//
// Flips status `draft` → `onboarding` because picking an intent is the
// first concrete commitment the user makes on a freshly-promoted project.
// If the project is already `onboarding` or beyond, status is left alone.
//
// `archived` and `ready` projects can't have their intent re-saved this way
// (RLS doesn't help here — the user could legitimately own a ready project
// they want to re-onboard). For now we accept the call and let it land;
// the UI side gates entry to the wizard at the route level via a
// status='ready' redirect.
//
// DEFERRED — Phase B prompts (lib/ai/component-generator.ts) do not read
// `projects.intent`. Every prompt is implicitly "faithful"; refresh and
// reimagine are captured here but not honored downstream. Stage 0 decision
// #2 originally flagged this for retirement in Stage 2; the full retire
// (drop column + wizard step + picker component + ~15 file edits) is held
// back because polish-pass scope wouldn't swallow it. Two paths from here:
// (a) thread intent through Phase B prompts as a real product lever, or
// (b) ship the retire migration in a follow-up. See docs/conversion-
// pipeline.md §10 G8 for the gap disclosure.

const SaveIntentInput = z.object({
  projectId: z.string().uuid(),
  intent: z.enum(["faithful", "refresh", "reimagine"]),
});

export async function saveIntentAction(
  projectId: string,
  intent: "faithful" | "refresh" | "reimagine",
): Promise<OnboardingActionState> {
  const parsed = SaveIntentInput.safeParse({ projectId, intent });
  if (!parsed.success) {
    return { error: parsed.error.errors.map((e) => e.message).join("; ") };
  }

  const supabase = await createClient();
  // Read first to know whether we should bump status. RLS-scoped: a wrong
  // tenant gets PGRST116 here, identical to a real not-found.
  const { data: project, error: readErr } = await supabase
    .from("projects")
    .select("id, status")
    .eq("id", parsed.data.projectId)
    .single();
  if (readErr) {
    if (readErr.code === "PGRST116") return { error: "Project not found" };
    return { error: readErr.message };
  }

  const updates: { intent: string; status?: string } = {
    intent: parsed.data.intent,
  };
  if (project.status === "draft") updates.status = "onboarding";

  const { error: updateErr } = await supabase
    .from("projects")
    .update(updates)
    .eq("id", parsed.data.projectId);
  if (updateErr) return { error: `Couldn't save intent: ${updateErr.message}` };

  revalidatePath(`/projects/${parsed.data.projectId}/onboard`);
  revalidatePath(`/projects/${parsed.data.projectId}`);
  return null;
}

// ----------------------------------------------------------------------------
// verifyPluginAction — optional step 1 affordance
// ----------------------------------------------------------------------------
// GETs `{wp_url}/wp-json/jab/v1/` on the project's stored wp_url. Returns
// ok=true if the plugin's REST namespace responds with a 200; ok=false with
// a user-facing message otherwise.
//
// SSRF: even though wp_url is stored by an authenticated tenant member, it
// originated as user input. We re-check the hostname here via
// `assertHostnameSafe` — same guard the scraper uses — so a malicious or
// misconfigured wp_url can't probe internal services.
//
// 5s timeout via AbortController. Worth a small allowance for cold WP
// installs; longer than that and the plugin probably isn't there.

const VerifyPluginInput = z.object({ projectId: z.string().uuid() });

export interface VerifyPluginResult {
  ok: boolean;
  message?: string;
}

export async function verifyPluginAction(
  projectId: string,
): Promise<VerifyPluginResult> {
  const parsed = VerifyPluginInput.safeParse({ projectId });
  if (!parsed.success) {
    return { ok: false, message: "Invalid project id." };
  }

  const supabase = await createClient();
  const { data: project, error: readErr } = await supabase
    .from("projects")
    .select("wp_url")
    .eq("id", parsed.data.projectId)
    .single();
  if (readErr || !project?.wp_url) {
    return {
      ok: false,
      message: "Couldn't read this project's WordPress URL.",
    };
  }

  let target: URL;
  try {
    target = new URL("/wp-json/jab/v1/", project.wp_url);
  } catch {
    return { ok: false, message: "WordPress URL is malformed." };
  }

  try {
    await assertHostnameSafe(target.hostname);
  } catch (err) {
    if (err instanceof SsrfError) {
      return {
        ok: false,
        message: "WordPress URL points at a restricted address.",
      };
    }
    return { ok: false, message: "Couldn't resolve the WordPress URL." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(target.toString(), {
      method: "GET",
      signal: controller.signal,
      // Same guard as scrape-fetch: never follow into a private address on
      // redirects. Plugin endpoint shouldn't redirect anyway.
      redirect: "manual",
    });
    if (res.ok) return { ok: true };
    if (res.status === 404) {
      // The check hits the plugin's /wp-json/jab/v1/ health endpoint
      // (added in v0.4.0). 404 means either the plugin isn't activated
      // OR an older release is installed — both are user-fixable.
      return {
        ok: false,
        message: `Plugin not detected at ${target.host}. Confirm it's installed AND activated. If you have an older release, install the latest zip from this page.`,
      };
    }
    return {
      ok: false,
      message: `Plugin endpoint returned ${res.status} on ${target.host}.`,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        message: `Plugin endpoint didn't respond within 5s on ${target.host}.`,
      };
    }
    return {
      ok: false,
      message: "Couldn't reach the WordPress site to verify the plugin.",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// completeOnboardingAction — step 3 of the wizard
// ----------------------------------------------------------------------------
// Persists the content_ownership map, flips status to 'ready', sets
// onboarded_at, and redirects to the workspace. The wizard's onComplete
// awaits this; the user sees a "Saving…" state on the Finish setup button
// while it runs.

const OwnershipModeSchema = z.enum(["wp-managed", "jab-managed"]);
const CompleteInput = z.object({
  projectId: z.string().uuid(),
  ownership: z.record(z.string().min(1), OwnershipModeSchema),
});

export async function completeOnboardingAction(
  projectId: string,
  ownership: Record<string, "wp-managed" | "jab-managed">,
): Promise<OnboardingActionState> {
  const parsed = CompleteInput.safeParse({ projectId, ownership });
  if (!parsed.success) {
    return { error: parsed.error.errors.map((e) => e.message).join("; ") };
  }

  // `.select("id, tenant_id").single()` is load-bearing — a Supabase UPDATE
  // blocked by RLS returns `{ data: null, error: null }` (no rows affected,
  // no error). Without the row confirmation we'd happily redirect a user to
  // a workspace whose row was never updated, looping them through the
  // resume-banner state on every visit. The .single() turns "zero rows
  // matched" into PGRST116 which we surface.
  const supabase = await createClient();
  const { data: updatedRow, error: updateErr } = await supabase
    .from("projects")
    .update({
      content_ownership: parsed.data.ownership,
      status: "ready",
      onboarded_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.projectId)
    .select("id, tenant_id")
    .single();
  if (updateErr || !updatedRow) {
    return {
      error: `Couldn't finalize onboarding: ${updateErr?.message ?? "project not found"}`,
    };
  }

  revalidatePath(`/projects/${parsed.data.projectId}/onboard`);
  revalidatePath(`/projects/${parsed.data.projectId}`);
  redirect(`/projects/${parsed.data.projectId}`);
}
