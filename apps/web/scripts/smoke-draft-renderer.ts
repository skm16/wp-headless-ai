/**
 * Phase-1 draft renderer smoke. Usage:
 *   pnpm --filter @jab/web exec tsx scripts/smoke-draft-renderer.ts <projectId> [baseUrl]
 * Requires the Next dev/prod server running with .env.local secrets.
 * Mints a token directly (same env secret) and asserts: shell 200, page JSON
 * for "/", assets served, garbage 404, and 401 without a token.
 */

// Load .env.local so tsx (which doesn't auto-load Next.js env files) can
// find JAB_DRAFT_TOKEN_SECRET / JAB_ENCRYPTION_KEY.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
try {
  const envPath = resolve(process.cwd(), ".env.local");
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch {
  // no .env.local — caller must have set env vars another way
}

import { mintDraftToken } from "../lib/draft/token";

const projectId = process.argv[2];
const baseUrl = process.argv[3] ?? "http://localhost:3000";
if (!projectId) {
  console.error("usage: tsx scripts/smoke-draft-renderer.ts <projectId> [baseUrl]");
  process.exit(1);
}

async function main() {
  const token = mintDraftToken(projectId);
  console.log(`\ndraft URL: ${baseUrl}/draft/${projectId}/?token=${encodeURIComponent(token)}`);
  const q = `token=${encodeURIComponent(token)}`;
  const fails: string[] = [];

  const check = async (
    label: string,
    url: string,
    assert: (res: Response, body: string) => boolean,
  ) => {
    try {
      const res = await fetch(url);
      const body = await res.text();
      const ok = assert(res, body);
      console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (${res.status})`);
      if (!ok) fails.push(`${label}: status=${res.status} body=${body.slice(0, 200)}`);
    } catch (err) {
      console.log(`FAIL  ${label}  (network error: ${err})`);
      fails.push(`${label}: ${err}`);
    }
  };

  // Auth checks
  await check("shell 401 without token", `${baseUrl}/draft/${projectId}/`, (r) => r.status === 401);
  await check("page-json 401 without token", `${baseUrl}/api/draft/${projectId}/page?path=/`, (r) => r.status === 401);

  // Shell renders
  await check(
    "shell 200 with token",
    `${baseUrl}/draft/${projectId}/?${q}`,
    (r, b) => r.status === 200 && b.includes("__JAB_DRAFT__") && b.includes("jab-app"),
  );

  // Page data — this also lazily builds the artifacts (first call is slow)
  console.log("\n  (artifact build may take 10-30s on first request...)\n");
  await check(
    "page JSON for /",
    `${baseUrl}/api/draft/${projectId}/page?path=/&${q}`,
    (r, b) => {
      if (r.status !== 200) return false;
      try {
        return JSON.parse(b).kind === "page";
      } catch {
        return false;
      }
    },
  );

  // Front-slug redirect
  const slugRes = await fetch(`${baseUrl}/api/draft/${projectId}/page?path=/&${q}`);
  const slugJson = (await slugRes.json()) as { front_page_slug?: string };
  if (slugJson.front_page_slug) {
    await check(
      "front-slug redirect",
      `${baseUrl}/api/draft/${projectId}/page?path=/${slugJson.front_page_slug}&${q}`,
      (r, b) => {
        try {
          const j = JSON.parse(b) as { kind: string; to?: string };
          return r.status === 200 && j.kind === "redirect" && j.to === "/";
        } catch {
          return false;
        }
      },
    );
  }

  // Assets (the shell route embedded the buildId in ?v — fetch the shell first to get it)
  const shellRes = await fetch(`${baseUrl}/draft/${projectId}/?${q}`);
  const shellHtml = await shellRes.text();
  const vMatch = shellHtml.match(/asset\/draft\.css\?[^"]*&v=([^"&]+)/);
  const vParam = vMatch?.[1] ?? "";
  if (vParam) {
    const aq = `${q}&v=${vParam}`;
    await check(
      "css asset",
      `${baseUrl}/api/draft/${projectId}/asset/draft.css?${aq}`,
      (r, b) => r.status === 200 && b.includes("jab-app"),
    );
    await check(
      "bundle asset",
      `${baseUrl}/api/draft/${projectId}/asset/bundle.js?${aq}`,
      (r, b) => r.status === 200 && b.length > 10_000,
    );
  } else {
    console.log("SKIP  assets — could not extract ?v from shell (check shell HTML)");
  }

  // Unknown path → not_found
  await check(
    "garbage path is not_found",
    `${baseUrl}/api/draft/${projectId}/page?path=/zz/yy/xx&${q}`,
    (r, b) => {
      if (r.status !== 404) return false;
      try {
        return (JSON.parse(b) as { kind: string }).kind === "not_found";
      } catch {
        return false;
      }
    },
  );

  if (fails.length) {
    console.error(`\n--- SMOKE FAIL (${fails.length} assertion(s)) ---`);
    fails.forEach((f) => console.error(` • ${f}`));
    process.exit(1);
  }
  console.log("\n--- SMOKE PASS ---");
}

void main();
