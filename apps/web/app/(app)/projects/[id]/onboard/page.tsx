import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Alert } from "@/components/ui/alert";
import { Stepper } from "@/components/ui/stepper";
import { WpCredsForm } from "./wp-creds-form";
import { GithubForm } from "./github-form";

/**
 * Phase C — Onboarding wizard.
 *
 * Server Component that reads the project state and progressively reveals
 * the right step:
 *   - No manifest yet → show WP credentials form
 *   - Manifest captured but no GitHub repo → show GitHub form (with a
 *     summary of what we already verified)
 *   - status='ready' → bounce back to the project page (the user shouldn't
 *     have re-entered the wizard, but if they did, just send them home)
 *
 * RLS-PGRST116 → 404 keeps cross-tenant probing indistinguishable from
 * "doesn't exist", same pattern as the project detail page.
 *
 * Post-§12 note: the GitHub step is slated for removal per the SaaS pivot;
 * the canonical post-pivot onboarding lives in `OnboardingWizard` (see
 * `/ui-kit/onboarding`). This route stays in place until engineering ships
 * the §12 surfaces in `(app)/projects/[id]/`.
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
      "id, name, status, wp_url, wp_username, github_repo_full_name, manifest",
    )
    .eq("id", id)
    .single();

  if (error?.code === "PGRST116" || !project) notFound();
  if (error) throw error;

  // Note: we deliberately don't redirect 'ready' projects away from the
  // wizard — re-running it is the user-facing way to update GitHub creds
  // (e.g. when a PAT expires or scope was wrong). The forms write fresh
  // encrypted values; status stays 'ready' on submit.
  const hasManifest = Boolean(project.manifest);
  const abilityCount = hasManifest
    ? (project.manifest as { abilities?: unknown[] }).abilities?.length ?? 0
    : 0;

  return (
    <article className="mx-auto max-w-2xl space-y-8 px-6 py-8">
      <header>
        <p className="font-mono text-xs text-gry-d">
          <Link
            href={`/projects/${id}`}
            className="hover:text-gry hover:underline"
          >
            {project.name}
          </Link>{" "}
          /
        </p>
        <h1 className="mt-1 font-display text-[28px] font-extrabold leading-[1.15] tracking-[-0.02em] text-wht">
          Onboarding
        </h1>
        <p className="mt-1 text-sm text-gry">
          Two steps: verify the WordPress install, then connect the GitHub
          repo where Jab will push generated code.
        </p>
      </header>

      <Stepper
        steps={[
          {
            label: "WordPress",
            status: hasManifest ? "done" : "current",
          },
          {
            label: "GitHub",
            status: hasManifest ? "current" : "pending",
          },
        ]}
      />

      {!hasManifest ? (
        <WpCredsForm
          projectId={id}
          defaultWpUrl={project.wp_url ?? ""}
          defaultUsername={project.wp_username ?? ""}
        />
      ) : (
        <>
          <Alert
            tone="success"
            title={`WordPress verified — found ${abilityCount} ${abilityCount === 1 ? "ability" : "abilities"}.`}
          >
            Connected to <span className="font-mono">{project.wp_url}</span>{" "}
            as <span className="font-mono">{project.wp_username}</span>.
          </Alert>
          <GithubForm projectId={id} />
        </>
      )}
    </article>
  );
}
