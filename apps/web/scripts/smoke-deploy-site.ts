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
      // HEAD-check the URL to confirm Vercel really served the deploy AND
      // the URL is actually reachable by the agency's client (the SaaS's
      // unit of value). The Vercel client at apps/web/lib/vercel/client.ts
      // attempts to disable Deployment Protection at project-create time
      // (`ssoProtection: null` + `passwordProtection: null`), but Vercel
      // may re-enable it via a team-level default. A 401 here means the
      // deployment exists but is gated — that is a client-visible failure
      // mode by default and the verification gate refuses to paper over it.
      //
      // Opt-out: set JAB_SMOKE_ACCEPT_PROTECTED=1 to demote 401 to a
      // warning. Use this only when the operator has consciously decided
      // to ship gated previews (e.g. internal staging where SSO is wanted).
      const acceptProtected = process.env.JAB_SMOKE_ACCEPT_PROTECTED === "1";
      try {
        const res = await fetch(build.preview_url, { method: "HEAD" });
        if (res.status === 200) {
          // Public preview — the happy path.
        } else if (res.status === 401 && acceptProtected) {
          console.log(
            `[smoke] WARN — preview HEAD returned 401 (Vercel Deployment Protection active). ` +
              `JAB_SMOKE_ACCEPT_PROTECTED=1 set, demoting to warning. ` +
              `Clients will see Vercel SSO before the site; disable Deployment Protection in project settings to ship a publicly-reachable preview.`,
          );
        } else if (res.status === 401) {
          console.error(
            `[smoke] FAIL — preview HEAD returned 401 (Vercel Deployment Protection blocking public access). ` +
              `The SaaS contract is a publicly-reachable preview URL; clients cannot view a 401-gated site. ` +
              `Either disable Deployment Protection on the Vercel project (recommended) or set ` +
              `JAB_SMOKE_ACCEPT_PROTECTED=1 to acknowledge the gated preview and skip this check.`,
          );
          process.exit(1);
        } else {
          console.error(`[smoke] FAIL — HEAD ${build.preview_url} returned ${res.status}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`[smoke] FAIL — HEAD ${build.preview_url} threw: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      console.log(`[smoke] PASS — preview HEAD confirmed (deployment live)`);
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
