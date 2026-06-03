import { Buffer } from "node:buffer";
import { type SiteManifest, isSiteManifest } from "./types/site.js";

/**
 * Fail-soft fetch of GET /wp-json/jab/v1/site (plugin v0.7.0+). Returns null
 * on any non-200 (a pre-v0.7.0 plugin 404s the route), network error, or a
 * body that fails the structural guard. No SSRF guard by design — the caller
 * guards the hostname (CLI runs against operator-supplied URLs; the app uses
 * its own redirect-manual wpRestFetch path instead of this helper).
 */
export async function fetchSiteManifest(opts: {
  wpUrl: string;
  user: string;
  password: string;
  timeoutMs?: number;
}): Promise<SiteManifest | null> {
  const wpUrl = opts.wpUrl.replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString("base64")}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8_000);
  try {
    const res = await fetch(`${wpUrl}/wp-json/jab/v1/site`, {
      method: "GET",
      headers: { Authorization: auth, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isSiteManifest(body) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
