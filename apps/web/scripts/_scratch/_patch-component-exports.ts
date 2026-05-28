// apps/web/scripts/_patch-component-exports.ts
//
// One-off patcher to align LLM-generated component exports with the
// dispatcher's import contract. For each .tsx file under
// builds/<id>/project/components/blocks/:
//   - Compute expectedName = filename minus extension
//   - If no `export <decl> ${expectedName}` exists but some other
//     `export <decl> X` exists, append `export { X as ${expectedName} };`
//
// Also patches app/page.tsx and app/__catchall_slug__/page.tsx to cast
// the `unknown` return of `jabClient.callAbility` to the param shape
// composeBlockTree expects.
//
// Phase B/C follow-up needed: component-generator.ts should enforce the
// expectedName at validate-tsx time, and compose-site-emit's emitHomepageTsx /
// emitCatchAllPageTsx should emit the cast.
//
//   pnpm tsx scripts/_patch-component-exports.ts <buildId>

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";

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

interface ListedFile {
  path: string;
}

async function listRecursive(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
): Promise<ListedFile[]> {
  const results: ListedFile[] = [];
  const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error) throw new Error(`list ${prefix} failed: ${error.message}`);
  for (const item of data ?? []) {
    if (item.id === null) {
      const sub = await listRecursive(supabase, bucket, `${prefix}${item.name}/`);
      results.push(...sub);
    } else {
      results.push({ path: `${prefix}${item.name}` });
    }
  }
  return results;
}

function findActualExportedName(src: string): string | null {
  // Prefer `export function X` (covers named exports)
  const m1 = src.match(/^export\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/m);
  if (m1) return m1[1];
  // Default export functions
  const m2 = src.match(/^export\s+default\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/m);
  if (m2) return m2[1];
  // Named const arrow exports
  const m3 = src.match(/^export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/m);
  if (m3) return m3[1];
  return null;
}

function alreadyExportsExpected(src: string, expected: string): boolean {
  const namedFn = new RegExp(`^export\\s+function\\s+${expected}\\s*\\(`, "m");
  const namedConst = new RegExp(`^export\\s+const\\s+${expected}\\s*[:=]`, "m");
  const namedClass = new RegExp(`^export\\s+class\\s+${expected}\\b`, "m");
  const aliasOf = new RegExp(`^export\\s+\\{[^}]*\\b${expected}\\b[^}]*\\}`, "m");
  return namedFn.test(src) || namedConst.test(src) || namedClass.test(src) || aliasOf.test(src);
}

async function patchComponentExports(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  blocksPrefix: string,
): Promise<{ patched: string[]; skipped: string[] }> {
  const files = await listRecursive(supabase, bucket, blocksPrefix);
  const tsxFiles = files.filter((f) => f.path.endsWith(".tsx") && !basename(f.path).startsWith("_"));
  const patched: string[] = [];
  const skipped: string[] = [];

  for (const f of tsxFiles) {
    const fileName = basename(f.path);
    const expected = fileName.replace(/\.tsx$/, "");
    const { data, error } = await supabase.storage.from(bucket).download(f.path);
    if (error || !data) {
      console.warn(`  ✗ ${fileName}: download failed: ${error?.message ?? "no data"}`);
      continue;
    }
    const src = await data.text();
    if (alreadyExportsExpected(src, expected)) {
      skipped.push(fileName);
      continue;
    }
    const actual = findActualExportedName(src);
    if (!actual) {
      console.warn(`  ✗ ${fileName}: no exported function found, skipping`);
      continue;
    }
    const aliased = src.trimEnd() + `\n\nexport { ${actual} as ${expected} };\n`;
    const buf = Buffer.from(aliased, "utf8");
    const { error: upErr } = await supabase.storage
      .from(bucket)
      .upload(f.path, buf, { contentType: "text/plain", upsert: true });
    if (upErr) {
      console.warn(`  ✗ ${fileName}: upload failed: ${upErr.message}`);
      continue;
    }
    patched.push(`${fileName} (alias ${actual} → ${expected})`);
    console.log(`  ✓ ${fileName}: aliased ${actual} → ${expected}`);
  }
  return { patched, skipped };
}

async function patchPageCasts(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  buildId: string,
): Promise<string[]> {
  const targets = [
    `builds/${buildId}/project/app/page.tsx`,
    `builds/${buildId}/project/app/__catchall_slug__/page.tsx`,
  ];
  const patched: string[] = [];
  for (const path of targets) {
    const { data, error } = await supabase.storage.from(bucket).download(path);
    if (error || !data) {
      console.warn(`  ✗ ${path}: download failed: ${error?.message ?? "no data"}`);
      continue;
    }
    let src = await data.text();
    if (!src.includes("composeBlockTree(record,")) {
      console.warn(`  ✗ ${path}: no 'composeBlockTree(record,' call to cast`);
      continue;
    }
    // Replace `composeBlockTree(record,` with the typed cast using Parameters<>.
    src = src.replace(
      /composeBlockTree\(record,/g,
      "composeBlockTree(record as Parameters<typeof composeBlockTree>[0],",
    );
    const buf = Buffer.from(src, "utf8");
    const { error: upErr } = await supabase.storage
      .from(bucket)
      .upload(path, buf, { contentType: "text/plain", upsert: true });
    if (upErr) {
      console.warn(`  ✗ ${path}: upload failed: ${upErr.message}`);
      continue;
    }
    patched.push(path);
    console.log(`  ✓ ${path}: cast added`);
  }
  return patched;
}

async function main() {
  loadDotEnvLocal();
  const [, , buildId] = process.argv;
  if (!buildId) {
    console.error("Usage: pnpm tsx scripts/_patch-component-exports.ts <buildId>");
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing supabase env vars");
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const bucket = "site-screenshots";
  const blocksPrefix = `builds/${buildId}/project/components/blocks/`;

  console.log(`Patching component exports under ${blocksPrefix}…`);
  const { patched, skipped } = await patchComponentExports(supabase, bucket, blocksPrefix);
  console.log(`Patched ${patched.length} component file(s); ${skipped.length} already matched.`);

  console.log(`\nPatching page casts (homepage + catchall)…`);
  const pagesPatched = await patchPageCasts(supabase, bucket, buildId);
  console.log(`Patched ${pagesPatched.length} page file(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
