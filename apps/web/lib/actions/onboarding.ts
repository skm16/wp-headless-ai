"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { encryptString } from "@/lib/crypto/encrypt";
import { probeWordPress } from "@/lib/jab/probe";
import { createClient } from "@/lib/supabase/server";

/**
 * Phase C onboarding server actions.
 *
 * Two-step flow, both gated by RLS via the user's Supabase session:
 *   1. probeAndSaveWpAction — verify WP creds work, then encrypt + persist
 *      them alongside the manifest snapshot. Project flips to status
 *      'onboarding' (it has working WP creds but no GitHub link yet).
 *   2. saveGithubAction — capture repo + PAT, encrypt + persist, flip to
 *      status 'ready'.
 *
 * Both actions return `{ error?: string }` so client forms can surface the
 * failure via useActionState. Successful flows revalidate + (for step 2)
 * redirect back to the project page.
 *
 * Why two actions and not one combined "submit everything at once"?
 * Probe-first ordering means we never persist credentials we haven't
 * verified. If GitHub setup blows up, the WP-side state is already saved
 * and recoverable on retry — the user doesn't have to re-enter their WP
 * password.
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
  });
  if (!parsed.success) {
    return { error: parsed.error.errors.map((e) => e.message).join("; ") };
  }
  const { projectId, wpUrl, wpUsername, wpAppPassword } = parsed.data;

  const probe = await probeWordPress({
    wpUrl,
    username: wpUsername,
    appPassword: wpAppPassword,
  });
  if (!probe.ok) {
    return { error: probe.error };
  }

  const supabase = await createClient();
  const { error: updateErr } = await supabase
    .from("projects")
    .update({
      wp_url: wpUrl,
      wp_username: wpUsername,
      wp_app_password_encrypted: encryptString(wpAppPassword),
      manifest: probe.manifest,
      status: "onboarding",
    })
    .eq("id", projectId);
  if (updateErr) {
    // RLS denial returns 0 rows updated with no error; an actual error
    // means something deeper went wrong. Surface raw message.
    return { error: `Couldn't save: ${updateErr.message}` };
  }

  revalidatePath(`/projects/${projectId}/onboard`);
  revalidatePath(`/projects/${projectId}`);
  return null;
}

const GithubInput = z.object({
  projectId: z.string().uuid(),
  githubRepoFullName: z
    .string()
    .trim()
    .regex(
      /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
      "Must be in the form 'owner/repo' (e.g. acme-agency/client-site)",
    ),
  githubPat: z
    .string()
    .trim()
    .min(20, "PAT looks too short — paste the full token")
    .max(255),
});

export async function saveGithubAction(
  _prev: OnboardingActionState,
  formData: FormData,
): Promise<OnboardingActionState> {
  const parsed = GithubInput.safeParse({
    projectId: formData.get("projectId"),
    githubRepoFullName: formData.get("githubRepoFullName"),
    githubPat: formData.get("githubPat"),
  });
  if (!parsed.success) {
    return { error: parsed.error.errors.map((e) => e.message).join("; ") };
  }
  const { projectId, githubRepoFullName, githubPat } = parsed.data;

  const supabase = await createClient();
  const { data: project, error: readErr } = await supabase
    .from("projects")
    .select("id, manifest")
    .eq("id", projectId)
    .single();
  if (readErr) {
    if (readErr.code === "PGRST116") return { error: "Project not found" };
    return { error: readErr.message };
  }
  if (!project.manifest) {
    return {
      error:
        "WP probe hasn't completed yet — go back and verify the WordPress credentials first.",
    };
  }

  const { error: updateErr } = await supabase
    .from("projects")
    .update({
      github_repo_full_name: githubRepoFullName,
      github_pat_encrypted: encryptString(githubPat),
      status: "ready",
      onboarded_at: new Date().toISOString(),
    })
    .eq("id", projectId);
  if (updateErr) {
    return { error: `Couldn't save: ${updateErr.message}` };
  }

  revalidatePath(`/projects/${projectId}/onboard`);
  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}`);
}
