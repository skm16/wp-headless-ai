// apps/web/scripts/snapshot-build-components.ts
//
// One-shot snapshot of all Phase B component .tsx files for a given buildId,
// downloaded from Supabase Storage to a timestamped local directory. Use to
// take a baseline before re-running Phase B and compare against the post-rerun
// snapshot.
//
// Run with:
//   cd apps/web
//   pnpm tsx scripts/snapshot-build-components.ts <buildId> [outputDir]
//
// Default outputDir is `C:\tmp\jab-component-snapshots\<buildId>-<YYYYMMDD-HHMMSS>\`
// (outside the repo to avoid accidental commits).
//
// Prereqs:
//   - SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL in .env.local
//
// Self-contained: does not import `@/lib/*` (those carry server-only markers
// that throw under tsx). Same pattern as the smoke-* scripts.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

const BUCKET = "site-screenshots";

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

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function main() {
  loadDotEnvLocal();

  const [, , buildId, outputDirArg] = process.argv;
  if (!buildId) {
    console.error("Usage: pnpm tsx scripts/snapshot-build-components.ts <buildId> [outputDir]");
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
    process.exit(1);
  }

  const outDir =
    outputDirArg ?? `C:\\tmp\\jab-component-snapshots\\${buildId}-${timestamp()}`;
  mkdirSync(outDir, { recursive: true });
  console.log(`[snapshot] target: ${outDir}`);

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // List every object under builds/<buildId>/components/.
  const prefix = `builds/${buildId}/components`;
  const { data: files, error: listErr } = await supabase.storage
    .from(BUCKET)
    .list(prefix, { limit: 1000 });
  if (listErr) {
    console.error(`[snapshot] list failed: ${listErr.message}`);
    process.exit(1);
  }
  if (!files || files.length === 0) {
    console.warn(`[snapshot] no component files found under ${prefix}`);
    process.exit(0);
  }

  console.log(`[snapshot] downloading ${files.length} files…`);
  let downloaded = 0;
  let totalBytes = 0;
  const manifest: Array<{ name: string; bytes: number }> = [];

  for (const file of files) {
    const path = `${prefix}/${file.name}`;
    const { data, error } = await supabase.storage.from(BUCKET).download(path);
    if (error || !data) {
      console.warn(`[snapshot] ${file.name}: download failed (${error?.message ?? "no data"}) — skipping`);
      continue;
    }
    const buf = Buffer.from(await data.arrayBuffer());
    const dest = join(outDir, file.name);
    writeFileSync(dest, buf);
    downloaded++;
    totalBytes += buf.byteLength;
    manifest.push({ name: file.name, bytes: buf.byteLength });
  }

  manifest.sort((a, b) => a.name.localeCompare(b.name));
  const manifestPath = join(outDir, "_MANIFEST.json");
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        buildId,
        downloadedAt: new Date().toISOString(),
        fileCount: downloaded,
        totalBytes,
        files: manifest,
      },
      null,
      2,
    ),
  );

  console.log(`[snapshot] done. ${downloaded} files, ${totalBytes} bytes total.`);
  console.log(`[snapshot] manifest: ${manifestPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
