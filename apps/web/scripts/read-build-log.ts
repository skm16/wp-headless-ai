// apps/web/scripts/read-build-log.ts
//
// Downloads a failed build's log from Storage and prints to stdout.
//   cd apps/web
//   pnpm tsx scripts/read-build-log.ts <buildId>
//
// Path resolution (in order):
//   1. site_builds.build_log_storage_path — set by deploy-site.ts on a
//      Phase D Vercel failure and by compile-generated-project.ts on a
//      Phase C tsc failure. Either path may be present, so trusting the
//      DB lets one tool triage either phase's failures.
//   2. Legacy default: builds/<id>/build-log.txt — for old Phase D builds
//      written before the build_log_storage_path column shipped.

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function main() {
  loadDotEnvLocal();

  const [, , buildId] = process.argv;
  if (!buildId) {
    console.error("Usage: pnpm tsx scripts/read-build-log.ts <buildId>");
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // Resolve the log path: prefer the DB-recorded value, fall back to the
  // legacy hardcoded path for builds predating the build_log_storage_path
  // column. A null/missing field is normal (not an error) — the row may
  // exist for a build that hasn't failed yet, or for a deploy that failed
  // before the on-failure update ran.
  const { data: row, error: rowError } = await supabase
    .from("site_builds")
    .select("build_log_storage_path")
    .eq("id", buildId)
    .maybeSingle();
  if (rowError) {
    console.error(`Failed to query site_builds for ${buildId}: ${rowError.message}`);
    process.exit(1);
  }

  const recordedPath = (row?.build_log_storage_path as string | null | undefined) ?? null;
  const path = recordedPath ?? `builds/${buildId}/build-log.txt`;
  console.error(
    `[read-build-log] reading ${path} (${recordedPath ? "from site_builds.build_log_storage_path" : "legacy default — no DB-recorded path"})`,
  );

  const { data, error } = await supabase.storage.from("site-screenshots").download(path);
  if (error || !data) {
    console.error(`Failed to read ${path}: ${error?.message ?? "no data"}`);
    process.exit(1);
  }
  console.log(await data.text());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
