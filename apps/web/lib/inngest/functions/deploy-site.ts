import "server-only";
import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptColumnToString } from "@/lib/crypto/encrypt";
import { downloadProjectTree, assertRequiredFiles } from "@/lib/jab/download-project-tree";
import { pollDeployment } from "@/lib/vercel/poll-deployment";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { recordDeployment } from "@/lib/jab/deployments-recorder";
import { markBuildFailed } from "@/lib/inngest/shared-failure";
import { loadVercelClient } from "@/lib/vercel/load-client";
import { isBuildCancelled } from "@/lib/jab/build-cancel";
import { ACTIVE_BUILD_PHASES } from "@/lib/jab/build-status";

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

const POLL_TICK_MS = 10_000;
const POLL_MAX_MS = 5 * 60 * 1000;

export const deploySite = inngest.createFunction(
  { id: "deploy-site", retries: 0 },
  { event: "site/deploy.requested" },
  async ({ event, step }) => {
    const { projectId, tenantId, buildId } = event.data as {
      projectId: string;
      tenantId: string;
      buildId: string;
    };

    try {
      const cancelledAtEntry = await step.run("deploy-cancel-guard", async () => {
        const supabase = createAdminClient();
        return isBuildCancelled(supabase, buildId, projectId);
      });
      if (cancelledAtEntry) {
        console.log(`[deploy-site] build ${buildId} is cancelled — skipping deploy.`);
        return { buildId, cancelled: true };
      }

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
        const supabase = createAdminClient();
        const files = await downloadProjectTree(supabase, buildId);
        assertRequiredFiles(files.map((f) => f.file));
        return files;
      }),
    ]);

    console.log(`[deploy-site] ${envsSynced} env var(s) synced, ${projectFiles.length} file(s) downloaded for build ${buildId}`);

    const deployment = await step.run("create-deployment", async () => {
      return vercel.createDeployment({
        projectId: vercelProject.id,
        name: vercelProject.name,
        files: projectFiles,
      });
    });

    console.log(`[deploy-site] created Vercel deployment ${deployment.id} (${deployment.url}) for build ${buildId}`);

    const pollResult = await step.run("poll-deployment", async () => {
      return pollDeployment({
        client: vercel,
        deploymentId: deployment.id,
        tickMs: POLL_TICK_MS,
        maxMs: POLL_MAX_MS,
      });
    });

    if (pollResult.outcome === "READY") {
      const normalizedPreviewUrl = pollResult.deployment.url.startsWith("http")
        ? pollResult.deployment.url
        : `https://${pollResult.deployment.url}`;

      // Terminal-state guard: only advance from an ACTIVE prior status. A
      // discard (cancelled) or stale auto-fail (failed) that landed since
      // the entry guard must not be overwritten back to an active status.
      // Zero rows updated = terminal elsewhere — stop BEFORE recording the
      // preview deployment or dispatching verify.
      const advanced = await step.run("on-success", async () => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("site_builds")
          .update({
            status: "verifying",
            preview_url: normalizedPreviewUrl,
            vercel_deployment_id: deployment.id,
          })
          .eq("id", buildId)
          .eq("project_id", projectId)
          .in("status", [...ACTIVE_BUILD_PHASES])
          .select("id");
        if (error) throw new Error(`deploy-site: on-success update failed: ${error.message}`);
        return (data ?? []).length > 0;
      });
      if (!advanced) {
        console.log(`[deploy-site] build ${buildId} reached a terminal state elsewhere (discard or auto-fail) — stopping.`);
        return { buildId, cancelled: true };
      }

      // Phase 1 plan task 1f: make `deployments` the canonical deploy
      // history. site_builds.preview_url is kept as the denormalized
      // convenience pointer for UI surfaces that just want "the latest
      // build's URL"; deployments is the table you query for history.
      await step.run("record-preview-deployment", async () => {
        const supabase = createAdminClient();
        return recordDeployment(supabase, {
          buildId,
          projectId,
          environment: "preview",
          status: "ready",
          providerDeploymentId: deployment.id,
          url: normalizedPreviewUrl,
        });
      });

      await step.sendEvent("dispatch-verify", {
        name: "site/verify.requested",
        data: { projectId, tenantId, buildId },
      });

      return { buildId, vercelDeploymentId: deployment.id, previewUrl: normalizedPreviewUrl, outcome: "ready" };
    }

    // pollResult.outcome ∈ { ERROR, CANCELED, TIMEOUT }
    const buildLogPath = `builds/${buildId}/build-log.txt`;

    await step.run("on-failure", async () => {
      let logText = `[deploy-site] outcome: ${pollResult.outcome}\n`;
      if (pollResult.outcome === "TIMEOUT") {
        logText += `[deploy-site] poll exceeded ${POLL_MAX_MS}ms; lastReadyState=${pollResult.lastReadyState}\n`;
      }

      // Fetch Vercel build events. Tolerate fetch failure — the log
      // upload itself must not block the failure-write to site_builds.
      try {
        const events = await vercel.getDeploymentEvents(deployment.id);
        logText += "\n--- Vercel build events ---\n";
        logText += events;
      } catch (err) {
        logText += `\n[deploy-site] failed to fetch Vercel events: ${err instanceof Error ? err.message : String(err)}\n`;
      }

      // Upload to Storage with 3-attempt backoff (mirror persist-shell-generation.ts).
      const supabase = createAdminClient();
      const buf = Buffer.from(logText, "utf8");
      let lastError: { message: string } | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const { error: uploadError } = await supabase.storage
          .from(SITE_SCREENSHOTS_BUCKET)
          .upload(buildLogPath, buf, { contentType: "text/plain", upsert: true });
        if (!uploadError) {
          lastError = null;
          break;
        }
        lastError = uploadError;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 200 * Math.pow(3, attempt)));
        }
      }
      if (lastError) {
        console.warn(`[deploy-site] build-log upload failed after 3 attempts: ${lastError.message}`);
      }

      const outcomeDetail =
        pollResult.outcome === "TIMEOUT" ? ` (lastReadyState=${pollResult.lastReadyState})` : "";
      const { error } = await supabase
        .from("site_builds")
        .update({
          status: "failed",
          failed_phase: "building",
          error_text: `deploy ${pollResult.outcome}${outcomeDetail} — see build log`,
          finished_at: new Date().toISOString(),
          vercel_deployment_id: deployment.id,
          build_log_storage_path: lastError ? null : buildLogPath,
        })
        .eq("id", buildId)
        .eq("project_id", projectId)
        // A user discard (status='cancelled') must not be relabeled as a system failure.
        .neq("status", "cancelled");
      if (error) throw new Error(`deploy-site: on-failure update failed: ${error.message}`);
    });

    // Phase 1 plan task 1f: write a failed-status deployments row so the
    // history surface shows every attempt — operators reviewing a project
    // need to see "we tried, it failed" not silence. Vercel issues `dpl_*`
    // at create time so we always have a provider_deployment_id even when
    // the URL never materialized. TIMEOUT outcomes only carry
    // lastReadyState, no deployment object — fall back to the URL Vercel
    // returned at create-deployment time.
    await step.run("record-failed-deployment", async () => {
      const supabase = createAdminClient();
      const rawUrl =
        pollResult.outcome === "TIMEOUT"
          ? deployment.url
          : pollResult.deployment.url;
      const url = rawUrl
        ? rawUrl.startsWith("http")
          ? rawUrl
          : `https://${rawUrl}`
        : null;
      return recordDeployment(supabase, {
        buildId,
        projectId,
        environment: "preview",
        status: "failed",
        providerDeploymentId: deployment.id,
        url,
      });
    });

    return {
      buildId,
      vercelDeploymentId: deployment.id,
      outcome: pollResult.outcome.toLowerCase(),
    };
    } catch (err) {
      // Mirror discover/components/compose: any unhandled throw (load-project,
      // sync-env-vars, download-project-files, etc) flips site_builds to
      // failed with phase='building'. The on-failure step above handles the
      // pollResult branch — this catches everything else.
      await markBuildFailed({ buildId, projectId, phase: "building", error: err });
      throw err;
    }
  },
);
