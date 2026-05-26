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

const TIMEOUT_MS = 60_000; // 60s — well above a healthy by-slug response

async function main() {
  loadEnv();
  const projectId = process.argv[2];
  const abilityName = process.argv[3] ?? "jab/get-page-by-slug";
  const slug = process.argv[4] ?? "have-a-beer-ct";
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data } = await sb.from("projects").select("wp_url, wp_username, wp_app_password_encrypted").eq("id", projectId).single<{ wp_url: string; wp_username: string; wp_app_password_encrypted: unknown }>();
  if (!data) { console.error("no project"); process.exit(1); }
  const pw = dec(data.wp_app_password_encrypted, process.env.JAB_ENCRYPTION_KEY!);
  const auth = "Basic " + Buffer.from(`${data.wp_username}:${pw}`).toString("base64");

  // Step 1: open MCP session (POST initialize to get a session id)
  const mcpUrl = `${data.wp_url.replace(/\/$/, "")}/wp-json/mcp/mcp-adapter-default-server`;
  console.log(`mcp endpoint: ${mcpUrl}`);
  const initController = new AbortController();
  const initTimeout = setTimeout(() => initController.abort(), TIMEOUT_MS);
  const initStart = Date.now();
  const initResp = await fetch(mcpUrl, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "diag", version: "0" } } }),
    signal: initController.signal,
  });
  clearTimeout(initTimeout);
  const initText = await initResp.text();
  const sessionId = initResp.headers.get("mcp-session-id") ?? initResp.headers.get("Mcp-Session-Id");
  console.log(`initialize HTTP ${initResp.status} in ${Date.now() - initStart}ms; session id=${sessionId ?? "(none)"}`);

  if (!sessionId) {
    console.error("no mcp-session-id header in initialize response; first 500 chars:");
    console.log(initText.slice(0, 500));
    process.exit(1);
  }

  // Send initialized notification (required by MCP)
  await fetch(mcpUrl, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  // Step 2: call the ability through the mcp-adapter wrapper, with explicit timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const callStart = Date.now();
  console.log(`calling ${abilityName} slug="${slug}" with ${TIMEOUT_MS}ms timeout...`);
  try {
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
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const elapsed = Date.now() - callStart;
    const text = await r.text();
    console.log(`HTTP ${r.status} in ${elapsed}ms; response length: ${text.length} chars`);
    // Try parsing first chunk to see if it's an error envelope
    const firstNewline = text.indexOf("\n");
    const head = text.slice(0, firstNewline >= 0 ? Math.min(firstNewline, 2000) : 2000);
    console.log(`response head:`);
    console.log(head);
    if (text.includes("isError") || text.includes("error")) {
      console.log(`\n…full response (truncated to 4000 chars):`);
      console.log(text.slice(0, 4000));
    }
  } catch (e) {
    const elapsed = Date.now() - callStart;
    if (e instanceof Error && e.name === "AbortError") {
      console.error(`FAILED: WP did not respond within ${TIMEOUT_MS}ms (elapsed=${elapsed}ms)`);
      console.error("→ The plugin/WP is hanging on this page. Likely cause: pathological block tree, reusable-block recursion, or PHP execution timeout.");
    } else {
      console.error(`error after ${elapsed}ms:`, e);
    }
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
