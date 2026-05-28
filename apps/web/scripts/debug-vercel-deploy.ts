// apps/web/scripts/debug-vercel-deploy.ts
//
// One-shot debug runner that talks to Vercel directly — no Inngest worker.
// Loads an existing build's project files from Storage, ensures the
// Vercel project exists, syncs env vars, creates a deployment, polls,
// reports outcome. On failure, prints the build log inline.
//
// Usage:
//   pnpm debug:vercel <projectId> <tenantId> <buildId>
//
// Prereqs: same as smoke:deploy.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function main() {
  loadDotEnvLocal();

  const [, , projectId, tenantId, buildId] = process.argv;
  if (!projectId || !tenantId || !buildId) {
    console.error("Usage: pnpm debug:vercel <projectId> <tenantId> <buildId>");
    process.exit(1);
  }

  // Late imports — these depend on env vars being loaded first.
  const { VercelClient } = await import("../lib/vercel/client");
  const { pollDeployment } = await import("../lib/vercel/poll-deployment");
  const { downloadProjectTree, assertRequiredFiles } = await import(
    "../lib/jab/download-project-tree"
  );
  const { decryptColumnToString } = await import("../lib/crypto/encrypt");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const vercelToken = process.env.VERCEL_TOKEN;
  const vercelTeamId = process.env.VERCEL_TEAM_ID;
  if (!supabaseUrl || !serviceKey || !vercelToken || !vercelTeamId) {
    console.error(
      "Missing env vars (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VERCEL_TOKEN, VERCEL_TEAM_ID)."
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const vercel = new VercelClient({ token: vercelToken, teamId: vercelTeamId });

  console.log(`[debug] loading project ${projectId}…`);
  const { data: project, error } = await supabase
    .from("projects")
    .select(
      "id, name, wp_url, wp_username, wp_app_password_encrypted, vercel_project_id, vercel_project_name"
    )
    .eq("id", projectId)
    .eq("tenant_id", tenantId)
    .single();
  if (error || !project) {
    console.error(`load-project failed: ${error?.message ?? "no row"}`);
    process.exit(1);
  }

  // Slug expression mirrors slugifyProjectName() in deploy-site.ts — kept
  // inline intentionally so the debug tool is self-contained. The
  // `|| "headless-site"` fallback must stay aligned with the worker (see
  // commit 77b46c0).
  const slug =
    project.vercel_project_name ??
    (project.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "headless-site");

  let vercelProject = project.vercel_project_id
    ? { id: project.vercel_project_id, name: slug }
    : null;
  if (!vercelProject) {
    console.log(`[debug] looking up or creating Vercel project '${slug}'…`);
    vercelProject =
      (await vercel.getProjectByName(slug)) ??
      (await vercel.createProject(slug));
  }
  console.log(`[debug] Vercel project: ${vercelProject.id} (${vercelProject.name})`);

  console.log(`[debug] syncing env vars…`);
  const envPlan = [
    { key: "WP_URL", value: project.wp_url },
    { key: "WP_USER", value: project.wp_username ?? "" },
    {
      key: "WP_APP_PASSWORD",
      value: decryptColumnToString(project.wp_app_password_encrypted),
    },
  ];
  const existing = await vercel.listEnvVars(vercelProject.id);
  const existingByKey = new Map(existing.map((e) => [e.key, e]));
  for (const v of envPlan) {
    const found = existingByKey.get(v.key);
    if (found) {
      await vercel.updateEnvVar(vercelProject.id, found.id, v.value);
    } else {
      await vercel.createEnvVar(vercelProject.id, v.key, v.value);
    }
  }

  console.log(`[debug] downloading project tree from Storage…`);
  const files = await downloadProjectTree(supabase, buildId);
  assertRequiredFiles(files.map((f) => f.file));
  console.log(`[debug] ${files.length} files downloaded`);

  console.log(`[debug] creating Vercel deployment…`);
  const deployment = await vercel.createDeployment({
    projectId: vercelProject.id,
    name: vercelProject.name,
    files,
  });
  console.log(
    `[debug] deployment ${deployment.id} → ${deployment.url} (state: ${deployment.readyState})`
  );

  console.log(`[debug] polling deployment (10s ticks, 5min cap)…`);
  const result = await pollDeployment({
    client: vercel,
    deploymentId: deployment.id,
    tickMs: 10_000,
    maxMs: 5 * 60 * 1000,
  });
  console.log(`[debug] outcome: ${result.outcome}`);
  if (result.outcome === "READY") {
    console.log(`[debug] ✓ PASS — https://${result.deployment.url}/`);
  } else {
    console.log(`[debug] fetching events log for failure inspection…`);
    const events = await vercel.getDeploymentEvents(deployment.id);
    console.log(`\n--- Vercel build events ---\n${events}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
