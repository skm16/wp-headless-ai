/**
 * `wpheadless init` — discover abilities on a WP install and persist the manifest.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { McpClient, McpClientError } from "../mcp/client.js";
import {
  MANIFEST_SCHEMA_VERSION,
  type AbilityManifestEntry,
  type Manifest,
} from "../types/manifest.js";
import { relaxTlsForLocalDev } from "../util/local-dev.js";

export interface InitOptions {
  user: string;
  password: string;
  output: string;
  /** Filter abilities by name prefix. Defaults to "skm/". */
  prefix?: string;
  /** Disable TLS verification for self-signed staging hosts. Auto-applied for .local/.test. */
  insecure?: boolean;
}

interface DiscoveredAbility {
  name: string;
  label: string;
  description: string;
}

interface DiscoverAbilitiesResult {
  abilities: DiscoveredAbility[];
}

interface AbilityInfoResult {
  name: string;
  label: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

const NAMESPACE = "mcp";
const SERVER_ROUTE = "mcp-adapter-default-server";

export async function runInit(wpUrl: string, opts: InitOptions): Promise<void> {
  relaxTlsForLocalDev(wpUrl, { insecure: opts.insecure });

  const prefix = opts.prefix ?? "skm/";
  const client = new McpClient({
    wpUrl,
    user: opts.user,
    password: opts.password,
    namespace: NAMESPACE,
    serverRoute: SERVER_ROUTE,
  });

  console.log(`→ Connecting to ${wpUrl}/wp-json/${NAMESPACE}/${SERVER_ROUTE}`);

  // Sanity-check the connection by listing tools. If this fails the user gets
  // a clear network/auth error before we attempt any discovery work.
  const toolsList = await client.listTools();
  if (!Array.isArray(toolsList.tools) || toolsList.tools.length === 0) {
    throw new McpClientError(
      "Server returned an empty tools list. Is the MCP Adapter active and at least one ability marked meta.mcp.public => true?",
    );
  }

  console.log(`→ Discovering public abilities (prefix: ${prefix})`);
  const discoverResult = await client.callTool<DiscoverAbilitiesResult>(
    "mcp-adapter-discover-abilities",
  );
  if (discoverResult.isError) {
    throw new McpClientError(
      `mcp-adapter-discover-abilities returned isError=true: ${textOf(discoverResult)}`,
    );
  }
  const allAbilities = discoverResult.structuredContent?.abilities ?? [];
  const matched = allAbilities.filter((a) => a.name.startsWith(prefix));

  if (matched.length === 0) {
    throw new McpClientError(
      `Found ${allAbilities.length} public ability(ies) but none matched prefix "${prefix}". Try --prefix=<your-prefix> or remove the filter.`,
    );
  }

  console.log(
    `  found ${matched.length} ability(ies)${
      allAbilities.length > matched.length
        ? ` (skipping ${allAbilities.length - matched.length} non-matching)`
        : ""
    }`,
  );

  const entries: AbilityManifestEntry[] = [];
  for (const ability of matched) {
    process.stdout.write(`  → ${ability.name} … `);
    const info = await client.callTool<AbilityInfoResult>(
      "mcp-adapter-get-ability-info",
      { ability_name: ability.name },
    );
    if (info.isError || !info.structuredContent) {
      console.log("FAILED");
      throw new McpClientError(
        `mcp-adapter-get-ability-info failed for ${ability.name}: ${textOf(info)}`,
      );
    }
    const data = info.structuredContent;
    entries.push({
      name: data.name,
      label: data.label,
      description: data.description,
      inputSchema: data.input_schema,
      outputSchema: data.output_schema,
      meta: data.meta,
    });
    console.log("ok");
  }

  const manifest: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    source: wpUrl.replace(/\/+$/, ""),
    fetchedAt: new Date().toISOString(),
    server: {
      namespace: NAMESPACE,
      route: SERVER_ROUTE,
    },
    abilities: entries,
  };

  const outDir = path.resolve(opts.output, ".skm");
  const outPath = path.join(outDir, "manifest.json");
  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  // Persist auth + connection details for `wpheadless sync` to reuse later.
  // This file MUST stay out of version control (.gitignored automatically
  // by the standard root .gitignore for `.skm/` if user adopted ours, but
  // we also write a per-directory .gitignore as belt-and-suspenders).
  const configPath = path.join(outDir, "config.json");
  const config = {
    wpUrl: wpUrl.replace(/\/+$/, ""),
    user: opts.user,
    password: opts.password,
    namespace: NAMESPACE,
    serverRoute: SERVER_ROUTE,
    prefix,
  };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  await writeFile(
    path.join(outDir, ".gitignore"),
    "# Created by wpheadless. Local-only auth/config — never commit.\nconfig.json\n",
    "utf8",
  );

  console.log(`\n✓ Wrote manifest with ${entries.length} ability(ies) → ${outPath}`);
  console.log(`  Saved auth/config (gitignored)         → ${configPath}`);
}

function textOf(result: { content?: Array<{ text: string }> }): string {
  return result.content?.[0]?.text ?? "(no error text)";
}
