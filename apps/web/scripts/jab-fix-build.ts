// apps/web/scripts/jab-fix-build.ts
//
// One-off operator tool to hand-patch a build's Phase-B SOURCE components in
// Storage and resume the pipeline at compose — WITHOUT re-running the
// expensive discover + generate phases.
//
// IMPORTANT: compose READS each block component from the Phase-B source path
//   builds/<id>/components/<Name>.tsx          (COMPONENT_PATH / buildComponentStoragePath)
// runs rewriteBlockNodeImports, and WRITES the result to
//   builds/<id>/project/components/blocks/<Name>.tsx   (the composed tree)
// and it also re-emits tsconfig.json from a code template. So patching the
// project/ tree (or tsconfig) does nothing — compose overwrites it. We must
// patch the SOURCE components.
//
//   download: pull every SOURCE component named in the build's compile-log
//             (mapping components/blocks/X.tsx → components/X.tsx) into
//             apps/web/.jab-fix-src/<buildId>/components/X.tsx. Edit locally, then:
//   resume:   re-upload everything under .jab-fix-src/<buildId>/ to
//             builds/<buildId>/<relpath> and dispatch site/compose.requested.
//
// Usage (from apps/web):
//   pnpm tsx scripts/jab-fix-build.ts download <buildId>
//   pnpm tsx scripts/jab-fix-build.ts resume   <buildId> <projectId> <tenantId>

import { createClient } from "@supabase/supabase-js";
import { Inngest } from "inngest";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve, dirname, join, relative } from "node:path";

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function fixRoot(buildId: string): string {
  return resolve(process.cwd(), ".jab-fix-src", buildId);
}

/**
 * Parse `components/blocks/File.tsx(line,col): error ...` from the compile log
 * → unique SOURCE-relative paths `components/File.tsx`. The compile log names
 * the composed-tree path (components/blocks/X.tsx); the source is one level up
 * (components/X.tsx). Non-component errors (lib/, app/) are reported but not
 * auto-collected — they need a different fix.
 */
function parseCompileLog(log: string): { sources: string[]; others: string[] } {
  const sources = new Set<string>();
  const others = new Set<string>();
  for (const line of log.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_./-]+\.tsx?)\(\d+,\d+\):/);
    if (!m) continue;
    const p = m[1].replace(/\\/g, "/");
    const blocks = p.match(/^components\/blocks\/(.+\.tsx)$/);
    if (blocks) sources.add(`components/${blocks[1]}`);
    else others.add(p);
  }
  return { sources: [...sources], others: [...others] };
}

async function download(buildId: string) {
  const supabase = supa();
  const { data: row } = await supabase
    .from("site_builds")
    .select("build_log_storage_path")
    .eq("id", buildId)
    .maybeSingle<{ build_log_storage_path: string | null }>();
  const logPath = row?.build_log_storage_path ?? `builds/${buildId}/compile-log.txt`;
  const { data: logBlob, error: logErr } = await supabase.storage.from(BUCKET).download(logPath);
  if (logErr || !logBlob) {
    console.error(`Failed to read compile log at ${logPath}: ${logErr?.message ?? "no data"}`);
    process.exit(1);
  }
  const log = await logBlob.text();
  const { sources, others } = parseCompileLog(log);
  if (others.length) {
    console.warn(`[jab-fix] NON-component errors (need manual handling, not downloaded):`);
    others.forEach((o) => console.warn(`    ${o}`));
  }

  const root = fixRoot(buildId);
  console.log(`[jab-fix] downloading ${sources.length} SOURCE component(s) → ${root}`);
  for (const rel of sources) {
    const storagePath = `builds/${buildId}/${rel}`;
    const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
    if (error || !data) {
      console.warn(`  ! skip ${rel}: ${error?.message ?? "no data"} (path ${storagePath})`);
      continue;
    }
    const localPath = join(root, rel);
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, await data.text(), "utf8");
    console.log(`  ✓ ${rel}`);
  }
  console.log(`\n[jab-fix] edit the files under ${root}, then run:`);
  console.log(`  pnpm tsx scripts/jab-fix-build.ts resume ${buildId} <projectId> <tenantId>`);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

async function resume(buildId: string, projectId: string, tenantId: string) {
  const supabase = supa();
  const root = fixRoot(buildId);
  if (!existsSync(root)) {
    console.error(`No local edits at ${root} — run the download mode first.`);
    process.exit(1);
  }
  const files = walk(root);
  console.log(`[jab-fix] re-uploading ${files.length} SOURCE file(s) from ${root}`);
  for (const localPath of files) {
    const rel = relative(root, localPath).replace(/\\/g, "/");
    const storagePath = `builds/${buildId}/${rel}`;
    const body = readFileSync(localPath, "utf8");
    // text/plain with NO charset suffix — Storage MIME allowlist gotcha
    // (mirrors persist-generation.ts).
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, body, { contentType: "text/plain", upsert: true });
    if (error) {
      console.error(`  ! failed ${rel}: ${error.message}`);
      process.exit(1);
    }
    console.log(`  ✓ ${rel}  → ${storagePath}`);
  }

  const inngest = new Inngest({
    id: "jab-fix-build",
    eventKey: process.env.INNGEST_EVENT_KEY ?? "local-dev-key",
    baseUrl: process.env.INNGEST_BASE_URL ?? "http://localhost:8288",
    isDev: true,
  });
  console.log(`[jab-fix] dispatching site/compose.requested for build ${buildId}…`);
  await inngest.send({
    name: "site/compose.requested",
    data: { projectId, tenantId, buildId },
  });
  console.log("[jab-fix] dispatched. Watch the Inngest dashboard + site_builds.status.");
}

async function main() {
  loadDotEnvLocal();
  const [, , mode, buildId, projectId, tenantId] = process.argv;
  if (mode === "download" && buildId) {
    await download(buildId);
  } else if (mode === "resume" && buildId && projectId && tenantId) {
    await resume(buildId, projectId, tenantId);
  } else {
    console.error(
      "Usage:\n" +
        "  pnpm tsx scripts/jab-fix-build.ts download <buildId>\n" +
        "  pnpm tsx scripts/jab-fix-build.ts resume <buildId> <projectId> <tenantId>",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
