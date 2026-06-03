/**
 * @jab/core — pure-function engine for the Jab kit.
 *
 * Used by:
 *   - The CLI (`@jab/wp-headless-cli`) for local file generation
 *   - The SaaS web app (`apps/web`) worker for AI-driven page generation
 *
 * No I/O assumptions: returns data structures, never reads/writes the filesystem,
 * never logs, never prompts. Callers handle persistence + UX.
 */

// Manifest types and schema version.
export {
  MANIFEST_SCHEMA_VERSION,
  type AbilityManifestEntry,
  type Manifest,
} from "./types/manifest.js";

// MCP client primitives — exported in case a caller wants to talk to a WP MCP
// server directly without going through fetchManifest (e.g. one-off tool calls).
export {
  McpClient,
  McpClientError,
  type McpClientOptions,
  type McpToolCallResult,
  type McpToolDefinition,
  type McpToolListResult,
} from "./mcp/client.js";

// High-level entry points.
export {
  fetchManifest,
  fetchPluginVersion,
  parsePluginVersion,
  type FetchManifestOptions,
  type FetchManifestProgress,
} from "./manifest.js";

// Site manifest (GET /wp-json/jab/v1/site) — shared by CLI scaffold + SaaS worker.
export { type SiteManifest, type SitePageRef, isSiteManifest } from "./types/site.js";
export { fetchSiteManifest } from "./site.js";

// Semver + plugin-version staleness helpers. Canonical home for plugin version
// comparison across the kit (the CLI's `jab sync` consumes
// describePluginVersionChange). NOTE: apps/web ships its own lib/jab/semver.ts
// predating this — a future DRY pass should migrate it to import from here.
export {
  parseSemver,
  compareSemver,
  gteSemver,
  describePluginVersionChange,
  type PluginVersionChange,
  type PluginVersionChangeKind,
} from "./semver.js";

export {
  emitSdk,
  type EmitSdkOptions,
  type EmitProgress,
} from "./sdk.js";

// Ability-name derivation utilities. Exposed because consumers may need to
// derive PascalCase / camelCase variants outside the SDK emit pipeline.
export {
  type AbilityNameMap,
  abilityNameToPascal,
  makeAbilityNames,
} from "./ability-names.js";

// Project scaffolding renderers — pure templates the CLI and SaaS worker both
// need to emit into a Next.js project on first run.
export {
  renderJabClient,
  renderEnvExample,
  renderNextConfig,
  renderProxyRoute,
} from "./proxy.js";

// Lower-level emitters — callers usually go through emitSdk() but exposing the
// individual renderers lets advanced callers (e.g. an admin panel that wants
// just the CLAUDE.md file) skip the full bundle.
export { renderClientFile } from "./emit/client.js";
export { renderAbilitiesFile } from "./emit/abilities.js";
export { renderIndexFile } from "./emit/index_barrel.js";
export { renderClaudeMdFile } from "./emit/claude_md.js";
