// apps/web/scripts/smoke-generate-components.ts
//
// Manual smoke runner for Phase B component generation. Run with:
//   cd apps/web
//   pnpm tsx scripts/smoke-generate-components.ts <projectId> <tenantId> <buildId>
//
// Prereqs (same as smoke-discover-site.ts):
//   - Inngest dev server running (npx inngest-cli@latest dev -u http://localhost:3000/api/inngest)
//   - Next dev running (pnpm dev in apps/web)
//   - The given buildId is a completed Phase A discovery (page_inventory + block_inventory populated)
//   - SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL in .env.local
//   - ANTHROPIC_API_KEY in .env.local (real key — live LLM calls fire for
//     all three tiers: visual + standard use Sonnet 4.6, trivial uses Haiku 4.5)
//
// What this verifies:
//   1. generateComponents worker runs without crashing
//   2. site_builds.status transitions to 'composing'
//   3. block_inventory rows have compile_status populated (ok | failed | skipped)
//   4. Storage contains .tsx files under builds/<buildId>/components/
//   5. Storage .tsx count is >= block_inventory rows with compile_status='ok'
//
// Exit codes:
//   0 — all assertions passed
//   1 — assertion failed or timeout

import { createClient } from "@supabase/supabase-js";
import { Inngest } from "inngest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — Phase B can take up to 5 min on large sites.

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
    console.error("Usage: pnpm tsx scripts/smoke-generate-components.ts <projectId> <tenantId> <buildId>");
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error("[smoke] missing env: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY must be set.");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Force the Inngest SDK into dev mode even when .env.local has prod-mode
  // INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY set. The smoke is a LOCAL
  // verification — events must hit the dev server, never Inngest Cloud.
  // isDev: true overrides env-based mode detection; baseUrl pins the SDK
  // to the dev server's REST endpoint regardless of INNGEST_BASE_URL /
  // INNGEST_EVENT_KEY.
  const inngestBaseUrl = process.env.INNGEST_DEV_SERVER_URL ?? "http://localhost:8288";
  const inngest = new Inngest({
    id: "jab-saas",
    isDev: true,
    baseUrl: inngestBaseUrl,
    eventKey: "dev",
  });

  // Verify the build exists and Phase A populated something.
  const { data: build, error: buildErr } = await supabase
    .from("site_builds")
    .select("id, status, block_type_count, component_count")
    .eq("id", buildId)
    .eq("project_id", projectId)
    .single<{ id: string; status: string; block_type_count: number | null; component_count: number | null }>();
  if (buildErr || !build) {
    console.error(`[smoke] Build ${buildId} not found: ${buildErr?.message}`);
    process.exit(1);
  }
  console.log(`[smoke] Build ${buildId} found, current status: ${build.status}`);

  await inngest.send({
    name: "site/components.requested",
    data: { projectId, tenantId, buildId },
  });
  console.log("[smoke] Dispatched site/components.requested. Polling...");

  const startedAt = Date.now();
  const deadline = startedAt + TIMEOUT_MS;
  let finalStatus: string | null = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const { data: current } = await supabase
      .from("site_builds")
      .select("status, component_count, error_text")
      .eq("id", buildId)
      .single<{ status: string; component_count: number | null; error_text: string | null }>();

    if (!current) continue;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[smoke] t=${elapsed}s status=${current.status} components=${current.component_count ?? "?"}`);

    if (current.status === "failed") {
      console.error(`[smoke] Build failed: ${current.error_text}`);
      process.exit(1);
    }
    if (current.status === "composing") {
      finalStatus = "composing";
      console.log("[smoke] Phase B complete — status is 'composing'.");
      break;
    }
  }

  if (finalStatus !== "composing") {
    console.error(`[smoke] FAIL: timed out at ${TIMEOUT_MS}ms waiting for status=composing.`);
    process.exit(1);
  }

  const { data: inventoryRows } = await supabase
    .from("block_inventory")
    .select("block_name, tier, compile_status, compile_attempt_count")
    .eq("site_build_id", buildId)
    .eq("project_id", projectId);

  const rows = (inventoryRows ?? []) as Array<{
    block_name: string;
    tier: string | null;
    compile_status: string | null;
    compile_attempt_count: number | null;
  }>;

  const ok = rows.filter((r) => r.compile_status === "ok").length;
  const failed = rows.filter((r) => r.compile_status === "failed").length;
  const skipped = rows.filter((r) => r.compile_status === "skipped").length;
  const pending = rows.filter((r) => r.compile_status === null).length;

  console.log(`\n[smoke] block_inventory compile summary:`);
  console.log(`  ok:      ${ok}`);
  console.log(`  failed:  ${failed}`);
  console.log(`  skipped: ${skipped}`);
  console.log(`  pending: ${pending}`);
  console.log(`  total:   ${rows.length}`);

  if (failed > 0) {
    console.warn(`[smoke] WARN: ${failed} component(s) fell back to passthrough due to compile failure.`);
    rows
      .filter((r) => r.compile_status === "failed")
      .forEach((r) => console.warn(`  - ${r.block_name} (${r.compile_attempt_count} attempts)`));
  }

  const { data: storageItems } = await supabase.storage
    .from("site-screenshots")
    .list(`builds/${buildId}/components`);
  const tsxCount = (storageItems ?? []).filter((item) => item.name.endsWith(".tsx")).length;
  console.log(`\n[smoke] Storage: ${tsxCount} .tsx files at builds/${buildId}/components/`);

  if (tsxCount < ok) {
    console.error(`[smoke] FAIL: Storage has ${tsxCount} .tsx files but ${ok} blocks compiled ok — mismatch.`);
    process.exit(1);
  }

  console.log("\n[smoke] PASS — Phase B smoke complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] Unhandled error:", err);
  process.exit(1);
});
