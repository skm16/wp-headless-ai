import { createClient } from "@supabase/supabase-js";
import { createDecipheriv } from "node:crypto";
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

function dec(value: unknown, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  if (typeof value !== "string" || !value.startsWith("\\x")) throw new Error("bad enc");
  const buf = Buffer.from(value.slice(2), "hex");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

async function main() {
  loadEnv();
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data } = await sb.from("projects").select("wp_url, wp_username, wp_app_password_encrypted").eq("id", process.argv[2]).single<{ wp_url: string; wp_username: string; wp_app_password_encrypted: unknown }>();
  if (!data) { console.error("no project"); process.exit(1); }
  const pw = dec(data.wp_app_password_encrypted, process.env.JAB_ENCRYPTION_KEY!);
  const auth = "Basic " + Buffer.from(`${data.wp_username}:${pw}`).toString("base64");
  const url = `${data.wp_url}/wp-json/jab/v1/manifest?_cb=${Date.now()}`;
  const r = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
  const j = await r.json() as { plugin_version?: string; abilities?: Array<{ name: string; category?: string }> };
  console.log(`plugin_version: ${j.plugin_version}`);
  console.log(`abilities (${j.abilities?.length ?? 0}):`);
  for (const a of j.abilities ?? []) {
    console.log(`  ${a.name}${a.category ? ` (${a.category})` : ""}`);
  }
  const target = "jab/get-beer-by-slug";
  const found = j.abilities?.some((a) => a.name === target);
  console.log(`\n"${target}" present: ${found ? "YES" : "NO"}`);
  // Print anything that contains 'beer'
  const beerish = (j.abilities ?? []).filter((a) => a.name.includes("beer"));
  console.log(`abilities matching /beer/: ${beerish.map((a) => a.name).join(", ") || "(none)"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
