// apps/web/scripts/read-build-log.ts
//
// Downloads a failed build's log from Storage and prints to stdout.
//   cd apps/web
//   pnpm tsx scripts/read-build-log.ts <buildId>
//
// Mirrors the failure-path artifact deploy-site.ts on-failure writes to
// builds/<id>/build-log.txt. Useful for triaging Phase D failures.

import { createClient } from "@supabase/supabase-js";
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

  const [, , buildId] = process.argv;
  if (!buildId) {
    console.error("Usage: pnpm tsx scripts/read-build-log.ts <buildId>");
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const path = `builds/${buildId}/build-log.txt`;
  const { data, error } = await supabase.storage.from("site-screenshots").download(path);
  if (error || !data) {
    console.error(`Failed to read ${path}: ${error?.message ?? "no data"}`);
    process.exit(1);
  }
  console.log(await data.text());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
