/**
 * One-shot verification: calls skm/get-beers against the live WP backend
 * and reports whether the response passes MCP output validation, plus a
 * tiny summary of what came back.
 *
 * Run with:
 *   pnpm exec tsx scripts/verify-beers.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Minimal .env.local loader — avoids pulling in dotenv just for this script.
const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const { createClient, getBeers } = await import("../lib/sdk/index.js");

const client = createClient({
  wpUrl: process.env.WP_URL!,
  user: process.env.WP_USER!,
  password: process.env.WP_APP_PASSWORD!,
});

console.log(`→ Fetching skm/get-beers from ${process.env.WP_URL} …`);

try {
  const { beers } = await getBeers(client, { numberposts: 25 });
  console.log(`✓ ${beers.length} beer(s) passed schema validation\n`);

  for (const beer of beers.slice(0, 10)) {
    const fi = beer.acf?.feature_image;
    const fiKind =
      fi === undefined ? "—" : typeof fi === "number" ? `int(${fi})` : `${typeof fi}(${JSON.stringify(fi)})`;
    console.log(`  • [${beer.id}] ${beer.title}  feature_image=${fiKind}`);
  }
  if (beers.length > 10) console.log(`  … and ${beers.length - 10} more`);
  process.exit(0);
} catch (err) {
  console.error(`✗ getBeers failed:`);
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
