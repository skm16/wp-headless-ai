// apps/web/scripts/smoke-build.ts
//
// End-to-end smoke runner for the full Phase A → E pipeline. Inserts a
// site_builds row, dispatches site/discover.requested, and polls until
// the build reaches `ready` (success) or `failed` (fail). With
// JAB_GENERATE_MOCK=1 the per-component LLM calls return canned TSX so
// the full chain completes in a couple of minutes without burning real
// Anthropic spend.
//
// Usage:
//   cd apps/web
//   pnpm tsx scripts/smoke-build.ts <projectId> <tenantId>
//
// Prereqs:
//   - Inngest dev server running (`npx inngest-cli@latest dev`)
//   - Next dev running (`pnpm dev` in apps/web) for /api/inngest webhook
//   - SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL in env
//   - VERCEL_TOKEN + VERCEL_TEAM_ID for the Phase D deploy step
//   - Project is in status='ready' with credentials + manifest
//
// Exit codes:
//   0 — build reached 'ready'
//   1 — build failed or smoke timed out
//
// Pattern follows smoke-discover-site.ts: self-contained, inlines
// supabase + Inngest client construction (avoids `server-only` imports).
import { createClient } from "@supabase/supabase-js";
import { Inngest } from "inngest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { findNonZeroSpend } from "./lib/zero-spend";

const POLL_INTERVAL_MS = 8_000;
// Generous budget: discover (~3min on mock), components (~30s mock),
// compose (~30s), deploy (~3min Vercel real), verify (~1min). Pad x2.
const TIMEOUT_MS = 20 * 60 * 1000;

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
    console.error(
      "Usage: pnpm tsx scripts/smoke-build.ts <projectId> <tenantId>",
    );
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error(
      "[smoke:build] missing env: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY",
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const inngest = new Inngest({
    id: "jab-saas",
    isDev: true,
    baseUrl: process.env.INNGEST_DEV_SERVER_URL ?? "http://localhost:8288",
    eventKey: "dev",
  });

  console.log(
    `[smoke:build] kicking off full pipeline for project=${projectId} tenant=${tenantId}`,
  );
  if (process.env.JAB_GENERATE_MOCK !== "1") {
    console.warn(
      "[smoke:build] JAB_GENERATE_MOCK is not set — every component-generation call will hit Anthropic. Set JAB_GENERATE_MOCK=1 in .env.local to mock.",
    );
  }

  // Refuse if there's an active build already (mirrors the action's guard).
  const { data: active } = await supabase
    .from("site_builds")
    .select("id, status")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1);
  const latest = (active ?? [])[0] as { id: string; status: string } | undefined;
  const ACTIVE_PHASES = new Set([
    "queued",
    "discovering",
    "components",
    "composing",
    "building",
    "verifying",
  ]);
  if (latest && ACTIVE_PHASES.has(latest.status)) {
    console.error(
      `[smoke:build] active build exists: ${latest.id} (status=${latest.status}). Wait or cancel before retrying.`,
    );
    process.exit(1);
  }

  // Insert build row. config={mode:'full'} mirrors triggerBuildAction.
  const { data: build, error: insertErr } = await supabase
    .from("site_builds")
    .insert({
      project_id: projectId,
      status: "queued",
      config: { mode: "full" },
    })
    .select("id")
    .single<{ id: string }>();
  if (insertErr || !build) {
    console.error(
      `[smoke:build] site_builds insert failed: ${insertErr?.message ?? "no row returned"}`,
    );
    process.exit(1);
  }
  const buildId = build.id;
  console.log(`[smoke:build] buildId=${buildId}`);

  await inngest.send({
    name: "site/discover.requested",
    data: {
      projectId,
      tenantId,
      buildId,
      maxPages: Number(process.env.SMOKE_MAX_PAGES ?? "15") || 15,
    },
  });

  const start = Date.now();
  let lastStatus = "queued";
  while (Date.now() - start < TIMEOUT_MS) {
    const { data, error } = await supabase
      .from("site_builds")
      .select(
        "status, failed_phase, error_text, page_count, block_type_count, component_count, fidelity_avg, preview_url",
      )
      .eq("id", buildId)
      .single<{
        status: string;
        failed_phase: string | null;
        error_text: string | null;
        page_count: number | null;
        block_type_count: number | null;
        component_count: number | null;
        fidelity_avg: string | null;
        preview_url: string | null;
      }>();
    if (error) {
      console.error(`[smoke:build] poll error: ${error.message}`);
      process.exit(1);
    }
    if (data.status !== lastStatus) {
      console.log(
        `[smoke:build] t=${Math.round((Date.now() - start) / 1000)}s status=${data.status}`,
      );
      lastStatus = data.status;
    }
    if (data.status === "ready") {
      console.log(
        `[smoke:build] PASS — ready in ${Math.round(
          (Date.now() - start) / 1000,
        )}s; preview=${data.preview_url} fidelity=${data.fidelity_avg ?? "n/a"} pages=${data.page_count} blocks=${data.block_type_count} components=${data.component_count}`,
      );
      // Mock-mode invariant: verify "Cost: $0" against block_inventory AND
      // shell_generations telemetry. The worker's env (not this script's)
      // controls MockModelClient, so the DB is the only trustworthy signal.
      if (process.env.JAB_GENERATE_MOCK === "1") {
        const [{ data: blockRows, error: blockErr }, { data: shellRows, error: shellErr }] =
          await Promise.all([
            supabase
              .from("block_inventory")
              .select(
                "block_name, input_tokens_cached, input_tokens_uncached, input_tokens_cache_creation, output_tokens",
              )
              .eq("site_build_id", buildId)
              .eq("project_id", projectId),
            supabase
              .from("shell_generations")
              .select(
                "shell_kind, input_tokens_cached, input_tokens_uncached, input_tokens_cache_creation, output_tokens",
              )
              .eq("site_build_id", buildId),
          ]);
        if (blockErr || shellErr) {
          console.error(
            `[smoke:build] FAIL: zero-spend verification query failed: ${blockErr?.message ?? shellErr?.message}`,
          );
          process.exit(1);
        }
        const nonZero = findNonZeroSpend([
          ...(blockRows ?? []).map((r) => ({
            label: `block_inventory:${r.block_name}`,
            tokens: [
              r.input_tokens_cached,
              r.input_tokens_uncached,
              r.input_tokens_cache_creation,
              r.output_tokens,
            ] as Array<number | null>,
          })),
          ...(shellRows ?? []).map((r) => ({
            label: `shell_generations:${r.shell_kind}`,
            tokens: [
              r.input_tokens_cached,
              r.input_tokens_uncached,
              r.input_tokens_cache_creation,
              r.output_tokens,
            ] as Array<number | null>,
          })),
        ]);
        if (nonZero.length > 0) {
          console.error("[smoke:build] FAIL: mock run recorded real token spend:");
          nonZero.forEach((r) => console.error(`  - ${r.label}: tokens=${JSON.stringify(r.tokens)}`));
          console.error(
            "[smoke:build] The WORKER process is live. Restart `pnpm dev` after setting JAB_GENERATE_MOCK=1 in .env.local.",
          );
          process.exit(1);
        }
        console.log("[smoke:build] verified Cost: $0 — block_inventory + shell_generations token columns all zero/null.");
      }
      process.exit(0);
    }
    if (data.status === "failed") {
      console.error(
        `[smoke:build] FAIL — phase=${data.failed_phase} error=${data.error_text}`,
      );
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.error(
    `[smoke:build] FAIL — timed out after ${TIMEOUT_MS / 1000}s; last status=${lastStatus}`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("[smoke:build] fatal:", err);
  process.exit(1);
});
