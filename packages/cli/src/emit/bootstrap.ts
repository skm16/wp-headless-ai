/**
 * Writes the project's hand-crafted glue files on first init.
 *
 * Each file is written ONLY when missing — never overwritten:
 *   - `lib/jab/client.ts`        — server-only env-driven SDK client wrapper
 *   - `.env.example`             — sample env vars the dev copies to `.env.local`
 *   - `app/[[...slug]]/route.ts` — strangler-fig catch-all proxy
 *
 * These files are *project policy*, not regenerated artifacts. After init
 * writes them once, the dev owns them — they survive `jab sync`,
 * accept hand edits (logging, retry policy, custom error formatting),
 * and only get touched again if the dev deletes them.
 *
 * The split mirrors lib/sdk/ (regenerated, never edited) vs lib/jab/
 * (hand-crafted, persists). Init bootstrapping the glue layer eliminates
 * the "the SDK exists but how do I instantiate it" friction beat that
 * every new agency dev hits 30 seconds in.
 *
 * The actual file *contents* (the templates) come from `@jab/core`'s
 * `renderJabClient`/`renderEnvExample`/`renderProxyRoute` — same templates
 * the SaaS worker uses when scaffolding a fresh GitHub repo. This module
 * is just the local-disk write half.
 */

import { mkdir, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import {
  renderJabClient,
  renderEnvExample,
  renderProxyRoute,
} from "@jab/core";

export interface BootstrapResult {
  /** Files written. Empty when both already existed. */
  written: string[];
  /** Files left alone because they already existed. */
  skipped: string[];
}

/**
 * Write the project's glue scaffolding (jab/client.ts + .env.example +
 * the strangler-fig catch-all proxy route) into `projectDir`, skipping
 * any file that already exists. Returns a record of what changed so the
 * caller can log it.
 */
export async function writeProjectScaffolding(
  projectDir: string,
): Promise<BootstrapResult> {
  const written: string[] = [];
  const skipped: string[] = [];

  const jabClientPath = path.resolve(projectDir, "lib", "jab", "client.ts");
  if (await fileExists(jabClientPath)) {
    skipped.push(jabClientPath);
  } else {
    await mkdir(path.dirname(jabClientPath), { recursive: true });
    await writeFile(jabClientPath, renderJabClient(), "utf8");
    written.push(jabClientPath);
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
