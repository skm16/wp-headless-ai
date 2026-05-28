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
  const cb = Date.now();
  const url = `${data.wp_url}/wp-json/jab/v1/manifest?_cb=${cb}`;
  const r = await fetch(url, { headers: { Authorization: auth, Accept: "application/json", "Cache-Control": "no-cache", Pragma: "no-cache" } });
  const j = await r.json() as { plugin_version?: string; generated_at?: string; abilities?: Array<{ name: string; output_schema?: unknown }> };
  console.log(`url: ${url}`);
  console.log(`response headers:`);
  for (const [k, v] of r.headers.entries()) {
    if (/^(age|cache-control|x-cache|cf-cache-status|server|x-wp-engine|via|x-served-by)/i.test(k)) {
      console.log(`  ${k}: ${v}`);
    }
  }
  console.log(`live plugin_version: ${j.plugin_version}`);
  console.log(`generated_at: ${j.generated_at}`);
  // Pick the jab/get-beer ability and look for enum/format in its output_schema
  const beer = j.abilities?.find((a) => a.name === "jab/get-beer");
  if (beer) {
    const schemaStr = JSON.stringify(beer.output_schema);
    console.log(`jab/get-beer schema length: ${schemaStr.length}`);
    const enumCount = (schemaStr.match(/"enum"/g) ?? []).length;
    const formatCount = (schemaStr.match(/"format"\s*:\s*"(uri|email|date|date-time)"/g) ?? []).length;
    const xAcfCount = (schemaStr.match(/"x-acf-choices"/g) ?? []).length;
    console.log(`  enum occurrences: ${enumCount}`);
    console.log(`  format(uri/email/date/date-time) occurrences: ${formatCount}`);
    console.log(`  x-acf-choices occurrences: ${xAcfCount}`);
    if (xAcfCount > 0) console.log("  ✓ v0.6.1 — schema relaxed");
    else if (enumCount > 0 || formatCount > 0) console.log("  ✗ v0.6.0 still live — schema strict");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
