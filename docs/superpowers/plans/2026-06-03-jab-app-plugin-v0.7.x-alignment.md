# JAB App ↔ Plugin v0.7.x Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `apps/web` (the JAB SaaS) actually consume the plugin's v0.7.0/v0.7.1 connector surface — plugin version capture + semver gate, the `/site` and `/diagnostics` endpoints, the REQUIRED `modified`/`modified_gmt` row fields, list pagination, and modified-watermark incremental re-sync — and reconcile the plugin docs that overstate these integrations.

**Architecture:** The keystone is threading the plugin version through `@jab/core`'s `fetchManifest` (a fail-soft REST GET to `/wp-json/jab/v1/manifest`, which already returns `plugin_version`), so both the CLI and the app become version-aware without ripping out the MCP discovery path. Everything else layers on top: a real semver gate replaces the `["jab/get-menus"]` shibboleth; app-side fetchers (`getSiteManifest`, `getDiagnostics`) consume the new endpoints with the existing `wpRestFetch` SSRF posture and degrade to the current stock-REST/scrape paths when an older plugin 404s; the discovery worker persists per-page `modified_gmt` and a per-build watermark to enable incremental re-sync. All new endpoint consumption is gated so a pre-v0.7.0 install keeps working.

**Tech Stack:** TypeScript (Node 20+, NodeNext modules — imports use `.js` extensions in `@jab/core`), Vitest 2.x, Next.js 15 App Router + Tailwind (JAB dark tokens), Drizzle ORM + Supabase Postgres (migrations are hand-written SQL under `apps/web/drizzle/migrations/NNNN_*.sql`, applied via Supabase `apply_migration`), Inngest workers, PHP 7.4 plugin (read-only here — no plugin code changes, docs only).

---

## Shared Contracts (locked — every task below uses these names verbatim)

**New / changed `@jab/core` surface:**

```typescript
// packages/core/src/types/manifest.ts — ADDITIVE field, schemaVersion stays 1.
export interface Manifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  source: string;
  fetchedAt: string;
  server: { namespace: string; route: string };
  abilities: AbilityManifestEntry[];
  /** Plugin version from the REST /manifest envelope. null when the plugin
   * predates the plugin_version field or the supplemental fetch failed. */
  pluginVersion?: string | null;
}

// packages/core/src/types/site.ts (NEW) — shared by CLI + app.
export interface SiteManifest {
  plugin_version: string | null;
  generated_at: string;
  site: { title: string; tagline: string; home_url: string; site_url: string; timezone: string; locale: string; permalink_structure: string };
  front_page: { show_on_front: "posts" | "page"; static_front: SitePageRef; posts_page: SitePageRef };
  branding: { site_icon_url: string | null; custom_logo_id: number | null; custom_logo_url: string | null };
  menus: Array<{ slug: string; label: string }>;
  image_sizes: Array<{ name: string; width: number; height: number; crop: boolean }>;
  theme: { slug: string | null; name: string | null; version: string | null };
}
export interface SitePageRef { id: number | null; slug: string | null; title: string | null }

// packages/core/src/manifest.ts (NEW exports)
export function parsePluginVersion(body: unknown): string | null;
export async function fetchPluginVersion(opts: { wpUrl: string; user: string; password: string; timeoutMs?: number }): Promise<string | null>;

// packages/core/src/site.ts (NEW)
export async function fetchSiteManifest(opts: { wpUrl: string; user: string; password: string; timeoutMs?: number }): Promise<SiteManifest | null>;
```

**New / changed `apps/web` surface:**

```typescript
// apps/web/lib/jab/semver.ts (NEW)
export function compareSemver(a: string, b: string): number;   // -1 | 0 | 1
export function gteSemver(a: string, b: string): boolean;

// apps/web/lib/jab/probe.ts (CHANGED ProbeResult)
export type ProbeResult =
  | { ok: true; manifest: Manifest; abilityCount: number; pluginVersion: string | null; warnings: string[] }
  | { ok: false; error: string };
export const RECOMMENDED_PLUGIN_VERSION = "0.7.0";

// apps/web/lib/jab/ability-client.ts (CHANGED + NEW)
export interface PostListRow extends Record<string, unknown> {
  id: number; title: string; slug: string; link: string; date: string; excerpt: string;
  modified: string; modified_gmt: string;          // NEW (v0.7.0 REQUIRED)
}
export interface PageBySlugRecord {
  id: number; title: string; slug: string; link: string; date: string; excerpt: string;
  modified: string; modified_gmt: string;          // NEW
  content?: string; blocks?: BlockNode[]; acf?: Record<string, unknown>; rendered_content?: string;
}
export interface ListPostTypeOpts {
  abilityName: string; wrapperKey: string; numberposts: number; postStatus?: string;
  page?: number; offset?: number; orderby?: "date" | "modified" | "title" | "menu_order" | "id";
  order?: "asc" | "desc"; modifiedAfter?: string;  // NEW v0.7.0 sync inputs
}
export async function listPostType(client: McpClient, opts: ListPostTypeOpts): Promise<PostListRow[]>;
export async function listAllPostType(client: McpClient, opts: ListPostTypeOpts & { maxPages?: number }): Promise<{ rows: PostListRow[]; truncated: boolean }>;
export async function getSiteManifest(creds: JabCredentials, opts?: { timeoutMs?: number }): Promise<SiteManifest | null>;
// getGlobalStyles gains an optional known stylesheet to skip the themes?status=active probe:
export async function getGlobalStyles(creds: JabCredentials, opts?: { timeoutMs?: number; stylesheet?: string }): Promise<GlobalStylesResponse | null>;

// apps/web/lib/jab/diagnostics.ts (NEW)
export interface DiagnosticsReport {
  plugin_version: string; generated_at: string;
  summary: { pass: number; warn: number; fail: number };
  facts: Array<{ id: string; label: string; value: unknown; detail?: unknown }>;
  checks: Array<{ id: string; label: string; severity: "pass" | "warn" | "fail"; message: string; detail?: string | string[] | null }>;
}
export async function getDiagnostics(creds: JabCredentials, opts?: { timeoutMs?: number }): Promise<DiagnosticsReport | null>;

// apps/web/lib/actions/onboarding.ts (CHANGED VerifyPluginResult)
export interface VerifyPluginResult { ok: boolean; message?: string; report?: DiagnosticsReport; pluginVersion?: string | null }

// apps/web/lib/jab/incremental.ts (NEW — pure)
export interface PriorPage { slug: string; postType: string; modifiedGmt: string | null }
export interface ChangedSet { changedSlugs: Set<string>; isFullSync: boolean }
export function resolveSyncWindow(priorWatermark: string | null): { modifiedAfter?: string };
export function selectChangedPages(prior: PriorPage[], current: PostListRow[], window: { modifiedAfter?: string }): ChangedSet;
export function maxModifiedGmt(rows: Array<{ modified_gmt?: string }>): string | null;
```

**DB migrations (next number is 0025; highest existing is `0024_workspace_edits.sql`):**
- `0025_projects_plugin_version.sql` → `projects.wp_plugin_version TEXT` (nullable).
- `0026_page_inventory_modified.sql` → `page_inventory.source_modified_gmt TIMESTAMPTZ` (nullable).
- `site_builds.config` (existing JSONB) gains a `last_sync_watermark: string` key (no migration — JSONB).

**Test commands:**
- `@jab/core`: `pnpm --filter @jab/core test` (all) · `pnpm --filter @jab/core test src/<file>.test.ts` (one) · `pnpm --filter @jab/core typecheck`.
- `@jab/web`: `pnpm --filter @jab/web test` · `pnpm --filter @jab/web test lib/jab/<file>.test.ts` · `pnpm --filter @jab/web typecheck`.
- `packages/cli`: no test runner — `pnpm --filter @jab/wp-headless-cli typecheck` only.

**Commit convention:** Conventional Commits. Scopes: `core`, `saas-app`, `cli`, `wp-plugin`. Subject explains the *why*.

**Worktree:** Execute on a feature branch / worktree created via `superpowers:using-git-worktrees` (master currently has uncommitted untracked files — do not implement on master).

---

## Phase 1 — `@jab/core`: capture the plugin version (keystone)

**Why first:** every version-gated decision downstream depends on the app knowing the plugin version. The app reads the manifest through `@jab/core` `fetchManifest`, which uses the MCP path and never sees `plugin_version`. We add a fail-soft supplemental REST GET to `/wp-json/jab/v1/manifest` (the one endpoint reachable at the `read` cap the probe relies on) and surface the version on the `Manifest` object. Additive optional field → no `schemaVersion` bump → existing `.jab/manifest.json` files keep working.

### Task 1.1: `Manifest.pluginVersion` field

**Files:**
- Modify: `packages/core/src/types/manifest.ts:11-25`
- Test: `packages/core/src/types/manifest.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/types/manifest.test.ts
import { describe, it, expectTypeOf } from "vitest";
import type { Manifest } from "./manifest.js";

describe("Manifest.pluginVersion", () => {
  it("accepts a string, null, or undefined pluginVersion", () => {
    const base = {
      schemaVersion: 1 as const,
      source: "https://x",
      fetchedAt: "2026-06-03T00:00:00Z",
      server: { namespace: "mcp", route: "mcp-adapter-default-server" },
      abilities: [],
    };
    expectTypeOf<Manifest["pluginVersion"]>().toEqualTypeOf<string | null | undefined>();
    const a: Manifest = { ...base, pluginVersion: "0.7.1" };
    const b: Manifest = { ...base, pluginVersion: null };
    const c: Manifest = { ...base }; // optional
    void a; void b; void c;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/core test src/types/manifest.test.ts`
Expected: FAIL — `Property 'pluginVersion' does not exist on type 'Manifest'`.

- [ ] **Step 3: Add the field**

In `packages/core/src/types/manifest.ts`, inside the `Manifest` interface after `abilities`:

```typescript
  /** All abilities the CLI generated typings for. */
  abilities: AbilityManifestEntry[];
  /**
   * Plugin version read from the REST `/wp-json/jab/v1/manifest` envelope's
   * `plugin_version` key. `null` when the plugin predates that field or the
   * supplemental fetch failed (fail-soft — never blocks manifest discovery).
   * Additive + optional, so `schemaVersion` stays 1 and existing
   * `.jab/manifest.json` files remain valid.
   */
  pluginVersion?: string | null;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @jab/core test src/types/manifest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types/manifest.ts packages/core/src/types/manifest.test.ts
git commit -m "feat(core): add optional pluginVersion to Manifest type"
```

### Task 1.2: `parsePluginVersion` pure helper

**Files:**
- Modify: `packages/core/src/manifest.ts` (add export near `textOf`)
- Test: `packages/core/src/manifest.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/manifest.test.ts
import { describe, it, expect } from "vitest";
import { parsePluginVersion } from "./manifest.js";

describe("parsePluginVersion", () => {
  it("extracts plugin_version from the REST manifest envelope", () => {
    expect(parsePluginVersion({ plugin_version: "0.7.1", abilities: [] })).toBe("0.7.1");
  });
  it("returns null for a missing or non-string plugin_version", () => {
    expect(parsePluginVersion({ abilities: [] })).toBeNull();
    expect(parsePluginVersion({ plugin_version: null })).toBeNull();
    expect(parsePluginVersion({ plugin_version: 7 })).toBeNull();
  });
  it("returns null for non-object bodies", () => {
    expect(parsePluginVersion(null)).toBeNull();
    expect(parsePluginVersion("0.7.1")).toBeNull();
    expect(parsePluginVersion(undefined)).toBeNull();
  });
  it("trims and rejects empty strings", () => {
    expect(parsePluginVersion({ plugin_version: "  0.7.1  " })).toBe("0.7.1");
    expect(parsePluginVersion({ plugin_version: "   " })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/core test src/manifest.test.ts`
Expected: FAIL — `parsePluginVersion is not exported`.

- [ ] **Step 3: Implement**

Add to `packages/core/src/manifest.ts` (after the `textOf` helper at the bottom):

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @jab/core test src/manifest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/manifest.ts packages/core/src/manifest.test.ts
git commit -m "feat(core): parsePluginVersion pure helper for REST manifest envelope"
```

### Task 1.3: `fetchPluginVersion` REST helper + wire into `fetchManifest`

**Files:**
- Modify: `packages/core/src/manifest.ts` (add `fetchPluginVersion`; set `pluginVersion` in the return)
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/src/manifest.test.ts` (extend)

- [ ] **Step 1: Write the failing test** (append to `manifest.test.ts`; add `afterEach` to the vitest import)

```typescript
import { afterEach } from "vitest";
import { fetchPluginVersion } from "./manifest.js";

describe("fetchPluginVersion", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it("GETs /wp-json/jab/v1/manifest with Basic auth and returns plugin_version", async () => {
    let seenUrl = ""; let seenAuth = "";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      return new Response(JSON.stringify({ plugin_version: "0.7.1", abilities: [] }), { status: 200 });
    }) as typeof fetch;
    const v = await fetchPluginVersion({ wpUrl: "https://x/", user: "u", password: "p" });
    expect(v).toBe("0.7.1");
    expect(seenUrl).toBe("https://x/wp-json/jab/v1/manifest");
    expect(seenAuth).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  it("returns null on non-200 (old plugin then 404) without throwing", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    expect(await fetchPluginVersion({ wpUrl: "https://x", user: "u", password: "p" })).toBeNull();
  });

  it("returns null on network error without throwing", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    expect(await fetchPluginVersion({ wpUrl: "https://x", user: "u", password: "p" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/core test src/manifest.test.ts`
Expected: FAIL — `fetchPluginVersion is not exported`.

- [ ] **Step 3: Implement `fetchPluginVersion`**

Add to `packages/core/src/manifest.ts` (and `import { Buffer } from "node:buffer";` at the top):

```typescript
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
```

- [ ] **Step 4: Wire into `fetchManifest`**

In `packages/core/src/manifest.ts`, replace the final `return { schemaVersion: ... }` (currently lines 177-186) with:

```typescript
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
    server: { namespace, route: serverRoute },
    abilities: entries,
    pluginVersion,
  };
```

- [ ] **Step 5: Export from index**

In `packages/core/src/index.ts`, extend the `./manifest.js` export block:

```typescript
export {
  fetchManifest,
  fetchPluginVersion,
  parsePluginVersion,
  type FetchManifestOptions,
  type FetchManifestProgress,
} from "./manifest.js";
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @jab/core test src/manifest.test.ts && pnpm --filter @jab/core typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/manifest.ts packages/core/src/index.ts packages/core/src/manifest.test.ts
git commit -m "feat(core): fetchPluginVersion + thread pluginVersion through fetchManifest"
```

### Task 1.4: `fetchSiteManifest` in core (shared type + CLI fetcher)

**Files:**
- Create: `packages/core/src/types/site.ts`
- Create: `packages/core/src/site.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/site.test.ts` (Create)

- [ ] **Step 1: Create the shared type**

```typescript
// packages/core/src/types/site.ts
/** Faithful mirror of GET /wp-json/jab/v1/site (plugin SiteManifest::respond). */
export interface SiteManifest {
  plugin_version: string | null;
  generated_at: string;
  site: {
    title: string; tagline: string; home_url: string; site_url: string;
    timezone: string; locale: string; permalink_structure: string;
  };
  front_page: {
    show_on_front: "posts" | "page";
    static_front: SitePageRef;
    posts_page: SitePageRef;
  };
  branding: {
    site_icon_url: string | null;
    custom_logo_id: number | null;
    custom_logo_url: string | null;
  };
  menus: Array<{ slug: string; label: string }>;
  image_sizes: Array<{ name: string; width: number; height: number; crop: boolean }>;
  theme: { slug: string | null; name: string | null; version: string | null };
}

export interface SitePageRef { id: number | null; slug: string | null; title: string | null }

/** Structural type-guard. Narrow check only — trusts the plugin's contract. */
export function isSiteManifest(v: unknown): v is SiteManifest {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.site === "object" && o.site !== null &&
    typeof o.front_page === "object" && o.front_page !== null &&
    typeof o.theme === "object" && o.theme !== null &&
    Array.isArray(o.menus) && Array.isArray(o.image_sizes)
  );
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// packages/core/src/site.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { Buffer } from "node:buffer";
import { fetchSiteManifest } from "./site.js";

const SAMPLE = {
  plugin_version: "0.7.1", generated_at: "2026-06-03T00:00:00Z",
  site: { title: "T", tagline: "", home_url: "https://x", site_url: "https://x", timezone: "UTC", locale: "en_US", permalink_structure: "/%postname%/" },
  front_page: { show_on_front: "page", static_front: { id: 2, slug: "home", title: "Home" }, posts_page: { id: null, slug: null, title: null } },
  branding: { site_icon_url: null, custom_logo_id: 9, custom_logo_url: "https://x/logo.png" },
  menus: [{ slug: "primary", label: "Primary" }],
  image_sizes: [{ name: "large", width: 1024, height: 0, crop: false }],
  theme: { slug: "twentytwentyfour", name: "Twenty Twenty-Four", version: "1.0" },
};

describe("fetchSiteManifest", () => {
  const orig = globalThis.fetch;
  afterEach(() => { globalThis.fetch = orig; });

  it("GETs /wp-json/jab/v1/site with Basic auth and returns the manifest", async () => {
    let url = ""; let auth = "";
    globalThis.fetch = (async (u: string, init?: RequestInit) => {
      url = String(u); auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    }) as typeof fetch;
    const site = await fetchSiteManifest({ wpUrl: "https://x/", user: "u", password: "p" });
    expect(site?.front_page.static_front.slug).toBe("home");
    expect(url).toBe("https://x/wp-json/jab/v1/site");
    expect(auth).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  it("returns null on 404 (old plugin) and on network error", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    expect(await fetchSiteManifest({ wpUrl: "https://x", user: "u", password: "p" })).toBeNull();
    globalThis.fetch = (async () => { throw new Error("boom"); }) as typeof fetch;
    expect(await fetchSiteManifest({ wpUrl: "https://x", user: "u", password: "p" })).toBeNull();
  });

  it("returns null when the body fails the structural guard", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ nope: true }), { status: 200 })) as typeof fetch;
    expect(await fetchSiteManifest({ wpUrl: "https://x", user: "u", password: "p" })).toBeNull();
  });
});
```

- [ ] **Step 2b: Run test to verify it fails**

Run: `pnpm --filter @jab/core test src/site.test.ts`
Expected: FAIL — module `./site.js` not found.

- [ ] **Step 3: Implement**

```typescript
// packages/core/src/site.ts
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
  wpUrl: string; user: string; password: string; timeoutMs?: number;
}): Promise<SiteManifest | null> {
  const wpUrl = opts.wpUrl.replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString("base64")}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8_000);
  try {
    const res = await fetch(`${wpUrl}/wp-json/jab/v1/site`, {
      method: "GET", headers: { Authorization: auth, Accept: "application/json" }, signal: controller.signal,
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
```

- [ ] **Step 4: Export from index**

Add to `packages/core/src/index.ts`:

```typescript
// Site manifest (GET /wp-json/jab/v1/site) — shared by CLI scaffold + SaaS worker.
export { type SiteManifest, type SitePageRef, isSiteManifest } from "./types/site.js";
export { fetchSiteManifest } from "./site.js";
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter @jab/core test src/site.test.ts && pnpm --filter @jab/core typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types/site.ts packages/core/src/site.ts packages/core/src/index.ts packages/core/src/site.test.ts
git commit -m "feat(core): SiteManifest type + fetchSiteManifest fetcher for /wp-json/jab/v1/site"
```

---

## Phase 2 — Semver gate, version persistence + UI surfacing

### Task 2.1: `compareSemver` / `gteSemver` helpers

**Files:**
- Create: `apps/web/lib/jab/semver.ts`
- Test: `apps/web/lib/jab/semver.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/jab/semver.test.ts
import { describe, it, expect } from "vitest";
import { compareSemver, gteSemver } from "./semver";

describe("compareSemver", () => {
  it("orders by major, minor, patch", () => {
    expect(compareSemver("0.7.1", "0.7.0")).toBe(1);
    expect(compareSemver("0.6.9", "0.7.0")).toBe(-1);
    expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
    expect(compareSemver("0.7.0", "0.7.0")).toBe(0);
  });
  it("tolerates a leading v and missing patch", () => {
    expect(compareSemver("v0.7", "0.7.0")).toBe(0);
    expect(compareSemver("0.7.2", "v0.7")).toBe(1);
  });
  it("treats unparseable input as 0.0.0 (lowest)", () => {
    expect(compareSemver("", "0.0.1")).toBe(-1);
    expect(compareSemver("garbage", "0.0.0")).toBe(0);
  });
});

describe("gteSemver", () => {
  it("is true when a >= b", () => {
    expect(gteSemver("0.7.1", "0.7.0")).toBe(true);
    expect(gteSemver("0.7.0", "0.7.0")).toBe(true);
    expect(gteSemver("0.6.3", "0.7.0")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test lib/jab/semver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/web/lib/jab/semver.ts
/**
 * Minimal semver compare for plugin-version gating. We control both operands
 * (plugin reports x.y.z; we compare against fixed minimums), so a tiny parser
 * beats a dependency. Unparseable input sorts as 0.0.0 (lowest) so a missing
 * version never falsely satisfies a minimum.
 */
function parse(v: string): [number, number, number] {
  const m = v.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return [0, 0, 0];
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function compareSemver(a: string, b: string): number {
  const pa = parse(a); const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! > pb[i]!) return 1;
    if (pa[i]! < pb[i]!) return -1;
  }
  return 0;
}

export function gteSemver(a: string, b: string): boolean {
  return compareSemver(a, b) >= 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @jab/web test lib/jab/semver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/semver.ts apps/web/lib/jab/semver.test.ts
git commit -m "feat(saas-app): minimal semver compare helpers for plugin-version gating"
```

### Task 2.2: Version-aware probe (keep v0.6.0 floor, warn below recommended)

**Files:**
- Modify: `apps/web/lib/jab/probe.ts`
- Test: `apps/web/lib/jab/probe.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/jab/probe.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@jab/core", async (orig) => {
  const actual = await orig<typeof import("@jab/core")>();
  return { ...actual, fetchManifest: vi.fn() };
});
import { fetchManifest } from "@jab/core";
import { probeWordPress, RECOMMENDED_PLUGIN_VERSION } from "./probe";

const baseManifest = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, source: "https://x", fetchedAt: "2026-06-03T00:00:00Z",
  server: { namespace: "mcp", route: "mcp-adapter-default-server" },
  abilities: [{ name: "jab/get-menus", label: "", description: "", inputSchema: {} }],
  ...over,
});

describe("probeWordPress version awareness", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns pluginVersion and no warnings when >= recommended", async () => {
    (fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue(baseManifest({ pluginVersion: "0.7.1" }));
    const r = await probeWordPress({ wpUrl: "https://x", username: "u", appPassword: "p" });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.pluginVersion).toBe("0.7.1"); expect(r.warnings).toEqual([]); }
  });

  it("succeeds but warns when below recommended", async () => {
    (fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue(baseManifest({ pluginVersion: "0.6.0" }));
    const r = await probeWordPress({ wpUrl: "https://x", username: "u", appPassword: "p" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pluginVersion).toBe("0.6.0");
      expect(r.warnings.join(" ")).toContain(RECOMMENDED_PLUGIN_VERSION);
    }
  });

  it("succeeds with null version + a warning when the plugin reports none", async () => {
    (fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue(baseManifest({ pluginVersion: null }));
    const r = await probeWordPress({ wpUrl: "https://x", username: "u", appPassword: "p" });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.pluginVersion).toBeNull(); expect(r.warnings.length).toBeGreaterThan(0); }
  });

  it("still hard-fails when the v0.6.0 ability floor is unmet", async () => {
    (fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue(baseManifest({ abilities: [] }));
    const r = await probeWordPress({ wpUrl: "https://x", username: "u", appPassword: "p" });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test lib/jab/probe.test.ts`
Expected: FAIL — `RECOMMENDED_PLUGIN_VERSION` not exported / `warnings`/`pluginVersion` missing.

- [ ] **Step 3: Implement**

In `apps/web/lib/jab/probe.ts`:
1. Add import: `import { gteSemver } from "./semver";`
2. Change `ProbeResult` and add the constant:

```typescript
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
```

3. Replace the success `return` (currently `return { ok: true, manifest, abilityCount: manifest.abilities.length }`) with:

```typescript
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
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @jab/web test lib/jab/probe.test.ts && pnpm --filter @jab/web typecheck`
Expected: PASS (the new fields are additive on the `ok: true` branch, so existing reads of `.manifest`/`.abilityCount` still compile).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/probe.ts apps/web/lib/jab/probe.test.ts
git commit -m "feat(saas-app): version-aware probe — surface pluginVersion + staleness warnings, keep v0.6.0 floor"
```

### Task 2.3: Migration 0025 — `projects.wp_plugin_version`

**Files:**
- Create: `apps/web/drizzle/migrations/0025_projects_plugin_version.sql`
- Modify: `apps/web/lib/db/schema.ts:59-95` (projects table)

- [ ] **Step 1: Write the migration**

```sql
-- 0025_projects_plugin_version.sql — JAB app + plugin v0.7.x alignment
-- (2026-06-03 alignment epic, Phase 2).
--
-- Captures the connected plugin's reported version at connect time so the app
-- can (a) gate v0.7.x-only features, (b) warn operators on outdated installs,
-- and (c) record version drift for debugging fidelity issues across sites.
-- Read from the REST /wp-json/jab/v1/manifest envelope via @jab/core
-- fetchManifest -> Manifest.pluginVersion -> probe -> connectWpAction.
--
-- Nullable: NULL means the plugin predates the plugin_version field or the
-- supplemental fetch failed (fail-soft). No backfill -- populated on the next
-- successful connect/probe.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS wp_plugin_version TEXT;

COMMENT ON COLUMN public.projects.wp_plugin_version IS
  'Plugin version reported by /wp-json/jab/v1/manifest at last successful connect. NULL when unreported (pre-v0.7.0 plugin or fetch failed).';

-- ============================================================================
-- End 0025_projects_plugin_version.sql
-- ============================================================================
```

- [ ] **Step 2: Update the Drizzle schema**

In `apps/web/lib/db/schema.ts`, in the `projects` table after `manifest: jsonb("manifest"),`:

```typescript
    manifest: jsonb("manifest"),
    // Plugin version reported by /wp-json/jab/v1/manifest at last successful
    // connect (migration 0025). NULL when unreported (pre-v0.7.0 plugin or the
    // fail-soft fetch returned nothing).
    wpPluginVersion: text("wp_plugin_version"),
```

- [ ] **Step 3: Apply the migration**

Apply via Supabase (the canonical path): use the Supabase `apply_migration` tool with name `projects_plugin_version` and the SQL above. (For local dev: `pnpm --filter @jab/web db:push`.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @jab/web typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/drizzle/migrations/0025_projects_plugin_version.sql apps/web/lib/db/schema.ts
git commit -m "feat(saas-app): add projects.wp_plugin_version column (migration 0025)"
```

### Task 2.4: Persist `wp_plugin_version` in `connectWpAction`

**Files:**
- Modify: `apps/web/lib/actions/onboarding.ts` (the `.update()` payload at ~188-197)

- [ ] **Step 1: Implement** (no isolated unit test — server action with Supabase; covered by typecheck + manual smoke)

In `connectWpAction`, change the projects `.update()` payload to include the version from the probe:

```typescript
    const { data: updatedRow, error: updateErr } = await supabase
      .from("projects")
      .update({
        wp_url: data.wpUrl,
        wp_username: data.wpUsername,
        wp_app_password_encrypted: encryptedPassword,
        manifest: probe.manifest,
        // v0.7.x alignment: record the connected plugin version for gating +
        // operator visibility. `probe.ok` is true here (guarded above).
        wp_plugin_version: probe.pluginVersion,
        status: existing.status === "draft" ? "onboarding" : existing.status,
      })
      .eq("id", data.projectId)
      .select("id, tenant_id")
      .single();
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @jab/web typecheck`
Expected: PASS — `probe.pluginVersion` is typed (probe is narrowed to `ok: true` after the `if (!probe.ok) return` guard).

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/actions/onboarding.ts
git commit -m "feat(saas-app): persist wp_plugin_version on connect"
```

### Task 2.5: Surface the version + probe warnings in the wizard

**Files:**
- Modify: `apps/web/lib/actions/onboarding.ts` (thread `warnings` into `ConnectWpResult`)
- Modify: `apps/web/components/onboarding-wizard.tsx` (render warnings on the connect step)

- [ ] **Step 1: Extend `ConnectWpResult`**

In `apps/web/lib/actions/onboarding.ts`:

```typescript
export type ConnectWpResult =
  | { ok: true; contentTypes: WPContentType[]; pluginVersion: string | null; warnings: string[] }
  | { ok: false; error: string };
```

And the success `return` at the end of `connectWpAction`:

```typescript
    return { ok: true, contentTypes, pluginVersion: probe.pluginVersion, warnings: probe.warnings };
```

- [ ] **Step 2: Mirror the type in the wizard prop**

In `apps/web/components/onboarding-wizard.tsx`, update `OnboardingConnectResult`:

```typescript
export type OnboardingConnectResult =
  | { ok: true; contentTypes: WPContentType[]; pluginVersion?: string | null; warnings?: string[] }
  | { ok: false; error: string };
```

- [ ] **Step 3: Render the warnings**

In `onboarding-wizard.tsx`, after a successful connect is stored (where `contentTypes` are set from the connect result), capture `pluginVersion`/`warnings` into state and render them on the connect step using the existing `Alert` component with `tone="warning"`:

```tsx
{connectWarnings.length > 0 && (
  <div className="mt-3 space-y-2">
    {connectWarnings.map((w, i) => (
      <Alert key={i} tone="warning" title="Plugin update recommended">{w}</Alert>
    ))}
  </div>
)}
```

Add `const [connectWarnings, setConnectWarnings] = useState<string[]>([]);` to the component state, and in the connect handler set `setConnectWarnings(result.ok ? (result.warnings ?? []) : [])`.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @jab/web typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/actions/onboarding.ts apps/web/components/onboarding-wizard.tsx
git commit -m "feat(saas-app): surface plugin version + staleness warnings in onboarding wizard"
```

---

## Phase 3 — `/diagnostics` fetcher + onboarding connector-health panel

### Task 3.1: `DiagnosticsReport` type + `getDiagnostics` fetcher

**Files:**
- Create: `apps/web/lib/jab/diagnostics.ts`
- Test: `apps/web/lib/jab/diagnostics.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/jab/diagnostics.test.ts
import { describe, it, expect } from "vitest";
import { isDiagnosticsReport } from "./diagnostics";

const SAMPLE = {
  plugin_version: "0.7.1", generated_at: "2026-06-03T00:00:00Z",
  summary: { pass: 5, warn: 1, fail: 0 },
  facts: [{ id: "plugin_version", label: "Plugin version", value: "0.7.1" }],
  checks: [{ id: "abilities_api", label: "Abilities API loaded", severity: "pass", message: "OK" }],
};

describe("isDiagnosticsReport", () => {
  it("accepts a well-formed report", () => { expect(isDiagnosticsReport(SAMPLE)).toBe(true); });
  it("rejects bodies missing checks/summary", () => {
    expect(isDiagnosticsReport({ plugin_version: "0.7.1" })).toBe(false);
    expect(isDiagnosticsReport(null)).toBe(false);
    expect(isDiagnosticsReport({ ...SAMPLE, checks: "no" })).toBe(false);
  });
});
```

(Add a `getDiagnostics` network test mirroring the `fetchSiteManifest` test pattern — Basic auth, `redirect: "manual"`, returns null on 404/network error/guard failure.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test lib/jab/diagnostics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/web/lib/jab/diagnostics.ts
import "server-only";
import { Buffer } from "node:buffer";
import type { JabCredentials } from "./ability-client";

export interface DiagnosticsCheck {
  id: string; label: string; severity: "pass" | "warn" | "fail";
  message: string; detail?: string | string[] | null;
}
export interface DiagnosticsFact { id: string; label: string; value: unknown; detail?: unknown }
export interface DiagnosticsReport {
  plugin_version: string; generated_at: string;
  summary: { pass: number; warn: number; fail: number };
  facts: DiagnosticsFact[];
  checks: DiagnosticsCheck[];
}

export function isDiagnosticsReport(v: unknown): v is DiagnosticsReport {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.summary === "object" && o.summary !== null &&
    Array.isArray(o.checks) && Array.isArray(o.facts)
  );
}

/**
 * Fail-soft GET /wp-json/jab/v1/diagnostics (plugin v0.7.1+, default cap
 * manage_options). Returns null on any non-200 (pre-v0.7.1 404, or 403 when
 * the app password lacks manage_options), network error, or guard failure.
 * Same redirect-manual SSRF posture as ability-client.ts wpRestFetch.
 */
export async function getDiagnostics(
  creds: JabCredentials,
  opts: { timeoutMs?: number } = {},
): Promise<DiagnosticsReport | null> {
  const auth = Buffer.from(`${creds.username}:${creds.appPassword}`, "utf8").toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8_000);
  try {
    const res = await fetch(`${creds.wpUrl.replace(/\/+$/, "")}/wp-json/jab/v1/diagnostics`, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) return null;
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isDiagnosticsReport(body) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @jab/web test lib/jab/diagnostics.test.ts && pnpm --filter @jab/web typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/diagnostics.ts apps/web/lib/jab/diagnostics.test.ts
git commit -m "feat(saas-app): DiagnosticsReport type + getDiagnostics fetcher for /wp-json/jab/v1/diagnostics"
```

### Task 3.2: Enhance `verifyPluginAction` to return the diagnostics report

**Files:**
- Modify: `apps/web/lib/actions/onboarding.ts` (`VerifyPluginResult` + `verifyPluginAction`)

- [ ] **Step 1: Implement** (no isolated unit test — server action; covered by typecheck + manual smoke)

1. Extend the result type:

```typescript
export interface VerifyPluginResult {
  ok: boolean;
  message?: string;
  report?: DiagnosticsReport;
  pluginVersion?: string | null;
}
```

2. Add imports: `import { getDiagnostics, type DiagnosticsReport } from "@/lib/jab/diagnostics";` and `import { decryptColumnToString } from "@/lib/crypto/encrypt";` (if not already imported). `verifyPluginAction` currently selects only `wp_url`. Extend the select to read credentials so it can call `/diagnostics`:

```typescript
  const { data: project, error: readErr } = await supabase
    .from("projects")
    .select("wp_url, wp_username, wp_app_password_encrypted")
    .eq("id", parsed.data.projectId)
    .single();
```

3. After the existing `/wp-json/jab/v1/` liveness check returns `res.ok`, attempt the richer diagnostics fetch (fail-soft — older plugins keep the plain success):

```typescript
    if (res.ok) {
      // v0.7.1+: enrich the liveness check with the structured diagnostics
      // report when credentials + the endpoint are available. Fail-soft: a
      // pre-v0.7.1 plugin (404) or a lower-priv app password (403) keeps the
      // plain { ok: true } liveness result.
      if (project.wp_username && project.wp_app_password_encrypted) {
        try {
          const appPassword = decryptColumnToString(project.wp_app_password_encrypted);
          const report = await getDiagnostics({
            wpUrl: project.wp_url.replace(/\/+$/, ""),
            username: project.wp_username,
            appPassword,
          });
          if (report) return { ok: true, report, pluginVersion: report.plugin_version };
        } catch {
          // fall through to the plain liveness success
        }
      }
      return { ok: true };
    }
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @jab/web typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/actions/onboarding.ts
git commit -m "feat(saas-app): verifyPluginAction returns structured diagnostics report when available"
```

### Task 3.3: Connector-health panel component

**Files:**
- Create: `apps/web/components/connector-health-panel.tsx`
- Modify: `apps/web/vitest.config.ts` (add `components/**/*.test.tsx` to `include`)
- Test: `apps/web/components/connector-health-panel.test.tsx`

> **Self-review catch:** `apps/web/vitest.config.ts` currently includes only `["lib/**/*.test.ts", "scripts/**/*.test.ts", "components/**/*.test.ts"]` — a `.test.tsx` file would NOT be collected. This is the first component render-test in the repo, so add the `.tsx` glob before writing the test.

- [ ] **Step 0: Extend the vitest include glob**

In `apps/web/vitest.config.ts`, change the `include` array to add the tsx pattern:

```typescript
    include: ["lib/**/*.test.ts", "scripts/**/*.test.ts", "components/**/*.test.ts", "components/**/*.test.tsx"],
```

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/components/connector-health-panel.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectorHealthPanel } from "./connector-health-panel";
import type { DiagnosticsReport } from "@/lib/jab/diagnostics";

const report: DiagnosticsReport = {
  plugin_version: "0.7.1", generated_at: "2026-06-03T00:00:00Z",
  summary: { pass: 5, warn: 1, fail: 0 },
  facts: [],
  checks: [
    { id: "abilities_api", label: "Abilities API loaded", severity: "pass", message: "OK" },
    { id: "acf_no_schema_skips", label: "No ACF schema skips", severity: "warn", message: "2 groups skipped" },
  ],
};

describe("ConnectorHealthPanel", () => {
  it("renders each check label + severity", () => {
    const html = renderToStaticMarkup(<ConnectorHealthPanel report={report} />);
    expect(html).toContain("Abilities API loaded");
    expect(html).toContain("No ACF schema skips");
    expect(html).toContain("0.7.1");
    expect(html).toContain("2 groups skipped");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test components/connector-health-panel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (use JAB tokens + existing `Card`/`Badge`)

```tsx
// apps/web/components/connector-health-panel.tsx
import type { DiagnosticsReport, DiagnosticsCheck } from "@/lib/jab/diagnostics";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const TONE: Record<DiagnosticsCheck["severity"], "success" | "warning" | "danger"> = {
  pass: "success", warn: "warning", fail: "danger",
};

export function ConnectorHealthPanel({ report }: { report: DiagnosticsReport }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connector health</CardTitle>
        <span className="font-mono text-[11px] text-gry">
          plugin v{report.plugin_version} · {report.summary.pass} pass · {report.summary.warn} warn · {report.summary.fail} fail
        </span>
      </CardHeader>
      <CardBody>
        <ul className="space-y-2">
          {report.checks.map((c) => (
            <li key={c.id} className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm text-wht">{c.label}</div>
                <div className="text-xs text-gry">{c.message}</div>
              </div>
              <Badge tone={TONE[c.severity]}>{c.severity}</Badge>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
```

> If `Badge`/`Card` props differ from the above, check `apps/web/components/ui/badge.tsx` + `card.tsx` and map to the actual API; the recon confirms a `tone` prop on `Badge` and `Card`/`CardHeader`/`CardTitle`/`CardBody` building blocks.

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @jab/web test components/connector-health-panel.test.tsx && pnpm --filter @jab/web typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/connector-health-panel.tsx apps/web/components/connector-health-panel.test.tsx
git commit -m "feat(saas-app): connector-health panel rendering /diagnostics checks"
```

### Task 3.4: Render the panel in the wizard after a successful verify

**Files:**
- Modify: `apps/web/components/onboarding-wizard.tsx`

- [ ] **Step 1: Implement**

In `onboarding-wizard.tsx`, capture the verify result's `report` into state and render `<ConnectorHealthPanel report={verifyReport} />` on the install/verify step when present:

```tsx
const [verifyReport, setVerifyReport] = useState<DiagnosticsReport | null>(null);
// in the verify handler:
const result = await onVerifyPlugin?.();
setVerifyReport(result?.report ?? null);
// in the verify step render, below the existing pass/fail Alert:
{verifyReport && <div className="mt-4"><ConnectorHealthPanel report={verifyReport} /></div>}
```

Add imports for `ConnectorHealthPanel` and `type DiagnosticsReport`. Update the `onVerifyPlugin` prop type to return `VerifyPluginResult` (import it from the actions module, or redefine structurally) so `.report` is typed.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @jab/web typecheck`
Expected: PASS

- [ ] **Step 3: Wire the action through the page** — confirm the onboard route passes `verifyPluginAction` to the wizard's `onVerifyPlugin` (it already does; the richer return type flows through). Typecheck the route file.

Run: `pnpm --filter @jab/web typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/onboarding-wizard.tsx
git commit -m "feat(saas-app): show connector-health panel in onboarding after verify"
```

---

## Phase 4 — `/site` fetcher wired into discovery

### Task 4.1: `getSiteManifest` app fetcher

**Files:**
- Modify: `apps/web/lib/jab/ability-client.ts` (add `getSiteManifest`, import `SiteManifest` from `@jab/core`)
- Test: `apps/web/lib/jab/ability-client.site.test.ts` (Create)

- [ ] **Step 1: Write the failing test** (mirror the `wpRestFetch` posture: Basic auth, `redirect: "manual"`, null on 404/redirect/network)

```typescript
// apps/web/lib/jab/ability-client.site.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { getSiteManifest } from "./ability-client";

const SAMPLE = {
  plugin_version: "0.7.1", generated_at: "2026-06-03T00:00:00Z",
  site: { title: "T", tagline: "", home_url: "https://x", site_url: "https://x", timezone: "UTC", locale: "en_US", permalink_structure: "/%postname%/" },
  front_page: { show_on_front: "page", static_front: { id: 2, slug: "home", title: "Home" }, posts_page: { id: null, slug: null, title: null } },
  branding: { site_icon_url: null, custom_logo_id: 9, custom_logo_url: "https://x/logo.png" },
  menus: [{ slug: "primary", label: "Primary" }],
  image_sizes: [{ name: "large", width: 1024, height: 0, crop: false }],
  theme: { slug: "tt4", name: "TT4", version: "1.0" },
};

describe("getSiteManifest", () => {
  const orig = globalThis.fetch;
  afterEach(() => { globalThis.fetch = orig; });
  it("returns the manifest on 200 and null on 404", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(SAMPLE), { status: 200 })) as typeof fetch;
    expect((await getSiteManifest({ wpUrl: "https://x", username: "u", appPassword: "p" }))?.front_page).toBeTruthy();
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    expect(await getSiteManifest({ wpUrl: "https://x", username: "u", appPassword: "p" })).toBeNull();
  });
  it("returns null on a 3xx redirect (SSRF posture)", async () => {
    globalThis.fetch = (async () => new Response("", { status: 302 })) as typeof fetch;
    expect(await getSiteManifest({ wpUrl: "https://x", username: "u", appPassword: "p" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test lib/jab/ability-client.site.test.ts`
Expected: FAIL — `getSiteManifest` not exported.

- [ ] **Step 3: Implement** in `apps/web/lib/jab/ability-client.ts`

Extend the existing `@jab/core` import to add the site types: `import { McpClient, type Manifest, type SiteManifest, isSiteManifest } from "@jab/core";`

Add the fetcher (reuse `wpRestFetch` for auth + redirect posture; it throws on redirect/non-ok, so catch → null):

```typescript
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
      `${creds.wpUrl}/wp-json/jab/v1/site`, creds, controller.signal,
    );
    return isSiteManifest(body) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @jab/web test lib/jab/ability-client.site.test.ts && pnpm --filter @jab/web typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/ability-client.ts apps/web/lib/jab/ability-client.site.test.ts
git commit -m "feat(saas-app): getSiteManifest fetcher for /wp-json/jab/v1/site with stock fallback contract"
```

### Task 4.2: `getGlobalStyles` accepts a known stylesheet

**Files:**
- Modify: `apps/web/lib/jab/ability-client.ts` (`getGlobalStyles` signature + skip the themes probe when `stylesheet` is supplied)

- [ ] **Step 1: Implement** — change the signature to `opts: { timeoutMs?: number; stylesheet?: string } = {}` and short-circuit the `themes?status=active` probe:

```typescript
    // Step 1: resolve the active theme stylesheet. Prefer a caller-supplied
    // value (from /site.theme.slug) to skip the stock /wp/v2/themes probe.
    let stylesheet = opts.stylesheet;
    if (!stylesheet) {
      let themes: Array<{ stylesheet?: string; status?: string }>;
      try {
        themes = await wpRestFetch<Array<{ stylesheet?: string; status?: string }>>(
          `${creds.wpUrl}/wp-json/wp/v2/themes?status=active`, creds, controller.signal,
        );
      } catch (err) {
        throw new JabAbilityError(
          `GET /wp-json/wp/v2/themes?status=active failed: ${err instanceof Error ? err.message : String(err)}`,
          "ability_call_failed", err,
        );
      }
      stylesheet = Array.isArray(themes) && themes.length > 0 ? themes[0].stylesheet : undefined;
    }
    if (!stylesheet) return null;
```

- [ ] **Step 2: Typecheck** — Run: `pnpm --filter @jab/web typecheck` → PASS (existing callers pass no `stylesheet`, still valid).

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/jab/ability-client.ts
git commit -m "feat(saas-app): getGlobalStyles accepts a known stylesheet to skip the stock themes probe"
```

### Task 4.3: Wire `/site` into `discover-site`

**Files:**
- Modify: `apps/web/lib/inngest/functions/discover-site.ts`

- [ ] **Step 1: Implement** — add a fail-soft `fetch-site-manifest` step before `resolve-front-page`, and use it:

```typescript
      // v0.7.0: one authenticated /site call supplies front-page mode + active
      // theme. Fail-soft -> null lets the stock paths below take over for
      // pre-v0.7.0 installs.
      const siteManifest = await step.run("fetch-site-manifest", () => getSiteManifest(creds));

      const frontPageSlug = await step.run("resolve-front-page", async () => {
        // Prefer /site (edit_posts cap, no manage_options requirement). Fall
        // back to the stock /wp/v2/settings + /pages path when /site is absent.
        if (siteManifest?.front_page?.show_on_front === "page") {
          const slug = siteManifest.front_page.static_front.slug;
          if (slug) return slug;
        }
        const fp = await resolveFrontPage(creds);
        return fp?.slug ?? null;
      });
```

Then in `fetch-global-styles`, pass the known stylesheet:

```typescript
        payload = await getGlobalStyles(creds, { stylesheet: siteManifest?.theme.slug ?? undefined });
```

Add `getSiteManifest` to the imports from `@/lib/jab/ability-client`.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @jab/web typecheck`
Expected: PASS

- [ ] **Step 3: Smoke (optional, requires a connected site)**

Run: `pnpm --filter @jab/web smoke:discover`
Expected: discovery completes; logs show the `/site` front-page slug used (or the stock fallback when `/site` is null).

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/inngest/functions/discover-site.ts
git commit -m "feat(saas-app): discover-site consumes /site for front page + theme, stock fallback intact"
```

---

## Phase 5 — REQUIRED `modified` / `modified_gmt` row fields + persistence

### Task 5.1: Add `modified` / `modified_gmt` to the row types

**Files:**
- Modify: `apps/web/lib/jab/ability-client.ts` (`PostListRow` ~474-481, `PageBySlugRecord` ~53-73)

- [ ] **Step 1: Implement**

`PostListRow`:

```typescript
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
```

`PageBySlugRecord` — add the two fields after `excerpt`:

```typescript
  excerpt: string;
  /** v0.7.0 REQUIRED row fields (mirror of each other; plugin emits GMT in both). */
  modified: string;
  modified_gmt: string;
  content?: string;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @jab/web typecheck`
Expected: PASS — additive required fields on a loosely-read shape; consumers don't break.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/jab/ability-client.ts
git commit -m "feat(saas-app): type modified/modified_gmt on PostListRow + PageBySlugRecord (v0.7.0 alignment)"
```

### Task 5.2: Migration 0026 + schema — `page_inventory.source_modified_gmt`

**Files:**
- Create: `apps/web/drizzle/migrations/0026_page_inventory_modified.sql`
- Modify: `apps/web/lib/db/schema.ts` (pageInventory ~275-300)

- [ ] **Step 1: Write the migration**

```sql
-- 0026_page_inventory_modified.sql — JAB app + plugin v0.7.x alignment
-- (2026-06-03 alignment epic, Phase 5).
--
-- Records each page's WP modified_gmt (from the v0.7.0 REQUIRED row field) so
-- builds can diff WP-side state and drive incremental re-sync (Phase 7). NULL
-- for rows written before this column existed or when the source row carried
-- no usable modified timestamp.

ALTER TABLE public.page_inventory
  ADD COLUMN IF NOT EXISTS source_modified_gmt TIMESTAMPTZ;

COMMENT ON COLUMN public.page_inventory.source_modified_gmt IS
  'WP modified_gmt of the source post at discovery time (v0.7.0 row field). Drives incremental re-sync change detection. NULL when unknown.';

-- ============================================================================
-- End 0026_page_inventory_modified.sql
-- ============================================================================
```

- [ ] **Step 2: Update schema** — in `pageInventory` after `paradigms`:

```typescript
    paradigms: text("paradigms").array().notNull().default([]),
    // WP modified_gmt of the source post at discovery time (migration 0026).
    // NULL when unknown. Drives Phase 7 incremental re-sync.
    sourceModifiedGmt: timestamp("source_modified_gmt", { withTimezone: true }),
```

- [ ] **Step 3: Apply migration** — Supabase `apply_migration` name `page_inventory_modified` (or `pnpm --filter @jab/web db:push` for dev).

- [ ] **Step 4: Typecheck** — Run: `pnpm --filter @jab/web typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/drizzle/migrations/0026_page_inventory_modified.sql apps/web/lib/db/schema.ts
git commit -m "feat(saas-app): add page_inventory.source_modified_gmt column (migration 0026)"
```

### Task 5.3: Thread `modified_gmt` through discovery + persistence

**Files:**
- Modify: `apps/web/lib/jab/persist-discovery.ts` (`PersistPagesInput` page shape + extract `toPageInventoryRow`)
- Modify: `apps/web/lib/inngest/functions/discover-site.ts` (thread `modified_gmt` into the persistPages payload)
- Test: `apps/web/lib/jab/persist-discovery.test.ts` (extend)

- [ ] **Step 1: Write/extend the failing test** — assert the upsert row carries `source_modified_gmt` by testing the extracted pure mapper:

```typescript
import { toPageInventoryRow } from "./persist-discovery";
it("maps source_modified_gmt onto the upsert row", () => {
  const row = toPageInventoryRow(
    { slug: "home", post_type: "page", title: "Home", route_path: "/home", block_count: 3, paradigms: [], sourceModifiedGmt: "2026-06-01T00:00:00Z", discovery: { slug: "home", post_type: "page", screenshotPaths: {}, blockCapturesByViewport: {} } },
    "b1", "p1",
  );
  expect(row.source_modified_gmt).toBe("2026-06-01T00:00:00Z");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test lib/jab/persist-discovery.test.ts`
Expected: FAIL — `toPageInventoryRow` not exported / field absent.

- [ ] **Step 3: Implement**

In `persist-discovery.ts`, add `sourceModifiedGmt?: string | null` to the `PersistPagesInput` page item type, extract the row mapper, and include the column:

```typescript
export function toPageInventoryRow(page: PersistPagesPage, buildId: string, projectId: string) {
  return {
    site_build_id: buildId,
    project_id: projectId,
    slug: page.slug,
    post_type: page.post_type,
    title: page.title,
    route_path: page.route_path,
    block_count: page.block_count,
    paradigms: page.paradigms,
    source_screenshot_paths: { source: page.discovery.screenshotPaths },
    rendering: "dynamic" as const,
    source_modified_gmt: page.sourceModifiedGmt ?? null,
  };
}
```

…and `persistPages` maps with `input.pages.map((p) => toPageInventoryRow(p, input.buildId, input.projectId))`. (`PersistPagesPage` is the page item type of `PersistPagesInput`; export it for the test.)

In `discover-site.ts`, thread the value: the `pageBlocks` items already carry the list `row`; capture `modified_gmt` when building `pageBlocks` (`modifiedGmt: row.modified_gmt`) and pass `sourceModifiedGmt: p.modifiedGmt` into the `persistPages` page objects.

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @jab/web test lib/jab/persist-discovery.test.ts && pnpm --filter @jab/web typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/persist-discovery.ts apps/web/lib/inngest/functions/discover-site.ts
git commit -m "feat(saas-app): persist source_modified_gmt per page from v0.7.0 row fields"
```

---

## Phase 6 — List pagination (stop losing >100 rows per CPT)

### Task 6.1: `listPostType` accepts sync inputs + `listAllPostType` paging loop

**Files:**
- Modify: `apps/web/lib/jab/ability-client.ts` (`ListPostTypeOpts`, `listPostType`, new `listAllPostType`)
- Test: `apps/web/lib/jab/ability-client.paging.test.ts` (Create)

- [ ] **Step 1: Write the failing test** (inject a fake `McpClient` via `callTool`)

```typescript
// apps/web/lib/jab/ability-client.paging.test.ts
import { describe, it, expect } from "vitest";
import { listAllPostType } from "./ability-client";
import type { McpClient } from "@jab/core";

function fakeClient(pages: Record<number, unknown[]>): McpClient {
  return {
    async callTool(_name: string, args: Record<string, unknown>) {
      const page = (args.page as number) ?? 1;
      return { isError: false, structuredContent: { posts: pages[page] ?? [] } };
    },
  } as unknown as McpClient;
}
const row = (id: number) => ({ id, title: `t${id}`, slug: `s${id}`, link: "", date: "", excerpt: "", modified: "", modified_gmt: "" });

describe("listAllPostType", () => {
  it("pages until a short page is returned and concatenates rows", async () => {
    const full = Array.from({ length: 100 }, (_, i) => row(i));
    const client = fakeClient({ 1: full, 2: full, 3: [row(999)] });
    const { rows, truncated } = await listAllPostType(client, {
      abilityName: "jab/get-posts", wrapperKey: "posts", numberposts: 100,
    });
    expect(rows.length).toBe(201);
    expect(truncated).toBe(false);
  });

  it("stops and flags truncated at maxPages", async () => {
    const full = Array.from({ length: 100 }, (_, i) => row(i));
    const client = fakeClient({ 1: full, 2: full, 3: full });
    const { rows, truncated } = await listAllPostType(client, {
      abilityName: "jab/get-posts", wrapperKey: "posts", numberposts: 100, maxPages: 2,
    });
    expect(rows.length).toBe(200);
    expect(truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test lib/jab/ability-client.paging.test.ts`
Expected: FAIL — `listAllPostType` not exported.

- [ ] **Step 3: Implement** — extend `listPostType` to forward optional sync inputs, then add the loop:

```typescript
export interface ListPostTypeOpts {
  abilityName: string;
  wrapperKey: string;
  numberposts: number;
  postStatus?: string;
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
    client, opts.abilityName, args,
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
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @jab/web test lib/jab/ability-client.paging.test.ts && pnpm --filter @jab/web typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/ability-client.ts apps/web/lib/jab/ability-client.paging.test.ts
git commit -m "feat(saas-app): listAllPostType pagination loop using v0.7.0 deterministic ordering"
```

### Task 6.2: Use `listAllPostType` in `discover-site`

**Files:**
- Modify: `apps/web/lib/inngest/functions/discover-site.ts` (list-{cpt} loop ~232-242)

- [ ] **Step 1: Implement** — replace the capped `listPostType` call:

```typescript
      for (const cpt of postTypes) {
        const meta = resolveCptAbilityMeta(manifest, cpt);
        const { rows, truncated } = await step.run(`list-${cpt.slug}`, () =>
          listAllPostType(client, {
            abilityName: meta.listAbilityName,
            wrapperKey: meta.listWrapperKey,
            numberposts: 100,
            postStatus: "publish",
            maxPages: 20, // 2000-row safety cap; log when hit
          }),
        );
        if (truncated) {
          console.warn(
            `[discoverSite ${buildId}] ${cpt.slug}: pagination hit the 2000-row cap — tail not discovered.`,
          );
        }
        perCptLists.push({ cpt, meta, rows });
      }
```

Add `listAllPostType` to the imports from `@/lib/jab/ability-client` (keep `listPostType` imported too — still used by `listAllPostType` and exported for tests).

- [ ] **Step 2: Typecheck** — Run: `pnpm --filter @jab/web typecheck` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/inngest/functions/discover-site.ts
git commit -m "feat(saas-app): discover-site pages every CPT — no more >100-row truncation"
```

---

## Phase 7 — Modified-watermark incremental re-sync

> **Scope guard:** this phase is additive and guarded. A full render still needs every page, so "incremental" means: when a prior *ready* build exists, fetch the changed set via `modified_after`, re-capture only changed/new pages, and carry forward unchanged pages' prior inventory. If the prior build is absent or the watermark is missing, fall through to the existing full discovery. The pure selection logic is unit-tested; the worker wiring is minimal and behind the prior-build guard.

### Task 7.1: Pure incremental helpers

**Files:**
- Create: `apps/web/lib/jab/incremental.ts`
- Test: `apps/web/lib/jab/incremental.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/jab/incremental.test.ts
import { describe, it, expect } from "vitest";
import { resolveSyncWindow, selectChangedPages, maxModifiedGmt } from "./incremental";

describe("maxModifiedGmt", () => {
  it("returns the latest modified_gmt or null when empty", () => {
    expect(maxModifiedGmt([{ modified_gmt: "2026-06-01T00:00:00Z" }, { modified_gmt: "2026-06-03T00:00:00Z" }]))
      .toBe("2026-06-03T00:00:00Z");
    expect(maxModifiedGmt([])).toBeNull();
    expect(maxModifiedGmt([{ }])).toBeNull();
  });
});

describe("resolveSyncWindow", () => {
  it("yields modifiedAfter when a watermark exists, empty otherwise", () => {
    expect(resolveSyncWindow("2026-06-01T00:00:00Z")).toEqual({ modifiedAfter: "2026-06-01T00:00:00Z" });
    expect(resolveSyncWindow(null)).toEqual({});
  });
});

describe("selectChangedPages", () => {
  const prior = [
    { slug: "home", postType: "page", modifiedGmt: "2026-06-01T00:00:00Z" },
    { slug: "about", postType: "page", modifiedGmt: "2026-06-01T00:00:00Z" },
  ];
  const cur = (over: Partial<{ slug: string; modified_gmt: string }> = {}) =>
    ({ id: 1, title: "", slug: "home", link: "", date: "", excerpt: "", modified: "", modified_gmt: "2026-06-03T00:00:00Z", ...over });

  it("flags full sync when there is no window", () => {
    const r = selectChangedPages(prior, [cur()], {});
    expect(r.isFullSync).toBe(true);
  });
  it("selects only pages newer than the window plus brand-new slugs", () => {
    const r = selectChangedPages(prior, [cur({ slug: "home" }), cur({ slug: "new", modified_gmt: "2026-06-03T00:00:00Z" })], { modifiedAfter: "2026-06-02T00:00:00Z" });
    expect(r.isFullSync).toBe(false);
    expect(r.changedSlugs.has("home")).toBe(true);
    expect(r.changedSlugs.has("new")).toBe(true);
    expect(r.changedSlugs.has("about")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test lib/jab/incremental.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/web/lib/jab/incremental.ts
import type { PostListRow } from "./ability-client";

export interface PriorPage { slug: string; postType: string; modifiedGmt: string | null }
export interface ChangedSet { changedSlugs: Set<string>; isFullSync: boolean }

/** Latest modified_gmt across rows (ISO strings sort lexicographically). */
export function maxModifiedGmt(rows: Array<{ modified_gmt?: string }>): string | null {
  let max: string | null = null;
  for (const r of rows) {
    const m = r.modified_gmt;
    if (typeof m === "string" && m !== "" && (max === null || m > max)) max = m;
  }
  return max;
}

export function resolveSyncWindow(priorWatermark: string | null): { modifiedAfter?: string } {
  return priorWatermark ? { modifiedAfter: priorWatermark } : {};
}

/**
 * Decide which slugs to re-capture. With no window (first build or no prior
 * watermark) -> full sync (every page). With a window -> pages whose
 * modified_gmt is at/after the window, plus any slug not present in the prior
 * build (brand-new content). Deletions are handled by the caller diffing
 * prior vs current slug sets; this returns what to (re)capture.
 */
export function selectChangedPages(
  prior: PriorPage[],
  current: PostListRow[],
  window: { modifiedAfter?: string },
): ChangedSet {
  if (!window.modifiedAfter) return { changedSlugs: new Set(current.map((r) => r.slug)), isFullSync: true };
  const priorSlugs = new Set(prior.map((p) => p.slug));
  const changed = new Set<string>();
  for (const r of current) {
    const isNew = !priorSlugs.has(r.slug);
    const isTouched = typeof r.modified_gmt === "string" && r.modified_gmt >= window.modifiedAfter;
    if (isNew || isTouched) changed.add(r.slug);
  }
  return { changedSlugs: changed, isFullSync: false };
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @jab/web test lib/jab/incremental.test.ts && pnpm --filter @jab/web typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/incremental.ts apps/web/lib/jab/incremental.test.ts
git commit -m "feat(saas-app): pure incremental-sync helpers (window, changed-set, watermark)"
```

### Task 7.2: Persist + read the per-build watermark

**Files:**
- Modify: `apps/web/lib/inngest/functions/discover-site.ts` (write `last_sync_watermark` into `site_builds.config` at finalize)
- Create: `apps/web/lib/jab/load-prior-build.ts` (read prior ready build's watermark + page modified map)
- Test: `apps/web/lib/jab/load-prior-build.test.ts` (pure mapping portion only)

- [ ] **Step 1: Write the watermark into config at finalize**

In `discover-site.ts`, add a step after `finalize-counts` using the read-modify-write `config` pattern:

```typescript
      await step.run("persist-sync-watermark", async () => {
        const watermark = maxModifiedGmt(
          perCptLists.flatMap((p) => p.rows).map((r) => ({ modified_gmt: r.modified_gmt })),
        );
        if (!watermark) return null;
        const supabase = createAdminClient();
        const { data: row } = await supabase
          .from("site_builds").select("config").eq("id", buildId)
          .single<{ config: Record<string, unknown> | null }>();
        const nextConfig = { ...(row?.config ?? {}), last_sync_watermark: watermark };
        await supabase.from("site_builds").update({ config: nextConfig }).eq("id", buildId).eq("project_id", projectId);
        return null;
      });
```

Add `maxModifiedGmt` to the imports from `@/lib/jab/incremental`.

- [ ] **Step 2: Implement the prior-build loader** (extract the pure row→PriorPage mapping for unit testing):

```typescript
// apps/web/lib/jab/load-prior-build.ts
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PriorPage } from "./incremental";

export function toPriorPages(
  rows: Array<{ slug: string; post_type: string; source_modified_gmt: string | null }>,
): PriorPage[] {
  return rows.map((r) => ({ slug: r.slug, postType: r.post_type, modifiedGmt: r.source_modified_gmt }));
}

export async function loadPriorReadyBuild(projectId: string, tenantId: string): Promise<{
  buildId: string; watermark: string | null; priorPages: PriorPage[];
} | null> {
  void tenantId; // site_builds has no tenant_id column; RLS rides project_id -> projects.tenant_id
  const supabase = createAdminClient();
  const { data: build } = await supabase
    .from("site_builds")
    .select("id, config, status")
    .eq("project_id", projectId)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; config: Record<string, unknown> | null; status: string }>();
  if (!build) return null;
  const { data: pages } = await supabase
    .from("page_inventory")
    .select("slug, post_type, source_modified_gmt")
    .eq("site_build_id", build.id);
  return {
    buildId: build.id,
    watermark: (build.config?.last_sync_watermark as string | undefined) ?? null,
    priorPages: toPriorPages(pages ?? []),
  };
}
```

- [ ] **Step 3: Test the pure mapper**

```typescript
// apps/web/lib/jab/load-prior-build.test.ts
import { describe, it, expect } from "vitest";
import { toPriorPages } from "./load-prior-build";
it("maps page_inventory rows to PriorPage", () => {
  expect(toPriorPages([{ slug: "home", post_type: "page", source_modified_gmt: "2026-06-01T00:00:00Z" }]))
    .toEqual([{ slug: "home", postType: "page", modifiedGmt: "2026-06-01T00:00:00Z" }]);
});
```

Run: `pnpm --filter @jab/web test lib/jab/load-prior-build.test.ts` → after impl, PASS.

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm --filter @jab/web typecheck`

```bash
git add apps/web/lib/inngest/functions/discover-site.ts apps/web/lib/jab/load-prior-build.ts apps/web/lib/jab/load-prior-build.test.ts
git commit -m "feat(saas-app): persist per-build sync watermark + prior-ready-build loader"
```

### Task 7.3: Use the window for incremental re-capture (guarded)

**Files:**
- Modify: `apps/web/lib/inngest/functions/discover-site.ts`

- [ ] **Step 1: Implement** — before the per-page block-fetch loop, load the prior build and compute the changed set; when not a full sync, restrict the expensive block-fetch + screenshot work to changed slugs and carry forward unchanged prior `page_inventory` rows.

```typescript
      const prior = await step.run("load-prior-build", () => loadPriorReadyBuild(projectId, tenantId));
      const syncWindow = resolveSyncWindow(prior?.watermark ?? null);
      const changed = selectChangedPages(
        prior?.priorPages ?? [],
        perCptLists.flatMap((p) => p.rows),
        syncWindow,
      );
      if (!changed.isFullSync) {
        console.log(`[discoverSite ${buildId}] incremental sync: ${changed.changedSlugs.size} changed/new pages (window > ${syncWindow.modifiedAfter}).`);
      }
```

Then filter `flatJobs` to `changed.changedSlugs` when `!changed.isFullSync`. For unchanged slugs, copy the prior build's `page_inventory` row data into this build via the existing `persistPages` path. Keep full behavior when `isFullSync`.

> **Implementer guidance — keep this strictly additive.** Simplest correct v1: when `!isFullSync`, still LIST every CPT (cheap) but only run the expensive per-page `getPostBySlug` + Playwright capture for `changedSlugs`; for unchanged slugs, copy the prior build's `page_inventory` row (slug, post_type, title, route_path, block_count, paradigms, source_screenshot_paths, source_modified_gmt) into the new build. This preserves a complete inventory for compose while skipping re-capture of unchanged pages. If carry-forward proves too involved, fall back to full sync (the guard makes this safe) and log that incremental was skipped — never produce a partial inventory.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @jab/web typecheck`
Expected: PASS

- [ ] **Step 3: Smoke (requires a connected site with a prior ready build)**

Run: `pnpm --filter @jab/web smoke:discover`
Expected: second run logs "incremental sync: N changed/new pages"; inventory page count matches the full site.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/inngest/functions/discover-site.ts
git commit -m "feat(saas-app): incremental re-discovery using modified_after window + carry-forward"
```

---

## Phase 8 — CLI `/site` scaffold wiring

### Task 8.1: `runInit` fetches `/site` and writes `.jab/site.json`

**Files:**
- Modify: `packages/cli/src/commands/init.ts`

- [ ] **Step 1: Implement** (no CLI test runner — typecheck + manual integration)

After the manifest is written in `runInit`, add a fail-soft `/site` fetch and write:

```typescript
import { fetchSiteManifest } from "@jab/core";
// ...after writing manifest.json:
const site = await fetchSiteManifest({ wpUrl, user, password });
if (site) {
  await writeFile(path.join(outDir, "site.json"), JSON.stringify(site, null, 2) + "\n", "utf8");
  console.log(`  Saved site manifest (identity/branding)  -> ${path.join(outDir, "site.json")}`);
} else {
  console.log("  Skipped site manifest (plugin < v0.7.0 or /site unavailable).");
}
```

- [ ] **Step 2: Build core, then typecheck the CLI** (CLI imports `@jab/core` from its built `dist`):

Run: `pnpm --filter @jab/core build && pnpm --filter @jab/wp-headless-cli typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/commands/init.ts
git commit -m "feat(cli): jab init fetches /wp-json/jab/v1/site -> .jab/site.json (fulfills README scaffold claim)"
```

---

## Phase 9 — Documentation reconciliation

### Task 9.1: Reconcile the plugin README `/site` + `/diagnostics` "consumed by" claims

**Files:**
- Modify: `packages/wp-plugin/README.md` (the `/site` and `/diagnostics` rows, ~:88-89)

- [ ] **Step 1: Update** the two endpoint descriptions so they state the *now-true* integration precisely: the app consumes `/site` in discovery (front page + theme) and `/diagnostics` in onboarding verify (connector-health panel); the CLI writes `.jab/site.json`. Replace any wording that previously overstated consumption with the actual call sites.

- [ ] **Step 2: Commit**

```bash
git add packages/wp-plugin/README.md
git commit -m "docs(wp-plugin): reconcile /site + /diagnostics consumed-by claims with the now-wired app + CLI"
```

### Task 9.2: Update root `CLAUDE.md` status + the alignment memory

**Files:**
- Modify: `CLAUDE.md` (SaaS track table / "Current state" snapshot)
- Modify: `C:\Users\srskm\.claude\projects\c--Projects-wp-headless\memory\app-pinned-to-v060-plugin-contract.md` + its `MEMORY.md` pointer

- [ ] **Step 1: Update CLAUDE.md** — record that `apps/web` now captures `wp_plugin_version`, consumes `/site` (discovery) and `/diagnostics` (onboarding), types/persists `modified`/`modified_gmt`, paginates list calls, and supports modified-watermark incremental re-sync.

- [ ] **Step 2: Update the memory** — edit the project memory to reflect implementation (keep the historical "was pinned to v0.6.0" context; add "resolved 2026-06-03 by docs/superpowers/plans/2026-06-03-jab-app-plugin-v0.7.x-alignment.md"). Update the `MEMORY.md` one-liner.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record JAB app + plugin v0.7.x alignment in status tables"
```

### Task 9.3: Final verification gate

- [ ] **Step 1: Full test + typecheck across touched packages**

Run:
```bash
pnpm --filter @jab/core test && pnpm --filter @jab/core typecheck
pnpm --filter @jab/web test && pnpm --filter @jab/web typecheck
pnpm --filter @jab/wp-headless-cli typecheck
```
Expected: all PASS.

- [ ] **Step 2: Build gate**

Run: `pnpm --filter @jab/core build && pnpm --filter @jab/web build`
Expected: PASS.

- [ ] **Step 3: Finish the branch** — use `superpowers:finishing-a-development-branch` to merge/PR.

---

## Self-Review Checklist (run before execution)

1. **Spec coverage** — map each audit step to a phase: version capture/gating → P1+P2; `/diagnostics` → P3; `/site` → P4; `modified` fields → P5; pagination → P6; incremental sync → P7; CLI `/site` → P8; docs → P9. All nine covered.
2. **Placeholder scan** — every code step shows complete code (the earlier draft's deliberate non-compiling loop marker was removed; Task 6.1 ships the final `while` loop).
3. **Type consistency** — `SiteManifest` (P1.4) is imported by P4.1/P4.3; `DiagnosticsReport` (P3.1) by P3.2/P3.3/P3.4; `PostListRow.modified_gmt` (P5.1) by P5.3/P6.1/P7.1; `ProbeResult.pluginVersion`/`warnings` (P2.2) by P2.4/P2.5; `ListPostTypeOpts` (P6.1) supersets the P2 sync inputs. Names match the Shared Contracts block.
4. **Migration numbering** — 0025 (projects.wp_plugin_version), 0026 (page_inventory.source_modified_gmt); highest existing confirmed 0024.

