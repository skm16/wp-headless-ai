// apps/web/scripts/smoke-discover-site.ts
//
// Manual smoke runner for Phase A discovery. Run with:
//   pnpm tsx apps/web/scripts/smoke-discover-site.ts <projectId> <tenantId>
//
// Prereqs:
//   - Inngest dev server running (`npx inngest-cli@latest dev`)
//   - Next dev running (`pnpm dev` in apps/web), since Inngest invokes the
//     /api/inngest webhook to dispatch functions
//   - The given projectId is connected to the Two Roads WP install
//   - SUPABASE_SERVICE_ROLE_KEY env set
//   - NEXT_PUBLIC_SUPABASE_URL env set
//
// Exit codes:
//   0 — smoke passed all assertions
//   1 — smoke failed an assertion or timed out
import { triggerDiscovery } from "@/lib/actions/trigger-discovery";
import { createAdminClient } from "@/lib/supabase/admin";

const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 2 * 60 * 1000; // 2 minute success-criteria budget

async function main(): Promise<void> {
  const [projectId, tenantId] = process.argv.slice(2);
  if (!projectId || !tenantId) {
    console.error("Usage: tsx smoke-discover-site.ts <projectId> <tenantId>");
    process.exit(1);
  }

  console.log(`[smoke] triggering discovery for project=${projectId} tenant=${tenantId}`);
  const { buildId } = await triggerDiscovery({ projectId, tenantId });
  console.log(`[smoke] buildId=${buildId}`);

  const supabase = createAdminClient();
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
