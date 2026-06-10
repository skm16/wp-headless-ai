import "server-only";
import { fetchManifest, McpClientError, type Manifest } from "@jab/core";
import { gteSemver } from "@jab/core";

/**
 * Probe a WordPress install for the Jab plugin and fetch its manifest.
 *
 * Wraps `@jab/core`'s `fetchManifest` with a UI-friendly result shape.
 *
 * Stage 0 v2 hardening: `probeWordPress` ALSO validates the discovered
 * manifest against `MANIFEST_V2_REQUIREMENTS` — currently that the plugin
 * exposes the `jab/get-menus` ability, which first shipped in plugin
 * v0.6.0 alongside the typed-block moat. v1's "best-effort" probe (any
 * manifest accepted) is gone; a manifest that omits a required ability
 * surfaces as `{ ok: false, error: "...plugin v0.6.0+..." }` to the caller.
 *
 * Errors that surface to the user are now:
 *   - "MCP endpoint not reachable" → URL wrong, plugin inactive, TLS issue
 *   - "Authentication failed" → bad app password
 *   - "No abilities matched prefix jab/" → plugin's old enough that no
 *     abilities are registered under the jab/ namespace
 *   - "Plugin too old — upgrade to v0.6.0 or later." → manifest discovered
 *     but missing the v2 baseline ability roster
 */
export type ProbeResult =
  | {
      ok: true;
      manifest: Manifest;
      abilityCount: number;
      pluginVersion: string | null;
      /** Non-blocking advisories (e.g. plugin older than recommended). */
      warnings: string[];
    }
  | { ok: false; error: string };

/**
 * Minimum plugin version that unlocks the full v0.7.x value surface
 * (/site, /diagnostics, modified-field incremental sync). NOT a hard floor —
 * the pipeline still runs against v0.6.0, so we warn rather than reject.
 */
export const RECOMMENDED_PLUGIN_VERSION = "0.7.0";

export interface ProbeInput {
  wpUrl: string;
  username: string;
  appPassword: string;
  /** Ability-name filter. Defaults to "jab/". Pass "" to fetch all abilities. */
  prefix?: string;
}

/**
 * The ability names the SaaS v2 component pipeline minimum-requires. If any
 * of these are absent from a freshly-fetched manifest, the plugin is older
 * than v0.6.0 and the v2 build pipeline can't run against it.
 *
 * `jab/get-menus` is the canonical v0.6.0+ shibboleth — it was added in
 * v0.6.0 alongside the typed-block moat and is not present in v0.5.x or
 * earlier. If/when the plugin starts exposing a dedicated version field
 * in the manifest, this list collapses into a single semver compare.
 */
const MANIFEST_V2_REQUIREMENTS = ["jab/get-menus"] as const;

export async function probeWordPress(input: ProbeInput): Promise<ProbeResult> {
  let manifest: Manifest;
  try {
    manifest = await fetchManifest({
      wpUrl: input.wpUrl,
      user: input.username,
      password: input.appPassword,
      prefix: input.prefix,
    });
  } catch (err) {
    if (err instanceof McpClientError) {
      return { ok: false, error: err.message };
    }
    if (err instanceof Error) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: String(err) };
  }

  // v2 acceptance gate. The fetch succeeded — auth and transport both
  // work — but the plugin is too old to drive the component pipeline.
  const abilityNames = new Set(manifest.abilities.map((a) => a.name));
  const missing = MANIFEST_V2_REQUIREMENTS.filter((name) => !abilityNames.has(name));
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `Plugin too old — upgrade to v0.6.0 or later. ` +
        `The connected install is missing required abilities: ${missing.join(", ")}.`,
    };
  }

  const pluginVersion = manifest.pluginVersion ?? null;
  const warnings: string[] = [];
  if (pluginVersion === null) {
    warnings.push(
      `Connected, but the plugin did not report a version. Upgrade to v${RECOMMENDED_PLUGIN_VERSION}+ for the /site and /diagnostics endpoints and incremental sync.`,
    );
  } else if (!gteSemver(pluginVersion, RECOMMENDED_PLUGIN_VERSION)) {
    warnings.push(
      `Plugin v${pluginVersion} is older than the recommended v${RECOMMENDED_PLUGIN_VERSION}. The build will run, but /site, /diagnostics, and incremental sync stay off until you upgrade.`,
    );
  }

  return {
    ok: true,
    manifest,
    abilityCount: manifest.abilities.length,
    pluginVersion,
    warnings,
  };
}
