// apps/web/scripts/_diag-mcp-tools.ts
//
// Diagnostic — full MCP handshake + tools/list + targeted tools/call.
//
// Usage: pnpm tsx scripts/_diag-mcp-tools.ts <projectId>
import { createClient } from "@supabase/supabase-js";
import { createDecipheriv } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function decryptColumnToString(value: unknown, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  let buf: Buffer;
  if (typeof value === "string" && value.startsWith("\\x")) {
    buf = Buffer.from(value.slice(2), "hex");
  } else if (typeof value === "string" && /^[A-Za-z0-9+/=]+$/.test(value)) {
    buf = Buffer.from(value, "base64");
  } else {
    throw new Error(`Unrecognized encrypted column format: ${typeof value}`);
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

async function mcpRpc(
  url: string,
  auth: string,
  sessionId: string | null,
  body: Record<string, unknown>,
): Promise<{ status: number; headers: Headers; body: string; json: unknown }> {
  const headers: Record<string, string> = {
    Authorization: auth,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await r.text();
  let parsed: unknown = null;
  // SSE responses come as `event: message\ndata: {...}` — peel out the JSON.
  if (text.startsWith("event:")) {
    const m = text.match(/data:\s*(.+)$/m);
    if (m) {
      try { parsed = JSON.parse(m[1]); } catch { /* leave null */ }
    }
  } else {
    try { parsed = JSON.parse(text); } catch { /* leave null */ }
  }
  return { status: r.status, headers: r.headers, body: text, json: parsed };
}

async function main(): Promise<void> {
  loadDotEnvLocal();
  const [projectId] = process.argv.slice(2);
  if (!projectId) {
    console.error("Usage: tsx scripts/_diag-mcp-tools.ts <projectId>");
    process.exit(1);
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const encKey = process.env.JAB_ENCRYPTION_KEY;
  if (!supabaseUrl || !serviceKey || !encKey) {
    console.error("[diag] missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JAB_ENCRYPTION_KEY");
    process.exit(1);
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase
    .from("projects")
    .select("wp_url, wp_username, wp_app_password_encrypted")
    .eq("id", projectId)
    .single<{ wp_url: string; wp_username: string; wp_app_password_encrypted: unknown }>();
  if (error || !data) {
    console.error("[diag] project load failed:", error?.message);
    process.exit(1);
  }
  const appPassword = decryptColumnToString(data.wp_app_password_encrypted, encKey);
  const wpUrl = data.wp_url.replace(/\/+$/, "");
  const auth = "Basic " + Buffer.from(`${data.wp_username}:${appPassword}`).toString("base64");
  const mcpUrl = `${wpUrl}/wp-json/mcp/mcp-adapter-default-server`;

  console.log(`[diag] wp_url=${wpUrl}  user=${data.wp_username}`);
  console.log("");

  // ── Step 1: initialize handshake ──
  console.log("=== STEP 1: initialize ===");
  const init = await mcpRpc(mcpUrl, auth, null, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "jab-diag", version: "0.0.0" },
    },
  });
  console.log(`status: ${init.status}`);
  console.log(`mcp-session-id header: ${init.headers.get("mcp-session-id") ?? init.headers.get("Mcp-Session-Id") ?? "(none)"}`);
  console.log(`response json:`, JSON.stringify(init.json, null, 2).slice(0, 800));
  console.log("");

  const sessionId = init.headers.get("mcp-session-id") ?? init.headers.get("Mcp-Session-Id");
  if (!sessionId) {
    console.log("[diag] no session id returned — server likely doesn't require it; proceeding without");
  }

  // Some servers want notifications/initialized before further requests.
  const initNotif = await mcpRpc(mcpUrl, auth, sessionId, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  console.log(`notifications/initialized status: ${initNotif.status}`);
  console.log("");

  // ── Step 2: tools/list ──
  console.log("=== STEP 2: tools/list ===");
  const list = await mcpRpc(mcpUrl, auth, sessionId, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  console.log(`status: ${list.status}`);
  if (list.json && typeof list.json === "object") {
    const j = list.json as { result?: { tools?: Array<{ name: string }> }; error?: { code: number; message: string } };
    if (j.error) {
      console.log(`error:`, JSON.stringify(j.error));
    } else if (j.result?.tools) {
      const names = j.result.tools.map((t) => t.name).sort();
      console.log(`tool count: ${names.length}`);
      console.log(`tools:`, names);
      console.log(`includes jab/get-menus?       ${names.includes("jab/get-menus")}`);
      console.log(`includes jab/get-page-by-slug? ${names.includes("jab/get-page-by-slug")}`);
      console.log(`includes jab/get-pages?       ${names.includes("jab/get-pages")}`);
    } else {
      console.log(`unexpected response shape:`, JSON.stringify(j).slice(0, 500));
    }
  } else {
    console.log(`body (first 500):`, list.body.slice(0, 500));
  }
  console.log("");

  // ── Step 3: tools/call jab/get-page-by-slug (worked under v0.5.x) ──
  console.log("=== STEP 3: tools/call jab/get-page-by-slug ===");
  const callOld = await mcpRpc(mcpUrl, auth, sessionId, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "jab/get-page-by-slug",
      arguments: { slug: "home", include: { content: false, blocks: false, render: false } },
    },
  });
  console.log(`status: ${callOld.status}`);
  console.log(`response (first 800):`, JSON.stringify(callOld.json).slice(0, 800));
  console.log("");

  // ── Step 4: tools/call jab/get-menus (new in v0.6.0) ──
  console.log("=== STEP 4: tools/call jab/get-menus ===");
  const callNew = await mcpRpc(mcpUrl, auth, sessionId, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "jab/get-menus", arguments: {} },
  });
  console.log(`status: ${callNew.status}`);
  console.log(`response (first 800):`, JSON.stringify(callNew.json).slice(0, 800));
  console.log("");

  // ── Step 5: WRAPPER PATTERN — mcp-adapter-execute-ability for jab/get-menus ──
  console.log("=== STEP 5: tools/call mcp-adapter-execute-ability(jab/get-menus) ===");
  const callWrapped = await mcpRpc(mcpUrl, auth, sessionId, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "mcp-adapter-execute-ability",
      arguments: { ability_name: "jab/get-menus", parameters: {} },
    },
  });
  console.log(`status: ${callWrapped.status}`);
  console.log(`response (first 1200):`, JSON.stringify(callWrapped.json).slice(0, 1200));
  console.log("");

  // ── Step 6: discover via the wrapper to confirm jab/get-menus is registered ──
  console.log("=== STEP 6: tools/call mcp-adapter-discover-abilities ===");
  const discover = await mcpRpc(mcpUrl, auth, sessionId, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "mcp-adapter-discover-abilities", arguments: {} },
  });
  console.log(`status: ${discover.status}`);
  const dj = discover.json as { result?: { content?: Array<{ text?: string }> } };
  const textBlock = dj?.result?.content?.[0]?.text ?? "";
  if (textBlock) {
    // Often returns a stringified JSON inside the text content block.
    try {
      const inner = JSON.parse(textBlock);
      const abilities = inner.abilities ?? inner;
      const names = Array.isArray(abilities)
        ? abilities.map((a: { name?: string } | string) => (typeof a === "string" ? a : a.name)).filter(Boolean)
        : [];
      console.log(`abilities discovered via wrapper: ${names.length}`);
      console.log(names.slice(0, 50));
      console.log(`includes jab/get-menus? ${names.includes("jab/get-menus")}`);
    } catch {
      console.log("text content (first 800):", textBlock.slice(0, 800));
    }
  } else {
    console.log("no text content in response, raw (first 800):", JSON.stringify(discover.json).slice(0, 800));
  }
}

main().catch((err) => {
  console.error("[diag] unexpected error:", err);
  process.exit(1);
});
