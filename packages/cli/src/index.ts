/**
 * wpheadless — CLI entry point.
 */

import { Command } from "commander";
import { runGenerate } from "./commands/generate.js";
import { runInit } from "./commands/init.js";
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
  .action(async (wpUrl: string, opts: { user: string; password: string; output: string; prefix: string }) => {
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
  .action(async (projectDir: string) => {
    try {
      await runSync({ projectDir });
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

program.parseAsync(process.argv);
