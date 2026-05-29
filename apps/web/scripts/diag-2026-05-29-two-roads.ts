// apps/web/scripts/diag-2026-05-29-two-roads.ts
//
// One-off diagnostic: download key emitted files for build 982f0d57 and
// print structural summaries. Supports plan
// docs/superpowers/plans/2026-05-29-two-roads-visual-fixes.md Phase 1.
//
//   cd apps/web
//   pnpm tsx scripts/diag-2026-05-29-two-roads.ts

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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

const BUILD_ID = "982f0d57-5275-499a-92d8-5f00dc70dba1";
const OUT_DIR = resolve(process.cwd(), "../../../tmp/two-roads-diag");

const FILES = [
  "next.config.ts",
  "tailwind.config.ts",
  "components/site/Header.tsx",
  "components/site/Footer.tsx",
  "styles/theme.css",
  "app/layout.tsx",
  "app/page.tsx",
];

async function main() {
  loadDotEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  // First, list block components.
  const { data: blockList, error: blockErr } = await sb.storage
    .from("site-screenshots")
    .list(`builds/${BUILD_ID}/project/components/blocks`, { limit: 100 });
  if (blockErr) {
    console.error("list(blocks) failed:", blockErr.message);
  } else {
    console.error(`\n=== blocks dir ===`);
    for (const b of blockList ?? []) {
      console.error(`  ${b.name}`);
    }
  }

  for (const rel of FILES) {
    const path = `builds/${BUILD_ID}/project/${rel}`;
    const { data, error } = await sb.storage.from("site-screenshots").download(path);
    if (error || !data) {
      console.error(`MISSING ${rel}: ${error?.message ?? "no data"}`);
      continue;
    }
    const contents = await data.text();
    console.error(`\n=== ${rel} (${contents.length} chars) ===`);
    // Print first 60 lines.
    const lines = contents.split(/\r?\n/);
    for (let i = 0; i < Math.min(lines.length, 60); i++) {
      console.error(`  ${(i + 1).toString().padStart(3)}: ${lines[i]}`);
    }
    if (lines.length > 60) console.error(`  ... (+${lines.length - 60} more lines)`);
    // Save full file for offline inspection.
    const safeRel = rel.replace(/[/\\]/g, "__");
    writeFileSync(resolve(OUT_DIR, safeRel), contents, "utf8");
  }

  // Pull each block component as well.
  for (const b of blockList ?? []) {
    const path = `builds/${BUILD_ID}/project/components/blocks/${b.name}`;
    const { data, error } = await sb.storage.from("site-screenshots").download(path);
    if (error || !data) continue;
    const contents = await data.text();
    writeFileSync(resolve(OUT_DIR, `blocks__${b.name}`), contents, "utf8");
  }

  console.error(`\nFull files saved to: ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
