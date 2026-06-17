import "server-only";
import { Buffer } from "node:buffer";
import { McpClient, type Manifest, type SiteManifest, isSiteManifest } from "@jab/core";
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
 * The `resolveFrontPage` helper below (introduced as `safeFindFrontPage` in
 * the deleted `lib/jab/page-context.ts:351` area, commit 75d485a) preserves
 * the same null-on-error contract — callers degrade gracefully when WP
 * hasn't configured a static front page (the `show_on_front === 'page'`
 * branch).
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
  /** v0.7.0 REQUIRED row fields (mirror of each other; plugin emits GMT in both). */
  modified: string;
  modified_gmt: string;
  content?: string;
  blocks?: BlockNode[];
  /**
   * Per-CPT ACF field-group payload. Populated by the plugin's
   * PostTypeBySlugAbility (`output_schema` lists `acf` as required when
   * AcfSchema::for_post_type returns a non-null schema for this CPT).
   * Shape mirrors the ACF schema in the manifest — scalars, repeaters
   * as arrays of nested objects, flexible_content as discriminated
   * unions keyed on `acf_fc_layout`. Absent when the CPT has no ACF
   * field groups attached (or when the WP install has no ACF plugin).
   */
  acf?: Record<string, unknown>;
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

/**
 * Common wrapper for MCP tool calls. Centralizes the three error paths the
 * ability-client surfaces:
 *   - callTool throws (network / TLS / handshake) → ability_call_failed
 *   - result.isError true → ability_call_failed
 *   - validate() returns false → ability_response_invalid
 *
 * `validate` receives the raw `structuredContent`. Return true to accept,
 * false to throw `ability_response_invalid`. Use it for narrow structural
 * checks — anything deep belongs in the caller's mapper.
 */
async function callJabAbility<T>(
  client: McpClient,
  toolName: string,
  args: Record<string, unknown>,
  validate: (sc: unknown) => sc is T,
): Promise<T> {
  let result: Awaited<ReturnType<typeof client.callTool<unknown>>>;
  try {
    result = await client.callTool<unknown>(toolName, args);
  } catch (err) {
    throw new JabAbilityError(
      `${toolName} call failed: ${err instanceof Error ? err.message : String(err)}`,
      "ability_call_failed",
      err,
    );
  }
  if (result.isError) {
    const detail = result.content?.[0]?.text ?? "(no error text)";
    throw new JabAbilityError(
      `${toolName} isError=true: ${detail}`,
      "ability_call_failed",
    );
  }
  const sc = result.structuredContent;
  if (!validate(sc)) {
    throw new JabAbilityError(
      `${toolName} response shape unexpected`,
      "ability_response_invalid",
    );
  }
  return sc;
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
    timeoutMs: 30_000,
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

/**
 * Reads WP's `show_on_front` Reading setting from the stock REST settings
 * endpoint. This is the pre-v0.7.0 fallback for blog-index detection: the
 * `/jab/v1/site` manifest (which carries `front_page.show_on_front`) only
 * exists on plugin v0.7.0+, but the plugin floor is v0.6.0. Without this, a
 * blog-index site (`show_on_front='posts'`) on a v0.6.x plugin can't be
 * detected and compose hard-fails. Fail-soft to null (auth gap / network /
 * unexpected shape) — the caller treats null as "unknown" and the static
 * front-page path takes over, exactly as before.
 */
export async function fetchShowOnFront(
  creds: JabCredentials,
  opts: { timeoutMs?: number } = {},
): Promise<"page" | "posts" | null> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const settings = await wpRestFetch<{ show_on_front?: string }>(
      `${creds.wpUrl}/wp-json/wp/v2/settings`,
      creds,
      controller.signal,
    );
    return settings.show_on_front === "page" || settings.show_on_front === "posts"
      ? settings.show_on_front
      : null;
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
 * Fail-soft GET /wp-json/jab/v1/site (plugin v0.7.0+). Returns null on any
 * failure — pre-v0.7.0 404, redirect (SSRF guard), network error, or a body
 * that fails the structural guard — so callers degrade to the stock-REST
 * front-page / theme-probe paths. Default cap is edit_posts (lower than the
 * manage_options that /wp/v2/settings needs), closing the resolveFrontPage
 * degradation hole for lower-priv app passwords.
 */
export async function getSiteManifest(
  creds: JabCredentials,
  opts: { timeoutMs?: number } = {},
): Promise<SiteManifest | null> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = await wpRestFetch<unknown>(
      `${creds.wpUrl}/wp-json/jab/v1/site`,
      creds,
      controller.signal,
    );
    return isSiteManifest(body) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
  const data = await callJabAbility<{ page: PageBySlugRecord | null }>(
    client,
    "jab/get-page-by-slug",
    { slug, include: { content: true, blocks: true, render: false } },
    (sc): sc is { page: PageBySlugRecord | null } => {
      if (typeof sc !== "object" || sc === null) return false;
      const page = (sc as { page?: unknown }).page;
      if (page === null) return true;
      if (typeof page !== "object" || page === null) return false;
      const p = page as { id?: unknown; slug?: unknown };
      return typeof p.id === "number" && typeof p.slug === "string";
    },
  );
  return data.page;
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
  const data = await callJabAbility<{ menus: Menu[] }>(
    client,
    "jab/get-menus",
    {},
    (sc): sc is { menus: Menu[] } =>
      typeof sc === "object" &&
      sc !== null &&
      Array.isArray((sc as { menus?: unknown }).menus),
  );
  return data.menus;
}

/**
 * One row from the plugin's `/wp-json/jab/v1/content-types` REST endpoint.
 * Schema mirrors `Rest/ContentTypes::describe_post_type` in the plugin.
 */
export interface PostTypeRow {
  slug: string;
  rest_base: string;
  plural_label: string;
  singular_label: string;
  is_builtin: boolean;
  hierarchical: boolean;
  count: number;
}

/**
 * Fetches the plugin's authoritative post-type catalog. Used by Phase A
 * to enumerate which CPTs to discover.
 *
 * REST (not MCP) on purpose: this endpoint pre-dates the typed-block work
 * and already returns the exact set Registry.php exposes — no manifest
 * parsing required.
 *
 * Uses the same SSRF posture as `wpRestFetch` (manual redirect handling).
 */
export async function listPostTypes(
  creds: JabCredentials,
  opts: { timeoutMs?: number } = {},
): Promise<PostTypeRow[]> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = await wpRestFetch<{ ok?: boolean; post_types?: unknown }>(
      `${creds.wpUrl}/wp-json/jab/v1/content-types`,
      creds,
      controller.signal,
    ).catch((err) => {
      throw new JabAbilityError(
        `GET /wp-json/jab/v1/content-types failed: ${err instanceof Error ? err.message : String(err)}`,
        "ability_call_failed",
        err,
      );
    });
    if (!Array.isArray(body.post_types)) {
      throw new JabAbilityError(
        `/wp-json/jab/v1/content-types response missing post_types array`,
        "ability_response_invalid",
      );
    }
    return body.post_types as PostTypeRow[];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Per-row shape from a `jab/get-{plural}` list ability. Trimmed to fields
 * the discovery phase actually needs — id (for diagnostics), slug + link
 * (for the per-page URL the Playwright runner navigates to), title (for
 * page_inventory display), date (for newest-first sort if Stage 1 ever
 * caps the per-CPT count).
 *
 * Per-CPT abilities also return featured_image, acf, taxonomy arrays — we
 * intentionally don't narrow those; they're available off the loose
 * `Record<string, unknown>` extra fields when needed.
 */
export interface PostListRow extends Record<string, unknown> {
  id: number;
  title: string;
  slug: string;
  link: string;
  date: string;
  excerpt: string;
  /** v0.7.0 REQUIRED row fields — canonical last-touched timestamp for sync. */
  modified: string;
  modified_gmt: string;
}

/**
 * Calls a `jab/get-{plural}` list ability and returns the items array.
 *
 * The caller supplies both the ability name and the wrapper key because
 * the plugin's `Registry::derive_config_from_post_type` derives them from
 * the CPT's `rest_base` (e.g. "page" CPT → `jab/get-pages` ability +
 * `pages` wrapper key; "beer" CPT → `jab/get-beers` + `beers`). The
 * discovery worker reads the project's persisted manifest to resolve
 * the pair per CPT.
 */
export interface ListPostTypeOpts {
  abilityName: string;
  wrapperKey: string;
  numberposts: number;
  postStatus?: string;
  /** v0.7.0 sync inputs. Only forwarded when set. */
  page?: number;
  offset?: number;
  orderby?: "date" | "modified" | "title" | "menu_order" | "id";
  order?: "asc" | "desc";
  modifiedAfter?: string;
}

export async function listPostType(client: McpClient, opts: ListPostTypeOpts): Promise<PostListRow[]> {
  const args: Record<string, unknown> = {
    numberposts: opts.numberposts,
    post_status: opts.postStatus ?? "publish",
    include: { content: false, blocks: false, render: false },
  };
  if (opts.page !== undefined) args.page = opts.page;
  if (opts.offset !== undefined) args.offset = opts.offset;
  if (opts.orderby !== undefined) args.orderby = opts.orderby;
  if (opts.order !== undefined) args.order = opts.order;
  if (opts.modifiedAfter !== undefined) args.modified_after = opts.modifiedAfter;

  const data = await callJabAbility<Record<string, unknown>>(
    client,
    opts.abilityName,
    args,
    (sc): sc is Record<string, unknown> => typeof sc === "object" && sc !== null,
  );
  const rows = (data as Record<string, unknown>)[opts.wrapperKey];
  if (!Array.isArray(rows)) {
    throw new JabAbilityError(
      `${opts.abilityName} response missing wrapper key '${opts.wrapperKey}' (or not an array)`,
      "ability_response_invalid",
    );
  }
  return rows as PostListRow[];
}

/**
 * Page through a list ability until a page returns fewer than `numberposts`
 * rows (the last page) or `maxPages` is hit. Uses orderby=id asc for a stable
 * cursor — the plugin's v0.7.0 deterministic ID tiebreaker guarantees each
 * record appears once across pages. `truncated` is true when maxPages capped
 * the walk, so callers can log a coverage shortfall instead of silently
 * losing the tail.
 */
export async function listAllPostType(
  client: McpClient,
  opts: ListPostTypeOpts & { maxPages?: number },
): Promise<{ rows: PostListRow[]; truncated: boolean }> {
  const maxPages = opts.maxPages ?? 20;
  const all: PostListRow[] = [];
  let page = opts.page ?? 1;
  let pagesWalked = 0;
  while (pagesWalked < maxPages) {
    const batch = await listPostType(client, {
      ...opts,
      page,
      orderby: opts.orderby ?? "id",
      order: opts.order ?? "asc",
    });
    all.push(...batch);
    pagesWalked++;
    if (batch.length < opts.numberposts) return { rows: all, truncated: false };
    page++;
  }
  return { rows: all, truncated: true };
}

/**
 * Calls a `jab/get-{singular}-by-slug` ability and returns the typed record
 * or null when WP has no matching slug.
 *
 * Generic counterpart to the existing `getPageBySlug` — that wrapper is
 * page-CPT-specific; this one takes the ability name + wrapper key so it
 * can hit `jab/get-beer-by-slug`, `jab/get-event-by-slug`, etc. derived
 * from the project manifest.
 *
 * `includeBlocks: true` is the discovery default (we need the BlockNode
 * trees for the inventory). Callers that only want the front-matter
 * fields can pass `includeBlocks: false` to keep payloads small.
 */
export async function getPostBySlug(
  client: McpClient,
  opts: {
    abilityName: string;
    wrapperKey: string;
    slug: string;
    includeBlocks: boolean;
  },
): Promise<PageBySlugRecord | null> {
  const data = await callJabAbility<Record<string, unknown>>(
    client,
    opts.abilityName,
    {
      slug: opts.slug,
      include: { content: true, blocks: opts.includeBlocks, render: false },
    },
    (sc): sc is Record<string, unknown> => typeof sc === "object" && sc !== null,
  );
  const record = (data as Record<string, unknown>)[opts.wrapperKey];
  if (record === null || record === undefined) return null;
  if (typeof record !== "object") {
    throw new JabAbilityError(
      `${opts.abilityName} wrapper key '${opts.wrapperKey}' had non-object value`,
      "ability_response_invalid",
    );
  }
  const r = record as { id?: unknown; slug?: unknown };
  if (typeof r.id !== "number" || typeof r.slug !== "string") {
    throw new JabAbilityError(
      `${opts.abilityName} record missing required id/slug fields`,
      "ability_response_invalid",
    );
  }
  return record as PageBySlugRecord;
}

/**
 * Subset of WP's global-styles response we care about for Phase A. Shape
 * comes from /wp-json/wp/v2/global-styles/themes/{stylesheet} — the
 * `settings` block carries theme.json's typography/color/spacing scales;
 * `styles` carries the resolved style overrides.
 *
 * Returns `null` on 404 (classic theme without theme.json — falls back to
 * computed-CSS inference per design doc §6.3). Throws on any other
 * non-success because the discovery worker can recover from a missing
 * theme.json but not from an auth failure.
 */
export interface GlobalStylesResponse {
  settings?: Record<string, unknown>;
  styles?: Record<string, unknown>;
}

/**
 * For a given CPT (slug + rest_base from the plugin's content-types REST
 * endpoint), resolve the four pieces of metadata the discovery worker
 * needs to call the list + by-slug abilities:
 *   - listAbilityName     — e.g. "jab/get-pages"
 *   - listWrapperKey      — e.g. "pages"
 *   - bySlugAbilityName   — e.g. "jab/get-page-by-slug"
 *   - bySlugWrapperKey    — e.g. "page"
 *
 * Strategy: parse the manifest's outputSchema for each candidate ability
 * name and pull the single key from its `required` array (the plugin
 * always emits exactly one required wrapper key per list / by-slug
 * ability). Fall back to slug-based derivation when manifest is null or
 * the ability isn't present — matches Registry::derive_config_from_post_type.
 */

/**
 * First `required` key of an ability's output schema. The persisted manifest
 * (projects.manifest, written from @jab/core's Manifest) uses camelCase
 * `outputSchema`; tolerate raw-REST-shaped (snake_case) data defensively. Null when the
 * ability/schema/required is absent — callers fall back to the derivation.
 */
export function abilityWrapperKeyFromSchema(ability: unknown): string | null {
  const a = ability as {
    outputSchema?: { required?: unknown };
    output_schema?: { required?: unknown };
  };
  const schema = a.outputSchema ?? a.output_schema;
  if (!schema || !Array.isArray(schema.required) || schema.required.length === 0) return null;
  const first = schema.required[0];
  return typeof first === "string" ? first : null;
}

export interface CptAbilityMeta {
  listAbilityName: string;
  listWrapperKey: string;
  bySlugAbilityName: string;
  bySlugWrapperKey: string;
}

export function resolveCptAbilityMeta(
  manifest: Manifest | null,
  cpt: { slug: string; rest_base: string },
): CptAbilityMeta {
  const kebab = (s: string) => s.toLowerCase().replace(/[\s_]+/g, "-");
  const snake = (s: string) => s.toLowerCase().replace(/[\s-]+/g, "_");

  const listAbilityName = `jab/get-${kebab(cpt.rest_base)}`;
  const bySlugAbilityName = `jab/get-${kebab(cpt.slug)}-by-slug`;
  const listWrapperKey = snake(cpt.rest_base);
  const bySlugWrapperKey = snake(cpt.slug);

  // Without a manifest, return the derivation. The manifest is a refinement,
  // not a requirement — the derivation matches what Registry emits.
  if (!manifest) {
    return { listAbilityName, listWrapperKey, bySlugAbilityName, bySlugWrapperKey };
  }

  // When the manifest IS present, prefer its required[0] wrapper key over the derivation (covers filter-customized wrapper keys; a name-suffixed collision ability still misses the lookup and fail-softs to the derivation).
  const lookup = (name: string): string | null => {
    const ability = manifest.abilities.find((a) => a.name === name);
    return ability ? abilityWrapperKeyFromSchema(ability) : null;
  };

  return {
    listAbilityName,
    listWrapperKey: lookup(listAbilityName) ?? listWrapperKey,
    bySlugAbilityName,
    bySlugWrapperKey: lookup(bySlugAbilityName) ?? bySlugWrapperKey,
  };
}

export async function getGlobalStyles(
  creds: JabCredentials,
  opts: { timeoutMs?: number; stylesheet?: string } = {},
): Promise<GlobalStylesResponse | null> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Step 1: resolve the active theme stylesheet. Prefer a caller-supplied
    // value (from /site.theme.slug) to skip the stock /wp/v2/themes probe.
    let stylesheet = opts.stylesheet;
    if (!stylesheet) {
      let themes: Array<{ stylesheet?: string; status?: string }>;
      try {
        themes = await wpRestFetch<Array<{ stylesheet?: string; status?: string }>>(
          `${creds.wpUrl}/wp-json/wp/v2/themes?status=active`,
          creds,
          controller.signal,
        );
      } catch (err) {
        throw new JabAbilityError(
          `GET /wp-json/wp/v2/themes?status=active failed: ${err instanceof Error ? err.message : String(err)}`,
          "ability_call_failed",
          err,
        );
      }
      stylesheet =
        Array.isArray(themes) && themes.length > 0 ? themes[0].stylesheet : undefined;
    }
    if (!stylesheet) {
      // No active theme stylesheet returned. Treat as "no theme.json available."
      return null;
    }

    // Step 2: fetch global-styles for that stylesheet.
    try {
      return await wpRestFetch<GlobalStylesResponse>(
        `${creds.wpUrl}/wp-json/wp/v2/global-styles/themes/${encodeURIComponent(stylesheet)}`,
        creds,
        controller.signal,
      );
    } catch (err) {
      // 404 → classic theme. Return null. wpRestFetch's error message
      // includes "→ 404 ..." so we can distinguish 404 from real failures.
      const msg = err instanceof Error ? err.message : String(err);
      if (/→ 404/.test(msg)) return null;
      throw new JabAbilityError(
        `GET /wp-json/wp/v2/global-styles/themes/${stylesheet} failed: ${msg}`,
        "ability_call_failed",
        err,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
