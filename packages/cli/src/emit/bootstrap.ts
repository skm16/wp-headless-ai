/**
 * Emits the project's hand-crafted glue files on first init.
 *
 * Two files, each written ONLY when missing — never overwritten:
 *   - `lib/skm/client.ts`  — server-only env-driven SDK client wrapper
 *   - `.env.example`       — sample env vars the dev copies to `.env.local`
 *
 * These files are *project policy*, not regenerated artifacts. After init
 * writes them once, the dev owns them — they survive `wpheadless sync`,
 * they accept hand edits (logging, retry policy, custom error formatting),
 * and they only get touched again if the dev deletes them.
 *
 * The split mirrors lib/sdk/ (regenerated, never edited) vs lib/skm/
 * (hand-crafted, persists). Init bootstrapping the glue layer eliminates
 * the "the SDK exists but how do I instantiate it" friction beat that
 * every new agency dev hits 30 seconds in.
 */

import { mkdir, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export interface BootstrapResult {
  /** Files written. Empty when both already existed. */
  written: string[];
  /** Files left alone because they already existed. */
  skipped: string[];
}

/**
 * Write the project's glue scaffolding (skm/client.ts + .env.example) into
 * `projectDir`, skipping any file that already exists. Returns a record of
 * what changed so the caller can log it.
 */
export async function writeProjectScaffolding(
  projectDir: string,
): Promise<BootstrapResult> {
  const written: string[] = [];
  const skipped: string[] = [];

  const skmClientPath = path.resolve(projectDir, "lib", "skm", "client.ts");
  if (await fileExists(skmClientPath)) {
    skipped.push(skmClientPath);
  } else {
    await mkdir(path.dirname(skmClientPath), { recursive: true });
    await writeFile(skmClientPath, renderSkmClient(), "utf8");
    written.push(skmClientPath);
  }

  const envExamplePath = path.resolve(projectDir, ".env.example");
  if (await fileExists(envExamplePath)) {
    skipped.push(envExamplePath);
  } else {
    await writeFile(envExamplePath, renderEnvExample(), "utf8");
    written.push(envExamplePath);
  }

  return { written, skipped };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `lib/skm/client.ts` template — server-only env-driven SDK client.
 *
 * Pinned to three env vars (WP_URL, WP_USER, WP_APP_PASSWORD) that match
 * the names used in the emitted CLAUDE.md and README. Throws clear errors
 * on missing values rather than letting auth failures bubble up from the
 * MCP layer with confusing 401s.
 */
function renderSkmClient(): string {
  return `/**
 * Server-only WP MCP client.
 *
 * Wraps the auto-generated SDK with environment-driven credentials. Imported
 * from Server Components, route handlers, server actions, and scripts — never
 * from Client Components (the \`server-only\` import below makes that a build
 * error if you try).
 *
 * Edit this file freely — \`wpheadless sync\` does NOT regenerate it. The SDK
 * itself lives in \`@/lib/sdk\` and IS regenerated; treat that directory as
 * read-only output.
 */

import "server-only";
import { createClient } from "@/lib/sdk";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      \`Missing required env var \${name}. Copy .env.example to .env.local and fill in your WordPress credentials.\`,
    );
  }
  return value;
}

export const skmClient = createClient({
  wpUrl: required("WP_URL"),
  user: required("WP_USER"),
  password: required("WP_APP_PASSWORD"),
});
`;
}

/**
 * `.env.example` template — credentials the dev fills in. Mirrors the env
 * var names referenced in `lib/skm/client.ts` so the two files stay in
 * lockstep.
 */
function renderEnvExample(): string {
  return `# WordPress headless SDK credentials.
# Copy this file to .env.local and fill in real values. .env.local is
# already gitignored by Next.js — never commit credentials.

# Full URL of your WordPress install (no trailing slash).
WP_URL=https://your-wp-site.com

# WordPress username with at least 'read' capability.
WP_USER=admin

# Application Password generated at WP Admin → Users → your profile →
# Application Passwords. Spaces in the value are fine; do not quote.
WP_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx

# Optional: incremental-migration proxy URL.
#
# When set, any route NOT handled by this Next.js app falls through to
# this URL automatically (the "strangler fig" pattern). Useful for
# migrating an existing site to headless one route at a time — your new
# /posts implementation renders normally while /about still proxies to
# the original WP site until you build it locally.
#
# Leave empty to disable proxying. Unmatched routes will 404 instead.
WP_PROXY_URL=
`;
}

/**
 * `next.config.ts` template — replaces the create-next-app default with
 * one that wires up the strangler-fig rewrites.fallback. The fallback
 * runs ONLY for requests that don't match any local route, so explicit
 * routes (app/posts/page.tsx etc.) win automatically. When WP_PROXY_URL
 * is unset the rewrites function returns [] and the config is a no-op.
 */
export function renderNextConfig(): string {
  return `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Strangler-fig fallback: any route this Next.js app doesn't handle
   * falls through to the WP_PROXY_URL site, so a headless project can
   * incrementally replace an existing WP site one route at a time
   * without breaking links to pages that haven't been ported yet.
   *
   * - Set WP_PROXY_URL in .env.local to enable.
   * - Explicit routes always win — fallback only fires for misses.
   * - Leave WP_PROXY_URL empty to disable; unmatched routes will 404.
   */
  async rewrites() {
    const proxy = process.env.WP_PROXY_URL?.replace(/\\/+$/, "");
    if (!proxy) return [];
    return {
      fallback: [
        {
          source: "/:path*",
          destination: \`\${proxy}/:path*\`,
        },
      ],
    };
  },
};

export default nextConfig;
`;
}
