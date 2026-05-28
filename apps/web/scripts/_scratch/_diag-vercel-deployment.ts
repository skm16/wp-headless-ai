// apps/web/scripts/_diag-vercel-deployment.ts
//
// One-off diagnostic: query Vercel directly for a deployment's state +
// raw events array. Prints both raw response bodies so we can see what
// Vercel actually returned vs. what VercelClient parsed.
//
//   pnpm tsx scripts/_diag-vercel-deployment.ts <deploymentId>

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function main() {
  loadDotEnvLocal();
  const [, , deploymentId] = process.argv;
  if (!deploymentId) {
    console.error("Usage: pnpm tsx scripts/_diag-vercel-deployment.ts <deploymentId>");
    process.exit(1);
  }
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  if (!token || !teamId) {
    console.error("Missing VERCEL_TOKEN or VERCEL_TEAM_ID");
    process.exit(1);
  }
  const headers = { Authorization: `Bearer ${token}` };

  console.log("=== GET /v13/deployments/" + deploymentId + " ===");
  const depRes = await fetch(
    `https://api.vercel.com/v13/deployments/${deploymentId}?teamId=${teamId}`,
    { headers },
  );
  console.log("status:", depRes.status);
  const depText = await depRes.text();
  // Pretty-print up to a sane cap
  try {
    const parsed = JSON.parse(depText);
    console.log(JSON.stringify(parsed, null, 2).slice(0, 6000));
  } catch {
    console.log(depText.slice(0, 6000));
  }

  console.log("\n=== GET /v3/deployments/" + deploymentId + "/events ===");
  const evRes = await fetch(
    `https://api.vercel.com/v3/deployments/${deploymentId}/events?teamId=${teamId}`,
    { headers },
  );
  console.log("status:", evRes.status);
  const evText = await evRes.text();
  try {
    const parsed = JSON.parse(evText);
    if (Array.isArray(parsed)) {
      console.log("array length:", parsed.length);
      // Sort by created and print concatenated text — the real failure surface
      const sorted = [...parsed].sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
      console.log("\n--- concatenated text (using e.text) ---");
      for (const ev of sorted) {
        const t = ev.text ?? ev.payload?.text ?? "";
        const type = ev.type ?? "?";
        if (t) console.log(`[${type}] ${t}`);
      }
    } else {
      console.log("shape:", JSON.stringify(parsed, null, 2).slice(0, 4000));
    }
  } catch {
    console.log(evText.slice(0, 4000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
