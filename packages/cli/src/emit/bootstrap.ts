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
 * Write the project's glue scaffolding (skm/client.ts + .env.example +
 * the strangler-fig catch-all proxy route) into `projectDir`, skipping
 * any file that already exists. Returns a record of what changed so the
 * caller can log it.
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

  // Strangler-fig catch-all proxy. Probes both app/ and src/app/ to
  // detect whichever layout create-next-app produced. Skip if neither
  // exists (non-Next.js project, or unusual layout we shouldn't touch).
  const appDirCandidates = ["app", path.join("src", "app")];
  for (const appDir of appDirCandidates) {
    const fullAppDir = path.resolve(projectDir, appDir);
    if (!(await fileExists(fullAppDir))) continue;
    const routeDir = path.join(fullAppDir, "[[...slug]]");
    const routePath = path.join(routeDir, "route.ts");
    if (await fileExists(routePath)) {
      skipped.push(routePath);
    } else {
      await mkdir(routeDir, { recursive: true });
      await writeFile(routePath, renderProxyRoute(), "utf8");
      written.push(routePath);
    }
    break;
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

# Dev-only: disable TLS verification when WP_URL or WP_PROXY_URL points
# to a local-dev host (LocalWP, Valet, DDEV) with a self-signed cert.
# Both the SDK and Next.js's rewrite proxy use Node fetch, which refuses
# self-signed certs by default. NEVER set this in production — anything
# you fetch from outside your local machine becomes vulnerable to MITM.
# NODE_TLS_REJECT_UNAUTHORIZED=0
`;
}

/**
 * `next.config.ts` template — kept identical to the create-next-app
 * default (no rewrites). The strangler-fig proxy is implemented as a
 * catch-all route handler at app/[[...slug]]/route.ts instead, because
 * Next.js's rewrite engine uses an undici dispatcher that ignores
 * NODE_TLS_REJECT_UNAUTHORIZED and breaks against self-signed certs
 * (LocalWP / Valet / DDEV). The route handler uses our own fetch call,
 * which respects the env var and works for any host.
 *
 * Provided so scaffold can replace create-next-app's output with a
 * known-good template — keeps file structure consistent across runs
 * and avoids drift if create-next-app's defaults change.
 */
export function renderNextConfig(): string {
  return `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
`;
}

/**
 * `app/[[...slug]]/route.ts` template — the strangler-fig catch-all.
 *
 * Optional catch-all means this handler runs for any path not handled by
 * a more specific route (app/posts/page.tsx, app/api/foo/route.ts, etc.).
 * Forwards method, headers, and body to WP_PROXY_URL; passes the
 * upstream response straight back. fetch in user-code Route Handlers
 * respects NODE_TLS_REJECT_UNAUTHORIZED — so self-signed certs on
 * .local hosts work in dev when that env var is set in .env.local.
 *
 * Returns 404 when WP_PROXY_URL is unset (production-safe default).
 */
function renderProxyRoute(): string {
  return `/**
 * Strangler-fig catch-all proxy.
 *
 * Falls through to the WP_PROXY_URL site for any route not handled by a
 * more specific app route. Lets agencies migrate an existing WP site to
 * headless one route at a time — explicit Next.js routes always win;
 * unmatched routes proxy to the original.
 *
 * To opt out: clear WP_PROXY_URL in .env.local (this handler returns
 * 404), or delete this file entirely.
 *
 * Edit freely — this file is project-policy scaffolding (like
 * lib/skm/client.ts), not regenerated SDK code.
 */

import type { NextRequest } from "next/server";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

async function handler(
  request: NextRequest,
  ctx: { params: Promise<{ slug?: string[] }> },
): Promise<Response> {
  const proxyUrl = process.env.WP_PROXY_URL?.replace(/\\/+$/, "");
  if (!proxyUrl) {
    return new Response("Not Found", { status: 404 });
  }

  const { slug = [] } = await ctx.params;
  const pathname = "/" + slug.join("/");

  // Don't proxy Next.js internals or local API routes — guard even though
  // routing precedence usually handles this; defense in depth is cheap.
  if (pathname.startsWith("/_next/") || pathname.startsWith("/api/")) {
    return new Response("Not Found", { status: 404 });
  }

  const target = new URL(
    pathname + request.nextUrl.search,
    proxyUrl + "/",
  ).toString();

  const forwardHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  }

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.arrayBuffer();

  const upstream = await fetch(target, {
    method: request.method,
    headers: forwardHeaders,
    body,
    redirect: "manual",
  });

  // Strip hop-by-hop headers from the response too — anything in that
  // set is per-connection metadata that shouldn't propagate to the
  // browser via Next.js's runtime.
  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;
export const OPTIONS = handler;
`;
}
