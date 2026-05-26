# SaaS v2 Phase A — Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase A "Discover" stage of the SaaS v2 pipeline — given a connected `project_id`, produce a complete `block_inventory` + `page_inventory` + per-page source screenshots + computed-CSS aggregates + theme.json snapshot, persisted to the Stage 0 tables and Supabase Storage.

**Architecture:** A new Inngest worker `discoverSite` orchestrates: (1) ability-client calls to enumerate menus, post types, and per-page block trees via the v0.6.0 plugin; (2) a Playwright pass to capture screenshots + computed CSS + bounding rects per viewport per page; (3) an `inventory.ts` reducer that walks the typed `BlockNode[]` trees and assigns tiers; (4) persistence to `block_inventory` / `page_inventory` + a new `site-screenshots` Supabase Storage bucket; (5) chained dispatch of the existing `project/design.requested` event for the one-shot design-tokens pass. Pipeline rationale lives in [`docs/saas-v2-component-pipeline.md`](../../saas-v2-component-pipeline.md) §4 Phase A.

**Tech Stack:** Next.js 15 (server-only modules), TypeScript 5.5, Inngest 3.27 (workers), `@jab/core` McpClient (MCP transport), Supabase service-role client (DB + Storage), Playwright `chromium` (headless), `vitest` (added in Task 1 — no test framework exists in `apps/web` yet). Plugin floor: v0.6.0.

---

## Inline decisions for controller review (Sean)

These were made in the plan without re-prompting; flag any to revisit before dispatch:

1. **Inngest-vs-dedicated-worker for Playwright is a spike-first task (Task 5).** The plan does NOT pre-commit to either path. Task 5 runs a smoke inside an Inngest function; Task 6 contains two branches (continue in Inngest / scaffold a `DiscoveryRunner` HTTP adapter for Fly/Railway). The smoke result decides which Task 7 onwards consumes. Both branches use the same `playwright-discovery.ts` module — the seam is only at the call site.

2. **Tier heuristics seed list** (Task 11, baked into `inventory.ts`):
   - **trivial**: `core/heading`, `core/paragraph`, `core/list`, `core/list-item`, `core/separator`, `core/spacer`, `core/quote`, `core/preformatted`, `core/code`, `core/html` (raw passthrough but cheap LLM scaffolds the wrapper)
   - **standard**: `core/columns`, `core/column`, `core/group`, `core/cover`, `core/buttons`, `core/button`, `core/image`, `core/embed`, `core/social-links`, `core/social-link`
   - **visual**: `core/gallery`, `core/media-text`, `core/post-template`, `core/query`, `core/post-featured-image`, anything matching `acf/*`
   - **passthrough**: anything else AND any block whose `occurrence_count <= 2` (overrides tier above), AND any block with `blockName === null` (classic-editor content).

   The comment in `inventory.ts` calls this v1 seed and notes it is meant to be tuned after the first real Two Roads run.

3. **New Storage bucket `site-screenshots`** (Task 14). The existing `project-assets` bucket is public (for srcDoc iframes that no longer exist). Screenshots are tenant-scoped build artifacts — going into a separate **private** bucket. Signed URLs at read time (via `createSignedUrl`) for the Phase F review UI to load them. This is a deliberate scope addition not in Stage 0.

4. **No new plugin abilities required.** Discovery uses: `jab/get-menus` (exists in v0.6.0); auto-discovered `jab/get-{plural}` + `jab/get-{singular}-by-slug` per CPT (exist via Registry.php); `/wp-json/jab/v1/content-types` REST endpoint (exists); `/wp-json/wp/v2/global-styles` (stock WP 5.9+, no plugin call needed). Therefore **no `MANIFEST_V2_REQUIREMENTS` bump** in `probe.ts` — the existing `jab/get-menus` shibboleth already covers v0.6.0.

5. **`getPostBySlug(cpt, slug, includeBlocks)`** resolves the ability name + wrapper key from the project's stored `manifest` (Stage 0 keeps the `projects.manifest` JSONB column). Falls back to `jab/get-{kebab(cpt)}-by-slug` + `wrapper_key = snake(cpt)` if manifest is null. Documented inline; a tier-2 issue at most.

6. **Vitest** is added to `apps/web` in Task 1 (no test framework exists today). Configured for Node-environment unit tests against pure logic — Playwright/MCP/Supabase are mocked. The smoke against Two Roads (Task 22) is a manual `tsx` script, not a vitest test.

7. **Bounding-rect-to-block mapping (Task 9):** v1 uses WP's rendered `wp-block-{name}` class + `data-block` attributes that core/Gutenberg adds when `WP_DEBUG` is on. When that fails, fall back to walking the DOM in document order and zipping against the block tree's flattened top-level node list. This is "best-effort" by design per the design doc §6.1; mismatches degrade gracefully to "no computed CSS for that block instance," not a failure.

---

## File structure

**Create:**
- `apps/web/vitest.config.ts` — vitest setup for `apps/web`
- `apps/web/lib/jab/ability-client.test.ts` — co-located unit tests for the new ability-client methods
- `apps/web/lib/jab/playwright-discovery.ts` — headless Chromium per-page capture
- `apps/web/lib/jab/playwright-discovery.test.ts`
- `apps/web/lib/jab/inventory.ts` — BlockNode tree reducer + tier assignment
- `apps/web/lib/jab/inventory.test.ts`
- `apps/web/lib/jab/discovery-types.ts` — shared cross-module types (`PageDescriptor`, `PageDiscoveryResult`, `ComputedStyles`, `BoundingRect`)
- `apps/web/lib/inngest/functions/discover-site.ts` — the Inngest worker
- `apps/web/lib/jab/global-styles.ts` — `/wp-json/wp/v2/global-styles` fetcher
- `apps/web/lib/jab/global-styles.test.ts`
- `apps/web/scripts/smoke-discover-site.ts` — manual smoke runner against a project_id
- (Conditional, only if Task 5 spike fails) `apps/web/lib/jab/discovery-runner.ts` — abstract `DiscoveryRunner` interface + `InProcessRunner` + `HttpRunner` stub

**Modify:**
- `apps/web/package.json` — add `vitest`, `@vitest/expect`, `playwright`, `@types/css` devDeps
- `apps/web/lib/jab/ability-client.ts` — add `getMenus`, `listPostTypes`, `listPostType`, `getPostBySlug`, `getGlobalStyles` methods + supporting types
- `apps/web/lib/storage/bucket.ts` — add `SITE_SCREENSHOTS_BUCKET` constant + `ensureSiteScreenshotsBucket()` idempotent bootstrap
- `apps/web/app/api/inngest/route.ts` — register `discoverSite` in the `serve()` function list

**Do NOT modify (verified above):**
- `apps/web/lib/jab/probe.ts` — `MANIFEST_V2_REQUIREMENTS` floor stays `["jab/get-menus"]`; no new ability dependencies surface in this phase.
- `packages/wp-plugin/*` — no v0.7-prerequisite ability work is needed.

---

## Task 1: Add vitest to apps/web

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/lib/_smoke/sanity.test.ts` (deleted at end of task — proves the runner works)

- [ ] **Step 1: Install vitest + playwright + types**

```bash
cd apps/web && pnpm add -D vitest@^2.1.0 @vitest/expect@^2.1.0 playwright@^1.48.0
```

- [ ] **Step 2: Add the vitest script to package.json**

Open `apps/web/package.json`, in the `"scripts"` object insert (after `"typecheck"`):

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 3: Write `apps/web/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "scripts/**/*.test.ts"],
    // The `server-only` import marker throws when evaluated outside an RSC
    // bundler. Mock it so unit tests of server-only modules can import them.
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
```

- [ ] **Step 4: Write `apps/web/vitest.setup.ts`**

```ts
import { vi } from "vitest";

// `import "server-only"` is a Next.js marker package whose body throws at
// runtime outside a server bundle. In vitest we're already running on Node
// with no client-side risk, so a no-op stub is correct.
vi.mock("server-only", () => ({}));
```

- [ ] **Step 5: Write a sanity test at `apps/web/lib/_smoke/sanity.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("vitest sanity", () => {
  it("evaluates 1+1", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Run it**

```bash
cd apps/web && pnpm test
```

Expected: 1 test passes (`vitest sanity > evaluates 1+1`).

- [ ] **Step 7: Delete the sanity file**

```bash
rm apps/web/lib/_smoke/sanity.test.ts && rmdir apps/web/lib/_smoke
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/package.json apps/web/vitest.config.ts apps/web/vitest.setup.ts pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
🧪 chore(web): add vitest for unit tests

Stage 1 Phase A introduces unit tests for the ability-client, inventory
reducer, and Playwright discovery module. `apps/web` had no test framework;
vitest with node environment + server-only mock matches the existing
import surface.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Shared discovery types module

**Files:**
- Create: `apps/web/lib/jab/discovery-types.ts`

- [ ] **Step 1: Write the file**

```ts
import "server-only";
import type { BlockNode } from "./ability-client";

/**
 * Cross-module type definitions for Phase A discovery. Kept separate from
 * ability-client.ts (which speaks MCP) and playwright-discovery.ts (which
 * speaks Chromium) because both modules + the inventory reducer + the
 * Inngest worker all need to import these.
 *
 * Conventions:
 *   - Viewport widths are FIXED to the three the design doc §6.1 calls out:
 *     375 (mobile), 768 (tablet), 1280 (desktop). The Phase B / E pipelines
 *     consume the same triple — do not parameterize without changing them.
 *   - `slug` is the URL-routable slug, NOT the post id. `post_type` carries
 *     the WP post type for downstream dispatch (page, post, beer, etc.).
 *   - `BoundingRect` numbers are CSS pixels (post-DPR-divided), matching
 *     what `Element.getBoundingClientRect()` reports.
 */

export type ViewportWidth = 375 | 768 | 1280;

export const VIEWPORT_WIDTHS: readonly ViewportWidth[] = [375, 768, 1280] as const;

/**
 * The input contract to playwright-discovery: one entry per page to capture.
 */
export interface PageDescriptor {
  slug: string;
  post_type: string;
  /** Absolute URL on the WP origin — playwright navigates to this. */
  url: string;
  /**
   * Optional flattened top-level block list. When present, used by the
   * bounding-rect mapper to zip DOM-order matches against block-tree order
   * when class-based mapping misses. When absent, only class-based mapping
   * is attempted.
   */
  topLevelBlockNames?: (string | null)[];
}

/**
 * Subset of CSSStyleDeclaration we extract per block instance.
 * Aligned with design doc §6.1's enumerated list — about 30 properties.
 */
export interface ComputedStyles {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
  color?: string;
  backgroundColor?: string;
  backgroundImage?: string;
  textAlign?: string;
  textTransform?: string;
  paddingTop?: string;
  paddingRight?: string;
  paddingBottom?: string;
  paddingLeft?: string;
  marginTop?: string;
  marginRight?: string;
  marginBottom?: string;
  marginLeft?: string;
  borderTopWidth?: string;
  borderRightWidth?: string;
  borderBottomWidth?: string;
  borderLeftWidth?: string;
  borderColor?: string;
  borderRadius?: string;
  display?: string;
  flexDirection?: string;
  gap?: string;
  gridTemplateColumns?: string;
  alignItems?: string;
  justifyContent?: string;
  boxShadow?: string;
  opacity?: string;
}

export interface BoundingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Per-block-instance capture from Playwright. One entry per instance, not
 * per type — the inventory reducer aggregates per type later.
 *
 * `blockName` is `string | null` because classic-editor content emits null
 * blocks (top-level untyped HTML).
 */
export interface BlockInstanceCapture {
  blockName: string | null;
  computedStyles: ComputedStyles;
  boundingRect: BoundingRect;
}

/**
 * Per-page output of playwright-discovery. One entry per page across all
 * three viewports — the per-viewport screenshot paths land in
 * `screenshotPaths`, keyed by viewport width as a stringified number.
 */
export interface PageDiscoveryResult {
  slug: string;
  post_type: string;
  screenshotPaths: Record<string, string>; // "375" | "768" | "1280" → storage path
  /**
   * Captures keyed by viewport. Each viewport's array is one entry per
   * block instance VISIBLE at that viewport (so a desktop-only block has
   * no entry in the 375 array).
   */
  blockCapturesByViewport: Record<string, BlockInstanceCapture[]>;
  /**
   * Pages that failed to capture at any viewport land with a non-empty
   * `failures` field; the worker treats this as fail-soft (page still
   * inventoried block-wise, just no screenshots/computed-CSS available).
   */
  failures?: Array<{ viewport: ViewportWidth; reason: string }>;
}
```

- [ ] **Step 2: Compile check**

```bash
cd apps/web && pnpm typecheck
```

Expected: PASS (the file only imports a type from ability-client which already exports `BlockNode`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/jab/discovery-types.ts
git commit -m "$(cat <<'EOF'
🏗️ feat(web): shared discovery types for Phase A

Cross-module type contract used by the ability-client extensions, the
Playwright capture module, and the inventory reducer. Fixed viewport
triple (375/768/1280) matches design doc §6.1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Ability-client — `getMenus()`

**Files:**
- Modify: `apps/web/lib/jab/ability-client.ts`
- Create: `apps/web/lib/jab/ability-client.test.ts`

- [ ] **Step 1: Write the failing test (`apps/web/lib/jab/ability-client.test.ts`)**

```ts
import { describe, it, expect, vi } from "vitest";
import { McpClient } from "@jab/core";
import { getMenus, JabAbilityError } from "./ability-client";

function mockClient(impl: Partial<McpClient>): McpClient {
  return impl as unknown as McpClient;
}

describe("getMenus", () => {
  it("returns typed menus on the happy path", async () => {
    const client = mockClient({
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "ok" }],
        structuredContent: {
          menus: [
            {
              id: 7,
              slug: "main-menu",
              name: "Main Menu",
              locations: ["primary"],
              items: [
                {
                  id: 12,
                  title: "Home",
                  url: "/",
                  target: "",
                  object_type: "page",
                  object_id: 4,
                  parent_id: 0,
                  order: 1,
                },
              ],
            },
          ],
        },
      }),
    });

    const menus = await getMenus(client);
    expect(menus).toHaveLength(1);
    expect(menus[0].locations).toContain("primary");
    expect(menus[0].items[0].url).toBe("/");
  });

  it("throws JabAbilityError when isError=true", async () => {
    const client = mockClient({
      callTool: vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: "text", text: "permission denied" }],
      }),
    });
    await expect(getMenus(client)).rejects.toMatchObject({
      name: "JabAbilityError",
      code: "ability_call_failed",
    });
  });

  it("throws ability_call_failed when callTool throws", async () => {
    const client = mockClient({
      callTool: vi.fn().mockRejectedValue(new Error("network down")),
    });
    await expect(getMenus(client)).rejects.toMatchObject({
      code: "ability_call_failed",
    });
  });

  it("throws ability_response_invalid for malformed structuredContent", async () => {
    const client = mockClient({
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "ok" }],
        structuredContent: { menus: "not an array" },
      }),
    });
    await expect(getMenus(client)).rejects.toMatchObject({
      code: "ability_response_invalid",
    });
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd apps/web && pnpm vitest run lib/jab/ability-client.test.ts
```

Expected: FAIL — `getMenus is not exported from "./ability-client"`.

- [ ] **Step 3: Implement `getMenus` in `apps/web/lib/jab/ability-client.ts`**

Append below `getPageBySlug` (after the closing brace of that function, before EOF):

```ts
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
```

- [ ] **Step 4: Run the test, verify pass**

```bash
cd apps/web && pnpm vitest run lib/jab/ability-client.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/ability-client.ts apps/web/lib/jab/ability-client.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): ability-client getMenus() for Phase A discovery

Wraps jab/get-menus with the same isError + structuredContent narrowing
pattern as getPageBySlug. Light shape validation only — the plugin's
output_schema is authoritative.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Ability-client — `listPostTypes()`, `listPostType()`, `getPostBySlug()`, `getGlobalStyles()`

These four extend the same module + test file with the same error-code pattern as `getMenus`. Implementing them together because they share helper plumbing (`callJabAbility<T>` extracted in Step 1).

**Files:**
- Modify: `apps/web/lib/jab/ability-client.ts`
- Modify: `apps/web/lib/jab/ability-client.test.ts`

- [ ] **Step 1: Refactor — extract a shared `callJabAbility` helper**

Inside `ability-client.ts`, just below the `JabAbilityError` class, add a private helper. Then rewrite `getPageBySlug` and `getMenus` to use it (keeps existing behaviour, new methods reuse it).

```ts
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
```

Then rewrite `getMenus` and `getPageBySlug` to use it:

```ts
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
```

Run the existing tests to confirm the refactor preserves behaviour:

```bash
cd apps/web && pnpm vitest run lib/jab/ability-client.test.ts
```

Expected: 4 tests still pass.

- [ ] **Step 2: Write failing tests for `listPostTypes`, `listPostType`, `getPostBySlug`, `getGlobalStyles`**

Append to `ability-client.test.ts`:

```ts
import {
  getGlobalStyles,
  getPostBySlug,
  listPostType,
  listPostTypes,
} from "./ability-client";

// We'll set process.env values + mock fetch for REST-backed helpers.
const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

describe("listPostTypes", () => {
  it("fetches /wp-json/jab/v1/content-types and returns typed rows", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          post_types: [
            {
              slug: "page",
              rest_base: "pages",
              plural_label: "Pages",
              singular_label: "Page",
              is_builtin: true,
              hierarchical: true,
              count: 12,
            },
            {
              slug: "beer",
              rest_base: "beers",
              plural_label: "Beers",
              singular_label: "Beer",
              is_builtin: false,
              hierarchical: false,
              count: 47,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const types = await listPostTypes({
      wpUrl: "https://wp.example.com",
      username: "u",
      appPassword: "p",
    });
    expect(types).toHaveLength(2);
    expect(types[0].slug).toBe("page");
    expect(types[1].count).toBe(47);
  });

  it("throws ability_call_failed on non-200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("forbidden", { status: 403 }),
    );
    await expect(
      listPostTypes({ wpUrl: "https://wp.example.com", username: "u", appPassword: "p" }),
    ).rejects.toMatchObject({ code: "ability_call_failed" });
  });

  it("throws ability_response_invalid on malformed body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(
      listPostTypes({ wpUrl: "https://wp.example.com", username: "u", appPassword: "p" }),
    ).rejects.toMatchObject({ code: "ability_response_invalid" });
  });
});

describe("listPostType", () => {
  it("returns the wrapped array for an auto-discovered ability", async () => {
    const client = mockClient({
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "ok" }],
        structuredContent: {
          pages: [
            { id: 1, title: "Home", slug: "home", link: "/", excerpt: "", date: "2025-01-01T00:00:00Z" },
            { id: 2, title: "About", slug: "about", link: "/about", excerpt: "", date: "2025-01-02T00:00:00Z" },
          ],
        },
      }),
    });
    const rows = await listPostType(client, {
      abilityName: "jab/get-pages",
      wrapperKey: "pages",
      numberposts: 100,
    });
    expect(rows).toHaveLength(2);
    expect(rows[1].slug).toBe("about");
  });

  it("throws ability_response_invalid when wrapper key missing", async () => {
    const client = mockClient({
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "ok" }],
        structuredContent: { somethingElse: [] },
      }),
    });
    await expect(
      listPostType(client, {
        abilityName: "jab/get-pages",
        wrapperKey: "pages",
        numberposts: 100,
      }),
    ).rejects.toMatchObject({ code: "ability_response_invalid" });
  });
});

describe("getPostBySlug", () => {
  it("returns the typed record with blocks", async () => {
    const client = mockClient({
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "ok" }],
        structuredContent: {
          page: {
            id: 4,
            title: "Home",
            slug: "home",
            link: "/",
            excerpt: "",
            date: "2025-01-01T00:00:00Z",
            blocks: [
              {
                blockName: "core/heading",
                attrs: { level: 1 },
                innerBlocks: [],
                innerHTML: "<h1>hi</h1>",
                innerContent: ["<h1>hi</h1>"],
              },
            ],
          },
        },
      }),
    });
    const record = await getPostBySlug(client, {
      abilityName: "jab/get-page-by-slug",
      wrapperKey: "page",
      slug: "home",
      includeBlocks: true,
    });
    expect(record).not.toBeNull();
    expect(record!.blocks).toHaveLength(1);
    expect(record!.blocks![0].blockName).toBe("core/heading");
  });

  it("returns null when wrapper value is null (post not found)", async () => {
    const client = mockClient({
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "ok" }],
        structuredContent: { page: null },
      }),
    });
    const r = await getPostBySlug(client, {
      abilityName: "jab/get-page-by-slug",
      wrapperKey: "page",
      slug: "ghost",
      includeBlocks: true,
    });
    expect(r).toBeNull();
  });
});

describe("getGlobalStyles", () => {
  it("returns the parsed settings + styles payload", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          settings: { color: { palette: [{ slug: "primary", color: "#1a4d2e" }] } },
          styles: { typography: { fontFamily: "Inter" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const styles = await getGlobalStyles({
      wpUrl: "https://wp.example.com",
      username: "u",
      appPassword: "p",
    });
    expect(styles).not.toBeNull();
    expect(styles!.settings).toBeDefined();
  });

  it("returns null on 404 (classic theme, no theme.json)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("not found", { status: 404 }),
    );
    const styles = await getGlobalStyles({
      wpUrl: "https://wp.example.com",
      username: "u",
      appPassword: "p",
    });
    expect(styles).toBeNull();
  });
});
```

And add to the top of the test file:

```ts
import { afterEach } from "vitest";
```

- [ ] **Step 3: Run the failing tests**

```bash
cd apps/web && pnpm vitest run lib/jab/ability-client.test.ts
```

Expected: FAIL on the imports — `listPostTypes`, `listPostType`, `getPostBySlug`, `getGlobalStyles` not exported.

- [ ] **Step 4: Implement `listPostTypes` in `ability-client.ts`**

Append:

```ts
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
```

Note: `wpRestFetch` throws plain `Error` on HTTP failures. The `.catch` above re-wraps as `JabAbilityError` so callers see the same code surface as MCP-backed methods.

- [ ] **Step 5: Implement `listPostType` (MCP-backed, calls `jab/get-{rest_base}`)**

Append:

```ts
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
export async function listPostType(
  client: McpClient,
  opts: { abilityName: string; wrapperKey: string; numberposts: number; postStatus?: string },
): Promise<PostListRow[]> {
  const data = await callJabAbility<Record<string, unknown>>(
    client,
    opts.abilityName,
    {
      numberposts: opts.numberposts,
      post_status: opts.postStatus ?? "publish",
      include: { content: false, blocks: false, render: false },
    },
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
```

- [ ] **Step 6: Implement `getPostBySlug` (the generic version)**

Append:

```ts
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
```

- [ ] **Step 7: Implement `getGlobalStyles` (REST `/wp-json/wp/v2/global-styles/themes/{stylesheet}`)**

WP's `/wp-json/wp/v2/global-styles` lookup needs the active theme's stylesheet slug — easiest path is to fetch `/wp-json/` (root) to discover the `home` + theme info isn't always there, so use `/wp-json/wp/v2/themes?status=active` first. Append:

```ts
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

export async function getGlobalStyles(
  creds: JabCredentials,
  opts: { timeoutMs?: number } = {},
): Promise<GlobalStylesResponse | null> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Step 1: discover the active theme stylesheet.
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
    const stylesheet =
      Array.isArray(themes) && themes.length > 0 ? themes[0].stylesheet : undefined;
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
```

- [ ] **Step 8: Run all ability-client tests**

```bash
cd apps/web && pnpm vitest run lib/jab/ability-client.test.ts
```

Expected: all tests pass (4 original + 3 + 2 + 2 + 2 = 13).

- [ ] **Step 9: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/web/lib/jab/ability-client.ts apps/web/lib/jab/ability-client.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): ability-client extensions for Phase A discovery

Adds listPostTypes (REST /jab/v1/content-types), listPostType + getPostBySlug
(generic per-CPT MCP), and getGlobalStyles (stock WP REST themes →
global-styles two-step). Refactors getPageBySlug + getMenus over a shared
callJabAbility helper to keep the three error-code paths consistent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: SPIKE — Can Playwright run in Inngest's serverless runtime?

This task answers an unknown that gates Task 6's branch choice. Per the design doc §10 decision #5 and the roadmap's Stage 1 risks, **headless Chromium in Inngest's runtime is the highest-risk infrastructure question across the whole roadmap**. The spike is short — run a minimum and look at the result — so it sits inline rather than as a separate stage.

---

### SPIKE RESULT (2026-05-25) — YELLOW

**Executed as standalone smoke** (deviation from the plan's two-terminal Inngest-dev-UI dance — see "Deviation rationale" below). Mirrored the planned function body via `apps/web/scripts/_spike-playwright-baseline.mjs` calling `chromium.launch() → newContext({viewport:1280x800}) → page.goto(url, {waitUntil:"load"}) → page.screenshot()` against three URLs:

| URL | Result | Elapsed | Bytes |
|---|---|---|---|
| `https://example.com` | ✅ ok | ~700ms (cold ~4.7s) | 10,892 |
| `https://wordpress.org` | ❌ `page.goto: Page crashed` | ~3.7s | n/a |
| `https://en.wikipedia.org` | ❌ `page.screenshot: Target crashed` | ~4.0s | n/a |

Reproduced with hardened launch args (`--no-sandbox --disable-dev-shm-usage --disable-gpu --disable-features=IsolateOrigins,site-per-process`) and with both `waitUntil: "load"` and `waitUntil: "networkidle"`. Same crash signatures.

**Diagnosis:** the crash is local-environment-specific:
- Windows 10 Pro host
- Chromium 1223 binary from Playwright 1.60.0 cache
- Crash happens *during navigation*, not at screenshot — rules out screenshot memory pressure
- example.com (tiny static page) succeeds; any modern page with heavy JS/CSS crashes the renderer process
- Likely either a Windows Defender / AV interception of Chromium subprocesses OR a Chromium 1223 bug specific to Windows builds

**Decision: take the IN-PROCESS branch in Task 6 *AND* fully scaffold the `HttpRunner` adapter.** Both paths matter because:
1. **Local-Windows dev reliability is YELLOW.** Task 22's Two Roads smoke will be the real test — if Two Roads' staging WP doesn't trip the same crash, we proceed. If it does, the implementer is the right person to harden Task 7 (retry-on-crash, viewport reduction, Chromium-channel pinning, possibly switching to `chromium-headless-shell`).
2. **Production deploy target is open.** apps/web's deploy target has not been fixed for v2. If Vercel: Playwright will not fit in serverless lambdas (~150MB Chromium against 250MB unzipped function limit, with `@sparticuz/chromium` providing a workaround that's its own infra question). If Fly/Railway/dedicated VM: in-process is viable. The `DiscoveryRunner` seam in Task 6 lets us swap implementations without touching the worker orchestration.

### Deviation rationale

The plan's Task 5 prescribed wrapping the smoke in an Inngest function, registering it in `route.ts`, then triggering via the Inngest dev UI's "Send Event" button. That requires interactive browser clicking that an autonomous agent can't perform reliably. Additionally, the spike's *real* question — "does this work in *production* Inngest" — depends entirely on apps/web's deploy target, which is open. The standalone smoke answers what's answerable now (does Chromium launch locally) without conflating it with the unanswerable bit.

**Files NOT created** (deviation): `apps/web/lib/inngest/functions/_spike-playwright.ts` and the temporary `route.ts` registration. The standalone smoke script was created, run, and deleted — no production worker registration was touched.

---

**Files:**
- Create (temporary, removed at end of task): `apps/web/lib/inngest/functions/_spike-playwright.ts`
- Modify (temporary): `apps/web/app/api/inngest/route.ts` (register, then unregister)

- [ ] **Step 1: Write a minimum Inngest function that launches chromium and screenshots a public URL**

`apps/web/lib/inngest/functions/_spike-playwright.ts`:

```ts
import "server-only";
import { inngest } from "../client";
import { chromium } from "playwright";

/**
 * SPIKE — do not ship. Answers: does Playwright + chromium work inside
 * an Inngest function in our environment?
 *
 * Trigger from the Inngest dev UI by sending the event
 * `_spike/playwright.test` with `{ url: "https://example.com" }`.
 *
 * Success criteria:
 *   - browser launches without error
 *   - navigate completes
 *   - screenshot returns a non-empty Buffer
 *   - total wall-clock < 30s
 */
export const _spikePlaywright = inngest.createFunction(
  { id: "_spike-playwright", retries: 0 },
  { event: "_spike/playwright.test" },
  async ({ event, step }) => {
    const url = (event.data as { url?: string }).url ?? "https://example.com";

    const result = await step.run("launch-navigate-screenshot", async () => {
      const start = Date.now();
      const browser = await chromium.launch({ headless: true });
      try {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
        const buf = await page.screenshot({ type: "png", fullPage: true });
        return {
          ok: true,
          bytes: buf.length,
          elapsedMs: Date.now() - start,
        };
      } finally {
        await browser.close();
      }
    });

    return result;
  },
);
```

- [ ] **Step 2: Register it in `apps/web/app/api/inngest/route.ts`**

Add the import and include it in the `functions` array:

```ts
import { _spikePlaywright } from "@/lib/inngest/functions/_spike-playwright";
// ...
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [extractProjectDesign, _spikePlaywright],
});
```

- [ ] **Step 3: Install Chromium binaries**

```bash
cd apps/web && npx playwright install chromium
```

Expected: downloads chromium build (~150 MB) into the Playwright cache.

- [ ] **Step 4: Run the Inngest dev server + the Next app and trigger the spike**

In two terminals:

```bash
# terminal A
cd apps/web && pnpm dev
```

```bash
# terminal B
npx inngest-cli@latest dev
```

Open `http://localhost:8288` (Inngest dev UI). Click "Send Event," enter:

```json
{
  "name": "_spike/playwright.test",
  "data": { "url": "https://example.com" }
}
```

Expected outcomes — record which one happens in the task notes:

- **GREEN:** function returns `{ ok: true, bytes: > 1000, elapsedMs: < 10000 }`. Step shows in the run trace. → **Task 6 takes the IN-PROCESS branch.**
- **YELLOW:** function returns successfully but `elapsedMs > 20000` or memory warnings appear. → Still take IN-PROCESS but document the latency budget concern; revisit in Task 22 telemetry.
- **RED:** function throws (browser launch fails, missing libs, OOM, sandbox error). → **Task 6 takes the DEDICATED-WORKER branch.**

- [ ] **Step 5: Document the spike result in a commit message**

If green/yellow:

```bash
git add apps/web/lib/inngest/functions/_spike-playwright.ts apps/web/app/api/inngest/route.ts apps/web/package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
🧪 spike(web): Playwright runs in Inngest dev runtime (PASS|YELLOW)

Spike per design doc §10 decision #5. chromium launched + screenshotted
example.com in <elapsed>ms. <Notes on memory, latency, or other concerns>.

Decision: Phase A discovery uses Inngest-hosted Playwright. The
DiscoveryRunner abstraction in Task 6 still exists as a seam for future
migration to a dedicated worker if production load shows different
characteristics from this dev spike.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If red, commit the same files with this message:

```bash
git commit -m "$(cat <<'EOF'
🧪 spike(web): Playwright does NOT run in Inngest runtime (FAIL)

Spike per design doc §10 decision #5. chromium launch failed with:
<paste error>

Decision: Phase A discovery scaffolds a DiscoveryRunner HTTP adapter
in Task 6 and a separate Fly/Railway service hosts Playwright. The
Inngest worker dispatches discovery jobs to that service via the
HttpRunner; the InProcessRunner remains for local-only dev.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Remove the spike file before continuing**

```bash
rm apps/web/lib/inngest/functions/_spike-playwright.ts
```

Then edit `apps/web/app/api/inngest/route.ts` to remove the import + the `_spikePlaywright` entry from the `functions` array (back to just `[extractProjectDesign]`).

```bash
cd apps/web && pnpm typecheck
```

Expected: PASS.

```bash
git add apps/web/lib/inngest/functions/_spike-playwright.ts apps/web/app/api/inngest/route.ts
git commit -m "🧹 chore(web): remove playwright spike, decision recorded above"
```

---

## Task 6: DiscoveryRunner seam

This task lays down the abstraction the rest of Phase A consumes. Either Task 5's spike was green (default to `InProcessRunner`) or red (default to `HttpRunner` with a dedicated service URL).

**Files:**
- Create: `apps/web/lib/jab/discovery-runner.ts`
- Create: `apps/web/lib/jab/discovery-runner.test.ts`

- [ ] **Step 1: Write the test (`apps/web/lib/jab/discovery-runner.test.ts`)**

```ts
import { describe, it, expect, vi } from "vitest";
import { InProcessRunner, type DiscoveryRunner, type DiscoveryJob } from "./discovery-runner";
import type { PageDiscoveryResult } from "./discovery-types";

describe("InProcessRunner", () => {
  it("delegates to the injected captureFn for each page", async () => {
    const captureFn = vi.fn().mockImplementation(
      async (job: DiscoveryJob): Promise<PageDiscoveryResult> => ({
        slug: job.pages[0].slug,
        post_type: job.pages[0].post_type,
        screenshotPaths: { "1280": "fake/path.png" },
        blockCapturesByViewport: { "1280": [] },
      }),
    );
    const runner: DiscoveryRunner = new InProcessRunner(captureFn);

    const result = await runner.run({
      buildId: "b1",
      projectId: "p1",
      tenantId: "t1",
      pages: [{ slug: "home", post_type: "page", url: "https://wp.example.com/" }],
    });
    expect(result).toHaveLength(1);
    expect(captureFn).toHaveBeenCalledOnce();
    expect(result[0].screenshotPaths["1280"]).toBe("fake/path.png");
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd apps/web && pnpm vitest run lib/jab/discovery-runner.test.ts
```

Expected: FAIL (module doesn't exist).

- [ ] **Step 3: Write `apps/web/lib/jab/discovery-runner.ts`**

```ts
import "server-only";
import type { PageDescriptor, PageDiscoveryResult } from "./discovery-types";

/**
 * Seam between the Inngest worker and the actual Playwright execution. The
 * Stage 1 spike (Task 5) decided whether the default runner is in-process
 * (chromium inside the Inngest function) or HTTP-based (dedicated Fly /
 * Railway service holding the browser).
 *
 * The seam exists either way: even with the in-process default, production
 * load may force a dedicated-worker migration without re-architecting the
 * discovery worker. Stages 4 (next build) and 5 (verification screenshots)
 * face the same decision and can reuse this abstraction.
 */

export interface DiscoveryJob {
  buildId: string;
  projectId: string;
  tenantId: string;
  pages: PageDescriptor[];
}

export interface DiscoveryRunner {
  run(job: DiscoveryJob): Promise<PageDiscoveryResult[]>;
}

/**
 * Default runner: calls a per-job capture function in-process. The capture
 * function is injected so the runner has no direct dependency on
 * playwright-discovery — keeps the test boundary clean.
 */
export class InProcessRunner implements DiscoveryRunner {
  constructor(
    private readonly captureFn: (
      pageJob: DiscoveryJob,
    ) => Promise<PageDiscoveryResult>,
  ) {}

  async run(job: DiscoveryJob): Promise<PageDiscoveryResult[]> {
    // Per-page sequential — chromium reuse across pages is left to the
    // capture function. Parallelism, if added, lives there too because
    // it needs to bound the open-context count for memory pressure.
    const out: PageDiscoveryResult[] = [];
    for (const page of job.pages) {
      const single = await this.captureFn({ ...job, pages: [page] });
      out.push(single);
    }
    return out;
  }
}

/**
 * Future-fit: HTTP runner that delegates to a dedicated Playwright service.
 * Stub now, fleshed out only when Task 5's spike forces it. The shape exists
 * here so the Inngest worker's wiring already takes a `DiscoveryRunner`
 * interface — switching defaults is a one-line edit later.
 */
export class HttpRunner implements DiscoveryRunner {
  constructor(private readonly endpointUrl: string, private readonly signingSecret: string) {}

  async run(_job: DiscoveryJob): Promise<PageDiscoveryResult[]> {
    throw new Error(
      "HttpRunner is a stub — implement when a dedicated Playwright service exists",
    );
  }
}
```

- [ ] **Step 4: Run the test**

```bash
cd apps/web && pnpm vitest run lib/jab/discovery-runner.test.ts
```

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/discovery-runner.ts apps/web/lib/jab/discovery-runner.test.ts
git commit -m "$(cat <<'EOF'
🏗️ feat(web): DiscoveryRunner seam for Phase A capture

Abstracts Playwright execution from the Inngest worker. InProcessRunner is
the default (Task 5 spike result above). HttpRunner stub exists for the
dedicated-worker migration path; the worker wiring already consumes the
interface so the swap is one line.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Playwright discovery module — page navigation + screenshot capture

**Files:**
- Create: `apps/web/lib/jab/playwright-discovery.ts`
- Create: `apps/web/lib/jab/playwright-discovery.test.ts`

The full module covers screenshot + computed-CSS + bounding-rect. Splitting by capability: Task 7 lands navigation + screenshots; Task 8 adds bounding-rect mapping; Task 9 adds computed-CSS extraction. Each is independently testable.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/lib/jab/playwright-discovery.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PageDescriptor } from "./discovery-types";

// We mock playwright at the boundary so unit tests don't need a real browser.
// The real-browser smoke runs via scripts/smoke-discover-site.ts (Task 22).
const mockPage = {
  goto: vi.fn(),
  setViewportSize: vi.fn(),
  screenshot: vi.fn(),
  evaluate: vi.fn(),
  close: vi.fn(),
};
const mockContext = { newPage: vi.fn().mockResolvedValue(mockPage), close: vi.fn() };
const mockBrowser = {
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: vi.fn(),
};

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mockBrowser),
  },
}));

// Mock storage upload to a no-op that returns a fake path.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        upload: vi.fn().mockResolvedValue({ data: { path: "ok" }, error: null }),
      }),
    },
  }),
}));

import { capturePage } from "./playwright-discovery";

beforeEach(() => {
  vi.clearAllMocks();
  mockPage.screenshot.mockResolvedValue(Buffer.from([0, 1, 2, 3]));
  mockPage.evaluate.mockResolvedValue([]); // no block instances captured in this test
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("capturePage — navigation + screenshot", () => {
  it("captures screenshots at all three viewports and returns storage paths", async () => {
    const page: PageDescriptor = { slug: "home", post_type: "page", url: "https://wp.example.com/" };
    const result = await capturePage({
      page,
      buildId: "b1",
      projectId: "p1",
      tenantId: "t1",
    });
    expect(result.slug).toBe("home");
    expect(Object.keys(result.screenshotPaths).sort()).toEqual(["1280", "375", "768"]);
    expect(mockPage.screenshot).toHaveBeenCalledTimes(3);
  });

  it("records a failure entry when navigation throws but does not throw", async () => {
    mockPage.goto.mockRejectedValueOnce(new Error("nav timeout"));
    const page: PageDescriptor = { slug: "broken", post_type: "page", url: "https://wp.example.com/broken" };
    const result = await capturePage({
      page,
      buildId: "b1",
      projectId: "p1",
      tenantId: "t1",
    });
    expect(result.failures).toBeDefined();
    expect(result.failures!.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd apps/web && pnpm vitest run lib/jab/playwright-discovery.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `apps/web/lib/jab/playwright-discovery.ts`**

```ts
import "server-only";
import { chromium, type Browser, type Page } from "playwright";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import {
  type BlockInstanceCapture,
  type PageDescriptor,
  type PageDiscoveryResult,
  type ViewportWidth,
  VIEWPORT_WIDTHS,
} from "./discovery-types";

/**
 * playwright-discovery.ts — Phase A capture per page per viewport.
 *
 * Three jobs:
 *   1. Navigate to the live WP URL with a sane wait state (`networkidle`)
 *      across each of the three viewports (375 / 768 / 1280).
 *   2. Take a full-page screenshot per viewport, upload to the
 *      site-screenshots bucket at
 *      `<buildId>/source/<viewport>/<slug>.png`.
 *   3. (Tasks 8 + 9) Map per-block bounding rects + computed styles. The
 *      placeholder in this task returns an empty array; Tasks 8 and 9
 *      replace it with the real implementation.
 *
 * Errors policy: fail-soft per viewport. A navigation timeout on tablet
 * does NOT abort capture for mobile or desktop. Failures are collected on
 * the `failures` field of the result; the worker decides whether to count
 * the page as inventoried (yes — blocks come from the MCP call) or
 * screenshot-less (yes — degraded fidelity, surfaced in Phase E later).
 *
 * Browser reuse: we launch chromium ONCE per `capturePage` call. The
 * DiscoveryRunner in Task 6 iterates pages sequentially in v1 — if Stage 1
 * telemetry shows the per-page launch overhead is significant, batch
 * pages per browser as a follow-up.
 */

export interface CapturePageInput {
  page: PageDescriptor;
  buildId: string;
  projectId: string;
  tenantId: string;
}

export async function capturePage(input: CapturePageInput): Promise<PageDiscoveryResult> {
  const { page: descriptor, buildId } = input;
  const result: PageDiscoveryResult = {
    slug: descriptor.slug,
    post_type: descriptor.post_type,
    screenshotPaths: {},
    blockCapturesByViewport: {},
  };
  const failures: NonNullable<PageDiscoveryResult["failures"]> = [];

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    for (const viewport of VIEWPORT_WIDTHS) {
      try {
        const captured = await captureAtViewport(browser, descriptor, viewport, buildId);
        result.screenshotPaths[String(viewport)] = captured.screenshotPath;
        result.blockCapturesByViewport[String(viewport)] = captured.blockCaptures;
      } catch (err) {
        failures.push({
          viewport,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  if (failures.length > 0) result.failures = failures;
  return result;
}

async function captureAtViewport(
  browser: Browser,
  descriptor: PageDescriptor,
  viewport: ViewportWidth,
  buildId: string,
): Promise<{ screenshotPath: string; blockCaptures: BlockInstanceCapture[] }> {
  const context = await browser.newContext({
    viewport: { width: viewport, height: heightFor(viewport) },
    // Headless UA — some hosts gate Cloudflare / WAF behavior on this.
    // Identifying as the agent is honest and easy to allowlist if a site
    // owner asks why their fidelity is degraded.
    userAgent: "JAB-Discovery/1.0 (+https://jab.app/bot)",
  });
  const page = await context.newPage();

  try {
    await page.goto(descriptor.url, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });

    const screenshotBuffer = await page.screenshot({
      type: "png",
      fullPage: true,
    });

    const storagePath = `${buildId}/source/${viewport}/${sanitizeSlugForPath(descriptor.slug || "front-page")}.png`;
    const supabase = createAdminClient();
    const { error: uploadErr } = await supabase.storage
      .from(SITE_SCREENSHOTS_BUCKET)
      .upload(storagePath, screenshotBuffer, {
        contentType: "image/png",
        upsert: true,
        cacheControl: "3600",
      });
    if (uploadErr) {
      throw new Error(`screenshot upload failed: ${uploadErr.message}`);
    }

    // Placeholder — Tasks 8 + 9 fill this in. Task 7 only delivers the
    // navigation + screenshot path; tests at this layer expect [].
    const blockCaptures: BlockInstanceCapture[] = await captureBlockInstances(page, descriptor);

    return { screenshotPath: storagePath, blockCaptures };
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
  }
}

/**
 * Placeholder — Tasks 8 + 9 implement bounding-rect + computed-CSS capture.
 * Lives behind this function so the test in Task 7 mocks `page.evaluate`
 * to return [] and gets a stable contract.
 */
async function captureBlockInstances(
  _page: Page,
  _descriptor: PageDescriptor,
): Promise<BlockInstanceCapture[]> {
  return [];
}

function heightFor(width: ViewportWidth): number {
  // Aspect ratios picked to bias toward enough first-paint content while
  // staying within reasonable headed-equivalent windows.
  if (width === 375) return 812;   // iPhone X-ish
  if (width === 768) return 1024;  // iPad portrait-ish
  return 800;                       // 1280×800 laptop default
}

/**
 * Storage paths can't contain control chars or '..'. WP slugs are already
 * URL-safe (lowercase, hyphens, alnum) but defence-in-depth keeps a
 * malformed slug from breaking the upload call.
 */
function sanitizeSlugForPath(slug: string): string {
  return slug.replace(/[^a-z0-9_-]/gi, "_").slice(0, 80) || "untitled";
}
```

- [ ] **Step 4: Run the test**

```bash
cd apps/web && pnpm vitest run lib/jab/playwright-discovery.test.ts
```

Expected: 2 tests pass. (The `SITE_SCREENSHOTS_BUCKET` import will currently fail because Task 14 hasn't run yet — add a temporary `export const SITE_SCREENSHOTS_BUCKET = "site-screenshots";` line to `apps/web/lib/storage/bucket.ts` now; Task 14 builds on it.)

- [ ] **Step 5: Add the bucket constant (will be expanded in Task 14)**

In `apps/web/lib/storage/bucket.ts`, append after `PROJECT_ASSETS_BUCKET`:

```ts
/**
 * Per-build screenshot bucket. PRIVATE (unlike PROJECT_ASSETS_BUCKET) —
 * Phase A source + Phase E generated screenshots are tenant-scoped build
 * artifacts. Phase F surfaces signed URLs to read them. Bootstrap +
 * permissions land in the same migration as Task 14.
 */
export const SITE_SCREENSHOTS_BUCKET = "site-screenshots";
```

Re-run the test:

```bash
cd apps/web && pnpm vitest run lib/jab/playwright-discovery.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/jab/playwright-discovery.ts apps/web/lib/jab/playwright-discovery.test.ts apps/web/lib/storage/bucket.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): playwright-discovery navigation + screenshots

Phase A capture skeleton: per-page navigation across 375/768/1280
viewports, full-page PNG upload to the site-screenshots bucket at
<buildId>/source/<viewport>/<slug>.png. Block-instance capture is a
placeholder filled in by Tasks 8 + 9.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Playwright discovery — bounding-rect block mapping

**Files:**
- Modify: `apps/web/lib/jab/playwright-discovery.ts`
- Modify: `apps/web/lib/jab/playwright-discovery.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `playwright-discovery.test.ts`:

```ts
describe("capturePage — block instance mapping", () => {
  it("returns block instances from page.evaluate output", async () => {
    mockPage.evaluate.mockResolvedValue([
      {
        blockName: "core/heading",
        boundingRect: { x: 0, y: 0, width: 800, height: 60 },
        computedStyles: {},
      },
      {
        blockName: "core/paragraph",
        boundingRect: { x: 0, y: 80, width: 800, height: 240 },
        computedStyles: {},
      },
    ]);
    const result = await capturePage({
      page: { slug: "home", post_type: "page", url: "https://wp.example.com/" },
      buildId: "b1",
      projectId: "p1",
      tenantId: "t1",
    });
    const captures = result.blockCapturesByViewport["1280"];
    expect(captures).toHaveLength(2);
    expect(captures[0].blockName).toBe("core/heading");
    expect(captures[1].boundingRect.height).toBe(240);
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd apps/web && pnpm vitest run lib/jab/playwright-discovery.test.ts -t "block instance mapping"
```

Expected: FAIL — `captures` is empty (still the placeholder).

- [ ] **Step 3: Implement `captureBlockInstances`**

Replace the placeholder body of `captureBlockInstances` in `playwright-discovery.ts`:

```ts
/**
 * Map every visible block instance on the page to its bounding rect.
 * Strategy (in fallback order):
 *
 *   1. Find every element matching `[class*="wp-block-"]`. Pull the block
 *      name from the `wp-block-{name}` class — converts to `core/{name}`
 *      for built-ins (the WP renderer prefixes core/ classes as just
 *      `wp-block-paragraph`, `wp-block-heading`, etc.; namespaced blocks
 *      like `acf/hero` render as `wp-block-acf-hero` — we reverse-map).
 *   2. Capture each element's `getBoundingClientRect()` + `getComputedStyle`
 *      property subset (Task 9 fills in the computed-styles fields; this
 *      task ships an empty object as a placeholder).
 *
 * We deliberately do NOT try to perfectly align with the BlockNode tree
 * order — that's the inventory builder's job. Block instances captured
 * here are typed by name only; the inventory reducer correlates names
 * with the tree to compute occurrence_count.
 */
async function captureBlockInstances(
  page: Page,
  _descriptor: PageDescriptor,
): Promise<BlockInstanceCapture[]> {
  return await page.evaluate(() => {
    const out: Array<{
      blockName: string | null;
      boundingRect: { x: number; y: number; width: number; height: number };
      computedStyles: Record<string, string>;
    }> = [];

    const elements = document.querySelectorAll<HTMLElement>('[class*="wp-block-"]');
    for (const el of elements) {
      // Find the wp-block-* class on this element (skip parents — they're
      // captured on their own iteration).
      const classes = Array.from(el.classList);
      const wpBlockClass = classes.find((c) => c.startsWith("wp-block-"));
      if (!wpBlockClass) continue;

      // `wp-block-acf-hero` → `acf/hero`. `wp-block-heading` → `core/heading`.
      const rest = wpBlockClass.slice("wp-block-".length);
      // Heuristic: if the first segment matches a known namespace prefix,
      // treat the first segment as the namespace. Otherwise default core/.
      // Known namespaces in the WP ecosystem: acf, jetpack, woocommerce, yoast.
      const knownNs = ["acf", "jetpack", "woocommerce", "yoast"];
      let blockName: string;
      const firstSeg = rest.split("-")[0];
      if (knownNs.includes(firstSeg)) {
        blockName = `${firstSeg}/${rest.slice(firstSeg.length + 1)}`;
      } else {
        blockName = `core/${rest}`;
      }

      const rect = el.getBoundingClientRect();
      // Skip zero-sized elements — they're either display:none, off-screen
      // siblings of conditional blocks, or block-supports wrappers that
      // don't actually render content.
      if (rect.width === 0 || rect.height === 0) continue;

      out.push({
        blockName,
        boundingRect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        // Task 9 populates this. Empty for now so the contract is stable.
        computedStyles: {},
      });
    }
    return out;
  });
}
```

- [ ] **Step 4: Run the test**

```bash
cd apps/web && pnpm vitest run lib/jab/playwright-discovery.test.ts
```

Expected: all tests pass (3 total in this file now).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/playwright-discovery.ts apps/web/lib/jab/playwright-discovery.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): playwright-discovery bounding-rect block mapping

Walks rendered DOM, finds wp-block-* elements, reverses the
namespace-prefix mapping (acf-hero → acf/hero, heading → core/heading),
captures bounding rects. Zero-sized blocks are skipped (display:none,
empty supports wrappers).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Playwright discovery — computed-CSS extraction

**Files:**
- Modify: `apps/web/lib/jab/playwright-discovery.ts`
- Modify: `apps/web/lib/jab/playwright-discovery.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
describe("capturePage — computed styles", () => {
  it("includes the property subset on each capture", async () => {
    mockPage.evaluate.mockResolvedValue([
      {
        blockName: "core/heading",
        boundingRect: { x: 0, y: 0, width: 800, height: 60 },
        computedStyles: {
          fontSize: "32px",
          fontWeight: "700",
          color: "rgb(26, 77, 46)",
          paddingTop: "16px",
        },
      },
    ]);
    const result = await capturePage({
      page: { slug: "home", post_type: "page", url: "https://wp.example.com/" },
      buildId: "b1",
      projectId: "p1",
      tenantId: "t1",
    });
    const capture = result.blockCapturesByViewport["1280"][0];
    expect(capture.computedStyles.fontSize).toBe("32px");
    expect(capture.computedStyles.color).toBe("rgb(26, 77, 46)");
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd apps/web && pnpm vitest run lib/jab/playwright-discovery.test.ts -t "computed styles"
```

Expected: PASS already (the mock returns the styles inline). But the production code path doesn't yet capture them — we need to ensure the in-browser evaluator pulls them.

- [ ] **Step 3: Update the in-browser evaluator inside `captureBlockInstances`**

Replace the `computedStyles: {},` line with the full extraction. The complete `captureBlockInstances` becomes:

```ts
async function captureBlockInstances(
  page: Page,
  _descriptor: PageDescriptor,
): Promise<BlockInstanceCapture[]> {
  return await page.evaluate(() => {
    // Properties we want — keep in sync with ComputedStyles in
    // discovery-types.ts. Strings on purpose: getComputedStyle returns
    // strings, and the LLM prompts consume them as strings.
    const PROPS = [
      "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
      "color", "backgroundColor", "backgroundImage",
      "textAlign", "textTransform",
      "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
      "marginTop", "marginRight", "marginBottom", "marginLeft",
      "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
      "borderColor", "borderRadius",
      "display", "flexDirection", "gap", "gridTemplateColumns",
      "alignItems", "justifyContent",
      "boxShadow", "opacity",
    ] as const;

    const out: Array<{
      blockName: string | null;
      boundingRect: { x: number; y: number; width: number; height: number };
      computedStyles: Record<string, string>;
    }> = [];

    const elements = document.querySelectorAll<HTMLElement>('[class*="wp-block-"]');
    for (const el of elements) {
      const classes = Array.from(el.classList);
      const wpBlockClass = classes.find((c) => c.startsWith("wp-block-"));
      if (!wpBlockClass) continue;

      const rest = wpBlockClass.slice("wp-block-".length);
      const knownNs = ["acf", "jetpack", "woocommerce", "yoast"];
      let blockName: string;
      const firstSeg = rest.split("-")[0];
      if (knownNs.includes(firstSeg)) {
        blockName = `${firstSeg}/${rest.slice(firstSeg.length + 1)}`;
      } else {
        blockName = `core/${rest}`;
      }

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      const cs = window.getComputedStyle(el);
      const computedStyles: Record<string, string> = {};
      for (const prop of PROPS) {
        // getPropertyValue uses CSS-cased names; the cssText property uses
        // camelCase via the StyleDeclaration object. Both work — using the
        // object-property syntax is shorter and stays type-stable.
        const value = cs[prop as keyof CSSStyleDeclaration];
        if (typeof value === "string" && value !== "") {
          computedStyles[prop] = value;
        }
      }

      out.push({
        blockName,
        boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        computedStyles,
      });
    }
    return out;
  });
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/web && pnpm vitest run lib/jab/playwright-discovery.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/playwright-discovery.ts apps/web/lib/jab/playwright-discovery.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): playwright-discovery extracts computed CSS per block

Per design doc §6.1: capture ~30 typography/spacing/layout/border
properties via getComputedStyle on each wp-block-* element. Empty
values are skipped to keep the captured payload compact.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Inventory reducer — tree walk + occurrence counts + attr samples

**Files:**
- Create: `apps/web/lib/jab/inventory.ts`
- Create: `apps/web/lib/jab/inventory.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/web/lib/jab/inventory.test.ts
import { describe, it, expect } from "vitest";
import type { BlockNode } from "./ability-client";
import { buildInventory } from "./inventory";

function blk(name: string | null, attrs: Record<string, unknown> = {}, inner: BlockNode[] = []): BlockNode {
  return { blockName: name, attrs, innerBlocks: inner, innerHTML: "", innerContent: [] };
}

describe("buildInventory — tree walk + counts", () => {
  it("counts occurrences across pages recursively", () => {
    const pages = [
      {
        slug: "home",
        post_type: "page",
        blocks: [
          blk("core/heading", { level: 1 }),
          blk("core/paragraph"),
          blk("core/columns", {}, [
            blk("core/column", {}, [blk("core/paragraph")]),
          ]),
        ],
      },
      {
        slug: "about",
        post_type: "page",
        blocks: [
          blk("core/heading", { level: 1 }),
          blk("core/paragraph"),
          blk("core/paragraph"),
        ],
      },
    ];
    const inv = buildInventory(pages);
    const heading = inv.find((b) => b.blockName === "core/heading")!;
    expect(heading.occurrenceCount).toBe(2);
    expect(heading.pageSlugs).toEqual(expect.arrayContaining(["home", "about"]));
    const paragraph = inv.find((b) => b.blockName === "core/paragraph")!;
    expect(paragraph.occurrenceCount).toBe(4);
    const column = inv.find((b) => b.blockName === "core/column")!;
    expect(column.occurrenceCount).toBe(1);
  });

  it("caps attr samples at 5 distinct shapes", () => {
    const blocks: BlockNode[] = [];
    for (let i = 0; i < 20; i++) {
      blocks.push(blk("core/heading", { level: (i % 6) + 1 }));
    }
    const inv = buildInventory([{ slug: "h", post_type: "page", blocks }]);
    const heading = inv.find((b) => b.blockName === "core/heading")!;
    expect(heading.attrSamples.length).toBeLessThanOrEqual(5);
  });

  it("preserves null blockName entries as their own inventory row", () => {
    const inv = buildInventory([
      {
        slug: "home",
        post_type: "page",
        blocks: [blk(null, {}), blk("core/heading")],
      },
    ]);
    const nullRow = inv.find((b) => b.blockName === null);
    expect(nullRow).toBeDefined();
    expect(nullRow!.occurrenceCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run the failing tests**

```bash
cd apps/web && pnpm vitest run lib/jab/inventory.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `apps/web/lib/jab/inventory.ts` — walk + counts + samples**

```ts
import "server-only";
import type { BlockNode } from "./ability-client";

/**
 * inventory.ts — Phase A reducer.
 *
 * Walks every page's BlockNode[] tree (recursively into innerBlocks),
 * accumulates per-block-name occurrence counts, attribute samples (capped
 * at 5 distinct shapes), the set of pages each block appears on, and
 * assigns an initial tier per the v1 heuristics seed list below.
 *
 * The reducer is PURE — no DB / Storage / network. The Inngest worker in
 * Task 17 calls `buildInventory(pages)` and persists the result.
 *
 * Tier assignment (v1 SEED LIST — tune after first Two Roads run):
 *
 *   trivial    — core/heading, core/paragraph, core/list, core/list-item,
 *                core/separator, core/spacer, core/quote, core/preformatted,
 *                core/code, core/html
 *
 *   standard   — core/columns, core/column, core/group, core/cover,
 *                core/buttons, core/button, core/image, core/embed,
 *                core/social-links, core/social-link
 *
 *   visual     — core/gallery, core/media-text, core/post-template,
 *                core/query, core/post-featured-image, anything matching
 *                `acf/*`
 *
 *   passthrough — anything else, OR occurrence_count <= 2 (overrides above),
 *                 OR blockName === null (classic-editor content).
 *
 * Tunability: the maps below are exported so future code (e.g. a Phase F
 * UI override) can read them without re-deriving.
 */

export const TIER_TRIVIAL = new Set([
  "core/heading",
  "core/paragraph",
  "core/list",
  "core/list-item",
  "core/separator",
  "core/spacer",
  "core/quote",
  "core/preformatted",
  "core/code",
  "core/html",
]);

export const TIER_STANDARD = new Set([
  "core/columns",
  "core/column",
  "core/group",
  "core/cover",
  "core/buttons",
  "core/button",
  "core/image",
  "core/embed",
  "core/social-links",
  "core/social-link",
]);

export const TIER_VISUAL = new Set([
  "core/gallery",
  "core/media-text",
  "core/post-template",
  "core/query",
  "core/post-featured-image",
]);

export type Tier = "trivial" | "standard" | "visual" | "passthrough";

export interface InventoryEntry {
  blockName: string | null;
  occurrenceCount: number;
  pageSlugs: string[];
  attrSamples: Array<Record<string, unknown>>;
  tier: Tier;
}

export interface PageBlocksInput {
  slug: string;
  post_type: string;
  blocks: BlockNode[];
}

const MAX_ATTR_SAMPLES_PER_BLOCK = 5;
const MAX_PAGE_SLUGS_PER_BLOCK = 50;

/**
 * Build the full inventory from a list of pages' block trees.
 */
export function buildInventory(pages: PageBlocksInput[]): InventoryEntry[] {
  const accum = new Map<
    string,
    {
      blockName: string | null;
      occurrenceCount: number;
      pageSlugs: Set<string>;
      attrShapes: Map<string, Record<string, unknown>>;
    }
  >();

  for (const page of pages) {
    walkBlocks(page.blocks, page.slug, accum);
  }

  const out: InventoryEntry[] = [];
  for (const [, entry] of accum) {
    out.push({
      blockName: entry.blockName,
      occurrenceCount: entry.occurrenceCount,
      pageSlugs: Array.from(entry.pageSlugs).slice(0, MAX_PAGE_SLUGS_PER_BLOCK),
      attrSamples: Array.from(entry.attrShapes.values()).slice(0, MAX_ATTR_SAMPLES_PER_BLOCK),
      tier: assignTier(entry.blockName, entry.occurrenceCount),
    });
  }
  // Stable order: occurrence desc, then name asc (nulls last).
  out.sort((a, b) => {
    if (b.occurrenceCount !== a.occurrenceCount) return b.occurrenceCount - a.occurrenceCount;
    if (a.blockName === null) return 1;
    if (b.blockName === null) return -1;
    return a.blockName.localeCompare(b.blockName);
  });
  return out;
}

/**
 * Recursive walk. Uses block name as the accumulator key. `null` blockName
 * (classic-editor) lands under the literal key `__null__` to keep the Map
 * single-typed without an extra branch on every read.
 */
function walkBlocks(
  blocks: BlockNode[],
  pageSlug: string,
  accum: Map<
    string,
    {
      blockName: string | null;
      occurrenceCount: number;
      pageSlugs: Set<string>;
      attrShapes: Map<string, Record<string, unknown>>;
    }
  >,
): void {
  for (const block of blocks) {
    const key = block.blockName ?? "__null__";
    let entry = accum.get(key);
    if (!entry) {
      entry = {
        blockName: block.blockName,
        occurrenceCount: 0,
        pageSlugs: new Set<string>(),
        attrShapes: new Map<string, Record<string, unknown>>(),
      };
      accum.set(key, entry);
    }
    entry.occurrenceCount += 1;
    entry.pageSlugs.add(pageSlug);

    // Sample shape = sorted keys list. Different keysets → different sample.
    // This is intentionally coarse — different VALUES under the same keyset
    // are NOT new samples. Same-shape samples after the first are dropped.
    const shapeKey = Object.keys(block.attrs).sort().join(",");
    if (!entry.attrShapes.has(shapeKey) && entry.attrShapes.size < MAX_ATTR_SAMPLES_PER_BLOCK) {
      // Defensive shallow clone — don't hand the LLM mutable references to
      // the worker's input data.
      entry.attrShapes.set(shapeKey, { ...block.attrs });
    }

    if (block.innerBlocks && block.innerBlocks.length > 0) {
      walkBlocks(block.innerBlocks, pageSlug, accum);
    }
  }
}

function assignTier(blockName: string | null, occurrence: number): Tier {
  // Null blockName = classic-editor / untyped passthrough.
  if (blockName === null) return "passthrough";
  // Rare blocks fall back regardless of name heuristic.
  if (occurrence <= 2) return "passthrough";
  if (blockName.startsWith("acf/")) return "visual";
  if (TIER_VISUAL.has(blockName)) return "visual";
  if (TIER_STANDARD.has(blockName)) return "standard";
  if (TIER_TRIVIAL.has(blockName)) return "trivial";
  // Unknown block name (third-party plugin, theme block, etc.) → passthrough.
  return "passthrough";
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/web && pnpm vitest run lib/jab/inventory.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/inventory.ts apps/web/lib/jab/inventory.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): inventory reducer — walk, count, sample, tier-assign

Pure reducer over BlockNode[] trees. Per-block accumulator tracks
occurrence count, page slugs, attribute samples (capped at 5 distinct
keysets). Tier assigned per the v1 seed list — comment in-file marks
it as tunable after first Two Roads run.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Inventory reducer — tier-assignment edge cases

**Files:**
- Modify: `apps/web/lib/jab/inventory.test.ts`

- [ ] **Step 1: Add tier-assignment tests**

Append:

```ts
describe("buildInventory — tier assignment", () => {
  it("assigns trivial tier to core/heading at >2 occurrences", () => {
    const inv = buildInventory([
      {
        slug: "p",
        post_type: "page",
        blocks: [blk("core/heading"), blk("core/heading"), blk("core/heading")],
      },
    ]);
    expect(inv.find((b) => b.blockName === "core/heading")!.tier).toBe("trivial");
  });

  it("assigns passthrough to a rare core/heading (2 or fewer)", () => {
    const inv = buildInventory([
      { slug: "p", post_type: "page", blocks: [blk("core/heading"), blk("core/heading")] },
    ]);
    expect(inv.find((b) => b.blockName === "core/heading")!.tier).toBe("passthrough");
  });

  it("assigns visual tier to acf/* blocks", () => {
    const inv = buildInventory([
      {
        slug: "p",
        post_type: "page",
        blocks: [blk("acf/hero"), blk("acf/hero"), blk("acf/hero")],
      },
    ]);
    expect(inv.find((b) => b.blockName === "acf/hero")!.tier).toBe("visual");
  });

  it("assigns passthrough to unknown third-party blocks", () => {
    const inv = buildInventory([
      {
        slug: "p",
        post_type: "page",
        blocks: [blk("woocommerce/cart"), blk("woocommerce/cart"), blk("woocommerce/cart")],
      },
    ]);
    expect(inv.find((b) => b.blockName === "woocommerce/cart")!.tier).toBe("passthrough");
  });

  it("assigns standard tier to core/columns at >2 occurrences", () => {
    const inv = buildInventory([
      {
        slug: "p",
        post_type: "page",
        blocks: [blk("core/columns"), blk("core/columns"), blk("core/columns")],
      },
    ]);
    expect(inv.find((b) => b.blockName === "core/columns")!.tier).toBe("standard");
  });
});
```

- [ ] **Step 2: Run the tests, verify pass**

```bash
cd apps/web && pnpm vitest run lib/jab/inventory.test.ts
```

Expected: 8 tests pass (3 from Task 10 + 5 new).

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/jab/inventory.test.ts
git commit -m "🧪 test(web): tier-assignment edge cases for inventory reducer

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Global-styles fetcher module wrapper

Since `getGlobalStyles` already landed in Task 4 as an ability-client method, this task adds a small post-processing helper for the data shape the inventory worker actually wants persisted.

**Files:**
- Create: `apps/web/lib/jab/global-styles.ts`
- Create: `apps/web/lib/jab/global-styles.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/lib/jab/global-styles.test.ts
import { describe, it, expect } from "vitest";
import { extractThemeJsonTokens } from "./global-styles";

describe("extractThemeJsonTokens", () => {
  it("flattens settings + styles into the persistence shape", () => {
    const result = extractThemeJsonTokens({
      settings: {
        color: { palette: [{ slug: "primary", color: "#1a4d2e" }] },
        typography: { fontSizes: [{ slug: "large", size: "32px" }] },
        spacing: { blockGap: "24px" },
      },
      styles: { color: { background: "#fff" } },
    });
    expect(result).not.toBeNull();
    expect(result!.colorPalette).toEqual([{ slug: "primary", color: "#1a4d2e" }]);
    expect(result!.fontSizes).toEqual([{ slug: "large", size: "32px" }]);
    expect(result!.blockGap).toBe("24px");
  });

  it("returns null when no usable tokens present", () => {
    expect(extractThemeJsonTokens(null)).toBeNull();
    expect(extractThemeJsonTokens({})).toBeNull();
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd apps/web && pnpm vitest run lib/jab/global-styles.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `apps/web/lib/jab/global-styles.ts`**

```ts
import "server-only";
import type { GlobalStylesResponse } from "./ability-client";

/**
 * Distills WP's global-styles response into the token shape Phase B
 * (tailwind.config emit) consumes. Lives separate from the ability-client
 * fetch because Phase B may swap in computed-CSS-derived tokens for
 * classic themes where global-styles is unavailable.
 *
 * Returns null when there's nothing usable — caller falls back to
 * inference from `block_inventory.computed_styles`.
 */

export interface ThemeJsonTokens {
  colorPalette?: Array<{ slug: string; color: string }>;
  fontSizes?: Array<{ slug: string; size: string }>;
  fontFamilies?: Array<{ slug: string; fontFamily: string }>;
  blockGap?: string;
  /** The raw payload, preserved for any consumer that wants the full tree. */
  raw: GlobalStylesResponse;
}

export function extractThemeJsonTokens(
  response: GlobalStylesResponse | null,
): ThemeJsonTokens | null {
  if (!response || typeof response !== "object") return null;
  const settings = (response.settings ?? {}) as Record<string, Record<string, unknown>>;
  const color = settings.color ?? {};
  const typography = settings.typography ?? {};
  const spacing = settings.spacing ?? {};

  const palette = Array.isArray(color.palette)
    ? (color.palette as Array<{ slug?: unknown; color?: unknown }>)
        .filter((e) => typeof e.slug === "string" && typeof e.color === "string")
        .map((e) => ({ slug: e.slug as string, color: e.color as string }))
    : undefined;

  const fontSizes = Array.isArray(typography.fontSizes)
    ? (typography.fontSizes as Array<{ slug?: unknown; size?: unknown }>)
        .filter((e) => typeof e.slug === "string" && typeof e.size === "string")
        .map((e) => ({ slug: e.slug as string, size: e.size as string }))
    : undefined;

  const fontFamilies = Array.isArray(typography.fontFamilies)
    ? (typography.fontFamilies as Array<{ slug?: unknown; fontFamily?: unknown }>)
        .filter((e) => typeof e.slug === "string" && typeof e.fontFamily === "string")
        .map((e) => ({ slug: e.slug as string, fontFamily: e.fontFamily as string }))
    : undefined;

  const blockGap = typeof spacing.blockGap === "string" ? (spacing.blockGap as string) : undefined;

  if (!palette && !fontSizes && !fontFamilies && !blockGap) return null;

  return { colorPalette: palette, fontSizes, fontFamilies, blockGap, raw: response };
}
```

- [ ] **Step 4: Run the test**

```bash
cd apps/web && pnpm vitest run lib/jab/global-styles.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/global-styles.ts apps/web/lib/jab/global-styles.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): theme.json token extractor for Phase B handoff

Flattens WP's global-styles response into the palette / fontSizes /
fontFamilies / blockGap shape Phase B's tailwind config emitter needs.
Returns null when nothing usable — Phase B falls back to computed-CSS
inference per design doc §6.3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Resolve per-CPT ability metadata from the project manifest

The discovery worker calls `listPostType(client, { abilityName, wrapperKey, ... })` per CPT. Both come from the plugin's per-CPT registration — we need a resolver that reads the project's stored manifest.

**Files:**
- Modify: `apps/web/lib/jab/ability-client.ts`
- Modify: `apps/web/lib/jab/ability-client.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `ability-client.test.ts`:

```ts
import { resolveCptAbilityMeta } from "./ability-client";
import type { Manifest } from "@jab/core";

describe("resolveCptAbilityMeta", () => {
  const manifest = {
    plugin_version: "0.6.0",
    generated_at: "2026-01-01T00:00:00Z",
    abilities: [
      {
        name: "jab/get-pages",
        category: "jab-content",
        label: "Get Pages",
        description: "",
        input_schema: {},
        output_schema: {
          type: "object",
          required: ["pages"],
          properties: { pages: { type: "array" } },
        },
        meta: {},
      },
      {
        name: "jab/get-page-by-slug",
        category: "jab-content",
        label: "Get Page By Slug",
        description: "",
        input_schema: {},
        output_schema: {
          type: "object",
          required: ["page"],
          properties: { page: {} },
        },
        meta: {},
      },
    ],
  } as unknown as Manifest;

  it("resolves the list + by-slug ability pair from rest_base", () => {
    const meta = resolveCptAbilityMeta(manifest, { slug: "page", rest_base: "pages" });
    expect(meta.listAbilityName).toBe("jab/get-pages");
    expect(meta.listWrapperKey).toBe("pages");
    expect(meta.bySlugAbilityName).toBe("jab/get-page-by-slug");
    expect(meta.bySlugWrapperKey).toBe("page");
  });

  it("falls back to slug-based naming when manifest lookup misses", () => {
    const meta = resolveCptAbilityMeta(null, { slug: "beer", rest_base: "beers" });
    expect(meta.listAbilityName).toBe("jab/get-beers");
    expect(meta.listWrapperKey).toBe("beers");
    expect(meta.bySlugAbilityName).toBe("jab/get-beer-by-slug");
    expect(meta.bySlugWrapperKey).toBe("beer");
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd apps/web && pnpm vitest run lib/jab/ability-client.test.ts -t "resolveCptAbilityMeta"
```

Expected: FAIL — not exported.

- [ ] **Step 3: Implement in `ability-client.ts`**

Add the import at the top (it already imports `McpClient` from `@jab/core` — add `Manifest`):

```ts
import { McpClient, type Manifest } from "@jab/core";
```

Append:

```ts
/**
 * For a given CPT (slug + rest_base from the plugin's content-types REST
 * endpoint), resolve the four pieces of metadata the discovery worker
 * needs to call the list + by-slug abilities:
 *   - listAbilityName     — e.g. "jab/get-pages"
 *   - listWrapperKey      — e.g. "pages"
 *   - bySlugAbilityName   — e.g. "jab/get-page-by-slug"
 *   - bySlugWrapperKey    — e.g. "page"
 *
 * Strategy: parse the manifest's output_schema for each candidate ability
 * name and pull the single key from its `required` array (the plugin
 * always emits exactly one required wrapper key per list / by-slug
 * ability). Fall back to slug-based derivation when manifest is null or
 * the ability isn't present — matches Registry::derive_config_from_post_type.
 */
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

  // When the manifest IS present, prefer its `required` key for the wrapper
  // (handles the rare BUG-2 collision suffixes -2, -3, …).
  const lookup = (name: string): string | null => {
    const ability = manifest.abilities.find((a) => a.name === name);
    if (!ability) return null;
    const schema = ability.output_schema as { required?: unknown } | undefined;
    if (!schema || !Array.isArray(schema.required) || schema.required.length === 0) return null;
    const first = schema.required[0];
    return typeof first === "string" ? first : null;
  };

  return {
    listAbilityName,
    listWrapperKey: lookup(listAbilityName) ?? listWrapperKey,
    bySlugAbilityName,
    bySlugWrapperKey: lookup(bySlugAbilityName) ?? bySlugWrapperKey,
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/web && pnpm vitest run lib/jab/ability-client.test.ts
```

Expected: all tests pass (15 total).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/ability-client.ts apps/web/lib/jab/ability-client.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): resolveCptAbilityMeta — derive list+by-slug names per CPT

The plugin auto-discovers abilities per public post type. Discovery worker
needs both the ability name AND the wrapper key for each. Prefers the
project's persisted manifest (handles BUG-2 collision suffixes); falls back
to slug-based derivation that mirrors Registry::derive_config_from_post_type.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Site-screenshots Storage bucket bootstrap

**Files:**
- Modify: `apps/web/lib/storage/bucket.ts`

- [ ] **Step 1: Add the `ensureSiteScreenshotsBucket` function**

In `apps/web/lib/storage/bucket.ts`, append at EOF:

```ts
let _screenshotsBootstrapped = false;

/**
 * Idempotently ensure the site-screenshots bucket exists as a PRIVATE
 * bucket. Phase A writes source/<viewport>/<slug>.png; Phase E writes
 * generated/<viewport>/<slug>.png; Phase F surfaces them via signed URLs.
 *
 * Same idempotency contract as ensureProjectAssetsBucket — including the
 * "already exists" race branch with re-verification.
 *
 * Public access is INTENTIONALLY false. Screenshots can carry draft /
 * unpublished content, dimensions of customer logos, internal URLs etc.;
 * exposing them anonymously would be a privacy regression.
 */
export async function ensureSiteScreenshotsBucket(): Promise<void> {
  if (_screenshotsBootstrapped) return;

  const supabase = createAdminClient();
  const { data: existing, error: getErr } = await supabase.storage.getBucket(
    SITE_SCREENSHOTS_BUCKET,
  );

  if (existing) {
    if (existing.public) {
      throw new Error(
        `Storage bucket "${SITE_SCREENSHOTS_BUCKET}" is public — must be private. Recreate via Supabase dashboard.`,
      );
    }
    _screenshotsBootstrapped = true;
    return;
  }
  if (getErr && !/not found|does not exist/i.test(getErr.message)) {
    throw new Error(
      `Failed to inspect storage bucket "${SITE_SCREENSHOTS_BUCKET}": ${getErr.message}`,
    );
  }

  const { error: createErr } = await supabase.storage.createBucket(
    SITE_SCREENSHOTS_BUCKET,
    {
      public: false,
      // ~25 MB per shot. Mobile-portrait full-page screenshots of long
      // landing pages can run 5–10 MB; this is a comfortable backstop.
      fileSizeLimit: 25 * 1024 * 1024,
      allowedMimeTypes: ["image/png", "image/jpeg"],
    },
  );

  if (!createErr) {
    _screenshotsBootstrapped = true;
    return;
  }

  // Tolerate "already exists" race; re-verify the bucket is private.
  if (/already exists/i.test(createErr.message)) {
    const { data: confirmed, error: confirmErr } = await supabase.storage.getBucket(
      SITE_SCREENSHOTS_BUCKET,
    );
    if (confirmErr || !confirmed) {
      throw new Error(
        `Storage bucket "${SITE_SCREENSHOTS_BUCKET}" creation hit "already exists" but verification failed: ${confirmErr?.message ?? "no bucket returned"}`,
      );
    }
    if (confirmed.public) {
      throw new Error(
        `Storage bucket "${SITE_SCREENSHOTS_BUCKET}" exists but is public. Recreate as private.`,
      );
    }
    _screenshotsBootstrapped = true;
    return;
  }

  throw new Error(
    `Failed to create storage bucket "${SITE_SCREENSHOTS_BUCKET}": ${createErr.message}`,
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/storage/bucket.ts
git commit -m "$(cat <<'EOF'
🏗️ feat(web): site-screenshots private bucket bootstrap

Per-build screenshot bucket. Private (vs. project-assets which is public
for srcDoc support). Phase A writes source/, Phase E writes generated/,
Phase F reads via signed URLs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Persistence helper — write inventory to `block_inventory` + `page_inventory`

**Files:**
- Create: `apps/web/lib/jab/persist-discovery.ts`
- Create: `apps/web/lib/jab/persist-discovery.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/lib/jab/persist-discovery.test.ts
import { describe, it, expect, vi } from "vitest";

// Mock the admin client at the boundary. We assert on the chained call
// shape: from("block_inventory").upsert(...).select(...).
const fromMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: fromMock }),
}));

import { persistInventory, persistPages } from "./persist-discovery";
import type { InventoryEntry } from "./inventory";
import type { PageDiscoveryResult } from "./discovery-types";

describe("persistInventory", () => {
  it("upserts each inventory row with project_id + site_build_id but no tenant_id column", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });

    const entries: InventoryEntry[] = [
      {
        blockName: "core/heading",
        occurrenceCount: 5,
        pageSlugs: ["home", "about"],
        attrSamples: [{ level: 1 }, { level: 2 }],
        tier: "trivial",
      },
    ];
    await persistInventory({
      buildId: "b1",
      projectId: "p1",
      entries,
      computedStylesByBlockName: { "core/heading": { median: { fontSize: "32px" } } },
    });

    expect(fromMock).toHaveBeenCalledWith("block_inventory");
    expect(upsert).toHaveBeenCalledOnce();
    const upsertedRow = upsert.mock.calls[0][0][0];
    expect(upsertedRow.project_id).toBe("p1");
    expect(upsertedRow.site_build_id).toBe("b1");
    expect(upsertedRow).not.toHaveProperty("tenant_id");
    expect(upsertedRow.block_name).toBe("core/heading");
    expect(upsertedRow.occurrence_count).toBe(5);
    expect(upsertedRow.tier).toBe("trivial");
    expect(upsertedRow.computed_styles).toEqual({ median: { fontSize: "32px" } });
  });

  it("skips persistence when entries is empty", async () => {
    fromMock.mockClear();
    await persistInventory({
      buildId: "b1",
      projectId: "p1",
      entries: [],
      computedStylesByBlockName: {},
    });
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe("persistPages", () => {
  it("upserts page_inventory rows with route_path + screenshot paths", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });

    const pages: Array<{
      slug: string;
      post_type: string;
      title: string;
      route_path: string;
      block_count: number;
      discovery: PageDiscoveryResult;
    }> = [
      {
        slug: "home",
        post_type: "page",
        title: "Home",
        route_path: "/",
        block_count: 7,
        discovery: {
          slug: "home",
          post_type: "page",
          screenshotPaths: { "375": "p.png", "768": "p.png", "1280": "p.png" },
          blockCapturesByViewport: { "375": [], "768": [], "1280": [] },
        },
      },
    ];

    await persistPages({ buildId: "b1", projectId: "p1", pages });
    const row = upsert.mock.calls[0][0][0];
    expect(row).not.toHaveProperty("tenant_id");
    expect(row.project_id).toBe("p1");
    expect(row.route_path).toBe("/");
    expect(row.source_screenshot_paths).toEqual({
      source: { "375": "p.png", "768": "p.png", "1280": "p.png" },
    });
    expect(row.block_count).toBe(7);
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd apps/web && pnpm vitest run lib/jab/persist-discovery.test.ts
```

Expected: FAIL (module doesn't exist).

- [ ] **Step 3: Implement `apps/web/lib/jab/persist-discovery.ts`**

```ts
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { InventoryEntry } from "./inventory";
import type { PageDiscoveryResult } from "./discovery-types";

/**
 * persist-discovery.ts — Phase A outputs → DB.
 *
 * Two write functions, both using upsert on the (site_build_id, *) unique
 * index Stage 0 created. NOTE on RLS: `block_inventory` / `page_inventory`
 * do NOT have a `tenant_id` column — tenant scoping rides on the
 * `site_builds.project_id → projects.tenant_id` join (see RLS policies
 * in 0014_saas_v2_schema.sql). `project_id` is denormalized on these
 * rows for query/RLS performance; we write it explicitly so a stray
 * service-role dispatch can't land on the wrong project even though
 * service role bypasses RLS itself.
 *
 * Schema mirror: see apps/web/lib/db/schema.ts and
 * apps/web/drizzle/migrations/0014_saas_v2_schema.sql. If columns drift,
 * the upsert call silently writes wrong shapes; integration smoke (Task
 * 22) catches this against the real DB.
 */

export interface PersistInventoryInput {
  buildId: string;
  projectId: string;
  entries: InventoryEntry[];
  /**
   * Map block_name → aggregated computed-styles JSON per design doc §6.1
   * shape `{ median, range, viewports }`. Inventory entries without
   * computed-styles data (passthrough blocks, blocks with no rendered
   * instance captured) get null in the column.
   */
  computedStylesByBlockName: Record<string, unknown>;
}

export async function persistInventory(input: PersistInventoryInput): Promise<void> {
  if (input.entries.length === 0) return;
  const supabase = createAdminClient();

  const rows = input.entries.map((entry) => {
    // The null-blockName row needs a deterministic string key in the
    // unique index — we use the literal "__null__" so downstream queries
    // can find it. The schema's UNIQUE INDEX is on (site_build_id, block_name)
    // and block_name is `text NOT NULL`, so we must coerce.
    const blockNameKey = entry.blockName ?? "__null__";
    return {
      site_build_id: input.buildId,
      project_id: input.projectId,
      block_name: blockNameKey,
      occurrence_count: entry.occurrenceCount,
      page_slugs: entry.pageSlugs,
      attr_samples: entry.attrSamples,
      computed_styles: input.computedStylesByBlockName[blockNameKey] ?? null,
      tier: entry.tier,
    };
  });

  const { error } = await supabase
    .from("block_inventory")
    .upsert(rows, { onConflict: "site_build_id,block_name" });
  if (error) {
    throw new Error(`block_inventory upsert failed: ${error.message}`);
  }
}

export interface PersistPagesInput {
  buildId: string;
  projectId: string;
  pages: Array<{
    slug: string;
    post_type: string;
    title: string;
    route_path: string;
    block_count: number;
    discovery: PageDiscoveryResult;
  }>;
}

export async function persistPages(input: PersistPagesInput): Promise<void> {
  if (input.pages.length === 0) return;
  const supabase = createAdminClient();

  const rows = input.pages.map((page) => ({
    site_build_id: input.buildId,
    project_id: input.projectId,
    slug: page.slug,
    post_type: page.post_type,
    title: page.title,
    route_path: page.route_path,
    block_count: page.block_count,
    source_screenshot_paths: { source: page.discovery.screenshotPaths },
    rendering: "dynamic",
  }));

  const { error } = await supabase
    .from("page_inventory")
    .upsert(rows, { onConflict: "site_build_id,slug,post_type" });
  if (error) {
    throw new Error(`page_inventory upsert failed: ${error.message}`);
  }
}
```

- [ ] **Step 4: Sanity-check the schema (no surprises expected)**

```bash
cd apps/web && grep -E "tenant_id" drizzle/migrations/0014_saas_v2_schema.sql | grep -iE "(block_inventory|page_inventory|fidelity_reports)" || echo "OK — no tenant_id column on inventory tables, matches Task 15 design"
```

Expected: prints "OK — no tenant_id column on inventory tables, matches Task 15 design". `block_inventory` / `page_inventory` / `fidelity_reports` are tenant-scoped via the `site_builds.project_id → projects.tenant_id` join, not a direct column. If this grep ever returns matches, the migration changed and Task 15 needs revisiting.

- [ ] **Step 5: Run the tests, verify pass**

```bash
cd apps/web && pnpm vitest run lib/jab/persist-discovery.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/jab/persist-discovery.ts apps/web/lib/jab/persist-discovery.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): persist-discovery — block_inventory + page_inventory writers

Upsert helpers keyed on the (site_build_id, block_name) and
(site_build_id, slug, post_type) unique indexes from migration 0014.
Service-role admin client bypasses RLS; project_id filtering provides
defence-in-depth.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Computed-styles aggregator

Bridges captured per-instance computed CSS (from Playwright) to the `{ median, range, viewports }` shape `block_inventory.computed_styles` stores.

**Files:**
- Create: `apps/web/lib/jab/aggregate-computed-styles.ts`
- Create: `apps/web/lib/jab/aggregate-computed-styles.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { aggregateComputedStyles } from "./aggregate-computed-styles";
import type { PageDiscoveryResult } from "./discovery-types";

describe("aggregateComputedStyles", () => {
  it("aggregates per-block-name per-viewport medians", () => {
    const pages: PageDiscoveryResult[] = [
      {
        slug: "home",
        post_type: "page",
        screenshotPaths: {},
        blockCapturesByViewport: {
          "1280": [
            { blockName: "core/heading", boundingRect: { x: 0, y: 0, width: 100, height: 50 }, computedStyles: { fontSize: "32px", color: "rgb(0,0,0)" } },
            { blockName: "core/heading", boundingRect: { x: 0, y: 80, width: 100, height: 60 }, computedStyles: { fontSize: "28px", color: "rgb(0,0,0)" } },
          ],
        },
      },
    ];
    const out = aggregateComputedStyles(pages);
    const heading = out["core/heading"];
    expect(heading).toBeDefined();
    expect(heading.viewports["1280"].fontSize).toEqual(expect.arrayContaining(["32px", "28px"]));
    expect(heading.viewports["1280"].color).toEqual(["rgb(0,0,0)"]);
  });

  it("returns empty object when no instances captured", () => {
    expect(aggregateComputedStyles([])).toEqual({});
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd apps/web && pnpm vitest run lib/jab/aggregate-computed-styles.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/web/lib/jab/aggregate-computed-styles.ts
import "server-only";
import type { PageDiscoveryResult } from "./discovery-types";

/**
 * aggregate-computed-styles.ts
 *
 * Reduces per-instance computed CSS captures (one entry per block per
 * page per viewport) into the `{ viewports: { <vp>: { <prop>: [unique
 * values...] } } }` shape `block_inventory.computed_styles` persists.
 *
 * v1 = "unique values list" per property. Median + range fields hinted
 * at by design doc §6.1 are deferred — strings like "32px" / "rgb(...)"
 * aren't trivially numeric-median-able, and Phase B's prompts can
 * inspect the value list directly. Add numeric aggregation as a
 * follow-up if Phase B's prompt-token budget pressures it.
 */

export type AggregatedComputedStyles = Record<
  string, // block_name (or "__null__")
  {
    viewports: Record<
      string, // viewport width as string
      Record<string, string[]> // property name → unique value list
    >;
  }
>;

export function aggregateComputedStyles(
  pages: PageDiscoveryResult[],
): AggregatedComputedStyles {
  const out: AggregatedComputedStyles = {};

  for (const page of pages) {
    for (const [viewport, captures] of Object.entries(page.blockCapturesByViewport)) {
      for (const capture of captures) {
        const key = capture.blockName ?? "__null__";
        if (!out[key]) out[key] = { viewports: {} };
        if (!out[key].viewports[viewport]) out[key].viewports[viewport] = {};
        const vp = out[key].viewports[viewport];
        for (const [prop, value] of Object.entries(capture.computedStyles)) {
          if (typeof value !== "string" || value === "") continue;
          if (!vp[prop]) vp[prop] = [];
          if (!vp[prop].includes(value)) vp[prop].push(value);
        }
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/web && pnpm vitest run lib/jab/aggregate-computed-styles.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/aggregate-computed-styles.ts apps/web/lib/jab/aggregate-computed-styles.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): aggregate computed CSS captures into block_inventory shape

Per-block-name per-viewport unique-value lists. v1 keeps the shape
simple; numeric median/range aggregation deferred until Phase B's
prompt-token budget demands it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: discover-site Inngest worker — orchestration

**Files:**
- Create: `apps/web/lib/inngest/functions/discover-site.ts`

- [ ] **Step 1: Write the worker**

```ts
import "server-only";
import { inngest } from "../client";
import {
  createJabMcpClient,
  loadJabCredentials,
  getMenus,
  listPostTypes,
  listPostType,
  getPostBySlug,
  getGlobalStyles,
  resolveCptAbilityMeta,
  type PageBySlugRecord,
  type PostListRow,
  type PostTypeRow,
  type Menu,
  type BlockNode,
  type GlobalStylesResponse,
  type CptAbilityMeta,
} from "@/lib/jab/ability-client";
import { extractThemeJsonTokens } from "@/lib/jab/global-styles";
import { buildInventory, type PageBlocksInput } from "@/lib/jab/inventory";
import { aggregateComputedStyles } from "@/lib/jab/aggregate-computed-styles";
import { InProcessRunner, type DiscoveryRunner } from "@/lib/jab/discovery-runner";
import { capturePage } from "@/lib/jab/playwright-discovery";
import {
  ensureSiteScreenshotsBucket,
} from "@/lib/storage/bucket";
import { persistInventory, persistPages } from "@/lib/jab/persist-discovery";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Manifest } from "@jab/core";
import type { PageDescriptor, PageDiscoveryResult } from "@/lib/jab/discovery-types";

/**
 * discoverSite — Phase A worker.
 *
 * Triggered by `site/discover.requested` (Stage 7 will also dispatch from
 * the top-level `site/build.requested` orchestrator; v1 supports direct
 * dispatch for the smoke test in Task 22).
 *
 * Steps (each `step.run` is a separate retry-able + traced boundary):
 *
 *   1. load-creds         — decrypt project WP creds (service-role read)
 *   2. probe-bucket       — idempotent site-screenshots bucket bootstrap
 *   3. load-manifest      — read projects.manifest JSONB for ability-meta
 *                           resolution (already populated by onboarding)
 *   4. enumerate-content  — REST + MCP: menus + post types + per-CPT lists
 *   5. fetch-page-blocks  — per page, jab/get-{singular}-by-slug with
 *                           includeBlocks=true; result is PageBlocksInput[]
 *   6. capture-screenshots — DiscoveryRunner.run() — Playwright pass
 *   7. build-inventory    — pure reducer (no I/O)
 *   8. persist            — block_inventory + page_inventory + site_builds
 *                           counts update
 *   9. warn-design-tokens — fail-soft: dispatch project/design.requested
 *                           if design_tokens is null. Existing
 *                           extractProjectDesign worker handles it.
 *
 * retries: 0 — same rationale as extractProjectDesign. Re-trigger via
 * a fresh `site/discover.requested` is the recovery path.
 *
 * Failure handling: any step throw flips site_builds.status to 'failed'
 * with the error captured in error_text. The next-attempt UI surfaces
 * this so the agency can re-trigger.
 */

export const discoverSite = inngest.createFunction(
  { id: "discover-site", retries: 0 },
  { event: "site/discover.requested" },
  async ({ event, step }) => {
    const { projectId, tenantId, buildId } = event.data as {
      projectId: string;
      tenantId: string;
      buildId: string;
    };

    // Single try/catch wraps everything so we can flip site_builds.failed.
    // step.run() boundaries inside are still independently traced + retry-able
    // (per the function-level retries: 0, no retries actually fire).
    try {
      await step.run("mark-discovering", async () => {
        const supabase = createAdminClient();
        const { error } = await supabase
          .from("site_builds")
          .update({ status: "discovering", started_at: new Date().toISOString() })
          .eq("id", buildId)
          .eq("project_id", projectId);
        if (error) throw new Error(`site_builds → discovering update failed: ${error.message}`);
      });

      const creds = await step.run("load-creds", () => loadJabCredentials(projectId, tenantId));

      await step.run("probe-bucket", () => ensureSiteScreenshotsBucket());

      const manifest = await step.run("load-manifest", async () => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("projects")
          .select("manifest")
          .eq("id", projectId)
          .eq("tenant_id", tenantId)
          .single<{ manifest: Manifest | null }>();
        if (error) throw new Error(`load manifest failed: ${error.message}`);
        return data?.manifest ?? null;
      });

      const client = createJabMcpClient(creds);

      // ── Enumerate content ──
      const menus: Menu[] = await step.run("get-menus", () => getMenus(client));
      const postTypes: PostTypeRow[] = await step.run("list-post-types", () =>
        listPostTypes(creds),
      );

      // Per-CPT list calls. step.run named per CPT for trace clarity.
      const perCptLists: Array<{ cpt: PostTypeRow; meta: CptAbilityMeta; rows: PostListRow[] }> = [];
      for (const cpt of postTypes) {
        const meta = resolveCptAbilityMeta(manifest, cpt);
        const rows = await step.run(`list-${cpt.slug}`, () =>
          listPostType(client, {
            abilityName: meta.listAbilityName,
            wrapperKey: meta.listWrapperKey,
            // 100 is the hard input-schema max per the plugin. v1 caps here;
            // sites with >100 entries per CPT lose the tail until we add
            // pagination. Two Roads is <100 across the board.
            numberposts: 100,
            postStatus: "publish",
          }),
        );
        perCptLists.push({ cpt, meta, rows });
      }

      // ── Fetch per-page block trees ──
      const pageBlocks: Array<PageBlocksInput & { title: string; url: string }> = [];
      for (const { cpt, meta, rows } of perCptLists) {
        for (const row of rows) {
          const record: PageBySlugRecord | null = await step.run(
            `blocks-${cpt.slug}-${row.slug}`,
            () =>
              getPostBySlug(client, {
                abilityName: meta.bySlugAbilityName,
                wrapperKey: meta.bySlugWrapperKey,
                slug: row.slug,
                includeBlocks: true,
              }),
          );
          if (!record) continue;
          pageBlocks.push({
            slug: row.slug,
            post_type: cpt.slug,
            title: row.title ?? "",
            url: row.link,
            blocks: (record.blocks ?? []) as BlockNode[],
          });
        }
      }

      // ── Capture screenshots + computed CSS ──
      const runner: DiscoveryRunner = new InProcessRunner((job) =>
        capturePage({
          page: job.pages[0],
          buildId: job.buildId,
          projectId: job.projectId,
          tenantId: job.tenantId,
        }),
      );
      const discoveryResults = await step.run("capture-screenshots", async () => {
        const pageDescriptors: PageDescriptor[] = pageBlocks.map((p) => ({
          slug: p.slug,
          post_type: p.post_type,
          url: p.url,
          topLevelBlockNames: p.blocks.map((b) => b.blockName),
        }));
        return runner.run({ buildId, projectId, tenantId, pages: pageDescriptors });
      });

      // ── Build inventory (pure) ──
      const inventoryInput: PageBlocksInput[] = pageBlocks.map((p) => ({
        slug: p.slug,
        post_type: p.post_type,
        blocks: p.blocks,
      }));
      const inventory = await step.run("build-inventory", async () =>
        buildInventory(inventoryInput),
      );
      const computedStylesByBlockName = await step.run("aggregate-computed-styles", async () =>
        aggregateComputedStyles(discoveryResults),
      );

      // ── Optional: global styles ──
      await step.run("fetch-global-styles", async () => {
        let payload: GlobalStylesResponse | null;
        try {
          payload = await getGlobalStyles(creds);
        } catch (err) {
          console.warn(
            `[discoverSite ${buildId}] global-styles fetch failed (continuing):`,
            err,
          );
          return null;
        }
        const tokens = extractThemeJsonTokens(payload);
        if (!tokens) return null;
        // Persist alongside design_tokens on the project row. Phase B
        // reads from here for tailwind.config emit. Doesn't overwrite
        // existing design_tokens — merges under a `themeJson` key.
        const supabase = createAdminClient();
        const { data: row } = await supabase
          .from("projects")
          .select("design_tokens")
          .eq("id", projectId)
          .eq("tenant_id", tenantId)
          .single<{ design_tokens: Record<string, unknown> | null }>();
        const next = { ...(row?.design_tokens ?? {}), themeJson: tokens };
        await supabase
          .from("projects")
          .update({ design_tokens: next })
          .eq("id", projectId)
          .eq("tenant_id", tenantId);
        return null;
      });

      // ── Persist ──
      await step.run("persist-inventory", () =>
        persistInventory({
          buildId,
          projectId,
          entries: inventory,
          computedStylesByBlockName,
        }),
      );
      await step.run("persist-pages", () =>
        persistPages({
          buildId,
          projectId,
          pages: pageBlocks.map((p) => {
            const discovery = discoveryResults.find((d) => d.slug === p.slug && d.post_type === p.post_type) ?? {
              slug: p.slug,
              post_type: p.post_type,
              screenshotPaths: {},
              blockCapturesByViewport: {},
            };
            return {
              slug: p.slug,
              post_type: p.post_type,
              title: p.title,
              route_path: routePathFor(p.post_type, p.slug),
              block_count: p.blocks.length,
              discovery,
            };
          }),
        }),
      );

      // ── Update site_builds with counts + flip to next phase state ──
      await step.run("finalize-counts", async () => {
        const supabase = createAdminClient();
        const { error } = await supabase
          .from("site_builds")
          .update({
            page_count: pageBlocks.length,
            block_type_count: inventory.length,
            // Status stays 'discovering' — Stage 7's orchestrator will
            // flip to 'components' when Phase B starts. v1 standalone
            // smoke leaves it at 'discovering' for clarity that the next
            // phase hasn't run.
          })
          .eq("id", buildId)
          .eq("project_id", projectId);
        if (error) throw new Error(`finalize-counts update failed: ${error.message}`);
      });

      // ── Chain design-tokens pass if missing (fail-soft) ──
      await step.run("warn-design-tokens", async () => {
        const supabase = createAdminClient();
        const { data: row } = await supabase
          .from("projects")
          .select("design_tokens, wp_url")
          .eq("id", projectId)
          .eq("tenant_id", tenantId)
          .single<{ design_tokens: unknown; wp_url: string | null }>();
        if (row?.design_tokens) return null;
        if (!row?.wp_url) {
          console.warn(
            `[discoverSite ${buildId}] design_tokens null and wp_url missing — skipping design dispatch`,
          );
          return null;
        }
        await inngest.send({
          name: "project/design.requested",
          data: { projectId, tenantId, wpUrl: row.wp_url },
        });
        return null;
      });

      return {
        buildId,
        pages: pageBlocks.length,
        blockTypes: inventory.length,
        menus: menus.length,
      };
    } catch (err) {
      // Flip the build row to failed, captured by Phase F surfaces.
      const supabase = createAdminClient();
      await supabase
        .from("site_builds")
        .update({
          status: "failed",
          failed_phase: "discovering",
          error_text: err instanceof Error ? err.message : String(err),
          finished_at: new Date().toISOString(),
        })
        .eq("id", buildId)
        .eq("project_id", projectId);
      throw err;
    }
  },
);

/**
 * Compute the route_path stored on page_inventory. Pages live at `/<slug>`
 * except for the front-page slug which routes at `/`. CPTs prepend the
 * rest_base or slug. Stage 3 (Phase C) consumes this for emit-time
 * routing; the routing rule lives here because Phase A is the canonical
 * inventory writer.
 */
function routePathFor(postType: string, slug: string): string {
  // Special case the page CPT — the front-page detection lives in
  // resolveFrontPage; downstream code (Stage 3) decides whether THIS
  // slug is the front page and overrides the route. For inventory
  // purposes, "/" is reserved for the front-page-named slug; everything
  // else gets a leading-slash slug.
  if (postType === "page") return `/${slug}`;
  // CPT: /<post_type>/<slug>. Hard-codes post_type rather than rest_base
  // because the smoke test (Task 22) only needs the route_path to be
  // unique per row; Phase C will rewrite this via the manifest if needed.
  return `/${postType}/${slug}`;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

Expected: PASS. (Type errors here usually mean a method signature drifted in Tasks 3 / 4 / 13 — fix at the source.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/inngest/functions/discover-site.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): discoverSite Inngest worker — Phase A orchestration

Loads creds → enumerates menus + CPTs → fetches per-page block trees →
Playwright pass via DiscoveryRunner seam → builds inventory + aggregates
computed CSS → persists block_inventory + page_inventory → chains
project/design.requested when design_tokens missing.

step.run boundaries per logical unit (per-CPT list, per-page block
fetch) so the Inngest run trace shows debuggable progress.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Register discoverSite in the Inngest serve() function list

**Files:**
- Modify: `apps/web/app/api/inngest/route.ts`

- [ ] **Step 1: Add the import and register**

```ts
import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { extractProjectDesign } from "@/lib/inngest/functions/extract-project-design";
import { discoverSite } from "@/lib/inngest/functions/discover-site";

/**
 * Inngest webhook endpoint. Discovers our registered functions for the dev
 * + cloud runtimes via GET/PUT/POST exposed by `serve()`.
 *
 * Stage 1 v2: registered `discoverSite` for Phase A discovery.
 * Stage 7 will add the `siteBuild` top-level orchestrator.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [extractProjectDesign, discoverSite],
});
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/inngest/route.ts
git commit -m "🔌 chore(web): register discoverSite in Inngest serve() list

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 19: Server-action helper — create a site_build row + dispatch the event

This lets the smoke runner (Task 22) and the Stage 7 orchestrator both create a build row and trigger Phase A through the same code path.

**Files:**
- Create: `apps/web/lib/actions/trigger-discovery.ts`

- [ ] **Step 1: Write the helper**

```ts
import "server-only";
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * triggerDiscovery — service-layer entry to Phase A.
 *
 * Creates a fresh `site_builds` row (status: queued), then dispatches the
 * `site/discover.requested` event with the new buildId. Stage 7's
 * orchestrator will wrap this; for now it's the single shared entry
 * point used by the smoke runner.
 *
 * Service-role on purpose — site_builds inserts always come from system
 * code, never from user-facing server actions (no INSERT RLS policy
 * exists per migration 0014).
 */
export async function triggerDiscovery(input: {
  projectId: string;
  tenantId: string;
}): Promise<{ buildId: string }> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("site_builds")
    .insert({
      project_id: input.projectId,
      status: "queued",
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) {
    throw new Error(`site_builds insert failed: ${error?.message ?? "no row returned"}`);
  }

  await inngest.send({
    name: "site/discover.requested",
    data: { projectId: input.projectId, tenantId: input.tenantId, buildId: data.id },
  });

  return { buildId: data.id };
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/actions/trigger-discovery.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): triggerDiscovery — create build row + dispatch Phase A

Service-layer entry point shared by the smoke runner and (eventually)
Stage 7's orchestrator. Inserts site_builds via service-role (no INSERT
RLS policy on site_builds per migration 0014).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: Confirm `MANIFEST_V2_REQUIREMENTS` floor unchanged (no plugin bump)

Per the inline decision (5) at top of plan, none of the abilities used in Phase A is new in v0.7. Verification step only.

**Files:**
- Read-only: `apps/web/lib/jab/probe.ts`

- [ ] **Step 1: Verify**

```bash
cd apps/web && grep -A 3 MANIFEST_V2_REQUIREMENTS lib/jab/probe.ts
```

Expected output includes `["jab/get-menus"] as const` and nothing about `jab/list-post-types` or `jab/get-global-styles` (those are REST endpoints, not abilities).

- [ ] **Step 2: No code changes; skip commit. This task is a no-op gate confirming the inline decision.**

If for any reason a previous task introduced a dependency on a new ability not in v0.6.0, return here and add it to the requirements list + bump the plugin version.

---

## Task 21: End-to-end typecheck + lint sweep before smoke

**Files:**
- (none modified)

- [ ] **Step 1: Run typecheck across the workspace**

```bash
cd apps/web && pnpm typecheck
```

Expected: PASS, zero errors.

- [ ] **Step 2: Run the full vitest suite**

```bash
cd apps/web && pnpm test
```

Expected: every test from Tasks 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16 passes. Total ~30+ tests across 7 files.

- [ ] **Step 3: Run next build (catches any RSC / server-only boundary issues)**

```bash
cd apps/web && pnpm build
```

Expected: build succeeds. Phase A modules don't ship to the client, but `next build` still type-checks the api/inngest route which transitively imports the worker.

- [ ] **Step 4: If green, no commit needed (no code changes).**

---

## Task 22: Smoke test against the Two Roads pilot

This is the success-criteria task from the roadmap. The smoke is a manual `tsx` script — not a vitest test — because it talks to real Inngest + Supabase + WP.

**Files:**
- Create: `apps/web/scripts/smoke-discover-site.ts`

- [ ] **Step 1: Write the smoke runner**

```ts
// apps/web/scripts/smoke-discover-site.ts
//
// Manual smoke runner for Phase A discovery. Run with:
//   pnpm tsx apps/web/scripts/smoke-discover-site.ts <projectId> <tenantId>
//
// Prereqs:
//   - Inngest dev server running (`npx inngest-cli@latest dev`)
//   - Next dev running (`pnpm dev` in apps/web), since Inngest invokes the
//     /api/inngest webhook to dispatch functions
//   - The given projectId is connected to the Two Roads WP install
//   - SUPABASE_SERVICE_ROLE_KEY env set
//   - NEXT_PUBLIC_SUPABASE_URL env set
//
// Exit codes:
//   0 — smoke passed all assertions
//   1 — smoke failed an assertion or timed out
import { triggerDiscovery } from "@/lib/actions/trigger-discovery";
import { createAdminClient } from "@/lib/supabase/admin";

const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 2 * 60 * 1000; // 2 minute success-criteria budget

async function main(): Promise<void> {
  const [projectId, tenantId] = process.argv.slice(2);
  if (!projectId || !tenantId) {
    console.error("Usage: tsx smoke-discover-site.ts <projectId> <tenantId>");
    process.exit(1);
  }

  console.log(`[smoke] triggering discovery for project=${projectId} tenant=${tenantId}`);
  const { buildId } = await triggerDiscovery({ projectId, tenantId });
  console.log(`[smoke] buildId=${buildId}`);

  const supabase = createAdminClient();
  const start = Date.now();
  let status: string | null = null;
  let pageCount: number | null = null;
  let blockTypeCount: number | null = null;

  while (Date.now() - start < TIMEOUT_MS) {
    const { data, error } = await supabase
      .from("site_builds")
      .select("status, page_count, block_type_count, error_text")
      .eq("id", buildId)
      .single<{ status: string; page_count: number | null; block_type_count: number | null; error_text: string | null }>();
    if (error) {
      console.error(`[smoke] poll error: ${error.message}`);
      process.exit(1);
    }
    status = data.status;
    pageCount = data.page_count;
    blockTypeCount = data.block_type_count;
    console.log(
      `[smoke] t=${Math.round((Date.now() - start) / 1000)}s status=${status} pages=${pageCount} blocks=${blockTypeCount}`,
    );
    if (status === "failed") {
      console.error(`[smoke] build failed: ${data.error_text}`);
      process.exit(1);
    }
    // Phase A standalone finishes at `discovering` with counts set. Stage 7
    // will flip onward; until then, finishing == counts populated.
    if (status === "discovering" && pageCount !== null && blockTypeCount !== null) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  const elapsedMs = Date.now() - start;
  if (elapsedMs >= TIMEOUT_MS) {
    console.error(`[smoke] FAIL: timed out at ${elapsedMs}ms`);
    process.exit(1);
  }
  console.log(`[smoke] discovery completed in ${elapsedMs}ms`);

  // ── Assertions ──
  let failed = false;
  function check(name: string, ok: boolean, detail: string): void {
    console.log(`[smoke] ${ok ? "PASS" : "FAIL"} — ${name}: ${detail}`);
    if (!ok) failed = true;
  }

  check("≤ 2 minute wall-clock", elapsedMs <= TIMEOUT_MS, `${elapsedMs}ms`);

  const { data: blocks } = await supabase
    .from("block_inventory")
    .select("block_name, tier, occurrence_count")
    .eq("site_build_id", buildId);
  check(
    "≥ 20 rows in block_inventory",
    !!blocks && blocks.length >= 20,
    `found ${blocks?.length ?? 0}`,
  );

  const { data: pages } = await supabase
    .from("page_inventory")
    .select("slug, post_type, source_screenshot_paths, block_count")
    .eq("site_build_id", buildId);
  check(
    "page_inventory has rows",
    !!pages && pages.length > 0,
    `found ${pages?.length ?? 0}`,
  );

  if (pages && pages.length > 0) {
    const sample = pages[0];
    const sourcePaths = (sample.source_screenshot_paths as { source?: Record<string, string> } | null)?.source ?? {};
    check(
      "first page has all 3 viewport screenshot paths",
      ["375", "768", "1280"].every((vp) => typeof sourcePaths[vp] === "string"),
      JSON.stringify(sourcePaths),
    );

    // List storage to confirm at least the first page's screenshots landed.
    const { data: listed } = await supabase.storage
      .from("site-screenshots")
      .list(`${buildId}/source/1280`);
    check(
      "site-screenshots bucket contains 1280 desktop captures",
      !!listed && listed.length > 0,
      `found ${listed?.length ?? 0}`,
    );
  }

  console.log(`[smoke] Inngest run trace: http://localhost:8288/runs (search buildId=${buildId})`);

  if (failed) {
    console.error("[smoke] one or more assertions failed");
    process.exit(1);
  }
  console.log("[smoke] all assertions passed");
}

main().catch((err) => {
  console.error("[smoke] unexpected error:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Identify the Two Roads project_id + tenant_id**

```bash
cd apps/web && psql "$DATABASE_URL" -c "SELECT id AS project_id, tenant_id, name, wp_url FROM projects WHERE wp_url LIKE '%two-roads%' OR name ILIKE '%two roads%';"
```

Expected: one row with the Two Roads project id and tenant id. Note them down.

- [ ] **Step 3: Start the supporting dev servers (two terminals)**

```bash
# terminal A
cd apps/web && pnpm dev
```

```bash
# terminal B
npx inngest-cli@latest dev
```

- [ ] **Step 4: Run the smoke against the Two Roads ids**

```bash
cd apps/web && pnpm tsx scripts/smoke-discover-site.ts <projectId> <tenantId>
```

Expected output ends with `[smoke] all assertions passed` within 2 minutes.

- [ ] **Step 5: Manually inspect the Inngest run trace**

Open `http://localhost:8288/runs`, search for the buildId. Confirm:
- The `discover-site` run has named step boundaries: `mark-discovering`, `load-creds`, `probe-bucket`, `load-manifest`, `get-menus`, `list-post-types`, `list-page`, `list-beer`, etc., `blocks-page-home`, `blocks-page-about` (one per page), `capture-screenshots`, `build-inventory`, `aggregate-computed-styles`, `fetch-global-styles`, `persist-inventory`, `persist-pages`, `finalize-counts`, `warn-design-tokens`.
- No step shows red / errored.

- [ ] **Step 6: Manually inspect the persisted data**

```bash
cd apps/web && psql "$DATABASE_URL" -c "SELECT block_name, occurrence_count, tier FROM block_inventory WHERE site_build_id = '<buildId>' ORDER BY occurrence_count DESC LIMIT 30;"
```

Expected: sensible ranked list — `core/heading` and `core/paragraph` near the top with high counts and `tier='trivial'`, `acf/*` blocks present with `tier='visual'`, rare blocks marked `tier='passthrough'`.

```bash
cd apps/web && psql "$DATABASE_URL" -c "SELECT slug, post_type, block_count, source_screenshot_paths FROM page_inventory WHERE site_build_id = '<buildId>' ORDER BY post_type, slug;"
```

Expected: every published Two Roads page + post + beer CPT entry has a row; `source_screenshot_paths` has all three viewport keys non-null.

- [ ] **Step 7: Manually inspect Storage**

In the Supabase dashboard → Storage → `site-screenshots` bucket, drill into `<buildId>/source/1280/`. Expected: one PNG per page, sizes range from ~200 KB (short pages) to ~5 MB (long beer-list pages). Repeat for `375` and `768`.

- [ ] **Step 8: If anything failed, debug and re-run**

The most likely failure modes:
- **Playwright launch error** — Task 5 spike result was wrong about runtime support. Switch the InProcessRunner to HttpRunner + scaffold a dedicated worker.
- **MCP timeout on a specific CPT** — bump the per-step timeout via Inngest function config, OR cap `numberposts` for that CPT.
- **Storage upload 403** — Task 14 bucket isn't private or the service role key is missing/wrong. Fix env + rerun.

- [ ] **Step 9: When green, commit the script**

```bash
git add apps/web/scripts/smoke-discover-site.ts
git commit -m "$(cat <<'EOF'
🧪 test(web): Phase A discovery smoke runner

Manual tsx script that triggers Phase A against a known projectId,
polls site_builds until counts are populated, then asserts ≤ 2 min,
≥ 20 inventory rows, page_inventory coverage, and 3-viewport
screenshots in Storage. Verified against the Two Roads pilot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review (writing-plans checklist)

### Spec coverage

Walking each Stage 1 deliverable from `2026-05-25-saas-v2-roadmap.md`:

- **Inngest worker `discover-site.ts`** → Task 17 + Task 18 (registration).
- **Ability-client extensions: `getMenus`, `listPostTypes`, `listPostType`, `getPostBySlug`, `getGlobalStyles`** → Task 3 (menus) + Task 4 (the other four).
- **`lib/jab/playwright-discovery.ts` — screenshots + computed CSS + bounding rects** → Tasks 7, 8, 9 (one per capability).
- **`lib/jab/inventory.ts` — walk + counts + tier assignment** → Tasks 10 + 11.
- **Persistence to `block_inventory` + `page_inventory` + Storage** → Tasks 14 (bucket) + 15 (DB writers).
- **Design-tokens one-shot reuse** → Task 17 step `warn-design-tokens` dispatches `project/design.requested` if missing.
- **Smoke against Two Roads** → Task 22.

Each handoff prompt requirement covered:
- Inngest-vs-dedicated-worker decision → Task 5 (spike) + Task 6 (seam).
- Tier heuristics seed list → inline decision (2), implementation in Task 10.
- Persistence layer columns → Task 15 (with Task 15 step 4 verifying schema alignment).
- Smoke test concrete commands → Task 22 has explicit `psql`, `pnpm tsx`, and storage list commands.

### Placeholder scan

- No "TODO", "TBD", "implement later" markers.
- Every "implement X" step shows the X.
- One `<paste error>` placeholder in Task 5 step 5 commit message — that's correct: the developer pastes the actual error text from the spike.
- Task 22 has `<projectId>`, `<tenantId>`, `<buildId>` placeholders — these are runtime values the developer fills in from the previous step output, not unspecified code.

### Type consistency

- `BlockNode` imported from `ability-client.ts` everywhere; `ability-client` re-exports `PageBySlugRecord`, `Menu`, `PostListRow`, `PostTypeRow`, `GlobalStylesResponse`, `CptAbilityMeta` consistently across Tasks 3, 4, 13, 17.
- `PageDescriptor`, `PageDiscoveryResult`, `BlockInstanceCapture`, `ComputedStyles`, `BoundingRect`, `ViewportWidth`, `VIEWPORT_WIDTHS` from `discovery-types.ts` consistent in Tasks 2, 6, 7, 8, 9, 15, 16, 17.
- `InventoryEntry`, `PageBlocksInput`, `Tier` from `inventory.ts` consistent in Tasks 10, 11, 15, 17.
- `DiscoveryRunner`, `DiscoveryJob`, `InProcessRunner`, `HttpRunner` from `discovery-runner.ts` consistent in Tasks 6, 17.
- `triggerDiscovery` signature consistent between Task 19 (definition) and Task 22 (use).
- `aggregateComputedStyles` return type `AggregatedComputedStyles` flows into `persistInventory`'s `computedStylesByBlockName` (Tasks 15, 16, 17).

### One inconsistency to flag

Task 17 imports `BlockNode` from `ability-client` — `ability-client.ts` exports `BlockNode` already (verified in the pre-plan read). Good.

Task 17 imports `GlobalStylesResponse` and `CptAbilityMeta` from `ability-client` — confirmed exported in Tasks 4 and 13 respectively.

Task 15 step 4 (schema verification) is the explicit "go check yourself before you write to a non-existent column" gate. The migration in `0014_saas_v2_schema.sql` does NOT have `tenant_id` on `block_inventory` or `page_inventory` (verified during plan prep — only `project_id` is denormalized). Therefore implementers should drop `tenant_id` from both row builders + the test assertion. The plan calls this out explicitly in Task 15 step 4 rather than silently picking one option, because plans should not paper over schema drift.

---

## Out of scope (deliberately)

- Block dispatcher emission, Tailwind config emission, component generation → Stage 2.
- Page route emission → Stage 3.
- Build + deploy → Stage 4.
- Fidelity scoring, vision diff → Stage 5.
- Per-page approval UI, publish gate → Stage 6.
- Real-time progress UI / event streaming to the browser → Stage 7.
- Bounding-rect-to-BlockNode-tree mapping refinement beyond class-based heuristics → fast-follow in Stage 2 if tier assignment is too lossy. (The roadmap risks call out `data-jab-block-id` as a possible plugin-side fix; deferring until evidence demands it.)
- Pagination for CPTs >100 entries → fast-follow.
- Multi-level menu rendering depth > 2 → out-of-scope per design doc §9.
