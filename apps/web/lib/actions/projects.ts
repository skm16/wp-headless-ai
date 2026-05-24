"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const CreateProjectInput = z.object({
  name: z.string().trim().min(1, "Name required").max(100),
  clientName: z.string().trim().min(1, "Client name required").max(100),
  wpUrl: z
    .string()
    .trim()
    .url("Must be a valid URL")
    .refine((v) => /^https?:\/\//i.test(v), "Must start with http:// or https://"),
});

/**
 * createProject — server action invoked from the new-project form.
 *
 * v0 picks the user's first tenant (each user has exactly one — auto-
 * provisioned by the handle_new_user trigger). v1+ adds a tenant picker
 * for users who belong to multiple, and the picker becomes the limit:
 * memberships[0] → params.tenant_id from the form.
 *
 * RLS verifies the insert is allowed (WITH CHECK on tenant_id IN
 * current_user_tenant_ids()), so even if the tenant_id were attacker-
 * controlled, the boundary holds.
 */
export async function createProject(formData: FormData): Promise<void> {
  const parsed = CreateProjectInput.safeParse({
    name: formData.get("name"),
    clientName: formData.get("clientName"),
    wpUrl: formData.get("wpUrl"),
  });
  if (!parsed.success) {
    throw new Error(parsed.error.errors.map((e) => e.message).join("; "));
  }

  const supabase = await createClient();

  const { data: memberships, error: mErr } = await supabase
    .from("tenant_members")
    .select("tenant_id")
    .limit(1);
  if (mErr) throw mErr;
  if (!memberships || memberships.length === 0) {
    throw new Error(
      "No tenant for current user — the handle_new_user trigger may have failed during signup. Sign out, sign back in, and try again.",
    );
  }
  const tenantId = memberships[0]!.tenant_id;

  const { data: project, error } = await supabase
    .from("projects")
    .insert({
      tenant_id: tenantId,
      name: parsed.data.name,
      client_name: parsed.data.clientName,
      wp_url: parsed.data.wpUrl,
      status: "draft",
    })
    .select("id")
    .single();
  if (error) throw error;

  // From-scratch projects (no preview to promote) route into the same
  // onboarding wizard the preview-flow uses. The wizard reads the project
  // row, sees intent/manifest/ownership all NULL, and opens at step 0.
  redirect(`/projects/${project.id}/onboard`);
}
