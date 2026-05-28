// apps/web/scripts/_patch-blocknode-import.ts
//
// Rewrite Phase B's `@/lib/jab/ability-client` BlockNode import to the
// emitted-project path `@/lib/sdk/types`. Phase C's substituteBlockNodeImport
// regex looks for a `// Minimal BlockNode shape` comment that doesn't exist
// in the actual Phase B output, so the substitution is a no-op in practice.
//
//   pnpm tsx scripts/_patch-blocknode-import.ts <buildId>

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

async function listRecursive(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const out: string[] = [];
  const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error) throw new Error(`list ${prefix}: ${error.message}`);
  for (const item of data ?? []) {
    if (item.id === null) {
      out.push(...(await listRecursive(supabase, bucket, `${prefix}${item.name}/`)));
    } else {
      out.push(`${prefix}${item.name}`);
    }
  }
  return out;
}

async function main() {
  loadDotEnvLocal();
  const [, , buildId] = process.argv;
  if (!buildId) {
    console.error("Usage: pnpm tsx scripts/_patch-blocknode-import.ts <buildId>");
    process.exit(1);
  }
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const prefix = `builds/${buildId}/project/`;
  const all = await listRecursive(supabase, "site-screenshots", prefix);
  const tsxPaths = all.filter((p) => p.endsWith(".tsx") || p.endsWith(".ts"));
  console.log(`Scanning ${tsxPaths.length} .ts/.tsx files…`);

  let patched = 0;
  for (const path of tsxPaths) {
    const { data, error } = await supabase.storage.from("site-screenshots").download(path);
    if (error || !data) continue;
    const src = await data.text();
    if (!src.includes("@/lib/jab/ability-client")) continue;
    const rewritten = src.replace(/@\/lib\/jab\/ability-client/g, "@/lib/sdk/types");
    const buf = Buffer.from(rewritten, "utf8");
    const { error: upErr } = await supabase.storage
      .from("site-screenshots")
      .upload(path, buf, { contentType: "text/plain", upsert: true });
    if (upErr) {
      console.warn(`  ✗ ${path}: ${upErr.message}`);
      continue;
    }
    patched++;
    console.log(`  ✓ ${path.slice(prefix.length)}`);
  }
  console.log(`Rewrote BlockNode import in ${patched} file(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
