// Quick recursive lister for a Storage prefix.
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
async function listRecursive(s: any, bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  const { data, error } = await s.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error) throw new Error(error.message);
  for (const item of data ?? []) {
    if (item.id === null) {
      out.push(...await listRecursive(s, bucket, `${prefix}${item.name}/`));
    } else out.push(`${prefix}${item.name}`);
  }
  return out;
}
async function main() {
  loadDotEnvLocal();
  const [, , prefix] = process.argv;
  if (!prefix) { console.error("Usage: pnpm tsx scripts/_diag-storage-list.ts <prefix>"); process.exit(1); }
  const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const paths = await listRecursive(s, "site-screenshots", prefix);
  for (const p of paths) console.log(p);
}
main().catch((e) => { console.error(e); process.exit(1); });
