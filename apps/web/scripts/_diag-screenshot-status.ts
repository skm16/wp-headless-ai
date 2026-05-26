import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
  const p = resolve(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    if (process.env[k] !== undefined) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
}

async function main() {
  loadEnv();
  const buildId = process.argv[2];
  if (!buildId) {
    console.error("usage: pnpm tsx scripts/_diag-screenshot-status.ts <buildId>");
    process.exit(1);
  }
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  const { data: pages, error } = await sb
    .from("page_inventory")
    .select("slug, post_type, source_screenshot_paths, block_count")
    .eq("site_build_id", buildId);
  if (error) { console.error(error); process.exit(1); }
  if (!pages) { console.error("no rows"); process.exit(1); }

  console.log(`build ${buildId} — ${pages.length} pages:\n`);
  const counts = { ok3: 0, partial: 0, none: 0 };
  for (const p of pages) {
    const src = (p.source_screenshot_paths as { source?: Record<string, string> } | null)?.source ?? {};
    const haves = ["375", "768", "1280"].filter((vp) => typeof src[vp] === "string");
    const status = haves.length === 3 ? "✓ ALL" : haves.length === 0 ? "✗ NONE" : `~ ${haves.length}/3`;
    if (haves.length === 3) counts.ok3++;
    else if (haves.length === 0) counts.none++;
    else counts.partial++;
    console.log(`  ${status}  blocks=${p.block_count}  ${p.post_type}/${p.slug}  [${haves.join(",") || "—"}]`);
  }
  console.log(`\nsummary: ${counts.ok3} fully captured, ${counts.partial} partial, ${counts.none} none captured`);

  // Storage bucket counts per viewport
  console.log(`\nstorage bucket: ${buildId}/source/`);
  for (const vp of ["375", "768", "1280"]) {
    const { data } = await sb.storage.from("site-screenshots").list(`${buildId}/source/${vp}`);
    console.log(`  ${vp}: ${data?.length ?? 0} files`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
