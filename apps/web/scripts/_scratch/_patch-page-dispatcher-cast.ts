// Patch app/page.tsx and app/__catchall_slug__/page.tsx to cast the
// RenderableBlock passed into BlockDispatcher down to BlockNode (the
// dispatcher's prop type). Phase C/B contract mismatch: RenderableBlock's
// innerBlocks is optional, BlockNode's is required.
//
//   pnpm tsx scripts/_patch-page-dispatcher-cast.ts <buildId>

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
    console.error("Usage: pnpm tsx scripts/_patch-page-dispatcher-cast.ts <buildId>");
    process.exit(1);
  }
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const targets = [
    `builds/${buildId}/project/app/page.tsx`,
    `builds/${buildId}/project/app/__catchall_slug__/page.tsx`,
  ];
  for (const path of targets) {
    const { data, error } = await supabase.storage.from("site-screenshots").download(path);
    if (error || !data) {
      console.warn(`  ✗ ${path}: ${error?.message ?? "no data"}`);
      continue;
    }
    let src = await data.text();
    // Replace block={b} (no cast) with block={b as BlockNode}
    if (!/block=\{b\}/.test(src)) {
      console.log(`  - ${path}: no 'block={b}' found, skipping`);
      continue;
    }
    src = src.replace(/block=\{b\}/g, "block={b as BlockNode}");
    // Make sure BlockNode type is imported
    if (!/import\s+type\s*\{[^}]*\bBlockNode\b[^}]*\}\s+from\s+["']@\/lib\/sdk\/types["']/.test(src)) {
      src = `import type { BlockNode } from "@/lib/sdk/types";\n` + src;
    }
    const buf = Buffer.from(src, "utf8");
    const { error: upErr } = await supabase.storage
      .from("site-screenshots")
      .upload(path, buf, { contentType: "text/plain", upsert: true });
    if (upErr) {
      console.warn(`  ✗ ${path}: ${upErr.message}`);
      continue;
    }
    console.log(`  ✓ ${path}: cast added`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
