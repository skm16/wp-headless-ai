/**
 * Route smoke against a deployed preview.
 *
 * Usage:
 *   pnpm --filter @jab/web exec tsx scripts/smoke-deployed-routes.ts <previewUrl> [path ...]
 *
 * With no paths, checks "/" only. Recommended set after a Two Roads build:
 *   "/" "/visit-us" "/beer/lil-heaven-ipa" "/post/<any-published-post-slug>"
 * (one mapped page, one mapped CPT detail, one FALLBACK route not in
 * ROUTE_MAP — the last one proves POST_TYPE_MAP resolution works live).
 * Exits 1 if any route fails.
 */
import { checkRoutes } from "../lib/jab/smoke-routes";

async function main() {
  const [baseUrl, ...paths] = process.argv.slice(2);
  if (!baseUrl) {
    console.error("usage: smoke-deployed-routes.ts <previewUrl> [path ...]");
    process.exit(2);
  }
  const results = await checkRoutes(baseUrl, paths.length > 0 ? paths : ["/"]);
  for (const r of results) {
    console.log(`${r.ok ? "OK  " : "FAIL"} ${r.status ?? "ERR"} ${r.path}${r.error ? ` (${r.error})` : ""}`);
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main();
