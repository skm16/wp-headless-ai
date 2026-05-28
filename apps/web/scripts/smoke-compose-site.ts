// apps/web/scripts/smoke-compose-site.ts
//
// Manual smoke runner for Phase C compose-site.
//   cd apps/web
//   pnpm tsx scripts/smoke-compose-site.ts <projectId> <tenantId> <buildId>
//
// Prereqs: Inngest dev + Next dev running, .env.local has
// SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, ANTHROPIC_API_KEY.
// Header + Footer use real Sonnet 4.6 — ~$0.08 per smoke.

import { createClient } from "@supabase/supabase-js";
import { Inngest } from "inngest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const BUCKET = "site-screenshots";
const POLL_INTERVAL_MS = 3_000;
const TIMEOUT_MS = 5 * 60 * 1000;

const REQUIRED_FILES = [
  "package.json", "tsconfig.json", "next.config.ts", "tailwind.config.ts",
  "postcss.config.mjs", ".gitignore", ".env.example", "README.md",
  "app/layout.tsx", "app/page.tsx", "app/not-found.tsx", "app/robots.ts",
  "app/sitemap.ts", "app/globals.css",
  // Catch-all routes use Storage-safe encoding (Supabase rejects brackets in
  // object keys). Phase D will rename __catchall_slug__ → [...slug] at deploy.
  "app/__catchall_slug__/page.tsx", "app/__catchall_slug__/route-map.ts",
  "components/blocks/_dispatcher.tsx", "components/blocks/_passthrough.tsx",
  "components/site/Header.tsx", "components/site/Footer.tsx",
  "lib/jab/client.ts", "lib/compose-block-tree.ts", "lib/acf-flex-fields.ts",
  "lib/sdk/types.ts", "lib/sdk/client.ts", "lib/sdk/abilities.ts",
  "lib/sdk/index.ts", "lib/sdk/CLAUDE.md",
];

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
    console.error("Usage: pnpm tsx scripts/smoke-compose-site.ts <projectId> <tenantId> <buildId>");
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const inngest = new Inngest({
    id: "smoke-compose-site",
    eventKey: process.env.INNGEST_EVENT_KEY ?? "local-dev-key",
    baseUrl: process.env.INNGEST_BASE_URL ?? "http://localhost:8288",
    isDev: true,
  });

  console.log(`[smoke] dispatching site/compose.requested for build ${buildId}…`);
  await inngest.send({
    name: "site/compose.requested",
    data: { projectId, tenantId, buildId },
  });

  const t0 = Date.now();
  let lastStatus = "";
  while (Date.now() - t0 < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const { data: build } = await supabase
      .from("site_builds")
      .select("status")
      .eq("id", buildId)
      .single();
    if (!build) continue;
    if (build.status !== lastStatus) {
      console.log(`[smoke] status: ${build.status}`);
      lastStatus = build.status;
    }
    if (build.status === "built") break;
    if (build.status === "failed") {
      console.error("[smoke] FAIL — site_builds.status = 'failed'");
      process.exit(1);
    }
  }
  const elapsed = Date.now() - t0;
  if (lastStatus !== "built") {
    console.error(`[smoke] FAIL — timed out after ${elapsed}ms (status=${lastStatus})`);
    process.exit(1);
  }
  console.log(`[smoke] Phase C complete in ${elapsed}ms.`);

  const { data: shells } = await supabase
    .from("shell_generations")
    .select("shell_kind, compile_status")
    .eq("site_build_id", buildId);
  if (!shells || shells.length !== 2) {
    console.error(`[smoke] FAIL — expected 2 shell_generations rows, got ${shells?.length ?? 0}`);
    process.exit(1);
  }
  console.log(
    `[smoke] PASS — shell_generations: header=${shells.find((s) => s.shell_kind === "header")?.compile_status}, footer=${shells.find((s) => s.shell_kind === "footer")?.compile_status}`,
  );

  const missing: string[] = [];
  for (const filePath of REQUIRED_FILES) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(`builds/${buildId}/project/${filePath}`);
    if (error || !data) missing.push(filePath);
  }
  if (missing.length > 0) {
    console.error(`[smoke] FAIL — ${missing.length} required file(s) missing:`);
    missing.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log(`[smoke] PASS — all ${REQUIRED_FILES.length} required files present.`);
  console.log(`[smoke] PASS — Phase C smoke complete.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
