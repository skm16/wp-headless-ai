/**
 * wpheadless — CLI entry point.
 */

import { Command } from "commander";
import { runGenerate } from "./commands/generate.js";
import { runInit } from "./commands/init.js";
import { runScaffold } from "./commands/scaffold.js";
import { runSync } from "./commands/sync.js";
import { McpClientError } from "./mcp/client.js";

const program = new Command();

program
  .name("wpheadless")
  .description(
    "Generate a typed Next.js project from a WordPress site exposing the MCP Adapter.",
  )
  .version("0.1.0");

program
  .command("init")
  .description(
    "Discover abilities on a WordPress install and persist the manifest to ./.skm/manifest.json.",
  )
  .argument(
    "<wp-url>",
    "Full URL of the target WordPress site (e.g. https://example.com)",
  )
  .requiredOption("--user <username>", "WordPress username")
  .requiredOption(
    "--password <password>",
    "WordPress Application Password (generate one in your WP profile)",
  )
  .option("--output <dir>", "Directory to write .skm/manifest.json into", ".")
  .option(
    "--prefix <prefix>",
    'Only include abilities whose name starts with this prefix. Default: "skm/"',
    "skm/",
  )
  .option(
    "--insecure",
    "Disable TLS verification (for self-signed certs on staging etc). Auto-applied for .local/.test hosts.",
    false,
  )
  .action(async (wpUrl: string, opts: { user: string; password: string; output: string; prefix: string; insecure: boolean }) => {
    try {
      await runInit(wpUrl, opts);
    } catch (err) {
      if (err instanceof McpClientError) {
        console.error(`\n✗ ${err.message}`);
      } else if (err instanceof Error) {
        console.error(`\n✗ ${err.name}: ${err.message}`);
      } else {
        console.error("\n✗ Unknown error:", err);
      }
      process.exitCode = 1;
    }
  });

program
  .command("generate")
  .description(
    "Read .skm/manifest.json and emit TypeScript types to <project-dir>/lib/sdk/types.ts.",
  )
  .argument(
    "[project-dir]",
    "Directory containing the .skm/manifest.json. Defaults to current working directory.",
    ".",
  )
  .action(async (projectDir: string) => {
    try {
      await runGenerate({ projectDir });
    } catch (err) {
      if (err instanceof McpClientError) {
        console.error(`\n✗ ${err.message}`);
      } else if (err instanceof Error) {
        console.error(`\n✗ ${err.message}`);
      } else {
        console.error("\n✗ Unknown error:", err);
      }
      process.exitCode = 1;
    }
  });

program
  .command("sync")
  .description(
    "Refresh .skm/manifest.json from the saved WP URL and regenerate the SDK. Reads .skm/config.json (written by init) for credentials.",
  )
  .argument(
    "[project-dir]",
    "Directory containing the .skm/ folder. Defaults to current working directory.",
    ".",
  )
  .option(
    "--insecure",
    "Disable TLS verification (for self-signed certs on staging etc). Auto-applied for .local/.test hosts.",
    false,
  )
  .action(async (projectDir: string, opts: { insecure: boolean }) => {
    try {
      await runSync({ projectDir, insecure: opts.insecure });
    } catch (err) {
      if (err instanceof McpClientError) {
        console.error(`\n✗ ${err.message}`);
      } else if (err instanceof Error) {
        console.error(`\n✗ ${err.message}`);
      } else {
        console.error("\n✗ Unknown error:", err);
      }
      process.exitCode = 1;
    }
  });

program
  .command("scaffold")
  .description(
    "Bootstrap a fresh Next.js project pre-wired to a WordPress headless backend. Wraps create-next-app then runs init + generate against the new project.",
  )
  .argument("<project-name>", "Name of the new project directory (created in cwd)")
  .option("--wp-url <url>", "Full URL of the target WordPress site (prompted if omitted)")
  .option("--user <username>", "WordPress username (prompted if omitted)")
  .option(
    "--password <password>",
    "Application Password. Prefer leaving this empty so we prompt — passing it on the CLI puts it in shell history. Falls back to the WP_APP_PASSWORD env var.",
  )
  .option(
    "--package-manager <pm>",
    "Override the package manager (pnpm | npm | yarn | bun). Default: auto-detect.",
  )
  .option(
    "--no-env-local",
    "Skip writing .env.local with credentials. Default: write it so dev works immediately.",
  )
  .option(
    "--insecure",
    "Disable TLS verification (auto-applied for .local/.test hosts).",
    false,
  )
  .action(
    async (
      projectName: string,
      opts: {
        wpUrl?: string;
        user?: string;
        password?: string;
        packageManager?: "pnpm" | "npm" | "yarn" | "bun";
        envLocal: boolean;
        insecure: boolean;
      },
    ) => {
      try {
        await runScaffold(projectName, {
          wpUrl: opts.wpUrl,
          user: opts.user,
          password: opts.password,
          packageManager: opts.packageManager,
          envLocal: opts.envLocal,
          insecure: opts.insecure,
        });
      } catch (err) {
        if (err instanceof McpClientError) {
          console.error(`\n✗ ${err.message}`);
        } else if (err instanceof Error) {
          console.error(`\n✗ ${err.message}`);
        } else {
          console.error("\n✗ Unknown error:", err);
        }
        process.exitCode = 1;
      }
    },
  );

program.parseAsync(process.argv);
