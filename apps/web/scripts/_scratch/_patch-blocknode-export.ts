// apps/web/scripts/_patch-blocknode-export.ts
//
// Append BlockNode interface to lib/sdk/types.ts. Phase C's
// substituteBlockNodeImport rewrites BlockNode imports to "@/lib/sdk/types"
// but @jab/core emitSdk doesn't include BlockNode there — surfaces as
// "Module '@/lib/sdk/types' has no exported member 'BlockNode'" once tsc
// reaches a component file.
//
//   pnpm tsx scripts/_patch-blocknode-export.ts <buildId>

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const BLOCKNODE_DECL = `
export interface BlockNode {
  blockName: string | null;
  attrs: Record<string, unknown>;
  innerHTML: string;
  innerContent: (string | null)[];
  innerBlocks: BlockNode[];
}
`;

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
    console.error("Usage: pnpm tsx scripts/_patch-blocknode-export.ts <buildId>");
    process.exit(1);
  }
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const path = `builds/${buildId}/project/lib/sdk/types.ts`;
  const { data, error } = await supabase.storage.from("site-screenshots").download(path);
  if (error || !data) {
    console.error(`download failed: ${error?.message}`);
    process.exit(1);
  }
  const src = await data.text();
  if (/^export\s+interface\s+BlockNode\b/m.test(src)) {
    console.log("BlockNode already exported — nothing to do.");
    return;
  }
  const appended = src.trimEnd() + "\n" + BLOCKNODE_DECL;
  const buf = Buffer.from(appended, "utf8");
  const { error: upErr } = await supabase.storage
    .from("site-screenshots")
    .upload(path, buf, { contentType: "text/plain", upsert: true });
  if (upErr) {
    console.error(`upload failed: ${upErr.message}`);
    process.exit(1);
  }
  console.log(`✓ appended BlockNode to ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
