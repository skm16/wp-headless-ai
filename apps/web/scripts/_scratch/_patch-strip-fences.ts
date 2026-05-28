// apps/web/scripts/_patch-strip-fences.ts
//
// Strip markdown code fences from .tsx files under a build's project tree.
// Phase B's stripCodeFences regex only matches `tsx|ts|jsx|js` language tags,
// missing `typescript`/`javascript`/no-tag. Live Two Roads smoke surfaced
// CoreParagraph.tsx with literal ```typescript fences. This patcher removes
// any line that is purely a fence (with optional language tag).
//
//   pnpm tsx scripts/_patch-strip-fences.ts <buildId>

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const FENCE_LINE = /^\s*```[A-Za-z0-9_-]*\s*$/;

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

async function listRecursive(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const out: string[] = [];
  const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error) throw new Error(`list ${prefix}: ${error.message}`);
  for (const item of data ?? []) {
    if (item.id === null) {
      out.push(...(await listRecursive(supabase, bucket, `${prefix}${item.name}/`)));
    } else {
      out.push(`${prefix}${item.name}`);
    }
  }
  return out;
}

function stripFences(src: string): string {
  const lines = src.split(/\r?\n/);
  const out = lines.filter((l) => !FENCE_LINE.test(l));
  return out.join("\n");
}

async function main() {
  loadDotEnvLocal();
  const [, , buildId] = process.argv;
  if (!buildId) {
    console.error("Usage: pnpm tsx scripts/_patch-strip-fences.ts <buildId>");
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing supabase env vars");
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const prefix = `builds/${buildId}/project/`;
  const all = await listRecursive(supabase, "site-screenshots", prefix);
  const tsxPaths = all.filter((p) => p.endsWith(".tsx") || p.endsWith(".ts"));
  console.log(`Scanning ${tsxPaths.length} .ts/.tsx files…`);

  let patched = 0;
  for (const path of tsxPaths) {
    const { data, error } = await supabase.storage.from("site-screenshots").download(path);
    if (error || !data) continue;
    const src = await data.text();
    if (!FENCE_LINE.test(src.split(/\r?\n/)[0] ?? "") && !src.split(/\r?\n/).some((l) => FENCE_LINE.test(l))) {
      continue;
    }
    const stripped = stripFences(src);
    if (stripped === src) continue;
    const buf = Buffer.from(stripped, "utf8");
    const { error: upErr } = await supabase.storage
      .from("site-screenshots")
      .upload(path, buf, { contentType: "text/plain", upsert: true });
    if (upErr) {
      console.warn(`  ✗ ${path}: upload failed: ${upErr.message}`);
      continue;
    }
    patched++;
    console.log(`  ✓ ${path.slice(prefix.length)}`);
  }
  console.log(`Stripped fences from ${patched} file(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
