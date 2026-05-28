// apps/web/scripts/_patch-use-client.ts
//
// One-off patcher: walk builds/<id>/project/ and prepend "use client" to any
// .tsx file that imports a React hook and lacks the directive. Triggered by
// the first Two Roads smoke failure where AcfFlexPagePageBuilderContentWysiwyg.tsx
// used useState without "use client".
//
// Followup: Phase B's component-generator.ts should add this directive at
// generation time when validateTsx detects hook imports. This patcher is
// the band-aid; the Phase B fix is the cure.
//
//   pnpm tsx scripts/_patch-use-client.ts <buildId>

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REACT_HOOK_RE =
  /\bfrom\s+["']react["']/m;

const HOOK_NAMES =
  /\b(useState|useEffect|useRef|useCallback|useMemo|useReducer|useContext|useLayoutEffect|useTransition|useDeferredValue|useId|useSyncExternalStore|useImperativeHandle|useFormStatus|useFormState|useOptimistic)\b/;

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

function needsUseClient(source: string): boolean {
  // Already declared?
  if (/^\s*["']use client["']/m.test(source.split("\n").slice(0, 5).join("\n"))) {
    return false;
  }
  return REACT_HOOK_RE.test(source) && HOOK_NAMES.test(source);
}

function prepend(source: string): string {
  return `"use client";\n\n${source}`;
}

async function listRecursive(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const results: string[] = [];
  const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error) throw new Error(`list ${prefix} failed: ${error.message}`);
  for (const item of data ?? []) {
    if (item.id === null) {
      const sub = await listRecursive(supabase, bucket, `${prefix}${item.name}/`);
      results.push(...sub);
    } else {
      results.push(`${prefix}${item.name}`);
    }
  }
  return results;
}

async function main() {
  loadDotEnvLocal();
  const [, , buildId] = process.argv;
  if (!buildId) {
    console.error("Usage: pnpm tsx scripts/_patch-use-client.ts <buildId>");
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing supabase env vars");
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const prefix = `builds/${buildId}/project/`;
  const allPaths = await listRecursive(supabase, "site-screenshots", prefix);
  const tsxPaths = allPaths.filter((p) => p.endsWith(".tsx"));
  console.log(`Scanning ${tsxPaths.length} .tsx files under ${prefix}…`);

  const patched: string[] = [];
  const skipped: string[] = [];
  for (const path of tsxPaths) {
    const { data, error } = await supabase.storage.from("site-screenshots").download(path);
    if (error || !data) {
      console.warn(`  ✗ ${path}: download failed: ${error?.message ?? "no blob"}`);
      continue;
    }
    const src = await data.text();
    if (!needsUseClient(src)) {
      skipped.push(path);
      continue;
    }
    const patchedSrc = prepend(src);
    const buf = Buffer.from(patchedSrc, "utf8");
    const { error: uploadErr } = await supabase.storage
      .from("site-screenshots")
      .upload(path, buf, { contentType: "text/plain", upsert: true });
    if (uploadErr) {
      console.error(`  ✗ ${path}: upload failed: ${uploadErr.message}`);
      continue;
    }
    patched.push(path);
    console.log(`  ✓ patched ${path.slice(prefix.length)}`);
  }
  console.log(`\nPatched ${patched.length} file(s), left ${skipped.length} file(s) untouched.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
