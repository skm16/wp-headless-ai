// apps/web/scripts/jab-check-artifacts.ts
//
// One-off operator check: download a build's composed layout.tsx + Header.tsx
// from Storage and report whether the tier-2 fixes emitted correctly:
//   - layout.tsx carries the Google Fonts <link> tags
//   - Header.tsx references a LOCAL /logo.<ext> src (not a project-assets path)
//
// Usage (from apps/web):  pnpm tsx scripts/jab-check-artifacts.ts <buildId>

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const BUCKET = "site-screenshots";

function loadDotEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[key] = v;
  }
}

async function main(): Promise<void> {
  loadDotEnvLocal();
  const buildId = process.argv[2];
  if (!buildId) throw new Error("usage: jab-check-artifacts.ts <buildId>");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  const sb = createClient(url, key);
  const base = `builds/${buildId}/project`;

  async function read(rel: string): Promise<string> {
    const { data, error } = await sb.storage.from(BUCKET).download(`${base}/${rel}`);
    if (error || !data) throw new Error(`download ${rel} failed: ${error?.message ?? "no data"}`);
    return await data.text();
  }

  const layout = await read("app/layout.tsx");
  const header = await read("components/site/Header.tsx");

  console.log("=== layout.tsx ===");
  console.log(layout);

  const fontLinks = layout.match(/<link[^>]*fonts\.googleapis\.com[^>]*>/g) ?? [];
  const preconnects = layout.match(/<link rel="preconnect"[^>]*>/g) ?? [];
  console.log(`\n>> font stylesheet links: ${fontLinks.length}`);
  fontLinks.forEach((l) => console.log(`   ${l}`));
  console.log(`>> preconnect links: ${preconnects.length}`);

  console.log("\n=== Header.tsx — logo / src references ===");
  header
    .split(/\r?\n/)
    .filter((l) => /logo|src\s*=|Image/i.test(l))
    .forEach((l) => console.log(`   ${l.trim()}`));
  const localLogo = /["'`]\/logo\.[a-z0-9]+["'`]/i.test(header);
  const storageLogo = /projects\/[0-9a-f-]+\/logo/i.test(header);
  console.log(`\n>> Header references local /logo.<ext>: ${localLogo}`);
  console.log(`>> Header still references a project-assets storage path: ${storageLogo}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
