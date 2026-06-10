// apps/web/scripts/jab-sniff-logo.ts
// One-off: sniff the magic bytes + size of the logo at each pipeline stage to
// localize where a binary PNG is being corrupted by UTF-8 text round-tripping.
//   1. SOURCE   project-assets/<logo_storage_path>            (onboarding capture)
//   2. BUNDLED  site-screenshots/builds/<id>/project/public/logo.png (compose bundle-logo)
// Usage (from apps/web): pnpm tsx scripts/jab-sniff-logo.ts <buildId> <logoStoragePath>

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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

function describe(buf: Uint8Array): { kind: string; magic: string; size: number; corruptUtf8: boolean } {
  const magic = Array.from(buf.slice(0, 12)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
  let kind = "unknown";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) kind = "PNG (valid)";
  else if (buf[0] === 0xff && buf[1] === 0xd8) kind = "JPEG (valid)";
  // UTF-8 corruption: 0x89 high byte became EF BF BD (U+FFFD) then "PNG"
  const corruptUtf8 =
    buf[0] === 0xef && buf[1] === 0xbf && buf[2] === 0xbd && buf[3] === 0x50 && buf[4] === 0x4e && buf[5] === 0x47;
  if (corruptUtf8) kind = "PNG but UTF-8-CORRUPTED (0x89 -> EF BF BD)";
  return { kind, magic, size: buf.length, corruptUtf8 };
}

async function main(): Promise<void> {
  loadDotEnvLocal();
  const buildId = process.argv[2];
  const logoPath = process.argv[3];
  if (!buildId || !logoPath) throw new Error("usage: jab-sniff-logo.ts <buildId> <logoStoragePath>");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("missing supabase env");
  const sb = createClient(url, key);

  async function sniff(bucket: string, path: string): Promise<void> {
    const { data, error } = await sb.storage.from(bucket).download(path);
    if (error || !data) {
      console.log(`${bucket}/${path}\n  -> download failed: ${error?.message ?? "no data"}`);
      return;
    }
    const buf = new Uint8Array(await data.arrayBuffer());
    const d = describe(buf);
    console.log(`${bucket}/${path}\n  kind=${d.kind}\n  size=${d.size}\n  magic=${d.magic}\n`);
  }

  console.log("--- SOURCE (project-assets, captured at onboarding) ---");
  await sniff("project-assets", logoPath);
  console.log("--- BUNDLED (site-screenshots, written by compose bundle-logo) ---");
  await sniff("site-screenshots", `builds/${buildId}/project/public/logo.png`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
