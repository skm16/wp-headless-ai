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
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data } = await sb.from("projects").select("wp_url").eq("id", process.argv[2]).single<{ wp_url: string }>();
  if (!data) { console.error("no project"); process.exit(1); }
  const base = data.wp_url.replace(/\/$/, "");
  const url = `${base}/wp-json/jab-debug/v1/schema-source?token=jab-debug-token-2026&_cb=${Date.now()}`;
  console.log(`GET ${url}\n`);
  const r = await fetch(url, { headers: { Accept: "application/json", "Cache-Control": "no-cache" } });
  console.log(`HTTP ${r.status}`);
  const text = await r.text();
  try {
    const j = JSON.parse(text);
    console.log(JSON.stringify(j, null, 2));
  } catch {
    console.log(text.slice(0, 2000));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
