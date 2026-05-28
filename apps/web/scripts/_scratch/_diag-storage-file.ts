// Quick file reader. Usage: pnpm tsx scripts/_diag-storage-file.ts <storagePath>
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
function loadDotEnvLocal() {
  const p = resolve(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
async function main() {
  loadDotEnvLocal();
  const [, , path] = process.argv;
  if (!path) { console.error("Usage: pnpm tsx scripts/_diag-storage-file.ts <storagePath>"); process.exit(1); }
  const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data, error } = await s.storage.from("site-screenshots").download(path);
  if (error || !data) { console.error("error:", error?.message); process.exit(1); }
  console.log(await data.text());
}
main().catch((e) => { console.error(e); process.exit(1); });
