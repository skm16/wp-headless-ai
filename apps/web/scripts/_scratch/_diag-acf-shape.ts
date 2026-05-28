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

/**
 * Walks an ACF data object, finds every array containing items with an
 * `acf_fc_layout` discriminator (ACF Flexible Content layouts), and counts
 * how many of each layout name appear. Returns the layout-name → count map.
 */
function walkAndCountFlexLayouts(node: unknown, counts: Record<string, number>, path: string = ""): Record<string, number> {
  if (Array.isArray(node)) {
    for (const item of node) walkAndCountFlexLayouts(item, counts, path);
    return counts;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.acf_fc_layout === "string") {
      const key = `${path || "(root)"} → ${obj.acf_fc_layout}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === "acf_fc_layout") continue;
      walkAndCountFlexLayouts(v, counts, path ? `${path}.${k}` : k);
    }
  }
  return counts;
}

async function main() {
  loadEnv();
  const projectId = process.argv[2];
  const abilityName = process.argv[3] ?? "jab/get-beer-by-slug";
  const slug = process.argv[4] ?? "winter-heaven";
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data } = await sb.from("projects").select("wp_url, wp_username, wp_app_password_encrypted").eq("id", projectId).single<{ wp_url: string; wp_username: string; wp_app_password_encrypted: unknown }>();
  if (!data) { console.error("no project"); process.exit(1); }
  const pw = dec(data.wp_app_password_encrypted, process.env.JAB_ENCRYPTION_KEY!);
  const auth = "Basic " + Buffer.from(`${data.wp_username}:${pw}`).toString("base64");

  // Match the working McpClient route: /wp-json/{namespace}/{serverRoute}
  // = /wp-json/mcp/mcp-adapter-default-server. The wrong path /mcp/v1/mcp
  // 404s and the server doesn't return an Mcp-Session-Id header.
  const mcpUrl = `${data.wp_url.replace(/\/$/, "")}/wp-json/mcp/mcp-adapter-default-server`;
  // Init session
  const initResp = await fetch(mcpUrl, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "diag", version: "0" } } }),
  });
  const sessionId = initResp.headers.get("mcp-session-id") ?? initResp.headers.get("Mcp-Session-Id");
  if (!sessionId) { console.error("no session"); process.exit(1); }
  await fetch(mcpUrl, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  console.log(`Calling ${abilityName} slug="${slug}"...\n`);
  const r = await fetch(mcpUrl, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "mcp-adapter-execute-ability",
        arguments: {
          ability_name: abilityName,
          parameters: { slug, include: { blocks: true } },
        },
      },
    }),
  });
  const text = await r.text();
  // Response may be JSON or SSE; extract the JSON body.
  const lines = text.split("\n").filter((l) => l.trim().startsWith("{") || l.trim().startsWith("data:"));
  let parsed: unknown = null;
  for (const line of lines) {
    const json = line.startsWith("data:") ? line.slice(5).trim() : line;
    try { parsed = JSON.parse(json); break; } catch { /* keep trying */ }
  }
  if (!parsed) { console.log(text.slice(0, 2000)); process.exit(1); }

  // Unwrap mcp-adapter envelope: result.content[0].text → { success, data: { <wrapperKey>: post } }
  const result = (parsed as { result?: { content?: Array<{ text?: string }> } }).result;
  const contentText = result?.content?.[0]?.text;
  if (!contentText) { console.log(JSON.stringify(parsed, null, 2).slice(0, 2000)); process.exit(1); }
  const envelope = JSON.parse(contentText) as { data?: Record<string, unknown> };
  const wrapperKey = Object.keys(envelope.data ?? {})[0];
  const post = (envelope.data ?? {})[wrapperKey] as Record<string, unknown> | null;

  if (!post) { console.log("post is null"); process.exit(1); }
  console.log(`wrapper: ${wrapperKey}`);
  console.log(`title: ${post.title}`);
  console.log(`top-level keys: ${Object.keys(post).join(", ")}`);
  console.log(`blocks: ${Array.isArray(post.blocks) ? `${(post.blocks as unknown[]).length} items` : "(missing)"}`);
  console.log();

  const acf = post.acf as Record<string, unknown> | undefined;
  if (!acf) {
    console.log("no .acf on the post");
    process.exit(0);
  }
  console.log(`acf top-level keys (${Object.keys(acf).length}): ${Object.keys(acf).join(", ")}`);
  console.log();

  // Find every ACF field whose value is an array with acf_fc_layout items.
  console.log("ACF flexible content layouts found:");
  const counts = walkAndCountFlexLayouts(acf, {});
  if (Object.keys(counts).length === 0) {
    console.log("  (none — this page has no flex_content layouts)");
  } else {
    for (const [key, count] of Object.entries(counts).sort()) {
      console.log(`  ${key}  × ${count}`);
    }
  }
  console.log();

  // Also report whether the FIELD GROUP for this CPT *declares* flex_content
  // fields (even if this particular post hasn't populated them).
  console.log("Pulling the manifest's by-slug output_schema to find declared flex_content fields…");
  const mResp = await fetch(`${data.wp_url.replace(/\/$/, "")}/wp-json/jab/v1/manifest`, { headers: { Authorization: auth, Accept: "application/json" } });
  const manifest = await mResp.json() as { abilities?: Array<{ name: string; output_schema?: unknown }> };
  const beerSchema = manifest.abilities?.find((a) => a.name === abilityName)?.output_schema;
  const schemaStr = JSON.stringify(beerSchema ?? {});
  const oneOfCount = (schemaStr.match(/"acf_fc_layout"/g) ?? []).length;
  console.log(`  ${oneOfCount} acf_fc_layout discriminator occurrences in ${abilityName}'s output_schema`);
  console.log(`  schema size: ${schemaStr.length} chars`);
}
main().catch((e) => { console.error(e); process.exit(1); });
