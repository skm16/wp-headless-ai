import "server-only";
import { Buffer } from "node:buffer";
import type {
  OwnershipMode,
  WPContentType,
} from "@/components/ownership-picker";

/**
 * Fetch the canonical post-type catalog from the plugin's
 * `/wp-json/jab/v1/content-types` endpoint and map it onto the
 * `WPContentType[]` shape the OwnershipPicker consumes.
 *
 * Why this lives separate from `contentTypesFromManifest`:
 *   - The manifest catalog is derived from MCP ability names. It double-
 *     lists post types (list + by-slug), bakes in `-2-` collision suffixes
 *     when rest_base == singular slug, includes taxonomy + menus abilities
 *     the ownership picker shouldn't render, and carries no counts.
 *   - This endpoint returns the exact post types Registry.php targets,
 *     with WP labels (so the picker shows "Pages" not "page") and real
 *     counts via `wp_count_posts()`.
 *
 * Endpoint contract — must stay in sync with
 * `packages/wp-plugin/includes/Rest/ContentTypes.php`. If the response
 * shape drifts, the type-guard below returns null and the caller falls
 * back to the manifest heuristic.
 *
 * Failure modes:
 *   - 401/403 → user lacks `edit_posts` (shouldn't happen — they just
 *     authenticated as an admin to run the probe, but auth contexts
 *     can desync). Returns null; caller falls back.
 *   - 404 → plugin is at v0.3.0 or earlier (no `/content-types` route).
 *     Returns null; caller falls back to the manifest heuristic.
 *   - Network failure / timeout → returns null; caller falls back.
 *
 * Auth: same Basic-auth scheme `@jab/core`'s McpClient uses. The
 * normalized app password (spaces stripped, matching WP's own
 * server-side normalization) is what the caller passes here.
 */

const FETCH_TIMEOUT_MS = 8_000;

interface ContentTypesResponse {
  ok: true;
  post_types: Array<{
    slug: string;
    rest_base: string;
    plural_label: string;
    singular_label: string;
    is_builtin: boolean;
    hierarchical: boolean;
    count: number;
  }>;
}

export async function fetchContentTypes(opts: {
  wpUrl: string;
  user: string;
  password: string;
}): Promise<WPContentType[] | null> {
  let target: URL;
  try {
    target = new URL(
      "/wp-json/jab/v1/content-types",
      opts.wpUrl.replace(/\/+$/, "") + "/",
    );
  } catch {
    return null;
  }

  const auth = Buffer.from(`${opts.user}:${opts.password}`).toString("base64");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(target.toString(), {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
      signal: controller.signal,
      // Don't follow redirects into a private address. The probe step
      // already validated the hostname; redirects are unexpected here.
      redirect: "manual",
    });
  } catch (err) {
    console.warn(
      `[fetchContentTypes] failed for ${target.host}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // 404 = older plugin without this route. Anything else (401, 5xx) =
    // some other failure. Either way the caller falls back to the manifest
    // heuristic and the wizard still works, just with a less accurate
    // catalog.
    console.warn(
      `[fetchContentTypes] HTTP ${res.status} from ${target.host} — caller will fall back to manifest heuristic`,
    );
    return null;
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    console.warn(
      `[fetchContentTypes] non-JSON response from ${target.host}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  if (!isContentTypesResponse(payload)) {
    console.warn(
      `[fetchContentTypes] unexpected response shape from ${target.host}`,
    );
    return null;
  }

  return payload.post_types.map((row): WPContentType => {
    return {
      slug: row.slug,
      pluralName: row.plural_label,
      kindLabel: kindLabelFor(row),
      count: row.count,
      recommendedMode: recommendedModeFor(row.slug),
    };
  });
}

/**
 * `pages` are bespoke marketing surfaces the agency typically wants
 * Jab to own — per the SaaS transition doc §3 default rule. Everything
 * else (built-in `post`, CPTs like events / beers / etc.) defaults to
 * WP-managed.
 */
function recommendedModeFor(slug: string): OwnershipMode {
  if (slug === "page") return "jab-managed";
  return "wp-managed";
}

/**
 * Single-line context shown under the type's name in the picker. Built
 * from the registration flags WP exposes — `_builtin` distinguishes
 * the core post/page types from CPTs, and `hierarchical` is a useful
 * tell for "this type has a parent/child structure" (pages, custom
 * hierarchical CPTs).
 */
function kindLabelFor(row: {
  is_builtin: boolean;
  hierarchical: boolean;
}): string {
  if (row.is_builtin) {
    return row.hierarchical ? "Built-in hierarchical post type" : "Built-in post type";
  }
  return row.hierarchical ? "Custom hierarchical post type" : "Custom post type";
}

/**
 * Defensive type guard — the plugin endpoint's contract is well-defined
 * but we re-verify in case an older or modified version of the plugin
 * returns a different shape. False on any drift; caller falls back to
 * the manifest heuristic.
 */
function isContentTypesResponse(value: unknown): value is ContentTypesResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.ok !== true) return false;
  if (!Array.isArray(v.post_types)) return false;
  return v.post_types.every(
    (row) =>
      row != null &&
      typeof row === "object" &&
      typeof (row as Record<string, unknown>).slug === "string" &&
      typeof (row as Record<string, unknown>).rest_base === "string" &&
      typeof (row as Record<string, unknown>).plural_label === "string" &&
      typeof (row as Record<string, unknown>).singular_label === "string" &&
      typeof (row as Record<string, unknown>).is_builtin === "boolean" &&
      typeof (row as Record<string, unknown>).hierarchical === "boolean" &&
      typeof (row as Record<string, unknown>).count === "number",
  );
}
