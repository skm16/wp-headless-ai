/**
 * Manifest — the persisted shape of a discovered abilities catalog.
 *
 * Versioned so that future `generate` commands can detect and refuse to
 * run on incompatible manifests. Bump `schemaVersion` whenever the shape
 * of `AbilityManifestEntry` or `Manifest` itself changes incompatibly.
 */

export const MANIFEST_SCHEMA_VERSION = 1;

export interface Manifest {
  /** Bumped on incompatible shape changes. */
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  /** Source WP site URL (no trailing slash). */
  source: string;
  /** ISO 8601 timestamp of when this manifest was fetched. */
  fetchedAt: string;
  /** WP server identifiers — useful for debugging mismatches across environments. */
  server: {
    namespace: string;
    route: string;
  };
  /** All abilities the CLI generated typings for. */
  abilities: AbilityManifestEntry[];
}

export interface AbilityManifestEntry {
  /** Ability name as registered in WP, e.g. "jab/get-posts". */
  name: string;
  /** Human label from `mcp-adapter-get-ability-info`. */
  label: string;
  /** Description from `mcp-adapter-get-ability-info`. */
  description: string;
  /** JSON Schema for the ability's input. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema for the ability's output. May be undefined if the ability declared none. */
  outputSchema?: Record<string, unknown>;
  /** Per-ability metadata (e.g. mcp.public, annotations). */
  meta?: Record<string, unknown>;
}
