/**
 * Validate AI page-generation quality on a real WP site.
 *
 * Run flow:
 *   1. Read .env (WP_URL, WP_USER, WP_PASSWORD, WP_PAGE_PATH, ABILITY_PREFIX,
 *      ANTHROPIC_API_KEY).
 *   2. fetchManifest() against the WP install (same code path the Phase D
 *      worker will use).
 *   3. emitSdk() to produce the typed SDK files Claude will see + import.
 *   4. fetch() the live page HTML.
 *   5. One-shot Claude Messages API call with system + user prompts in
 *      ./prompts.ts. Iterate by editing those — token cost is logged so
 *      you can see whether changes are worth it.
 *   6. Extract the first ```tsx block from the response, write to
 *      ./output/<timestamp>-<host>/page.tsx alongside meta.json.
 *
 * Usage:
 *   cp .env.example .env
 *   pnpm install
 *   pnpm --filter @jab/validate-ai generate
 *
 * The output is what you eyeball against the source page. If quality is
 * good across 3-5 different WP sites, Phase D's worker is built around
 * this same prompt + SDK shape. If quality is bad, iterate prompts here
 * before committing to Inngest plumbing.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenv } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { fetchManifest, emitSdk, type Manifest } from "@jab/core";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
dotenv({ path: resolve(HERE, "..", ".env") });

const MAX_HTML_BYTES = 60_000;
const MODEL = "claude-opus-4-7" as const;

interface RunConfig {
  wpUrl: string;
  wpUser: string;
  wpPassword: string;
  pagePath: string;
  abilityPrefix: string;
  apiKey: string;
}

function readConfig(): RunConfig {
  const required = (name: string): string => {
    const v = process.env[name];
    if (!v || v.trim() === "") {
      console.error(
        `Missing ${name} in .env (copy .env.example → .env and fill in)`,
      );
      process.exit(1);
    }
    return v;
  };
  return {
    wpUrl: required("WP_URL").replace(/\/+$/, ""),
    wpUser: required("WP_USER"),
    wpPassword: required("WP_PASSWORD"),
    pagePath: process.env.WP_PAGE_PATH?.trim() || "/",
    abilityPrefix: process.env.ABILITY_PREFIX?.trim() ?? "jab/",
    apiKey: required("ANTHROPIC_API_KEY"),
  };
}

async function fetchPageHtml(wpUrl: string, path: string): Promise<string> {
  const url = `${wpUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  let html = await res.text();
  // Trim aggressively — model context isn't free, and the inline <script>/
  // <style>/<svg> blocks are the parts least useful for layout inference.
  html = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "<!-- svg -->")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (html.length > MAX_HTML_BYTES) {
    html = `${html.slice(0, MAX_HTML_BYTES)}\n<!-- truncated at ${MAX_HTML_BYTES} chars -->`;
  }
  return html;
}

function summarizeAbilities(manifest: Manifest): string {
  return manifest.abilities
    .map((a) => `- ${a.name} — ${a.description ?? a.label ?? "(no description)"}`)
    .join("\n");
}

function bundleSdkSource(files: Map<string, string>): string {
  // The agent only needs the files it'll actually import from. Skip
  // CLAUDE.md (human doc) and keep types/client/abilities/index.
  const wanted = ["types.ts", "client.ts", "abilities.ts", "index.ts"];
  return wanted
    .filter((f) => files.has(f))
    .map((f) => `// ===== ${f} =====\n${files.get(f)!.trimEnd()}\n`)
    .join("\n");
}

function extractCodeBlock(text: string): string | null {
  // Match the first ```tsx, ```ts, or ```typescript block. Tolerate trailing
  // whitespace before the closing fence.
  const re = /```(?:tsx|ts|typescript)?\s*\n([\s\S]*?)\n\s*```/i;
  const m = text.match(re);
  return m ? m[1]!.trim() : null;
}

function urlSlug(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function isoCompact(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

async function main() {
  const cfg = readConfig();

  console.log(`→ Fetching manifest from ${cfg.wpUrl} (prefix: "${cfg.abilityPrefix}")`);
  const manifest = await fetchManifest({
    wpUrl: cfg.wpUrl,
    user: cfg.wpUser,
    password: cfg.wpPassword,
    prefix: cfg.abilityPrefix,
  });
  console.log(`  ${manifest.abilities.length} abilities matched.`);

  console.log(`→ Emitting SDK (so Claude sees what it'll be importing)`);
  const sdkFiles = await emitSdk(manifest);
  const sdkSource = bundleSdkSource(sdkFiles);

  const pageUrl = `${cfg.wpUrl}${cfg.pagePath.startsWith("/") ? cfg.pagePath : `/${cfg.pagePath}`}`;
  console.log(`→ Fetching page HTML: ${pageUrl}`);
  const pageHtml = await fetchPageHtml(cfg.wpUrl, cfg.pagePath);
  console.log(`  ${pageHtml.length} chars after stripping scripts/styles/svgs.`);

  const userPrompt = buildUserPrompt({
    wpUrl: cfg.wpUrl,
    pageUrl,
    pagePath: cfg.pagePath,
    pageHtml,
    abilitiesSummary: summarizeAbilities(manifest),
    sdkSource,
  });

  console.log(`→ Calling Claude (${MODEL})…`);
  const t0 = Date.now();
  const client = new Anthropic({ apiKey: cfg.apiKey });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });
  const elapsedMs = Date.now() - t0;

  const textBlocks = response.content.filter(
    (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
  );
  const fullText = textBlocks.map((b) => b.text).join("\n");
  const code = extractCodeBlock(fullText);

  const outDir = resolve(
    HERE,
    "..",
    "output",
    `${isoCompact(new Date())}-${urlSlug(cfg.wpUrl)}`,
  );
  await mkdir(outDir, { recursive: true });

  if (code) {
    await writeFile(resolve(outDir, "page.tsx"), code, "utf8");
  } else {
    console.warn("⚠ No code block found in response — saving raw text");
    await writeFile(resolve(outDir, "raw-response.md"), fullText, "utf8");
  }

  const meta = {
    timestamp: new Date().toISOString(),
    elapsedMs,
    model: MODEL,
    wpUrl: cfg.wpUrl,
    pagePath: cfg.pagePath,
    abilityPrefix: cfg.abilityPrefix,
    abilityCount: manifest.abilities.length,
    pageHtmlChars: pageHtml.length,
    sdkSourceChars: sdkSource.length,
    usage: response.usage,
    stopReason: response.stop_reason,
    extractedCode: Boolean(code),
  };
  await writeFile(
    resolve(outDir, "meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8",
  );
  await writeFile(
    resolve(outDir, "system-prompt.md"),
    SYSTEM_PROMPT,
    "utf8",
  );
  await writeFile(
    resolve(outDir, "user-prompt.md"),
    userPrompt,
    "utf8",
  );

  console.log(``);
  console.log(`✓ Output: ${outDir}`);
  console.log(`  Tokens: in=${response.usage.input_tokens}, out=${response.usage.output_tokens}`);
  console.log(`  Wall:   ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`  Stop:   ${response.stop_reason}`);
  if (!code) {
    console.log(``);
    console.log(`⚠ Could not extract a tsx code block from the response.`);
    console.log(`  See raw-response.md to debug the prompt.`);
  }
}

main().catch((err) => {
  console.error("✗ Failed:", err);
  process.exit(1);
});
