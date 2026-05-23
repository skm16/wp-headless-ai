/**
 * Quick dump of every menu and its items, to inform the homepage nav build.
 * Run with: pnpm exec tsx scripts/verify-menus.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const { createClient, getMenus } = await import("../lib/sdk/index.js");

const client = createClient({
  wpUrl: process.env.WP_URL!,
  user: process.env.WP_USER!,
  password: process.env.WP_APP_PASSWORD!,
});

const { menus } = await getMenus(client);
for (const m of menus) {
  console.log(`\n# Menu: ${m.name}  (slug: ${m.slug}, locations: ${m.locations.join(", ") || "none"})`);
  for (const item of m.items) {
    const indent = item.parent_id === 0 ? "" : "  └ ";
    console.log(`  ${indent}[${item.order}] ${item.title} → ${item.url}  (${item.object_type})`);
  }
}
