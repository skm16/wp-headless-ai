/**
 * `wpheadless sync` — re-pull the manifest and regenerate the SDK in one step.
 *
 * Reads `.skm/config.json` for connection + auth details (written by `init`),
 * runs the same fetch flow as `init` to refresh `.skm/manifest.json`, then
 * runs the same emit flow as `generate` to refresh `lib/sdk/*`.
 *
 * No new architecture — just a thin orchestrator over runInit + runGenerate.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInit } from "./init.js";
import { runGenerate } from "./generate.js";
import { relaxTlsForLocalDev } from "../util/local-dev.js";

export interface SyncOptions {
  /** Project directory containing `.skm/config.json`. Defaults to "." in the caller. */
  projectDir: string;
  /** Disable TLS verification for self-signed staging hosts. Auto-applied for .local/.test. */
  insecure?: boolean;
}

interface PersistedConfig {
  wpUrl: string;
  user: string;
  password: string;
  namespace?: string;
  serverRoute?: string;
  prefix?: string;
}

export async function runSync(opts: SyncOptions): Promise<void> {
  const configPath = path.resolve(opts.projectDir, ".skm", "config.json");
  let config: PersistedConfig;
  try {
    const raw = await readFile(configPath, "utf8");
    config = JSON.parse(raw) as PersistedConfig;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `No saved config found at ${configPath}. Run \`wpheadless init <wp-url> --user=... --password=...\` first.`,
      );
    }
    throw new Error(
      `Could not read ${configPath}: ${(err as Error).message}`,
    );
  }

  if (!config.wpUrl || !config.user || !config.password) {
    throw new Error(
      `${configPath} is missing required fields (wpUrl, user, password). Re-run init.`,
    );
  }

  // Apply TLS relaxation here (in addition to inside runInit) so the warning
  // — if any — prints once at the top of the run, not after the "Refreshing"
  // line that suggests a network call has already started.
  relaxTlsForLocalDev(config.wpUrl, { insecure: opts.insecure });

  console.log(`→ Refreshing manifest for ${config.wpUrl}`);
  await runInit(config.wpUrl, {
    user: config.user,
    password: config.password,
    output: opts.projectDir,
    prefix: config.prefix,
    insecure: opts.insecure,
  });

  console.log(`\n→ Regenerating SDK from refreshed manifest`);
  await runGenerate({ projectDir: opts.projectDir });
}
