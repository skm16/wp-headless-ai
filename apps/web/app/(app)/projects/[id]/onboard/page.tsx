import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
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
    <article className="mx-auto max-w-2xl space-y-8">
      <header>
        <p className="text-sm text-slate-500">
          <Link
            href={`/projects/${id}`}
            className="hover:underline"
          >
            {project.name}
          </Link>{" "}
          /
        </p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Onboarding</h1>
        <p className="mt-1 text-sm text-slate-600">
          Two steps: verify the WordPress install, then connect the GitHub
          repo where Jab will push generated code.
        </p>
      </header>

      <ol className="flex items-center gap-3 text-xs font-medium uppercase tracking-wide">
        <StepBadge index={1} label="WordPress" active={!hasManifest} done={hasManifest} />
        <span className="text-slate-300">—</span>
        <StepBadge index={2} label="GitHub" active={hasManifest} done={false} />
      </ol>

      {!hasManifest ? (
        <WpCredsForm
          projectId={id}
          defaultWpUrl={project.wp_url ?? ""}
          defaultUsername={project.wp_username ?? ""}
        />
      ) : (
        <>
          <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm">
            <p className="font-medium text-emerald-900">
              WordPress verified — found {abilityCount} {abilityCount === 1 ? "ability" : "abilities"}.
            </p>
            <p className="mt-1 text-emerald-800">
              Connected to{" "}
              <span className="font-mono">{project.wp_url}</span> as{" "}
              <span className="font-mono">{project.wp_username}</span>.
            </p>
          </section>
          <GithubForm projectId={id} />
        </>
      )}
    </article>
  );
}

function StepBadge({
  index,
  label,
  active,
  done,
}: {
  index: number;
  label: string;
  active: boolean;
  done: boolean;
}) {
  const cls = done
    ? "bg-emerald-600 text-white"
    : active
      ? "bg-slate-900 text-white"
      : "bg-slate-100 text-slate-500";
  return (
    <li className={`flex items-center gap-2 rounded-full px-3 py-1 ${cls}`}>
      <span className="font-mono">{done ? "✓" : index}</span>
      <span>{label}</span>
    </li>
  );
}
