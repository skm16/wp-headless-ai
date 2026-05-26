import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createDecipheriv } from "node:crypto";

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
  const base = data.wp_url.replace(/\/$/, "");

  // Step 1: flush
  const flushUrl = `${base}/wp-json/jab-debug/v1/flush-schema-cache?token=jab-debug-token-2026`;
  console.log(`POST ${flushUrl}`);
  const fr = await fetch(flushUrl, { method: "POST", headers: { Accept: "application/json" } });
  console.log(`flush HTTP ${fr.status}: ${await fr.text()}`);
  console.log();

  // Step 2: re-fetch manifest with cache-buster and check
  const pw = dec(data.wp_app_password_encrypted, process.env.JAB_ENCRYPTION_KEY!);
  const auth = "Basic " + Buffer.from(`${data.wp_username}:${pw}`).toString("base64");
  const url = `${base}/wp-json/jab/v1/manifest?_cb=${Date.now()}`;
  const r = await fetch(url, { headers: { Authorization: auth, Accept: "application/json", "Cache-Control": "no-cache" } });
  const j = await r.json() as { plugin_version?: string; generated_at?: string; abilities?: Array<{ name: string; output_schema?: unknown }> };
  console.log(`live plugin_version: ${j.plugin_version}`);
  console.log(`generated_at: ${j.generated_at}`);
  const beer = j.abilities?.find((a) => a.name === "jab/get-beer");
  if (beer) {
    const schemaStr = JSON.stringify(beer.output_schema);
    const enumCount = (schemaStr.match(/"enum"/g) ?? []).length;
    const xAcfCount = (schemaStr.match(/"x-acf-choices"/g) ?? []).length;
    console.log(`jab/get-beer schema length: ${schemaStr.length}`);
    console.log(`  enum occurrences: ${enumCount}`);
    console.log(`  x-acf-choices occurrences: ${xAcfCount}`);
    if (xAcfCount > 0 && enumCount < 30) console.log("  ✓ relaxed schema live");
    else console.log("  ✗ still strict — cache still hot or another code path");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
