"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Manifest } from "@jab/core";
import { encryptToBytea } from "@/lib/crypto/encrypt";
import { probeWordPress } from "@/lib/jab/probe";
import { contentTypesFromManifest } from "@/lib/jab/content-types-from-manifest";
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
 *   step 2: probeAndSaveWpAction   — connects WP, persists manifest
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

const ProbeInput = z.object({
  projectId: z.string().uuid(),
  wpUrl: z
    .string()
    .trim()
    .url("Must be a valid URL")
    .refine((v) => /^https?:\/\//i.test(v), "Must start with http:// or https://"),
  wpUsername: z.string().trim().min(1, "Username required").max(100),
  wpAppPassword: z.string().trim().min(1, "App password required"),
  // Ability-name filter. Defaults to "jab/" if blank/missing, but the form
  // exposes this so agencies running pre-rebrand plugins (skm/) or stock WP
  // core MCP (wp/) can target what they have.
  abilityPrefix: z
    .string()
    .trim()
    .max(50)
    .optional(),
});

export async function probeAndSaveWpAction(
  _prev: OnboardingActionState,
  formData: FormData,
): Promise<OnboardingActionState> {
  const parsed = ProbeInput.safeParse({
    projectId: formData.get("projectId"),
    wpUrl: formData.get("wpUrl"),
    wpUsername: formData.get("wpUsername"),
    wpAppPassword: formData.get("wpAppPassword"),
    // Optional — form may not include the field. Zod's `.optional()` on
    // the schema permits this; the spread is to handle the
    // `formData.get(name) === null` case which Zod would reject as
    // "expected string, got null."
    ...(formData.get("abilityPrefix") !== null && {
      abilityPrefix: formData.get("abilityPrefix"),
    }),
  });
  if (!parsed.success) {
    return { error: parsed.error.errors.map((e) => e.message).join("; ") };
  }
  const { projectId, wpUrl, wpUsername, wpAppPassword, abilityPrefix } =
    parsed.data;

  const probe = await probeWordPress({
    wpUrl,
    username: wpUsername,
    appPassword: wpAppPassword,
    // Empty/undefined falls back to fetchManifest's default ("jab/").
    prefix: abilityPrefix && abilityPrefix.length > 0 ? abilityPrefix : undefined,
  });
  if (!probe.ok) {
    return { error: probe.error };
  }

  const supabase = await createClient();
  const { data: updatedRow, error: updateErr } = await supabase
    .from("projects")
    .update({
      wp_url: wpUrl,
      wp_username: wpUsername,
      wp_app_password_encrypted: encryptToBytea(wpAppPassword),
      manifest: probe.manifest,
      status: "onboarding",
    })
    .eq("id", projectId)
    // RLS-scoped — only returns the row if the user owns it via tenant_members.
    // We use the returned `tenant_id` as a belt-and-suspenders filter on
    // the worker's service-role write below.
    .select("id, tenant_id")
    .single();
  if (updateErr || !updatedRow) {
    // RLS denial returns 0 rows updated with no error; an actual error
    // means something deeper went wrong. Surface raw message.
    return {
      error: `Couldn't save: ${updateErr?.message ?? "project not found"}`,
    };
  }

  // Fire-and-forget design extraction. The worker runs in the background
  // and persists `design_tokens` + `personality` + cached asset paths on
  // the project. Onboarding does NOT block on it — generation falls back
  // to ad-hoc HTML extraction if the worker hasn't completed yet.
  //
  // We pass `tenantId` so the worker can filter its service-role UPDATE
  // by both projectId AND tenantId — a stray event with a wrong projectId
  // becomes a no-op write (0 rows affected) instead of a cross-tenant
  // bleed.
  //
  // Failures here (Inngest down, network blip) silently log — the user
  // can re-trigger by re-running the probe. We do NOT surface as a
  // probe error because the probe ITSELF succeeded; design extraction
  // is enrichment, not correctness.
  try {
    await inngest.send({
      name: "project/design.requested",
      data: { projectId, tenantId: updatedRow.tenant_id, wpUrl },
    });
  } catch (dispatchErr) {
    console.error(
      `[probeAndSaveWp ${projectId}] design-extraction dispatch failed:`,
      dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
    );
  }

  revalidatePath(`/projects/${projectId}/onboard`);
  revalidatePath(`/projects/${projectId}`);
  return null;
}

// ----------------------------------------------------------------------------
// connectWpAction — step 2 of the wizard (typed wrapper around probeAndSaveWp)
// ----------------------------------------------------------------------------
// The wizard hands us a plain object of credentials; this action runs the
// same probe-and-persist work as probeAndSaveWpAction but returns the
// derived content-types catalog so the wizard can advance to ownership
// without a second roundtrip.
//
// Re-implements probeAndSaveWpAction's body (rather than calling it) because
// useActionState's FormData-only signature isn't ergonomic to call from a
// plain client component. Keep the two in sync if probeAndSaveWp changes.

const ConnectInput = z.object({
  projectId: z.string().uuid(),
  wpUrl: z
    .string()
    .trim()
    .url("Must be a valid URL")
    .refine((v) => /^https?:\/\//i.test(v), "Must start with http:// or https://"),
  wpUsername: z.string().trim().min(1, "Username required").max(100),
  wpAppPassword: z.string().trim().min(1, "App password required"),
});

export type ConnectWpResult =
  | { ok: true; contentTypes: WPContentType[] }
  | { ok: false; error: string };

export async function connectWpAction(
  projectId: string,
  credentials: {
    wpUrl: string;
    wpUsername: string;
    wpAppPassword: string;
  },
): Promise<ConnectWpResult> {
  const parsed = ConnectInput.safeParse({ projectId, ...credentials });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.errors.map((e) => e.message).join("; "),
    };
  }
  const data = parsed.data;

  const probe = await probeWordPress({
    wpUrl: data.wpUrl,
    username: data.wpUsername,
    appPassword: data.wpAppPassword,
  });
  if (!probe.ok) return { ok: false, error: probe.error };

  const supabase = await createClient();
  const { data: updatedRow, error: updateErr } = await supabase
    .from("projects")
    .update({
      wp_url: data.wpUrl,
      wp_username: data.wpUsername,
      wp_app_password_encrypted: encryptToBytea(data.wpAppPassword),
      manifest: probe.manifest,
      status: "onboarding",
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

  // Fire-and-forget design extraction. Matches probeAndSaveWpAction's
  // dispatch pattern — see that action's comment for the rationale.
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

  return {
    ok: true,
    contentTypes: contentTypesFromManifest(probe.manifest as Manifest),
  };
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
      return {
        ok: false,
        message: `Plugin not found at ${target.host} — re-check the install steps.`,
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

  const supabase = await createClient();
  const { error: updateErr } = await supabase
    .from("projects")
    .update({
      content_ownership: parsed.data.ownership,
      status: "ready",
      onboarded_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.projectId);
  if (updateErr) {
    return { error: `Couldn't finalize onboarding: ${updateErr.message}` };
  }

  revalidatePath(`/projects/${parsed.data.projectId}/onboard`);
  revalidatePath(`/projects/${parsed.data.projectId}`);
  redirect(`/projects/${parsed.data.projectId}`);
}
