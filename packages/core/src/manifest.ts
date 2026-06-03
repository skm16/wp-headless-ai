/**
 * `fetchManifest` — pure-function manifest discovery.
 *
 * Talks to a WordPress install exposing the MCP Adapter, runs the standard
 * MCP handshake + ability discovery flow, and returns a typed `Manifest`
 * object. NO I/O assumptions — does not read or write the filesystem,
 * does not log to stdout, does not read env vars or prompt for input.
 *
 * Callers (CLI's runInit, SaaS worker's onboarding step) handle their
 * own concerns:
 *   - File writes (manifest.json, config.json) — CLI's job
 *   - DB persistence — SaaS worker's job
 *   - Progress reporting — both subscribe via the optional onProgress callback
 *   - Credential prompting — CLI's job
 *   - TLS relaxation for local-dev hosts — caller sets NODE_TLS_REJECT_UNAUTHORIZED before invoking
 *
 * Throws `McpClientError` on transport / auth / protocol failures.
 */

import { Buffer } from "node:buffer";
import { McpClient, McpClientError } from "./mcp/client.js";
import {
  MANIFEST_SCHEMA_VERSION,
  type AbilityManifestEntry,
  type Manifest,
} from "./types/manifest.js";

const DEFAULT_NAMESPACE = "mcp";
const DEFAULT_SERVER_ROUTE = "mcp-adapter-default-server";
const DEFAULT_PREFIX = "jab/";

export interface FetchManifestOptions {
  wpUrl: string;
  user: string;
  password: string;
  /** Filter abilities by name prefix. Defaults to "jab/". */
  prefix?: string;
  /** MCP server namespace. Defaults to "mcp". */
  namespace?: string;
  /** MCP server route slug. Defaults to "mcp-adapter-default-server". */
  serverRoute?: string;
  /** Optional progress callback for callers that want to render activity. */
  onProgress?: (event: FetchManifestProgress) => void;
}

export type FetchManifestProgress =
  | { kind: "connecting"; endpoint: string }
  | {
      kind: "discovered";
      total: number;
      matched: number;
      prefix: string;
    }
  | {
      kind: "ability";
      name: string;
      index: number;
      matched: number;
    };

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

export async function fetchManifest(
  opts: FetchManifestOptions,
): Promise<Manifest> {
  const namespace = opts.namespace ?? DEFAULT_NAMESPACE;
  const serverRoute = opts.serverRoute ?? DEFAULT_SERVER_ROUTE;
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  const wpUrl = opts.wpUrl.replace(/\/+$/, "");

  const endpoint = `${wpUrl}/wp-json/${namespace}/${serverRoute}`;
  opts.onProgress?.({ kind: "connecting", endpoint });

  const client = new McpClient({
    wpUrl,
    user: opts.user,
    password: opts.password,
    namespace,
    serverRoute,
  });

  // Sanity-check the connection by listing tools. Catches network/auth
  // errors here with a clearer message than mid-discovery.
  const toolsList = await client.listTools();
  if (!Array.isArray(toolsList.tools) || toolsList.tools.length === 0) {
    throw new McpClientError(
      "Server returned an empty tools list. Is the MCP Adapter active and at least one ability marked meta.mcp.public => true?",
    );
  }

  const discoverResult = await client.callTool<DiscoverAbilitiesResult>(
    "mcp-adapter-discover-abilities",
  );
  if (discoverResult.isError) {
    throw new McpClientError(
      `mcp-adapter-discover-abilities returned isError=true: ${textOf(discoverResult)}`,
    );
  }

  const allAbilities = discoverResult.structuredContent?.abilities ?? [];
  const matched = prefix === ""
    ? allAbilities
    : allAbilities.filter((a) => a.name.startsWith(prefix));

  if (matched.length === 0) {
    // Surface the actual prefixes available so the caller can self-correct
    // without having to inspect the WP install. "skm/" instead of "jab/"
    // (pre-rebrand plugin), "wp/" (WP core MCP), or none at all are all
    // common cases.
    const prefixesFound = Array.from(
      new Set(
        allAbilities
          .map((a) => {
            const slash = a.name.indexOf("/");
            return slash > 0 ? a.name.slice(0, slash + 1) : "(none)";
          }),
      ),
    ).sort();
    throw new McpClientError(
      `Found ${allAbilities.length} public ability(ies) but none matched prefix "${prefix}". Available prefixes: ${prefixesFound.join(", ")}. Pass an empty prefix to fetch all abilities.`,
    );
  }

  opts.onProgress?.({
    kind: "discovered",
    total: allAbilities.length,
    matched: matched.length,
    prefix,
  });

  const entries: AbilityManifestEntry[] = [];
  for (let i = 0; i < matched.length; i++) {
    const ability = matched[i]!;
    opts.onProgress?.({
      kind: "ability",
      name: ability.name,
      index: i,
      matched: matched.length,
    });

    const info = await client.callTool<AbilityInfoResult>(
      "mcp-adapter-get-ability-info",
      { ability_name: ability.name },
    );
    if (info.isError || !info.structuredContent) {
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
  }

  // Keystone: capture the plugin version from the REST manifest envelope.
  // Fail-soft — a null version never blocks discovery.
  const pluginVersion = await fetchPluginVersion({
    wpUrl,
    user: opts.user,
    password: opts.password,
  });

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    source: wpUrl,
    fetchedAt: new Date().toISOString(),
    server: {
      namespace,
      route: serverRoute,
    },
    abilities: entries,
    pluginVersion,
  };
}

function textOf(result: { content?: Array<{ text: string }> }): string {
  return result.content?.[0]?.text ?? "(no error text)";
}

/**
 * Pull the `plugin_version` string from a REST `/wp-json/jab/v1/manifest`
 * (or `/site`) response body. Pure + defensive: any non-object body, missing
 * key, or non-string value yields null. Whitespace is trimmed; an
 * all-whitespace value is treated as absent.
 */
export function parsePluginVersion(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { plugin_version?: unknown }).plugin_version;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Fail-soft supplemental fetch of the plugin version. GETs the REST
 * `/wp-json/jab/v1/manifest` envelope (reachable at the `read` cap the probe
 * already requires) and returns its `plugin_version`. ANY failure — non-200,
 * network error, malformed JSON, missing field — resolves to null so manifest
 * discovery is never blocked by a version probe. No SSRF guard here by design:
 * `@jab/core` makes no I/O-safety assumptions; the caller (probe → onboarding)
 * guards the hostname before this runs.
 */
export async function fetchPluginVersion(opts: {
  wpUrl: string;
  user: string;
  password: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const wpUrl = opts.wpUrl.replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString("base64")}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8_000);
  try {
    const res = await fetch(`${wpUrl}/wp-json/jab/v1/manifest`, {
      method: "GET",
      headers: { Authorization: auth, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return parsePluginVersion(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
