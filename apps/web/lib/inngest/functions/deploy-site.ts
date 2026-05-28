import "server-only";
import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase/admin";
import { VercelClient } from "@/lib/vercel/client";
import { decryptColumnToString } from "@/lib/crypto/encrypt";

/**
 * deploy-site — Phase D Inngest worker.
 *
 * Trigger: site/deploy.requested (dispatched by compose-site.ts at the end
 * of Phase C). Phase C terminal status is 'building', so we enter with
 * that status already set — no entry status transition needed.
 *
 * Sequencing:
 *   load-project → ensure-vercel-project → parallel(sync-env-vars,
 *   download-project-files) → create-deployment → poll-deployment →
 *   on-success(UPDATE + dispatch verify) OR on-failure(log + UPDATE).
 *
 * retries: 0 — same rationale as discoverSite/generateComponents/composeSite.
 * Failure surface is durable in site_builds; Inngest auto-retry would
 * create duplicate Vercel deployments.
 */

interface ProjectRow {
  id: string;
  name: string;
  wp_url: string;
  wp_username: string | null;
  wp_app_password_encrypted: unknown;
  vercel_project_id: string | null;
  vercel_project_name: string | null;
}

/**
 * Project name → Vercel project slug. Lowercase, alphanumeric + dashes
 * only, collapse runs, trim leading/trailing dashes. Must match the slug
 * compose-site-emit.ts uses in emitPackageJson so package.json `name` and
 * Vercel project name stay aligned.
 */
function slugifyProjectName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "headless-site"
  );
}

/**
 * Three env vars the emitted JAB project's lib/jab/client.ts expects at
 * build time AND runtime. The Record<SyncedKey, string> below enforces
 * single-source-of-truth: adding a key here without adding a value to the
 * record (or vice versa) is a tsc error. The emitted client reads exactly
 * these names — see packages/core/src/proxy.ts.
 */
const SYNCED_ENV_KEYS = ["WP_URL", "WP_USER", "WP_APP_PASSWORD"] as const;
type SyncedKey = (typeof SYNCED_ENV_KEYS)[number];

function buildEnvVarPlan(project: ProjectRow): Array<{ key: SyncedKey; value: string }> {
  if (!project.wp_username) {
    throw new Error(`deploy-site: project ${project.id} has no wp_username — cannot sync env vars`);
  }
  const password = decryptColumnToString(project.wp_app_password_encrypted);
  const values: Record<SyncedKey, string> = {
    WP_URL: project.wp_url,
    WP_USER: project.wp_username,
    WP_APP_PASSWORD: password,
  };
  return SYNCED_ENV_KEYS.map((key) => ({ key, value: values[key] }));
}

function loadVercelClient(): VercelClient {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  if (!token)
    throw new Error(
      "VERCEL_TOKEN not set. See docs/superpowers/operator/2026-05-28-vercel-platform-setup.md",
    );
  if (!teamId)
    throw new Error(
      "VERCEL_TEAM_ID not set. See docs/superpowers/operator/2026-05-28-vercel-platform-setup.md",
    );
  return new VercelClient({ token, teamId });
}

export const deploySite = inngest.createFunction(
  { id: "deploy-site", retries: 0 },
  { event: "site/deploy.requested" },
  async ({ event, step }) => {
    const { projectId, tenantId, buildId } = event.data as {
      projectId: string;
      tenantId: string;
      buildId: string;
    };

    const project = await step.run(
      "load-project",
      async (): Promise<ProjectRow> => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("projects")
          .select(
            "id, name, wp_url, wp_username, wp_app_password_encrypted, vercel_project_id, vercel_project_name",
          )
          .eq("id", projectId)
          .eq("tenant_id", tenantId)
          .single();
        if (error || !data)
          throw new Error(
            `deploy-site: load-project failed: ${error?.message ?? "no row"}`,
          );
        return data as ProjectRow;
      },
    );

    const vercel = loadVercelClient();
    const wantedName =
      project.vercel_project_name ?? slugifyProjectName(project.name);

    const vercelProject = await step.run("ensure-vercel-project", async () => {
      // Already linked — trust the DB. If the Vercel project was deleted
      // out-of-band (operator removed it from the Vercel UI), Task 10's
      // create-deployment will surface a 404; we accept that risk in v1
      // to avoid a getProjectByName call on every deploy.
      if (project.vercel_project_id) {
        return { id: project.vercel_project_id, name: wantedName };
      }
      // Existing by name? (Idempotency fallback if our DB diverged from Vercel.)
      const existing = await vercel.getProjectByName(wantedName);
      const created = existing ?? (await vercel.createProject(wantedName));

      const supabase = createAdminClient();
      const { error } = await supabase
        .from("projects")
        .update({
          vercel_project_id: created.id,
          vercel_project_name: created.name,
        })
        .eq("id", projectId)
        .eq("tenant_id", tenantId);
      if (error)
        throw new Error(
          `deploy-site: persist vercel_project_id failed: ${error.message}`,
        );
      return created;
    });

    // Wave 2 parallel: sync env vars, download project files
    const [{ synced: envsSynced }, projectFiles] = await Promise.all([
      step.run("sync-env-vars", async () => {
        const plan = buildEnvVarPlan(project);
        const existing = await vercel.listEnvVars(vercelProject.id);
        const existingByKey = new Map(existing.map((e) => [e.key, e]));
        for (const item of plan) {
          const found = existingByKey.get(item.key);
          if (found) {
            await vercel.updateEnvVar(vercelProject.id, found.id, item.value);
          } else {
            await vercel.createEnvVar(vercelProject.id, item.key, item.value);
          }
        }
        // Return only the count — never include `plan` here. Inngest serializes
        // step outputs to durable storage; returning the plan would persist the
        // decrypted WP_APP_PASSWORD in Inngest's state store.
        return { synced: plan.length };
      }),
      step.run("download-project-files", async () => {
        // implementation in Task 9 — empty stub returns 0 files for now
        return [] as Array<{ file: string; data: string; encoding: "utf-8" }>;
      }),
    ]);

    console.log(`[deploy-site] ${envsSynced} env var(s) synced, ${projectFiles.length} file(s) downloaded for build ${buildId}`);
    return { buildId, vercelProjectId: vercelProject.id, fileCount: projectFiles.length };
  },
);
