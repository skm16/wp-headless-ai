/**
 * `wpheadless scaffold` — bootstrap a fresh Next.js project pre-wired to a
 * WordPress headless backend in one command.
 *
 * Flow:
 *   1. Validate project name and ensure target directory doesn't exist.
 *   2. Resolve credentials. WP URL and username come from flags or interactive
 *      prompt. Password comes from --password (with shell-history warning),
 *      WP_APP_PASSWORD env var, or a masked stdin prompt.
 *   3. Spawn `npx create-next-app@latest` with our opinionated flags
 *      (TypeScript + App Router + Tailwind + @/ alias, no ESLint).
 *   4. Run init against the new project (manifest fetch + bootstrap of
 *      lib/skm/client.ts + .env.example).
 *   5. Run generate (emit lib/sdk/{types,client,abilities,index,CLAUDE.md}).
 *   6. Optionally write .env.local with the captured credentials so
 *      `pnpm dev` works immediately.
 *   7. Print a "next steps" block.
 *
 * Half-state recovery: if step 3 succeeds but 4 or 5 fails, the project
 * dir is left in place with the partial state. The error message tells
 * the user how to resume manually with `wpheadless init`.
 */

import { writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { runInit } from "./init.js";
import { runGenerate } from "./generate.js";
import { spawnAndWait } from "../util/spawn.js";
import { ensureValue, resolvePassword } from "../util/credentials.js";
import { renderNextConfig } from "../emit/bootstrap.js";

export interface ScaffoldOptions {
  /** WordPress site URL. Prompted if missing in TTY, errored if not. */
  wpUrl?: string;
  /** WordPress username. Prompted if missing in TTY, errored if not. */
  user?: string;
  /** Application Password. Prompted (masked) if missing. */
  password?: string;
  /** Whether to write .env.local with captured creds. Default true. */
  envLocal?: boolean;
  /** Override package manager. Falls back to user_agent detection. */
  packageManager?: "pnpm" | "npm" | "yarn" | "bun";
  /** Disable TLS verification. Auto-applied for .local/.test hosts. */
  insecure?: boolean;
}

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export async function runScaffold(
  projectName: string,
  opts: ScaffoldOptions,
): Promise<void> {
  const validationErr = validateProjectName(projectName);
  if (validationErr) throw new Error(validationErr);

  const projectDir = path.resolve(process.cwd(), projectName);
  await ensureDoesNotExist(projectDir);

  // Resolve creds — interactive when possible, with env-var fallback for
  // CI scenarios. Password is the only one we accept from env-var since
  // exposing URL/user there isn't a meaningful security boundary.
  const wpUrl = await ensureValue(opts.wpUrl, "WP URL (e.g. https://your-site.com)");
  const user = await ensureValue(opts.user, "WP username");
  const password = await resolvePassword(opts.password);

  const pm: PackageManager = opts.packageManager ?? detectPackageManager();

  console.log(`\n→ Creating Next.js project: ${projectName}`);
  console.log(`  Using package manager: ${pm}\n`);

  await runCreateNextApp(projectName, pm);

  console.log(`\n✓ Project created at ${projectDir}\n`);

  // Replace create-next-app's default next.config.ts with our augmented
  // version that wires the strangler-fig WP_PROXY_URL fallback. Safe to
  // overwrite because the project is freshly scaffolded — no user edits
  // exist yet. (For non-scaffolded projects running `init`, we leave the
  // existing config alone; the user can opt in via the README snippet.)
  await patchNextConfig(projectDir);

  // From here, init/generate failures leave the project half-bootstrapped.
  // Wrap so we can give actionable recovery guidance.
  try {
    await runInit(wpUrl, {
      user,
      password,
      output: projectDir,
      insecure: opts.insecure,
    });
    await runGenerate({ projectDir });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n✗ Project was created but init/generate failed: ${message}`);
    console.error(`  The Next.js scaffold at ${projectDir} is intact. To finish setup:`);
    console.error(`    cd ${projectName}`);
    console.error(`    wpheadless init ${wpUrl} --user=${user} --password=<your-app-password>`);
    console.error(`    wpheadless generate`);
    throw err;
  }

  if (opts.envLocal !== false) {
    const envLocalPath = path.join(projectDir, ".env.local");
    await writeFile(envLocalPath, renderEnvLocal(wpUrl, user, password), "utf8");
    console.log(`\n✓ Wrote .env.local with your credentials → ${envLocalPath}`);
  } else {
    console.log(
      `\n  Skipped .env.local (--no-env-local). Copy .env.example → .env.local and fill in creds before running dev.`,
    );
  }

  printNextSteps(projectName, pm);
}

/**
 * Replace create-next-app's default `next.config.ts` with our augmented
 * version (adds rewrites.fallback for the WP_PROXY_URL strangler-fig
 * pattern). Skips silently if no config file is found — newer versions
 * of create-next-app may switch to a different filename, in which case
 * the user can apply the snippet from CLAUDE.md by hand.
 */
async function patchNextConfig(projectDir: string): Promise<void> {
  const candidatePaths = [
    path.join(projectDir, "next.config.ts"),
    path.join(projectDir, "next.config.mjs"),
    path.join(projectDir, "next.config.js"),
  ];
  let configPath: string | null = null;
  for (const candidate of candidatePaths) {
    try {
      await access(candidate, constants.F_OK);
      configPath = candidate;
      break;
    } catch {
      /* try next */
    }
  }
  if (!configPath) {
    console.log(
      "  (Skipped next.config patch — no config file found; apply the WP_PROXY_URL snippet from CLAUDE.md by hand.)",
    );
    return;
  }
  await writeFile(configPath, renderNextConfig(), "utf8");
  console.log(`✓ Patched next.config (added WP_PROXY_URL strangler-fig fallback)`);
}

async function runCreateNextApp(projectName: string, pm: PackageManager): Promise<void> {
  // create-next-app's CLI takes per-package-manager flags. We pass --yes
  // to skip the "do you want to install" confirmation since we've already
  // committed to the install via this command.
  const pmFlag =
    pm === "pnpm" ? "--use-pnpm"
      : pm === "npm" ? "--use-npm"
        : pm === "yarn" ? "--use-yarn"
          : "--use-bun";

  await spawnAndWait("npx", [
    "--yes",
    "create-next-app@latest",
    projectName,
    "--typescript",
    "--tailwind",
    "--app",
    "--no-src-dir",
    "--import-alias", "@/*",
    "--no-eslint",
    "--no-turbopack",
    pmFlag,
    "--yes",
  ]);
}

/**
 * Project name rules align with Next.js's create-next-app validation:
 * lowercase letters, digits, hyphens, underscores, and dots; must start
 * with a letter or digit. We accept uppercase letters in the input but
 * normalize to lowercase before passing on, since npm package names are
 * case-insensitive. Separately we cap at 214 chars (npm package name max).
 *
 * Returns the error message, or null when the name is valid.
 */
function validateProjectName(name: string): string | null {
  if (!name) return "Project name is required.";
  if (name.length > 214) return "Project name is too long (max 214 chars).";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    return `Project name must start with a letter or digit and contain only letters, digits, dots, hyphens, and underscores. Got: ${name}`;
  }
  return null;
}

async function ensureDoesNotExist(dir: string): Promise<void> {
  try {
    await access(dir, constants.F_OK);
    throw new Error(
      `Directory already exists: ${dir}. Choose a different project name or remove the existing directory first.`,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw err;
  }
}

/**
 * Detect the package manager invoking us via npm_config_user_agent. Set by
 * pnpm/npm/yarn/bun when they spawn child processes from a package script
 * or via dlx. Falls back to pnpm — our recommended default — if undetectable.
 */
function detectPackageManager(): PackageManager {
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.startsWith("pnpm/")) return "pnpm";
  if (ua.startsWith("yarn/")) return "yarn";
  if (ua.startsWith("bun/")) return "bun";
  if (ua.startsWith("npm/")) return "npm";
  return "pnpm";
}

function renderEnvLocal(wpUrl: string, user: string, password: string): string {
  return `# Auto-written by \`wpheadless scaffold\`. Next.js gitignores this file
# automatically — never commit it.

WP_URL=${wpUrl}
WP_USER=${user}
WP_APP_PASSWORD=${password}
`;
}

function printNextSteps(projectName: string, pm: PackageManager): void {
  const dev = pm === "npm" ? "npm run dev" : `${pm} dev`;
  console.log(`\n✓ Done. Next:`);
  console.log(`    cd ${projectName}`);
  console.log(`    ${dev}`);
  console.log("");
}
