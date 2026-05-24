import { notFound, redirect } from "next/navigation";
import type { Manifest } from "@jab/core";
import { createClient } from "@/lib/supabase/server";
import { contentTypesFromManifest } from "@/lib/jab/content-types-from-manifest";
import type {
  OwnershipMode,
  WPContentType,
} from "@/components/ownership-picker";
import type { ProjectIntent } from "@/components/intent-picker";
import { OnboardingWizardClient } from "./onboarding-wizard-client";

/**
 * Post-pivot onboarding wizard route.
 *
 * Server Component that hydrates the wizard from the project row:
 *   - `status === 'ready'` → redirect to /projects/[id]. The wizard's
 *     finished work; re-entering would be confusing. (Editing intent
 *     post-onboarding is a future workspace surface, not this route.)
 *   - Otherwise derives `initialStepIndex` purely from which of (intent,
 *     manifest, content_ownership) are persisted. No separate progress
 *     column — the data IS the progress.
 *
 * The route renders the wizard in its 2-column "with-aside" layout
 * (provided by OnboardingShell's new `aside` slot) so the saved /preview
 * HTML stays visible as a thumbnail while the user walks the steps. For
 * from-scratch projects with no preview, the wizard falls back to its
 * centered single-column layout.
 *
 * RLS scoping: a wrong-tenant id returns PGRST116 → 404, indistinguishable
 * from a missing id. Same pattern as the workspace page.
 */
export default async function OnboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select(
      "id, name, wp_url, intent, manifest, content_ownership, status, preview_html",
    )
    .eq("id", id)
    .single();

  if (error?.code === "PGRST116" || !project) notFound();
  if (error) throw error;
  if (project.status === "ready") redirect(`/projects/${id}`);

  const initialIntent: ProjectIntent =
    (project.intent as ProjectIntent | null) ?? "faithful";
  const initialStepIndex = deriveInitialStep(project);

  // If the manifest is already saved (user previously completed step 2),
  // derive the content-types catalog up-front so resuming at step 3
  // doesn't require re-running the probe.
  const initialContentTypes: WPContentType[] | undefined = project.manifest
    ? contentTypesFromManifest(project.manifest as Manifest)
    : undefined;

  const initialOwnership: Record<string, OwnershipMode> | undefined =
    project.content_ownership
      ? (project.content_ownership as Record<string, OwnershipMode>)
      : undefined;

  return (
    <OnboardingWizardClient
      projectId={project.id}
      wpUrl={project.wp_url ?? ""}
      initialIntent={initialIntent}
      initialStepIndex={initialStepIndex}
      initialContentTypes={initialContentTypes}
      initialOwnership={initialOwnership}
      previewHtml={project.preview_html ?? null}
    />
  );
}

/**
 * Derive which wizard step to open on. The data IS the progress —
 * intent set → past step 0; manifest set → past step 2; ownership set →
 * past step 3 (and status will be 'ready', so we wouldn't be here).
 *
 * Step 1 (Install plugin) has no persisted state of its own — if intent
 * is set but manifest isn't, we open on step 1. The user can advance
 * past it with "I've installed it — continue →" without re-confirming.
 */
function deriveInitialStep(p: {
  intent: string | null;
  manifest: unknown;
  content_ownership: unknown;
}): 0 | 1 | 2 | 3 {
  if (!p.intent) return 0;
  if (!p.manifest) return 1;
  if (!p.content_ownership) return 3;
  // All three set means status='ready' which we already redirected on.
  // Defensive fallback for the impossible-shouldn't-happen case.
  return 3;
}
