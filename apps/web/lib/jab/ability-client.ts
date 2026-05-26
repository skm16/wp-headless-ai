import "server-only";
import { Buffer } from "node:buffer";
import { McpClient } from "@jab/core";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptColumnToString } from "@/lib/crypto/encrypt";

/**
 * ability-client.ts — connected-site bridge for the AI generation pipeline.
 *
 * Three jobs:
 *   1. Decrypt per-project WP credentials (server-side only; uses Supabase
 *      service role since Inngest workers don't carry user sessions).
 *   2. Wire those credentials into the `@jab/core` `McpClient` — the same
 *      MCP handshake the probe step uses today, no new transport code.
 *   3. Read the WP front-page setting (stock /wp-json/wp/v2/* — no plugin
 *      bump required) so we can call `jab/get-page-by-slug` with the slug
 *      WP actually routes "/" to instead of guessing "home".
 *
 * Resurrects `safeFindFrontPage` from the deleted `lib/jab/page-context.ts:351`
 * area (commit 75d485a) — same null-on-error contract, so callers degrade
 * gracefully to the public-HTML scrape when the WP install hasn't configured
 * a static front page (the `show_on_front === 'page'` branch).
 *
 * See docs/ai-prompt-modes.md §10.0 step 6 for the surrounding refocus
 * context — this is the missing piece that lets the renderer consume
 * v0.6.0 typed `BlockNode[]` ground-truth instead of HTML-derived guesses.
 */

/**
 * Canonical `parse_blocks()` node shape as emitted by the v0.6.0 plugin
 * (PostTypeBySlugAbility → BlockSchema). Both the typed-variant branches
 * and the unknown-fallback variant collapse to this same five-field shape;
 * the discrimination is at validation time inside WP, not in this TS.
 *
 * `attrs` is loose by design (third-party blocks can attach arbitrary
 * payloads). `innerBlocks` is recursive — but the WP REST validator can't
 * enforce that beyond depth 1, so deep trees come back loose-but-shaped.
 */
export interface BlockNode {
  blockName: string | null;
  attrs: Record<string, unknown>;
  innerBlocks: BlockNode[];
  innerHTML: string;
  innerContent: (string | null)[];
}

/**
 * Trimmed view of the `jab/get-page-by-slug` result envelope. Adding more
 * fields here is safe (extra keys on the wire are tolerated); removing one
 * means callers were relying on it and need to be audited.
 */
export interface PageBySlugRecord {
  id: number;
  title: string;
  slug: string;
  link: string;
  date: string;
  excerpt: string;
  content?: string;
  blocks?: BlockNode[];
  rendered_content?: string;
}

export interface FrontPageInfo {
  id: number;
  slug: string;
  title: string;
}

/**
 * Aggregate the worker hands to the renderer when a project is connected.
 * Renderer treats `blocks` as the authoritative section sequence; `content`
 * is the raw post_content fallback for top-level nodes whose `blockName` is
 * null (classic-editor / page-builder content the v0.6.0 parser couldn't
 * type-narrow).
 *
 * `null` at the consuming boundary means "no connected data available" —
 * pre-auth previews, projects that haven't completed onboarding, or any
 * fetch failure during regen. The renderer degrades to its public-HTML
 * code path in that case.
 */
export interface ConnectedSiteData {
  frontPage: FrontPageInfo;
  blocks: BlockNode[];
  content: string;
}

export interface JabCredentials {
  wpUrl: string;
  username: string;
  appPassword: string;
}

export class JabAbilityError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "project_not_connected"
      | "credentials_decrypt_failed"
      | "ability_call_failed"
      | "ability_response_invalid",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "JabAbilityError";
  }
}

interface ProjectCredsRow {
  wp_url: string | null;
  wp_username: string | null;
  wp_app_password_encrypted: unknown;
}

/**
 * Service-role read of WP credentials for a project. Filter on both `id`
 * AND `tenant_id` for the same belt-and-suspenders reason every other
 * worker write does — service role bypasses RLS, so the application
 * filter is the only thing keeping a stray dispatch off the wrong row.
 */
export async function loadJabCredentials(
  projectId: string,
  tenantId: string,
): Promise<JabCredentials> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("projects")
    .select("wp_url, wp_username, wp_app_password_encrypted")
    .eq("id", projectId)
    .eq("tenant_id", tenantId)
    .single<ProjectCredsRow>();
  if (error) {
    throw new JabAbilityError(
      `load creds failed: ${error.message}`,
      "project_not_connected",
      error,
    );
  }
  if (!data?.wp_url || !data.wp_username || !data.wp_app_password_encrypted) {
    throw new JabAbilityError(
      `project ${projectId} is missing WP credentials — onboarding incomplete`,
      "project_not_connected",
    );
  }
  let appPassword: string;
  try {
    appPassword = decryptColumnToString(data.wp_app_password_encrypted);
  } catch (err) {
    throw new JabAbilityError(
      `credential decrypt failed for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
      "credentials_decrypt_failed",
      err,
    );
  }
  return {
    wpUrl: data.wp_url.replace(/\/+$/, ""),
    username: data.wp_username,
    appPassword,
  };
}

/**
 * Wires JabCredentials into `@jab/core`'s `McpClient`. The client lazily
 * runs the MCP handshake on the first `callTool`, so this is cheap to
 * construct even when the worker ends up not calling anything.
 */
export function createJabMcpClient(creds: JabCredentials): McpClient {
  return new McpClient({
    wpUrl: creds.wpUrl,
    user: creds.username,
    password: creds.appPassword,
  });
}

/**
 * Resolve the static front-page slug, returning null when:
 *   - `show_on_front !== 'page'` (latest-posts feed, not a Page)
 *   - settings or page lookup HTTP fails for any reason
 *
 * The null return is the graceful-degradation signal — callers fall back
 * to public-HTML scraping when we can't pin down a slug. We deliberately
 * do NOT throw on lookup failure; the worker is already past onboarding
 * (credentials valid as of probe time) and a transient settings hiccup
 * shouldn't kill the regen.
 *
 * `/wp-json/wp/v2/settings` requires `manage_options`. An app-password
 * owner who completed onboarding necessarily has admin caps, so this
 * works in practice — but agencies whose dev hands out a lower-priv
 * app password will silently fall through to the null path. That's
 * acceptable for v0; can be promoted to a typed warning later.
 */
export async function resolveFrontPage(
  creds: JabCredentials,
  opts: { timeoutMs?: number } = {},
): Promise<FrontPageInfo | null> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const settings = await wpRestFetch<{
      page_on_front?: number;
      show_on_front?: string;
    }>(`${creds.wpUrl}/wp-json/wp/v2/settings`, creds, controller.signal);

    if (
      typeof settings.page_on_front !== "number" ||
      settings.page_on_front === 0 ||
      settings.show_on_front !== "page"
    ) {
      return null;
    }
    const page = await wpRestFetch<{
      id: number;
      slug: string;
      title: { rendered?: string };
    }>(
      `${creds.wpUrl}/wp-json/wp/v2/pages/${settings.page_on_front}`,
      creds,
      controller.signal,
    );
    if (!page || typeof page.id !== "number" || typeof page.slug !== "string") {
      return null;
    }
    return {
      id: page.id,
      slug: page.slug,
      title: page.title?.rendered ?? "",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function wpRestFetch<T>(
  url: string,
  creds: JabCredentials,
  signal: AbortSignal,
): Promise<T> {
  const auth = Buffer.from(
    `${creds.username}:${creds.appPassword}`,
    "utf8",
  ).toString("base64");
  // `redirect: "manual"` — same SSRF posture as `fetch-content-types.ts`.
  // Even though the WP URL passed onboarding's hostname guard, the WP
  // install could return a 3xx pointing at link-local / metadata addresses
  // (169.254.169.254, 10.0.0.0/8, etc). Following such a redirect would
  // leak the agency's Basic-auth header to the redirect target. We treat
  // any redirect as an unexpected response and bail.
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
    redirect: "manual",
    signal,
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(
      `GET ${url} → unexpected redirect status ${res.status}; refusing to follow`,
    );
  }
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Calls `jab/get-page-by-slug` and returns the typed page record (or null
 * when WP has no published page matching the slug).
 *
 * `include` is passed explicitly even though the by-slug ability already
 * defaults `content` + `blocks` ON — explicit beats implicit when the
 * defaults could flip in a future plugin version. We don't ask for
 * `render` because `blocks` is the ground-truth source; the rendered
 * HTML is duplicate weight in the prompt.
 *
 * Response-shape validation is light on purpose: id + slug type-checks
 * cover the "is this actually a page?" question, and downstream
 * consumers narrow further. A heavy Zod parse here would couple this
 * module to schema drift on every ACF / taxonomy field.
 */
export async function getPageBySlug(
  client: McpClient,
  slug: string,
): Promise<PageBySlugRecord | null> {
  let result: Awaited<ReturnType<typeof client.callTool<{ page?: PageBySlugRecord | null }>>>;
  try {
    result = await client.callTool<{ page?: PageBySlugRecord | null }>(
      "jab/get-page-by-slug",
      {
        slug,
        include: { content: true, blocks: true, render: false },
      },
    );
  } catch (err) {
    throw new JabAbilityError(
      `jab/get-page-by-slug call failed for slug='${slug}': ${err instanceof Error ? err.message : String(err)}`,
      "ability_call_failed",
      err,
    );
  }

  if (result.isError) {
    const detail = result.content?.[0]?.text ?? "(no error text)";
    throw new JabAbilityError(
      `jab/get-page-by-slug isError=true for slug='${slug}': ${detail}`,
      "ability_call_failed",
    );
  }

  const page = result.structuredContent?.page;
  if (page === null || page === undefined) {
    return null;
  }
  if (
    typeof page !== "object" ||
    typeof (page as PageBySlugRecord).id !== "number" ||
    typeof (page as PageBySlugRecord).slug !== "string"
  ) {
    throw new JabAbilityError(
      `jab/get-page-by-slug response shape unexpected for slug='${slug}'`,
      "ability_response_invalid",
    );
  }
  return page as PageBySlugRecord;
}

/**
 * Trimmed view of the `jab/get-menus` result. Menu items are flat with
 * `parent_id` pointers — see MenusAbility::output_schema() in the plugin
 * for the contract. Consumers can rebuild a tree client-side.
 */
export interface MenuItem {
  id: number;
  title: string;
  url: string;
  target: string;
  object_type: string;
  object_id: number;
  parent_id: number;
  order: number;
}

export interface Menu {
  id: number;
  slug: string;
  name: string;
  /** Theme-registered locations (e.g. "primary", "footer") this menu fills. */
  locations: string[];
  items: MenuItem[];
}

/**
 * Calls `jab/get-menus`. No inputs — returns every registered nav menu plus
 * its items. Empty array when WP has no menus configured (rare on production
 * sites; common on a freshly-installed dev WP).
 *
 * Shape validation is structural only: top-level menus must be an array;
 * we trust the plugin's output_schema validation for everything beneath.
 * Stricter Zod-style parsing here would couple the SaaS to plugin bumps.
 */
export async function getMenus(client: McpClient): Promise<Menu[]> {
  let result: Awaited<ReturnType<typeof client.callTool<{ menus?: Menu[] }>>>;
  try {
    result = await client.callTool<{ menus?: Menu[] }>("jab/get-menus", {});
  } catch (err) {
    throw new JabAbilityError(
      `jab/get-menus call failed: ${err instanceof Error ? err.message : String(err)}`,
      "ability_call_failed",
      err,
    );
  }
  if (result.isError) {
    const detail = result.content?.[0]?.text ?? "(no error text)";
    throw new JabAbilityError(
      `jab/get-menus isError=true: ${detail}`,
      "ability_call_failed",
    );
  }
  const menus = result.structuredContent?.menus;
  if (!Array.isArray(menus)) {
    throw new JabAbilityError(
      `jab/get-menus response missing or non-array 'menus' field`,
      "ability_response_invalid",
    );
  }
  return menus as Menu[];
}
