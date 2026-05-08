import "server-only";
import { fetchManifest, McpClientError, type Manifest } from "@jab/core";

/**
 * Probe a WordPress install for the Jab plugin and fetch its manifest.
 *
 * Wraps `@jab/core`'s `fetchManifest` with a UI-friendly result shape:
 * success/failure with a clean error message, no exceptions for the caller
 * to filter through. Server actions consume this directly.
 *
 * Errors that surface to the user are mostly:
 *   - "MCP endpoint not reachable" → URL wrong, plugin not active, or HTTPS
 *     cert issue (we do NOT relax TLS here — agencies must use real HTTPS)
 *   - "Authentication failed" → bad app password
 *   - "No abilities matched prefix jab/" → plugin is installed but hasn't
 *     registered abilities (older plugin version, or activation didn't run)
 */
export type ProbeResult =
  | { ok: true; manifest: Manifest; abilityCount: number }
  | { ok: false; error: string };

export interface ProbeInput {
  wpUrl: string;
  username: string;
  appPassword: string;
}

export async function probeWordPress(input: ProbeInput): Promise<ProbeResult> {
  try {
    const manifest = await fetchManifest({
      wpUrl: input.wpUrl,
      user: input.username,
      password: input.appPassword,
    });
    return {
      ok: true,
      manifest,
      abilityCount: manifest.abilities.length,
    };
  } catch (err) {
    if (err instanceof McpClientError) {
      return { ok: false, error: err.message };
    }
    if (err instanceof Error) {
      // Most non-McpClientError failures here are network — fetch DNS, TCP,
      // or TLS errors. Surface the raw cause so the user has something to
      // search for.
      return { ok: false, error: err.message };
    }
    return { ok: false, error: String(err) };
  }
}
