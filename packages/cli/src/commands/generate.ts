/**
 * `jab generate` — read the manifest written by `init` and emit the typed SDK.
 *
 * Thin orchestrator over `@jab/core`'s `emitSdk()`. The pure compile +
 * render work lives in core; this command handles disk I/O and progress
 * logging.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  emitSdk,
  MANIFEST_SCHEMA_VERSION,
  type Manifest,
} from "@jab/core";

export interface GenerateOptions {
  /** Project directory containing `.jab/manifest.json`. Defaults to "." in the caller. */
  projectDir: string;
}

export async function runGenerate(opts: GenerateOptions): Promise<void> {
  const manifestPath = path.resolve(opts.projectDir, ".jab", "manifest.json");
  const manifest = await loadManifest(manifestPath);

  console.log(`→ Loaded manifest from ${manifestPath}`);
  console.log(`  source:     ${manifest.source}`);
  console.log(`  fetchedAt:  ${manifest.fetchedAt}`);
  console.log(`  abilities:  ${manifest.abilities.length}`);
  console.log(`  plugin:     ${manifest.pluginVersion ?? "unknown (pre-v0.7.0)"}`);

  const files = await emitSdk(manifest, {
    onProgress: (event) => {
      if (event.kind === "ability") {
        process.stdout.write(`  → ${event.name} … ok\n`);
      }
    },
  });

  const outDir = path.resolve(opts.projectDir, "lib", "sdk");
  await mkdir(outDir, { recursive: true });

  for (const [filename, contents] of files) {
    const outPath = path.join(outDir, filename);
    await writeFile(outPath, contents, "utf8");
  }

  console.log(`\n✓ Wrote SDK to ${outDir}`);
  console.log(`    - types.ts      (${manifest.abilities.length * 2} type(s))`);
  console.log(`    - client.ts     (portable MCP HTTP client, zero deps)`);
  console.log(`    - abilities.ts  (${manifest.abilities.length} typed function(s))`);
  console.log(`    - index.ts      (barrel)`);
  console.log(`    - CLAUDE.md     (generated SDK reference for Claude Code)`);
}

async function loadManifest(manifestPath: string): Promise<Manifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `Manifest not found at ${manifestPath}. Run \`jab init <wp-url>\` first.`,
      );
    }
    throw err;
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(raw) as Manifest;
  } catch (err) {
    throw new Error(
      `Manifest at ${manifestPath} is not valid JSON: ${(err as Error).message}`,
    );
  }

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Manifest schemaVersion ${manifest.schemaVersion} is not supported by this CLI (expected ${MANIFEST_SCHEMA_VERSION}). Re-run \`init\` to refresh.`,
    );
  }
  if (!Array.isArray(manifest.abilities) || manifest.abilities.length === 0) {
    throw new Error(`Manifest at ${manifestPath} contains no abilities.`);
  }
  return manifest;
}
