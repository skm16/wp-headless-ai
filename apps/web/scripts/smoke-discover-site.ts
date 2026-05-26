// apps/web/scripts/smoke-discover-site.ts
//
// Manual smoke runner for Phase A discovery. Run with:
//   cd apps/web
//   pnpm tsx scripts/smoke-discover-site.ts <projectId> <tenantId>
//
// Prereqs:
//   - Inngest dev server running (`npx inngest-cli@latest dev`)
//   - Next dev running (`pnpm dev` in apps/web), since Inngest invokes the
//     /api/inngest webhook to dispatch functions
//   - The given projectId is connected to the target WP install
//   - SUPABASE_SERVICE_ROLE_KEY env set in the shell
//   - NEXT_PUBLIC_SUPABASE_URL env set in the shell
//
// Self-contained on purpose — does NOT import the @/lib/* modules that
// carry `server-only` markers, because tsx runs in plain Node where
// `server-only` throws on import. Inlines the supabase client construction
// and the inngest event send instead. This keeps the smoke runnable from
// the command line without Next's RSC bundler.
//
// Exit codes:
//   0 — smoke passed all assertions
//   1 — smoke failed an assertion or timed out
import { createClient } from "@supabase/supabase-js";
import { Inngest } from "inngest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 2 * 60 * 1000; // 2 minute success-criteria budget

/**
 * Loads KEY=value pairs from `.env.local` into process.env. tsx (unlike
 * `next dev`) does NOT auto-load .env files, and bash/PowerShell don't
 * share env state across terminals — so a developer running this from a
 * fresh shell hits "missing env" without the loader. Strips surrounding
 * single/double quotes, skips comments + blank lines. Only sets keys not
 * already present in process.env so shell exports win (handy for CI / one-
 * off overrides).
 */
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

async function main(): Promise<void> {
  loadDotEnvLocal();

  const [projectId, tenantId] = process.argv.slice(2);
  if (!projectId || !tenantId) {
    console.error("Usage: tsx scripts/smoke-discover-site.ts <projectId> <tenantId>");
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error(
      "[smoke] missing env: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local or the shell",
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Force the Inngest SDK into dev mode even when .env.local has prod-mode
  // INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY set. The smoke is a LOCAL
  // integration probe — it must hit the local dev server (localhost:8288),
  // never Inngest Cloud, because the discoverSite function is only
  // registered at the local /api/inngest endpoint.
  //
  // `isDev: true` overrides env-based mode detection; setting baseUrl
  // pins the SDK to the dev server's REST endpoint regardless of what
  // INNGEST_BASE_URL / INNGEST_EVENT_KEY say.
  const inngestBaseUrl = process.env.INNGEST_DEV_SERVER_URL ?? "http://localhost:8288";
  const inngest = new Inngest({
    id: "jab-saas",
    isDev: true,
    baseUrl: inngestBaseUrl,
    // Suppress the "no event key" warning — dev server accepts any key.
    eventKey: "dev",
  });

  console.log(`[smoke] triggering discovery for project=${projectId} tenant=${tenantId}`);

  // Insert site_builds row first (the worker's mark-discovering step does
  // an UPDATE, not an INSERT — same contract as triggerDiscovery in
  // lib/actions/trigger-discovery.ts).
  const { data: build, error: insertErr } = await supabase
    .from("site_builds")
    .insert({ project_id: projectId, status: "queued" })
    .select("id")
    .single<{ id: string }>();
  if (insertErr || !build) {
    console.error(`[smoke] site_builds insert failed: ${insertErr?.message ?? "no row returned"}`);
    process.exit(1);
  }
  const buildId = build.id;
  console.log(`[smoke] buildId=${buildId}`);

  // Dispatch the event. In dev mode the SDK sends to the local Inngest
  // dev server discovered via INNGEST_BASE_URL (default localhost:8288).
  try {
    await inngest.send({
      name: "site/discover.requested",
      data: { projectId, tenantId, buildId },
    });
  } catch (err) {
    console.error(`[smoke] inngest.send failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`[smoke] is the Inngest dev server running? (\`npx inngest-cli@latest dev\`)`);
    process.exit(1);
  }

  const start = Date.now();
  let status: string | null = null;
  let pageCount: number | null = null;
  let blockTypeCount: number | null = null;

  while (Date.now() - start < TIMEOUT_MS) {
    const { data, error } = await supabase
      .from("site_builds")
      .select("status, page_count, block_type_count, error_text")
      .eq("id", buildId)
      .single<{ status: string; page_count: number | null; block_type_count: number | null; error_text: string | null }>();
    if (error) {
      console.error(`[smoke] poll error: ${error.message}`);
      process.exit(1);
    }
    status = data.status;
    pageCount = data.page_count;
    blockTypeCount = data.block_type_count;
    console.log(
      `[smoke] t=${Math.round((Date.now() - start) / 1000)}s status=${status} pages=${pageCount} blocks=${blockTypeCount}`,
    );
    if (status === "failed") {
      console.error(`[smoke] build failed: ${data.error_text}`);
      process.exit(1);
    }
    // Phase A standalone finishes at `discovering` with counts set. Stage 7
    // will flip onward; until then, finishing == counts populated.
    if (status === "discovering" && pageCount !== null && blockTypeCount !== null) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  const elapsedMs = Date.now() - start;
  if (elapsedMs >= TIMEOUT_MS) {
    console.error(`[smoke] FAIL: timed out at ${elapsedMs}ms`);
    process.exit(1);
  }
  console.log(`[smoke] discovery completed in ${elapsedMs}ms`);

  // ── Assertions ──
  let failed = false;
  function check(name: string, ok: boolean, detail: string): void {
    console.log(`[smoke] ${ok ? "PASS" : "FAIL"} — ${name}: ${detail}`);
    if (!ok) failed = true;
  }

  check("≤ 2 minute wall-clock", elapsedMs <= TIMEOUT_MS, `${elapsedMs}ms`);

  const { data: blocks } = await supabase
    .from("block_inventory")
    .select("block_name, tier, occurrence_count")
    .eq("site_build_id", buildId);
  check(
    "≥ 20 rows in block_inventory",
    !!blocks && blocks.length >= 20,
    `found ${blocks?.length ?? 0}`,
  );

  const { data: pages } = await supabase
    .from("page_inventory")
    .select("slug, post_type, source_screenshot_paths, block_count")
    .eq("site_build_id", buildId);
  check(
    "page_inventory has rows",
    !!pages && pages.length > 0,
    `found ${pages?.length ?? 0}`,
  );

  if (pages && pages.length > 0) {
    const sample = pages[0];
    const sourcePaths = (sample.source_screenshot_paths as { source?: Record<string, string> } | null)?.source ?? {};
    check(
      "first page has all 3 viewport screenshot paths",
      ["375", "768", "1280"].every((vp) => typeof sourcePaths[vp] === "string"),
      JSON.stringify(sourcePaths),
    );

    // List storage to confirm at least the first page's screenshots landed.
    const { data: listed } = await supabase.storage
      .from("site-screenshots")
      .list(`${buildId}/source/1280`);
    check(
      "site-screenshots bucket contains 1280 desktop captures",
      !!listed && listed.length > 0,
      `found ${listed?.length ?? 0}`,
    );
  }

  console.log(`[smoke] Inngest run trace: http://localhost:8288/runs (search buildId=${buildId})`);

  if (failed) {
    console.error("[smoke] one or more assertions failed");
    process.exit(1);
  }
  console.log("[smoke] all assertions passed");
}

main().catch((err) => {
  console.error("[smoke] unexpected error:", err);
  process.exit(1);
});
