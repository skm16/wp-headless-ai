// apps/web/scripts/smoke-deploy-site.ts
//
// End-to-end smoke for Phase D against an already-composed build.
//   cd apps/web
//   pnpm smoke:deploy <projectId> <tenantId> <buildId>
//
// Prereqs: Inngest dev + Next dev running, .env.local has
// SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, VERCEL_TOKEN,
// VERCEL_TEAM_ID. Real Vercel deployment — ~$0.40 in build minutes.
//
// Polls site_builds.status until 'verifying' (success) or 'failed'.
// On success, HEAD-checks the preview_url returns 200 before declaring PASS.

import { createClient } from "@supabase/supabase-js";
import { Inngest } from "inngest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 8 * 60 * 1000; // Vercel build ~60-180s + slack

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function main() {
  loadDotEnvLocal();

  const [, , projectId, tenantId, buildId] = process.argv;
  if (!projectId || !tenantId || !buildId) {
    console.error("Usage: pnpm smoke:deploy <projectId> <tenantId> <buildId>");
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  if (!process.env.VERCEL_TOKEN || !process.env.VERCEL_TEAM_ID) {
    console.error("Missing VERCEL_TOKEN or VERCEL_TEAM_ID. See docs/superpowers/operator/2026-05-28-vercel-platform-setup.md");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const inngest = new Inngest({
    id: "smoke-deploy-site",
    eventKey: process.env.INNGEST_EVENT_KEY ?? "local-dev-key",
    baseUrl: process.env.INNGEST_BASE_URL ?? "http://localhost:8288",
    isDev: true,
  });

  console.log(`[smoke] dispatching site/deploy.requested for build ${buildId}…`);
  await inngest.send({
    name: "site/deploy.requested",
    data: { projectId, tenantId, buildId },
  });

  const t0 = Date.now();
  let lastStatus = "";
  while (Date.now() - t0 < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const { data: build } = await supabase
      .from("site_builds")
      .select("status, preview_url, build_log_storage_path")
      .eq("id", buildId)
      .single();
    if (!build) continue;
    if (build.status !== lastStatus) {
      console.log(`[smoke] status: ${build.status}`);
      lastStatus = build.status;
    }
    if (build.status === "verifying") {
      console.log(`[smoke] preview_url: ${build.preview_url}`);
      // HEAD-check the URL to confirm Vercel really served it.
      try {
        const res = await fetch(build.preview_url, { method: "HEAD" });
        if (res.status !== 200) {
          console.error(`[smoke] FAIL — HEAD ${build.preview_url} returned ${res.status}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`[smoke] FAIL — HEAD ${build.preview_url} threw: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      console.log(`[smoke] PASS — preview HEAD returned 200`);
      console.log(`[smoke] Phase D complete in ${Date.now() - t0}ms.`);
      return;
    }
    if (build.status === "failed") {
      console.error(`[smoke] FAIL — site_builds.status='failed'`);
      if (build.build_log_storage_path) {
        console.error(`[smoke] build log at: ${build.build_log_storage_path}`);
      }
      process.exit(1);
    }
  }

  console.error(`[smoke] FAIL — timed out after ${Date.now() - t0}ms (status=${lastStatus})`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
