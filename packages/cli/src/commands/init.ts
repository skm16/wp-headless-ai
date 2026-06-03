/**
 * `jab init` — discover abilities on a WP install and persist the manifest.
 *
 * Thin orchestrator: handles all the I/O (prompts, file writes, console
 * progress) while the actual MCP discovery work lives in `@jab/core`'s
 * `fetchManifest()`. The same logic is reused by the SaaS worker — that
 * tier just persists the manifest to a database instead of disk.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchManifest, fetchSiteManifest, type FetchManifestProgress } from "@jab/core";
import { relaxTlsForLocalDev } from "../util/local-dev.js";
import { writeProjectScaffolding } from "../emit/bootstrap.js";
import { ensureValue, resolvePassword } from "../util/credentials.js";

export interface InitOptions {
  /** Optional — prompted on TTY when missing, error otherwise. */
  user?: string;
  /** Optional — prompted (masked) on TTY when missing, falls back to WP_APP_PASSWORD env var. */
  password?: string;
  output: string;
  /** Filter abilities by name prefix. Defaults to "jab/". */
  prefix?: string;
  /** Disable TLS verification for self-signed staging hosts. Auto-applied for .local/.test. */
  insecure?: boolean;
}

export async function runInit(wpUrl: string, opts: InitOptions): Promise<void> {
  relaxTlsForLocalDev(wpUrl, { insecure: opts.insecure });

  // Resolve credentials interactively when missing, with env-var fallback
  // for password. Mirrors scaffold's resolution path so direct `init`
  // invocations don't have a worse DX than the bundled scaffold.
  const user = await ensureValue(opts.user, "WP username");
  const password = await resolvePassword(opts.password);

  const prefix = opts.prefix ?? "jab/";

  const manifest = await fetchManifest({
    wpUrl,
    user,
    password,
    prefix,
    onProgress: (event: FetchManifestProgress) => {
      switch (event.kind) {
        case "connecting":
          console.log(`→ Connecting to ${event.endpoint}`);
          break;
        case "discovered":
          console.log(`→ Discovering public abilities (prefix: ${event.prefix})`);
          console.log(
            `  found ${event.matched} ability(ies)${
              event.total > event.matched
                ? ` (skipping ${event.total - event.matched} non-matching)`
                : ""
            }`,
          );
          break;
        case "ability":
          // Single-line activity per ability so a many-CPT site doesn't blow up
          // the terminal scrollback.
          process.stdout.write(`  → ${event.name} … ok\n`);
          break;
      }
    },
  });

  const outDir = path.resolve(opts.output, ".jab");
  const outPath = path.join(outDir, "manifest.json");
  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  // Persist auth + connection details for `jab sync` to reuse later.
  // This file MUST stay out of version control (.gitignored automatically
  // by the standard root .gitignore for `.jab/` if user adopted ours, but
  // we also write a per-directory .gitignore as belt-and-suspenders).
  const configPath = path.join(outDir, "config.json");
  const config = {
    wpUrl: wpUrl.replace(/\/+$/, ""),
    user,
    password,
    namespace: manifest.server.namespace,
    serverRoute: manifest.server.route,
    prefix,
  };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  await writeFile(
    path.join(outDir, ".gitignore"),
    "# Created by jab. Local-only auth/config — never commit.\nconfig.json\n",
    "utf8",
  );

  console.log(
    `\n✓ Wrote manifest with ${manifest.abilities.length} ability(ies) → ${outPath}`,
  );
  console.log(`  Saved auth/config (gitignored)         → ${configPath}`);

  // Site manifest (plugin v0.7.0+): identity, branding, front-page mode, menu
  // locations, image sizes, active theme — the structural facts a scaffold
  // wants without screen-scraping. Fail-soft: a pre-v0.7.0 plugin 404s /site,
  // so we skip the file rather than failing init.
  const site = await fetchSiteManifest({ wpUrl, user, password });
  if (site) {
    const sitePath = path.join(outDir, "site.json");
    await writeFile(sitePath, JSON.stringify(site, null, 2) + "\n", "utf8");
    console.log(`  Saved site manifest (identity/branding) → ${sitePath}`);
  } else {
    console.log("  Skipped site manifest (plugin < v0.7.0 or /site unavailable).");
  }

  // Bootstrap the project's hand-crafted glue layer. Idempotent — only
  // writes files that don't yet exist, so re-running init never clobbers
  // edits the dev has made (custom env var names, logging wrappers, etc.).
  const scaffold = await writeProjectScaffolding(opts.output);
  if (scaffold.written.length > 0) {
    console.log("");
    for (const p of scaffold.written) {
      console.log(`✓ Bootstrapped → ${p}`);
    }
    if (scaffold.written.some((p) => p.endsWith(".env.example"))) {
      console.log(
        "  Next: copy .env.example → .env.local and fill in your WP credentials.",
      );
    }
  }
}
