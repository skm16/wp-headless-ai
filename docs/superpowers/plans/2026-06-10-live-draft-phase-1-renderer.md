# Live Draft Phase 1 — Draft Renderer (read-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A token-gated draft renderer inside `apps/web` that renders the latest ready build's generated site (components + shell + live WP data) in a sandboxed iframe-servable shell — fully navigable, no Vercel involved, zero changes to the edit pipeline.

**Architecture:** Spec at [`docs/superpowers/specs/2026-06-10-live-draft-system-design.md`](../specs/2026-06-10-live-draft-system-design.md) (§7 Draft renderer, §5.4 Storage, §10 failure rows, §11 divergences). Server compiles (esbuild bundle of emitted dispatcher + stored components + shims; Tailwind JIT over raw sources) and serves JSON page data through the same pure runtimes the deployed site uses; LLM code executes only in the browser. Phase 1 keys everything by `buildId` (no `drafts` table yet — that's Phase 2); artifacts live at `drafts/base/<buildId>/bundle.js|draft.css`.

**Tech Stack:** Next.js 15 App Router route handlers, esbuild (new dep), Tailwind 3.4 JIT in-process, Supabase Storage, `@jab/core` McpClient, Vitest.

**Branch:** `feat/saas-e2e-loop` (already checked out; do NOT create a worktree — a parallel session shares this clone, commit early and often).

**Test commands:**
- Single file: `pnpm --filter @jab/web exec vitest run <path-from-apps/web>`
- Full suite: `pnpm --filter @jab/web test`
- Typecheck: `pnpm --filter @jab/web exec tsc --noEmit`

---

## Context for implementers (read once)

- All paths relative to `apps/web/` unless prefixed `docs/`.
- The deployed-site runtime modules are IN this repo and importable: `lib/jab/compose-block-tree-runtime.ts` (`composeBlockTree(record, postType, paradigms, opts)` → `RenderableBlock[]`), `lib/jab/related-posts-runtime.ts` (`resolveRelationshipRefs(blocks, callAbility, resolveMedia?)`), `lib/jab/dynamic-lists-runtime.ts` (`resolveDynamicLists(blocks, callAbility, specs, resolveMedia?, now?)`), `lib/jab/rewrite-links-runtime.ts` (`rewriteHtmlOriginLinks`, `sourceHostsFromEnv`).
- The emitted site's per-page logic to mirror is `emitCatchAllPageTsx()` in `lib/jab/compose-site-emit.ts:1309-1358`: `path = slug.join("/")`, `leaf = slug[slug.length-1]`, front-page slug 308s to `/`, `ROUTE_MAP[path]` first, fallback `slug.length >= 2 ? POST_TYPE_MAP[slug.slice(0,-1).join("/")] : POST_TYPE_MAP["page"]`, then `callAbility(entry.abilityName, { slug: leaf, include: { blocks: true } })` and `record = response[entry.wrapperKey]`.
- Ability resolution per post type is `abilityMetaFor(postType, manifest)` — currently PRIVATE in `lib/inngest/functions/compose-site.ts:143-161` (Task 2 extracts it). Wrapper key via `abilityWrapperKeyFromSchema` from `lib/jab/ability-client.ts`.
- WP access: `loadJabCredentials(projectId, tenantId)` + `createJabMcpClient(creds)` from `lib/jab/ability-client.ts`; `client.callTool<unknown>(toolName, args)` returns `{ isError?: boolean; structuredContent?: unknown }`-shaped results (see the private `callJab` wrapper at `ability-client.ts:135-150` for the error pattern).
- Storage bucket: `SITE_SCREENSHOTS_BUCKET` from `lib/storage/bucket.ts`. Component sources: `builds/<buildId>/components/<PascalName>.tsx`. Shell sources: `builds/<buildId>/project/components/site/Header.tsx|Footer.tsx` (`buildShellStoragePath` in `lib/ai/persist-shell-generation.ts`).
- Vitest: `environment: "node"`, `vi.mock("server-only", () => ({}))` already in `vitest.setup.ts`, alias `@/` → `apps/web/`. No DOM rendering in tests — assert on strings/objects.
- Generated component import surface (verified): type-only `BlockNode`, optional `next/image`, optional `"use client"`+handlers. Shell additionally uses `next/link` + `useState`.
- **Security note on raw-HTML rendering:** the draft MediaImage shim and the emitted Passthrough render WordPress `innerHTML` via React's raw-HTML escape hatch. This mirrors the DEPLOYED site's behavior byte-for-byte (the emitted `_passthrough.tsx` and `MediaImage.tsx` do exactly this), and the content is the site owner's own WP content rendered inside the opaque-origin sandboxed iframe — the XSS blast radius is the draft preview itself, identical to the published site's. Do not add a sanitizer here: it would create draft-vs-published divergence, the thing this design exists to avoid.

---

### Task 1: draft token module — `mintDraftToken` / `verifyDraftToken`

**Files:**
- Create: `lib/draft/token.ts`
- Test: `lib/draft/token.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/draft/token.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mintDraftToken, verifyDraftToken, DRAFT_TOKEN_TTL_MS } from "./token";

const NOW = Date.parse("2026-06-10T12:00:00.000Z");

beforeEach(() => {
  vi.stubEnv("JAB_DRAFT_TOKEN_SECRET", "test-secret-0123456789abcdef0123456789abcdef");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("draft token", () => {
  it("round-trips for the same project", () => {
    const token = mintDraftToken("proj-1", NOW);
    expect(verifyDraftToken("proj-1", token, NOW)).toBe(true);
  });

  it("rejects a token minted for another project", () => {
    const token = mintDraftToken("proj-1", NOW);
    expect(verifyDraftToken("proj-2", token, NOW)).toBe(false);
  });

  it("rejects after expiry (default TTL)", () => {
    const token = mintDraftToken("proj-1", NOW);
    expect(verifyDraftToken("proj-1", token, NOW + DRAFT_TOKEN_TTL_MS + 1)).toBe(false);
  });

  it("rejects malformed and empty tokens without throwing", () => {
    expect(verifyDraftToken("proj-1", null, NOW)).toBe(false);
    expect(verifyDraftToken("proj-1", "", NOW)).toBe(false);
    expect(verifyDraftToken("proj-1", "garbage", NOW)).toBe(false);
    expect(verifyDraftToken("proj-1", "123.nothex!", NOW)).toBe(false);
  });

  it("falls back to JAB_ENCRYPTION_KEY when JAB_DRAFT_TOKEN_SECRET is unset", () => {
    vi.stubEnv("JAB_DRAFT_TOKEN_SECRET", "");
    vi.stubEnv("JAB_ENCRYPTION_KEY", "fallback-key-0123456789abcdef");
    const token = mintDraftToken("proj-1", NOW);
    expect(verifyDraftToken("proj-1", token, NOW)).toBe(true);
  });

  it("throws loudly when no secret is configured (errors are loud)", () => {
    vi.stubEnv("JAB_DRAFT_TOKEN_SECRET", "");
    vi.stubEnv("JAB_ENCRYPTION_KEY", "");
    expect(() => mintDraftToken("proj-1", NOW)).toThrow(/JAB_DRAFT_TOKEN_SECRET/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/token.test.ts`
Expected: FAIL — `Cannot find module './token'`.

- [ ] **Step 3: Implement**

```typescript
// apps/web/lib/draft/token.ts
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * draft token — authenticates the draft-preview iframe surfaces.
 *
 * The preview iframe is sandboxed WITHOUT allow-same-origin (opaque origin),
 * so no cookies cross into /draft/* or /api/draft/* requests. This HMAC token,
 * minted by the workspace RSC AFTER its RLS project read proved membership,
 * is the only authz those routes have. Scope: read-only rendering of one
 * project's draft. Format: `<expMs>.<hex hmac-sha256(projectId.expMs)>`.
 */
export const DRAFT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2h — outlives an editing session

function secret(): string {
  const s = process.env.JAB_DRAFT_TOKEN_SECRET || process.env.JAB_ENCRYPTION_KEY;
  if (!s) {
    throw new Error(
      "draft-token: set JAB_DRAFT_TOKEN_SECRET (or JAB_ENCRYPTION_KEY) to sign draft preview tokens",
    );
  }
  return s;
}

function sign(projectId: string, exp: number): string {
  return createHmac("sha256", secret()).update(`${projectId}.${exp}`).digest("hex");
}

export function mintDraftToken(projectId: string, nowMs = Date.now()): string {
  const exp = nowMs + DRAFT_TOKEN_TTL_MS;
  return `${exp}.${sign(projectId, exp)}`;
}

export function verifyDraftToken(
  projectId: string,
  token: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < nowMs) return false;
  let got: Buffer;
  try {
    got = Buffer.from(token.slice(dot + 1), "hex");
  } catch {
    return false;
  }
  const want = Buffer.from(sign(projectId, exp), "hex");
  return got.length === want.length && got.length > 0 && timingSafeEqual(got, want);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/token.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/draft/token.ts apps/web/lib/draft/token.test.ts
git commit -m "feat(draft): HMAC draft-preview token (mint/verify, 2h TTL)"
```

---

### Task 2: extract `abilityMetaFor` into a shared module

**Files:**
- Create: `lib/jab/ability-meta.ts`
- Modify: `lib/inngest/functions/compose-site.ts` (remove the private copy, import the shared one)
- Test: `lib/jab/ability-meta.test.ts`

The function lives at `compose-site.ts:143-161` (with a `ManifestShape` interface near it). The draft route resolver (Task 3) needs identical resolution — move, don't duplicate.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/jab/ability-meta.test.ts
import { describe, it, expect } from "vitest";
import { abilityMetaFor, type ManifestShape } from "./ability-meta";

function manifestWith(names: string[]): ManifestShape {
  return { abilities: names.map((name) => ({ name })) };
}

describe("abilityMetaFor", () => {
  it("resolves the singular by-slug ability", () => {
    const meta = abilityMetaFor("beer", manifestWith(["jab/get-beer-by-slug"]));
    expect(meta?.abilityName).toBe("jab/get-beer-by-slug");
  });

  it("falls back to the pluralized form", () => {
    const meta = abilityMetaFor("event", manifestWith(["jab/get-events-by-slug"]));
    expect(meta?.abilityName).toBe("jab/get-events-by-slug");
  });

  it("returns null when no by-slug ability is registered", () => {
    expect(abilityMetaFor("popup_theme", manifestWith(["jab/get-pages"]))).toBeNull();
  });

  it("derives wrapperKey from post type when the ability has no schema hint", () => {
    const meta = abilityMetaFor("case-study", manifestWith(["jab/get-case-study-by-slug"]));
    expect(meta?.wrapperKey).toBe("case_study");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/ability-meta.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Move the code**

Create `lib/jab/ability-meta.ts` by CUTTING `abilityMetaFor` and the `ManifestShape` interface out of `compose-site.ts` (search `function abilityMetaFor` and `interface ManifestShape`). The moved file:

```typescript
// apps/web/lib/jab/ability-meta.ts
import { abilityWrapperKeyFromSchema } from "@/lib/jab/ability-client";

export interface ManifestAbility {
  name: string;
  [k: string]: unknown;
}

export interface ManifestShape {
  abilities?: ManifestAbility[];
  [k: string]: unknown;
}

/**
 * Resolves the registered ability name for a CPT's single-by-slug fetch.
 * JAB plugin convention is jab/get-{post_type}-by-slug — singular form
 * regardless of plural rest_base (verified against Two Roads manifest:
 * jab/get-page-by-slug, jab/get-beer-by-slug, etc.). Pluralized form
 * kept as a defensive fallback in case a custom plugin variant emits it.
 * Returns null if no matching ability is registered — caller treats that
 * as a hard error (homepage) or a warn+skip (route-map entries).
 */
export function abilityMetaFor(
  postType: string,
  manifest: ManifestShape,
): { abilityName: string; wrapperKey: string } | null {
  const abilities = manifest.abilities ?? [];
  const plural = postType.endsWith("s") ? postType : postType + "s";
  for (const candidate of [
    `jab/get-${postType}-by-slug`,
    `jab/get-${plural}-by-slug`,
  ]) {
    const ability = abilities.find((a) => a.name === candidate);
    if (ability) {
      const wrapperKey =
        abilityWrapperKeyFromSchema(ability) ?? postType.replace(/-/g, "_");
      return { abilityName: candidate, wrapperKey };
    }
  }
  return null;
}
```

NOTE: copy the function body from compose-site.ts EXACTLY as it stands there (the snippet above matches it at write time; if the in-tree body has drifted, the in-tree body wins). If compose-site's `ManifestShape` differs from the above, keep the in-tree shape. `abilityWrapperKeyFromSchema`'s parameter type may require `ability` to be passed as its declared type — match the existing call.

In `compose-site.ts`: delete the moved code, add
```typescript
import { abilityMetaFor, type ManifestShape } from "@/lib/jab/ability-meta";
```
and remove the now-unused `abilityWrapperKeyFromSchema` import if nothing else in the file uses it.

- [ ] **Step 4: Run the test + typecheck**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/ability-meta.test.ts`
Expected: PASS (4 tests).

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/ability-meta.ts apps/web/lib/jab/ability-meta.test.ts apps/web/lib/inngest/functions/compose-site.ts
git commit -m "refactor(jab): extract abilityMetaFor to shared lib/jab/ability-meta"
```

---

### Task 3: pure draft route resolver — `resolveDraftRoute`

**Files:**
- Create: `lib/draft/route-resolve.ts`
- Test: `lib/draft/route-resolve.test.ts`

Mirrors the emitted homepage + catch-all semantics exactly (see Context). Uses `postTypeMapEntriesFromPages` from `lib/jab/compose-site-emit.ts` so the fallback registry is derived by the SAME function compose uses.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/draft/route-resolve.test.ts
import { describe, it, expect } from "vitest";
import { resolveDraftRoute, type DraftPageRow } from "./route-resolve";
import type { ManifestShape } from "@/lib/jab/ability-meta";

const MANIFEST: ManifestShape = {
  abilities: [
    { name: "jab/get-page-by-slug" },
    { name: "jab/get-beer-by-slug" },
  ],
};

const PAGES: DraftPageRow[] = [
  { slug: "home", post_type: "page", route_path: "/", paradigms: ["gutenberg"] },
  { slug: "visit-us", post_type: "page", route_path: "visit-us", paradigms: ["gutenberg"] },
  { slug: "rocket", post_type: "beer", route_path: "beer/rocket", paradigms: ["acf_template"] },
];

describe("resolveDraftRoute", () => {
  it("resolves '/' to the front-page row", () => {
    const r = resolveDraftRoute("/", PAGES, MANIFEST, "home");
    expect(r).toMatchObject({
      kind: "page",
      target: { slug: "home", postType: "page", abilityName: "jab/get-page-by-slug" },
    });
  });

  it("resolves an exact mapped route (leading-slash tolerant both sides)", () => {
    const r = resolveDraftRoute("/visit-us", PAGES, MANIFEST, "home");
    expect(r).toMatchObject({ kind: "page", target: { slug: "visit-us", postType: "page" } });
  });

  it("308s the front-page slug to '/' (single segment only — mirrors emitted catch-all)", () => {
    expect(resolveDraftRoute("/home", PAGES, MANIFEST, "home")).toEqual({ kind: "redirect", to: "/" });
  });

  it("falls back to the post-type registry for unmapped multi-segment paths (leaf slug)", () => {
    const r = resolveDraftRoute("/beer/lil-heaven", PAGES, MANIFEST, "home");
    expect(r).toMatchObject({
      kind: "page",
      target: { slug: "lil-heaven", postType: "beer", abilityName: "jab/get-beer-by-slug" },
    });
  });

  it("falls back to the 'page' post type for unmapped single-segment paths", () => {
    const r = resolveDraftRoute("/totally-new-page", PAGES, MANIFEST, "home");
    expect(r).toMatchObject({ kind: "page", target: { slug: "totally-new-page", postType: "page" } });
  });

  it("is not_found when no registry entry covers the path prefix", () => {
    expect(resolveDraftRoute("/gear/hat", PAGES, MANIFEST, "home")).toEqual({ kind: "not_found" });
  });

  it("is not_found for '/' when no front page exists at all", () => {
    const noFront = PAGES.filter((p) => p.route_path !== "/");
    expect(resolveDraftRoute("/", noFront, MANIFEST, null)).toEqual({ kind: "not_found" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/route-resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/web/lib/draft/route-resolve.ts
import { abilityMetaFor, type ManifestShape } from "@/lib/jab/ability-meta";
import { postTypeMapEntriesFromPages } from "@/lib/jab/compose-site-emit";

/**
 * route-resolve — pure mirror of the EMITTED site's routing so the draft
 * preview and the deployed site agree on every URL:
 *   emitted app/page.tsx        → front-page row (route_path "/")
 *   emitted app/[...slug] logic → ROUTE_MAP[path], front-slug 308,
 *     fallback: len>=2 ? POST_TYPE_MAP[prefix] : POST_TYPE_MAP["page"]
 * (compose-site-emit.ts emitCatchAllPageTsx — keep in lockstep.)
 */
export interface DraftPageRow {
  slug: string;
  post_type: string;
  route_path: string;
  paradigms: string[];
}

export interface DraftRouteTarget {
  slug: string;
  postType: string;
  paradigms: string[];
  abilityName: string;
  wrapperKey: string;
}

export type DraftRouteResolution =
  | { kind: "page"; target: DraftRouteTarget }
  | { kind: "redirect"; to: "/" }
  | { kind: "not_found" };

/** Strip leading/trailing slashes; "" means the front page. */
function normalize(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

export function resolveDraftRoute(
  rawPath: string,
  pages: DraftPageRow[],
  manifest: ManifestShape,
  frontPageSlug: string | null,
): DraftRouteResolution {
  const path = normalize(rawPath);

  const toTarget = (slug: string, postType: string, paradigms: string[]): DraftRouteResolution => {
    const meta = abilityMetaFor(postType, manifest);
    if (!meta) return { kind: "not_found" };
    return {
      kind: "page",
      target: { slug, postType, paradigms, abilityName: meta.abilityName, wrapperKey: meta.wrapperKey },
    };
  };

  if (path === "") {
    const front =
      pages.find((p) => normalize(p.route_path) === "") ??
      (frontPageSlug ? pages.find((p) => p.slug === frontPageSlug) : undefined);
    if (!front) return { kind: "not_found" };
    return toTarget(front.slug, front.post_type, front.paradigms);
  }

  const segments = path.split("/");
  const leaf = segments[segments.length - 1];

  if (segments.length === 1 && frontPageSlug !== null && leaf === frontPageSlug) {
    return { kind: "redirect", to: "/" };
  }

  const mapped = pages.find(
    (p) => normalize(p.route_path) !== "" && normalize(p.route_path) === path,
  );
  if (mapped) return toTarget(mapped.slug, mapped.post_type, mapped.paradigms);

  // Fallback registry — derived by the SAME pure function compose uses for
  // POST_TYPE_MAP, so draft and deployed agree on unmapped URLs.
  const { entries } = postTypeMapEntriesFromPages(
    pages.map((p) => ({ post_type: p.post_type, paradigms: p.paradigms })),
    (postType) => abilityMetaFor(postType, manifest),
  );
  const fallbackKey = segments.length >= 2 ? segments.slice(0, -1).join("/") : "page";
  const entry = entries.find((e) => e.postType === fallbackKey);
  if (!entry) return { kind: "not_found" };
  return {
    kind: "page",
    target: {
      slug: leaf,
      postType: entry.postType,
      paradigms: entry.paradigms,
      abilityName: entry.abilityName,
      wrapperKey: entry.wrapperKey,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/route-resolve.test.ts`
Expected: PASS (7 tests). If `postTypeMapEntriesFromPages`'s `PostTypeMapEntry` lacks a field used above, check its definition at `compose-site-emit.ts:1471` region — it carries `postType`, `abilityName`, `wrapperKey`, `paradigms`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/draft/route-resolve.ts apps/web/lib/draft/route-resolve.test.ts
git commit -m "feat(draft): pure route resolver mirroring emitted ROUTE_MAP/POST_TYPE_MAP semantics"
```

---

### Task 4: draft runtime sources — shims + client renderer entry

**Files:**
- Create: `lib/draft/runtime/next-image-shim.tsx`
- Create: `lib/draft/runtime/next-link-shim.tsx`
- Create: `lib/draft/runtime/media-image.tsx`
- Create: `lib/draft/runtime/sdk-types-stub.ts`
- Create: `lib/draft/runtime/entry.tsx`
- Create: `lib/draft/runtime/virtual-modules.d.ts`

These are REAL files compiled into the browser bundle by Task 5 — they are not imported by the Next.js app itself. No unit tests in this task (no DOM in vitest); Task 5's bundle test compiles them, and `tsc` gates types.

- [ ] **Step 1: Write the shims**

```tsx
// apps/web/lib/draft/runtime/next-image-shim.tsx
/**
 * Draft-runtime stand-in for next/image. The published site optimizes via
 * next/image; the draft renders the same pixels with a plain <img>
 * (accepted divergence — spec §11). Width/height pass through so layout
 * matches; `fill` approximates with absolute positioning like next/image.
 */
import type { CSSProperties, ReactElement } from "react";

interface ImgProps {
  src: string | { src: string };
  alt?: string;
  width?: number | string;
  height?: number | string;
  fill?: boolean;
  priority?: boolean;
  quality?: number | string;
  sizes?: string;
  className?: string;
  style?: CSSProperties;
  [k: string]: unknown;
}

export default function Image(props: ImgProps): ReactElement {
  const { src, alt, width, height, fill, className, style, priority, quality, sizes, ...rest } = props;
  void priority; void quality; void sizes;
  const resolved = typeof src === "string" ? src : src?.src ?? "";
  const fillStyle: CSSProperties = fill
    ? { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: (style?.objectFit as CSSProperties["objectFit"]) ?? "cover" }
    : {};
  return (
    <img
      src={resolved}
      alt={alt ?? ""}
      width={fill ? undefined : (width as number | undefined)}
      height={fill ? undefined : (height as number | undefined)}
      className={className}
      style={{ ...style, ...fillStyle }}
      {...(rest as Record<string, unknown>)}
    />
  );
}
```

```tsx
// apps/web/lib/draft/runtime/next-link-shim.tsx
/**
 * Draft-runtime stand-in for next/link: a plain anchor. The entry's global
 * click interceptor (entry.tsx) handles same-site navigation via pushState,
 * so no per-link behavior is needed here.
 */
import type { AnchorHTMLAttributes, ReactElement, ReactNode } from "react";

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string | { pathname?: string };
  children?: ReactNode;
  prefetch?: boolean;
  scroll?: boolean;
  replace?: boolean;
}

export default function Link({ href, children, prefetch, scroll, replace, ...rest }: LinkProps): ReactElement {
  void prefetch; void scroll; void replace;
  const resolved = typeof href === "string" ? href : href?.pathname ?? "#";
  return (
    <a href={resolved} {...rest}>
      {children}
    </a>
  );
}
```

```tsx
// apps/web/lib/draft/runtime/media-image.tsx
/**
 * Draft-runtime MediaImage: same dispatcher contract as the emitted
 * components/blocks/_platform/MediaImage.tsx (props { block }), but always
 * renders a plain <img> — no next/image host validation needed in a draft.
 * Resolution order mirrors the emitted shim: structured attrs first, then
 * the first <img> found in innerHTML, then innerHTML passthrough.
 *
 * Raw-HTML note: the figure fallback renders the block's WP innerHTML via
 * React's raw-HTML prop — byte-identical to what the emitted MediaImage and
 * Passthrough ship on the DEPLOYED site. The content is the site owner's
 * own WP content inside the opaque-origin sandboxed draft iframe; adding a
 * sanitizer here would create draft-vs-published divergence (spec §11).
 */
import type { ReactElement } from "react";

interface BlockLike {
  blockName: string | null;
  attrs: Record<string, unknown>;
  innerHTML?: string;
  [k: string]: unknown;
}

export function parseImgFromInnerHTML(html: string): { src: string; alt: string } | null {
  const tag = html.match(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i);
  if (!tag) return null;
  const alt = tag[0].match(/\balt=["']([^"']*)["']/i);
  return { src: tag[1], alt: alt?.[1] ?? "" };
}

export function MediaImage({ block }: { block: BlockLike }): ReactElement | null {
  const attrs = block.attrs ?? {};
  const url = typeof attrs.url === "string" ? attrs.url : undefined;
  const alt = typeof attrs.alt === "string" ? attrs.alt : "";
  if (url) {
    return <img src={url} alt={alt} className="h-auto max-w-full" />;
  }
  const html = block.innerHTML ?? "";
  const parsed = parseImgFromInnerHTML(html);
  if (parsed) {
    return <img src={parsed.src} alt={parsed.alt} className="h-auto max-w-full" />;
  }
  if (html.trim()) {
    return <figure dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return null;
}
```

```typescript
// apps/web/lib/draft/runtime/sdk-types-stub.ts
/**
 * Value-level stub for "@/lib/sdk/types" / "@/lib/jab/ability-client" inside
 * the draft bundle. Generated components only ever need the BlockNode TYPE
 * from these paths; `import type` is erased at compile, and the postprocess
 * pass normalizes value-form imports to type-form — but if a stray value
 * import survives, resolving here keeps the bundle build green instead of
 * failing on a server-only module.
 */
export {};
```

- [ ] **Step 2: Write the renderer entry**

```tsx
// apps/web/lib/draft/runtime/entry.tsx
/**
 * Draft-runtime browser entry. Boot config comes from window.__JAB_DRAFT__
 * (written by the /draft HTML shell):
 *   { projectId, token, apiBase, initialPath }
 * Responsibilities: fetch page JSON → render via BlockDispatcher between the
 * build's Header/Footer; intercept same-site link clicks → pushState + refetch
 * (fully navigable, spec §2); render loud inline errors (spec §10).
 */
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
// virtual modules — resolved by the esbuild plugin in lib/draft/bundle.ts
import { BlockDispatcher } from "virtual:dispatcher";
import { Header } from "virtual:shell-header";
import { Footer } from "virtual:shell-footer";

interface DraftBootConfig {
  projectId: string;
  token: string;
  apiBase: string; // e.g. "/api/draft/<projectId>"
  initialPath: string;
}

interface RenderableBlockLike {
  blockName: string | null;
  attrs: Record<string, unknown>;
  innerBlocks?: RenderableBlockLike[];
  innerHTML?: string;
  _key: string;
}

type PageState =
  | { phase: "loading"; path: string }
  | { phase: "ready"; path: string; blocks: RenderableBlockLike[] }
  | { phase: "error"; path: string; message: string };

declare global {
  interface Window {
    __JAB_DRAFT__: DraftBootConfig;
  }
}

const cfg = window.__JAB_DRAFT__;

async function fetchPage(path: string): Promise<PageState> {
  try {
    const res = await fetch(
      `${cfg.apiBase}/page?path=${encodeURIComponent(path)}&token=${encodeURIComponent(cfg.token)}`,
    );
    if (res.status === 401) {
      // Token expired (2h TTL). Tell the workspace pane so it can refresh
      // the RSC and mint a fresh token into the iframe URL (spec §10).
      window.parent.postMessage({ type: "jab:draft-token-expired" }, "*");
      return { phase: "error", path, message: "Draft session expired — refreshing…" };
    }
    const body = (await res.json()) as
      | { kind: "page"; blocks: RenderableBlockLike[] }
      | { kind: "redirect"; to: string }
      | { kind: "not_found" }
      | { kind: "error"; message: string };
    if (body.kind === "redirect") return fetchPage(body.to);
    if (body.kind === "page") return { phase: "ready", path, blocks: body.blocks };
    if (body.kind === "not_found") return { phase: "error", path, message: `No page at ${path} (404 on the published site too).` };
    return { phase: "error", path, message: body.kind === "error" ? body.message : `Unexpected response (${res.status})` };
  } catch (err) {
    return { phase: "error", path, message: err instanceof Error ? err.message : String(err) };
  }
}

function DraftApp() {
  const [page, setPage] = useState<PageState>({ phase: "loading", path: cfg.initialPath });

  const navigate = useCallback((path: string, push: boolean) => {
    setPage({ phase: "loading", path });
    if (push) window.history.pushState({}, "", path);
    void fetchPage(path).then(setPage);
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    void fetchPage(cfg.initialPath).then(setPage);
    const onPop = () => navigate(window.location.pathname, false);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [navigate]);

  useEffect(() => {
    // Same-site navigation: any root-relative href renders in-draft. Absolute
    // URLs (WP media, external) keep default behavior.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (!href.startsWith("/") || href.startsWith("//")) return;
      e.preventDefault();
      navigate(href, true);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [navigate]);

  return (
    <>
      <Header />
      <main className="jab-theme">
        {page.phase === "loading" && (
          <div style={{ padding: "4rem", textAlign: "center", fontFamily: "monospace" }}>Loading draft…</div>
        )}
        {page.phase === "error" && (
          <div role="alert" style={{ margin: "2rem", padding: "1.5rem", border: "2px solid #dc2626", color: "#dc2626", fontFamily: "monospace" }}>
            <strong>Draft preview error</strong>
            <div>{page.message}</div>
          </div>
        )}
        {page.phase === "ready" &&
          page.blocks.map((b) => <BlockDispatcher key={b._key} block={b as never} />)}
      </main>
      <Footer />
    </>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <DraftApp />
    </StrictMode>,
  );
}
```

- [ ] **Step 3: Declare the virtual modules for tsc**

```typescript
// apps/web/lib/draft/runtime/virtual-modules.d.ts
// Type stubs for the esbuild-virtual modules consumed by entry.tsx.
// Real implementations are supplied at bundle time (lib/draft/bundle.ts).
declare module "virtual:dispatcher" {
  import type { ComponentType } from "react";
  export const BlockDispatcher: ComponentType<{ block: unknown }>;
}
declare module "virtual:shell-header" {
  import type { ComponentType } from "react";
  export const Header: ComponentType;
}
declare module "virtual:shell-footer" {
  import type { ComponentType } from "react";
  export const Footer: ComponentType;
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean. (Lint may flag the raw `<img>` elements; that's eslint, not tsc — these files never render inside the Next app.)

```bash
git add apps/web/lib/draft/runtime/
git commit -m "feat(draft): browser runtime sources — shims (next/image, next/link, MediaImage) + renderer entry"
```

---

### Task 5: esbuild bundler — `bundleDraftRuntime`

**Files:**
- Modify: `apps/web/package.json` (add esbuild dependency)
- Create: `lib/draft/bundle.ts`
- Test: `lib/draft/bundle.test.ts`

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @jab/web add esbuild@^0.25.0`
Expected: `apps/web/package.json` gains `"esbuild": "^0.25.0"` under dependencies (NOT devDependencies — it runs at request/worker time in production).

- [ ] **Step 2: Write the failing test**

```typescript
// apps/web/lib/draft/bundle.test.ts
import { describe, it, expect } from "vitest";
import { bundleDraftRuntime, draftComponentName } from "./bundle";
import { emitDispatcherTsx, emitPassthroughTsx } from "@/lib/jab/compose-site-emit";

const HERO_TSX = `import type { BlockNode } from "@/lib/sdk/types";
import Image from "next/image";

export function AcfHero({ block }: { block: BlockNode }) {
  const title = (block.attrs.title as string) ?? "Untitled";
  return (
    <section className="bg-primary px-4 py-16 text-4xl font-bold">
      <h1>{title}</h1>
      <Image src="/wp-content/uploads/hero.jpg" alt="" width={1200} height={600} />
    </section>
  );
}
`;

function input(over: Partial<Parameters<typeof bundleDraftRuntime>[0]> = {}) {
  return {
    componentSources: { AcfHero: HERO_TSX },
    dispatcherSource: emitDispatcherTsx([
      { blockName: "acf/hero", tier: "visual", compileStatus: "ok" },
    ]),
    passthroughSource: emitPassthroughTsx(),
    headerSource: `export function Header() { return <header className="p-4">site</header>; }`,
    footerSource: null,
    wpUrl: "https://tworoadsbrewing.com",
    ...over,
  };
}

describe("draftComponentName", () => {
  it("matches the dispatcher's PascalCase convention", () => {
    expect(draftComponentName("acf/hero")).toBe("AcfHero");
    expect(draftComponentName("core/heading")).toBe("CoreHeading");
  });
});

describe("bundleDraftRuntime", () => {
  it("produces a self-contained browser bundle (no unresolved next/* or server imports)", async () => {
    const { js } = await bundleDraftRuntime(input());
    expect(js.length).toBeGreaterThan(10_000); // React is bundled in
    expect(js).not.toMatch(/from\s*["']next\/image["']/);
    expect(js).toContain("AcfHero");
  }, 30_000);

  it("substitutes a null shell component when a shell source is absent", async () => {
    const { js } = await bundleDraftRuntime(input({ headerSource: null }));
    expect(js.length).toBeGreaterThan(10_000);
  }, 30_000);

  it("rejects loudly when a component fails to compile (this IS the per-edit compile gate)", async () => {
    await expect(
      bundleDraftRuntime(input({ componentSources: { AcfHero: "export function AcfHero({ <<<garbage" } })),
    ).rejects.toThrow();
  }, 30_000);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/bundle.test.ts`
Expected: FAIL — `Cannot find module './bundle'`.

- [ ] **Step 4: Implement**

```typescript
// apps/web/lib/draft/bundle.ts
import "server-only";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import { rewriteBlockNodeImports } from "@/lib/jab/import-rewrite";

/**
 * bundle — assembles the draft-runtime browser bundle:
 *   entry.tsx (real file) + virtual:dispatcher (emitDispatcherTsx output)
 *   + per-component TSX (Storage/DB sources) + shell + shims.
 *
 * SECURITY INVARIANT (spec §5/§7.4): esbuild PARSES the LLM-generated
 * sources; nothing here executes them. Execution happens only in the
 * user's browser inside the sandboxed draft iframe.
 *
 * This is also the per-edit compile gate: a component that fails to parse
 * or resolve fails the bundle, and the caller refuses to commit the draft
 * version (no broken previews).
 */
export interface DraftBundleInput {
  /** PascalCase component name -> TSX source (the dispatcher imports "./<Name>"). */
  componentSources: Record<string, string>;
  dispatcherSource: string;
  passthroughSource: string;
  headerSource: string | null;
  footerSource: string | null;
  wpUrl: string;
}

/** Mirror of compose-site-emit's private toPascalCase — dispatcher import names. */
export function draftComponentName(blockName: string): string {
  const trimmed = blockName.replace(/^[^a-zA-Z0-9]+/, "").replace(/[^a-zA-Z0-9]+$/, "");
  const pascal = trimmed
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (c: string) => c.toUpperCase());
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal;
}

const RUNTIME_DIR = path.join(process.cwd(), "lib", "draft", "runtime");

const NULL_SHELL = (name: "Header" | "Footer") =>
  `export function ${name}() { return null; }`;

export async function bundleDraftRuntime(input: DraftBundleInput): Promise<{ js: string }> {
  const virtualSources = new Map<string, string>();
  virtualSources.set("virtual:dispatcher", input.dispatcherSource);
  virtualSources.set("virtual:shell-header", input.headerSource ?? NULL_SHELL("Header"));
  virtualSources.set("virtual:shell-footer", input.footerSource ?? NULL_SHELL("Footer"));
  virtualSources.set("./_passthrough", input.passthroughSource);
  for (const [name, tsx] of Object.entries(input.componentSources)) {
    virtualSources.set(`./${name}`, rewriteBlockNodeImports(tsx));
  }

  const ALIASES: Record<string, string> = {
    "next/image": path.join(RUNTIME_DIR, "next-image-shim.tsx"),
    "next/link": path.join(RUNTIME_DIR, "next-link-shim.tsx"),
    "./_platform/MediaImage": path.join(RUNTIME_DIR, "media-image.tsx"),
    "@/lib/sdk/types": path.join(RUNTIME_DIR, "sdk-types-stub.ts"),
    "@/lib/jab/ability-client": path.join(RUNTIME_DIR, "sdk-types-stub.ts"),
    "@/lib/compose-block-tree": path.join(RUNTIME_DIR, "sdk-types-stub.ts"),
    "@/lib/jab/rewrite-links": path.join(process.cwd(), "lib", "jab", "rewrite-links-runtime.ts"),
  };

  const virtualPlugin: Plugin = {
    name: "jab-draft-virtual",
    setup(b) {
      b.onResolve({ filter: /^virtual:/ }, (args) => ({ path: args.path, namespace: "jab-virtual" }));
      // Relative imports issued FROM a virtual module (dispatcher -> ./AcfHero,
      // dispatcher -> ./_passthrough) resolve back into the virtual map or aliases.
      b.onResolve({ filter: /^\.\// }, (args) => {
        if (args.namespace !== "jab-virtual") return null;
        if (ALIASES[args.path]) return { path: ALIASES[args.path] };
        if (virtualSources.has(args.path)) return { path: args.path, namespace: "jab-virtual" };
        return null;
      });
      b.onResolve({ filter: /^@\// }, (args) => {
        if (ALIASES[args.path]) return { path: ALIASES[args.path] };
        return null;
      });
      b.onResolve({ filter: /^next\// }, (args) => {
        if (ALIASES[args.path]) return { path: ALIASES[args.path] };
        return null;
      });
      b.onLoad({ filter: /.*/, namespace: "jab-virtual" }, (args) => {
        const contents = virtualSources.get(args.path);
        if (contents === undefined) {
          return { errors: [{ text: `draft bundle: no source for virtual module '${args.path}'` }] };
        }
        return { contents, loader: "tsx", resolveDir: RUNTIME_DIR };
      });
    },
  };

  const result = await build({
    entryPoints: [path.join(RUNTIME_DIR, "entry.tsx")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    minify: false,
    logLevel: "silent",
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.WP_URL": JSON.stringify(input.wpUrl),
      "process.env.WP_USER": JSON.stringify(""),
      "process.env.WP_APP_PASSWORD": JSON.stringify(""),
    },
    plugins: [virtualPlugin],
  });

  if (result.errors.length > 0) {
    throw new Error(`draft bundle failed: ${result.errors.map((e) => e.text).join("; ")}`);
  }
  const out = result.outputFiles?.[0];
  if (!out) throw new Error("draft bundle: esbuild produced no output");
  return { js: out.text };
}
```

NOTE for the implementer: the emitted dispatcher source imports `"./_platform/MediaImage"` and `"./_passthrough"` with RELATIVE specifiers and `import type { RenderableBlock } from "@/lib/compose-block-tree"` (type-only — erased, but the alias above covers a stray value form). The emitted Passthrough imports `"@/lib/jab/rewrite-links"` as a VALUE import — that aliases to the real self-contained runtime file, whose `process.env.WP_URL` read is `define`d to the project's WP URL. If the bundle test fails on an unresolved specifier, print the dispatcher/passthrough source in the test and extend `ALIASES` — do not weaken the test. esbuild's `build()` rejects with an Error carrying per-file diagnostics; the compile-gate test only asserts rejection.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/bundle.test.ts`
Expected: PASS (4 tests; the bundle ones take seconds).

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/lib/draft/bundle.ts apps/web/lib/draft/bundle.test.ts
git commit -m "feat(draft): esbuild draft-runtime bundler with virtual modules + shims (per-edit compile gate)"
```

---

### Task 6: Tailwind extend extraction + draft CSS builder

**Files:**
- Modify: `lib/jab/compose-site-emit.ts` (extract `tailwindExtendFromTokens` from `emitTailwindConfigTs`)
- Modify: `apps/web/package.json` (move `tailwindcss`, `postcss`, `autoprefixer` from devDependencies to dependencies — they now run at request/worker time)
- Create: `lib/draft/css.ts`
- Test: `lib/draft/css.test.ts`

- [ ] **Step 1: Move the deps**

In `apps/web/package.json`, move the entries `"tailwindcss": "^3.4.10"`, `"postcss": "^8.4.47"`, `"autoprefixer": "^10.4.20"` from `devDependencies` to `dependencies` (keep versions). Run `pnpm install` at the repo root.

- [ ] **Step 2: Write the failing test**

```typescript
// apps/web/lib/draft/css.test.ts
import { describe, it, expect } from "vitest";
import { buildDraftCss } from "./css";
import { tailwindExtendFromTokens } from "@/lib/jab/compose-site-emit";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

const TOKENS: ThemeJsonTokens = {
  colorPalette: [{ slug: "primary", color: "#0a4f8a" }],
  fontFamilies: [{ slug: "heading", fontFamily: "Syne, sans-serif" }],
  fontSizes: [{ slug: "huge", size: "4rem" }],
};

describe("tailwindExtendFromTokens", () => {
  it("maps tokens to Tailwind extend shape (same mapping emitTailwindConfigTs serializes)", () => {
    expect(tailwindExtendFromTokens(TOKENS)).toEqual({
      colors: { primary: "#0a4f8a" },
      fontFamily: { heading: ["Syne, sans-serif"] },
      fontSize: { huge: "4rem" },
    });
  });

  it("returns empty maps for null tokens", () => {
    expect(tailwindExtendFromTokens(null)).toEqual({ colors: {}, fontFamily: {}, fontSize: {} });
  });
});

describe("buildDraftCss", () => {
  it("JITs utilities found in raw component sources, including token-derived ones", async () => {
    const css = await buildDraftCss({
      sources: [`<section className="bg-primary px-4 text-4xl font-bold">x</section>`],
      tokens: TOKENS,
      themeCss: null,
    });
    expect(css).toContain(".bg-primary");
    expect(css).toContain("#0a4f8a");
    expect(css).toContain(".text-4xl");
  }, 30_000);

  it("appends the scoped theme css verbatim after the Tailwind output", async () => {
    const css = await buildDraftCss({
      sources: [`<div className="p-2"/>`],
      tokens: null,
      themeCss: ".jab-theme .legacy { color: red; }",
    });
    expect(css.indexOf(".jab-theme .legacy")).toBeGreaterThan(css.indexOf(".p-2"));
  }, 30_000);
});
```

- [ ] **Step 3: Run to verify failures**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/css.test.ts`
Expected: FAIL — `tailwindExtendFromTokens` not exported; `./css` not found.

- [ ] **Step 4: Extract the extend helper in compose-site-emit.ts**

In `lib/jab/compose-site-emit.ts`, locate `emitTailwindConfigTs` (lines ~819-867). It builds `colors` / `fontFamily` / `fontSize` records inline from `tokens.colorPalette` / `tokens.fontFamilies` / `tokens.fontSizes` while string-building the config. Extract that mapping into an exported pure helper placed directly above `emitTailwindConfigTs`, and use it for the serialization:

```typescript
export interface TailwindExtend {
  colors: Record<string, string>;
  fontFamily: Record<string, string[]>;
  fontSize: Record<string, string>;
}

/**
 * The SINGLE source of the theme.extend mapping — serialized into the
 * emitted tailwind.config.ts AND consumed in-process by the draft CSS
 * builder (lib/draft/css.ts) so draft and deployed agree on every token.
 */
export function tailwindExtendFromTokens(tokens: ThemeJsonTokens | null): TailwindExtend {
  const colors: Record<string, string> = {};
  const fontFamily: Record<string, string[]> = {};
  const fontSize: Record<string, string> = {};
  for (const c of tokens?.colorPalette ?? []) {
    if (c.slug && c.color) colors[c.slug] = c.color;
  }
  for (const f of tokens?.fontFamilies ?? []) {
    if (f.slug && f.fontFamily) fontFamily[f.slug] = [f.fontFamily];
  }
  for (const s of tokens?.fontSizes ?? []) {
    if (s.slug && s.size) fontSize[s.slug] = s.size;
  }
  return { colors, fontFamily, fontSize };
}
```

Then inside `emitTailwindConfigTs`, replace the inline record-building with `const extend = tailwindExtendFromTokens(tokens);` and serialize `JSON.stringify(extend.colors, null, 2)` etc. into the same template positions. **The emitted string output must not change** — if the existing emitter filters or transforms slugs differently (read its body first!), replicate that exact behavior INSIDE `tailwindExtendFromTokens` and adjust the unit test above to match the real mapping. Run the existing emit tests to prove no drift (find them: `Glob apps/web/lib/jab/*emit*.test.ts`):

Run: `pnpm --filter @jab/web exec vitest run lib/jab/compose-site-emit.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 5: Implement the CSS builder**

```typescript
// apps/web/lib/draft/css.ts
import "server-only";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { tailwindExtendFromTokens } from "@/lib/jab/compose-site-emit";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

/**
 * css — Tailwind 3 JIT over the draft's raw TSX sources, using the SAME
 * theme.extend mapping the emitted tailwind.config.ts serializes
 * (tailwindExtendFromTokens) and the same `important: "#jab-app"` scoping
 * (the /draft HTML shell sets <html id="jab-app">). The build's scoped
 * theme.css (emitThemeCss output) is appended verbatim, matching the
 * emitted globals.css import order: tailwind first, theme second.
 */
export interface BuildDraftCssInput {
  /** Raw TSX sources to scan: all effective components + shell + dispatcher. */
  sources: string[];
  tokens: ThemeJsonTokens | null;
  /** Pre-scoped theme css (emitThemeCss output) or null when none captured. */
  themeCss: string | null;
}

export async function buildDraftCss(input: BuildDraftCssInput): Promise<string> {
  const extend = tailwindExtendFromTokens(input.tokens);
  const result = await postcss([
    tailwindcss({
      content: input.sources.map((raw) => ({ raw, extension: "tsx" })),
      important: "#jab-app",
      theme: { extend },
    } as never),
  ]).process("@tailwind base;\n@tailwind components;\n@tailwind utilities;\n", {
    from: undefined,
  });
  const themePart = input.themeCss ? `\n/* --- captured source theme (scoped) --- */\n${input.themeCss}\n` : "";
  return result.css + themePart;
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/css.test.ts`
Expected: PASS (4 tests).

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean. (Tailwind's plugin typing may need the `as never` cast shown above — its public types want a config path, but the object form is supported.)

- [ ] **Step 7: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/lib/jab/compose-site-emit.ts apps/web/lib/draft/css.ts apps/web/lib/draft/css.test.ts
git commit -m "feat(draft): in-process Tailwind JIT via shared tailwindExtendFromTokens"
```

---

### Task 7: page data assembly — `loadDraftPageData`

**Files:**
- Create: `lib/draft/page-data.ts`
- Test: `lib/draft/page-data.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/draft/page-data.test.ts
import { describe, it, expect, vi } from "vitest";
import { loadDraftPageData, type DraftPageDeps } from "./page-data";

const PAGES = [
  { slug: "home", post_type: "page", route_path: "/", paradigms: ["gutenberg"] },
  { slug: "visit-us", post_type: "page", route_path: "visit-us", paradigms: ["gutenberg"] },
];

function deps(over: Partial<DraftPageDeps> = {}): DraftPageDeps {
  return {
    loadPages: vi.fn(async () => PAGES),
    loadManifest: vi.fn(async () => ({ abilities: [{ name: "jab/get-page-by-slug" }] })),
    loadFrontPageSlug: vi.fn(async () => "home"),
    loadAcfFlexFields: vi.fn(async () => ({})),
    loadDynamicListSpecs: vi.fn(async () => ({})),
    callAbility: vi.fn(async () => ({
      page: {
        id: 1,
        title: "Visit",
        slug: "visit-us",
        blocks: [{ blockName: "core/heading", attrs: {}, innerBlocks: [], innerHTML: "<h2>Visit</h2>", innerContent: [] }],
      },
    })),
    resolveMedia: undefined,
    ...over,
  };
}

describe("loadDraftPageData", () => {
  it("returns composed renderable blocks for a mapped page", async () => {
    const d = deps();
    const result = await loadDraftPageData({ buildId: "b1", path: "/visit-us" }, d);
    expect(result.kind).toBe("page");
    if (result.kind === "page") {
      expect(result.blocks.length).toBeGreaterThan(0);
      expect(result.blocks[0]._key).toBeDefined();
    }
    expect(d.callAbility).toHaveBeenCalledWith("jab/get-page-by-slug", {
      slug: "visit-us",
      include: { blocks: true },
    });
  });

  it("propagates redirects (front-page slug)", async () => {
    const result = await loadDraftPageData({ buildId: "b1", path: "/home" }, deps());
    expect(result).toEqual({ kind: "redirect", to: "/" });
  });

  it("is not_found when WP returns no record under the wrapper key", async () => {
    const result = await loadDraftPageData(
      { buildId: "b1", path: "/visit-us" },
      deps({ callAbility: vi.fn(async () => ({ page: null })) }),
    );
    expect(result).toEqual({ kind: "not_found" });
  });

  it("returns a typed error (never throws) when the ability call fails", async () => {
    const result = await loadDraftPageData(
      { buildId: "b1", path: "/visit-us" },
      deps({ callAbility: vi.fn(async () => { throw new Error("WP unreachable"); }) }),
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("WP unreachable");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/page-data.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/web/lib/draft/page-data.ts
import "server-only";
import { composeBlockTree, type RenderableBlock } from "@/lib/jab/compose-block-tree-runtime";
import { resolveRelationshipRefs, type CallAbility, type MediaResolver } from "@/lib/jab/related-posts-runtime";
import { resolveDynamicLists, type DynamicListSpec } from "@/lib/jab/dynamic-lists-runtime";
import { resolveDraftRoute, type DraftPageRow } from "./route-resolve";
import type { ManifestShape } from "@/lib/jab/ability-meta";
import {
  createJabMcpClient,
  loadJabCredentials,
  type JabCredentials,
} from "@/lib/jab/ability-client";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * page-data — the draft renderer's server half. Runs the IDENTICAL pure
 * pipeline the emitted pages run at request time (see emitCatchAllPageTsx):
 * by-slug ability → response[wrapperKey] → composeBlockTree → relationship +
 * dynamic-list hydration. NO LLM code executes here — this is data assembly
 * only (spec §7.4).
 */
export type DraftPageDataResult =
  | { kind: "page"; path: string; blocks: RenderableBlock[] }
  | { kind: "redirect"; to: "/" }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

export interface DraftPageDeps {
  loadPages(buildId: string): Promise<DraftPageRow[]>;
  loadManifest(buildId: string): Promise<ManifestShape>;
  loadFrontPageSlug(buildId: string): Promise<string | null>;
  loadAcfFlexFields(buildId: string): Promise<Record<string, string[]>>;
  loadDynamicListSpecs(buildId: string): Promise<Record<string, DynamicListSpec>>;
  callAbility: CallAbility;
  resolveMedia?: MediaResolver;
}

export async function loadDraftPageData(
  args: { buildId: string; path: string },
  deps: DraftPageDeps,
): Promise<DraftPageDataResult> {
  try {
    const [pages, manifest, frontPageSlug] = await Promise.all([
      deps.loadPages(args.buildId),
      deps.loadManifest(args.buildId),
      deps.loadFrontPageSlug(args.buildId),
    ]);
    const resolution = resolveDraftRoute(args.path, pages, manifest, frontPageSlug);
    if (resolution.kind !== "page") return resolution;

    const t = resolution.target;
    const response = (await deps.callAbility(t.abilityName, {
      slug: t.slug,
      include: { blocks: true },
    })) as Record<string, unknown> | null;
    const record = response?.[t.wrapperKey];
    if (!record || typeof record !== "object") return { kind: "not_found" };

    const [acfFlexFields, dynamicSpecs] = await Promise.all([
      deps.loadAcfFlexFields(args.buildId),
      deps.loadDynamicListSpecs(args.buildId),
    ]);
    const blocks = composeBlockTree(
      record as Parameters<typeof composeBlockTree>[0],
      t.postType,
      t.paradigms,
      { acfFlexFields },
    );
    await resolveRelationshipRefs(blocks as never, deps.callAbility, deps.resolveMedia);
    await resolveDynamicLists(blocks as never, deps.callAbility, dynamicSpecs, deps.resolveMedia);
    return { kind: "page", path: args.path, blocks };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/* ---------------- production deps wiring ---------------- */

/** CallAbility over @jab/core McpClient — same error discipline as callJab. */
export function createCallAbility(client: ReturnType<typeof createJabMcpClient>): CallAbility {
  return async (abilityName, input) => {
    const result = await client.callTool<unknown>(abilityName, input ?? {});
    if ((result as { isError?: boolean }).isError) {
      throw new Error(`${abilityName} returned isError`);
    }
    return (result as { structuredContent?: unknown }).structuredContent;
  };
}

/** Media resolver bound to explicit creds (the env-based one is for emitted sites). */
export function mediaResolverFromCreds(creds: JabCredentials): MediaResolver {
  const auth = "Basic " + Buffer.from(`${creds.username}:${creds.appPassword}`).toString("base64");
  const cache = new Map<number, { url: string; alt?: string } | null>();
  return async (attachmentId) => {
    if (cache.has(attachmentId)) return cache.get(attachmentId) ?? null;
    try {
      const res = await fetch(`${creds.wpUrl}/wp-json/wp/v2/media/${attachmentId}`, {
        headers: { Authorization: auth },
      });
      if (!res.ok) {
        cache.set(attachmentId, null);
        return null;
      }
      const j = (await res.json()) as { source_url?: string; alt_text?: string };
      const ref = j.source_url ? { url: j.source_url, alt: j.alt_text ?? "" } : null;
      cache.set(attachmentId, ref);
      return ref;
    } catch {
      cache.set(attachmentId, null);
      return null;
    }
  };
}

export async function defaultDraftPageDeps(
  projectId: string,
  tenantId: string,
): Promise<DraftPageDeps> {
  const admin = createAdminClient();
  const creds = await loadJabCredentials(projectId, tenantId);
  const client = createJabMcpClient(creds);

  return {
    async loadPages(buildId) {
      const { data, error } = await admin
        .from("page_inventory")
        .select("slug, post_type, route_path, paradigms")
        .eq("site_build_id", buildId);
      if (error) throw new Error(`draft loadPages failed: ${error.message}`);
      return (data ?? []) as DraftPageRow[];
    },
    async loadManifest() {
      const { data, error } = await admin
        .from("projects")
        .select("manifest")
        .eq("id", projectId)
        .single();
      if (error) throw new Error(`draft loadManifest failed: ${error.message}`);
      return ((data?.manifest ?? {}) as ManifestShape);
    },
    async loadFrontPageSlug(buildId) {
      const { data } = await admin
        .from("site_builds")
        .select("config")
        .eq("id", buildId)
        .single();
      const cfg = (data?.config ?? {}) as { front_page_slug?: unknown };
      return typeof cfg.front_page_slug === "string" && cfg.front_page_slug ? cfg.front_page_slug : null;
    },
    async loadAcfFlexFields(buildId) {
      // Same derivation the emitted lib/acf-flex-fields.ts encodes: parse
      // acf_flex/<postType>/<fieldPath>/<layout> block names from inventory.
      // MIRROR emitAcfFlexFieldsTs (compose-site-emit.ts:941-969) — read it
      // first and copy its exact split/filter logic.
      const { data, error } = await admin
        .from("block_inventory")
        .select("block_name")
        .eq("site_build_id", buildId)
        .like("block_name", "acf_flex/%");
      if (error) throw new Error(`draft loadAcfFlexFields failed: ${error.message}`);
      const out: Record<string, Set<string>> = {};
      for (const row of data ?? []) {
        const parts = String((row as { block_name: string }).block_name).split("/");
        if (parts.length >= 4) {
          (out[parts[1]] ??= new Set()).add(parts[2]);
        }
      }
      return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
    },
    async loadDynamicListSpecs(buildId) {
      // dynamicListSpecsFromInventory is what compose uses — reuse it. Check
      // its exact signature in lib/jab/dynamic-list-detect.ts and select the
      // columns it expects.
      const { dynamicListSpecsFromInventory } = await import("@/lib/jab/dynamic-list-detect");
      const { data, error } = await admin
        .from("block_inventory")
        .select("block_name, kind, spec")
        .eq("site_build_id", buildId);
      if (error) throw new Error(`draft loadDynamicListSpecs failed: ${error.message}`);
      const specs = dynamicListSpecsFromInventory((data ?? []) as never);
      return Object.fromEntries(specs.map((s: DynamicListSpec) => [s.blockName, s]));
    },
    callAbility: createCallAbility(client),
    resolveMedia: mediaResolverFromCreds(creds),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/page-data.test.ts`
Expected: PASS (4 tests).

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean. The `as never` casts bridge the runtime modules' structurally-identical `RBlock`/`RenderableBlock` shapes — same shapes the emitted pages pass without casts because they're colocated.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/draft/page-data.ts apps/web/lib/draft/page-data.test.ts
git commit -m "feat(draft): server page-data assembly over the shared pure runtimes"
```

---

### Task 8: artifact builder — `ensureBaseDraftArtifacts`

**Files:**
- Create: `lib/draft/artifacts.ts`
- Test: `lib/draft/artifacts.test.ts`

- [ ] **Step 1: Write the failing test (pure parts + orchestration with mocked IO)**

```typescript
// apps/web/lib/draft/artifacts.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  baseDraftArtifactPath,
  dispatcherRowsFromInventory,
  ensureBaseDraftArtifacts,
  type ArtifactDeps,
} from "./artifacts";

describe("baseDraftArtifactPath", () => {
  it("keys phase-1 artifacts by buildId", () => {
    expect(baseDraftArtifactPath("b1", "bundle.js")).toBe("drafts/base/b1/bundle.js");
    expect(baseDraftArtifactPath("b1", "draft.css")).toBe("drafts/base/b1/draft.css");
  });
});

describe("dispatcherRowsFromInventory", () => {
  it("passes through the dispatcher-relevant columns", () => {
    const rows = dispatcherRowsFromInventory([
      { block_name: "acf/hero", tier: "visual", compile_status: "ok" },
      { block_name: null, tier: "passthrough", compile_status: null },
    ]);
    expect(rows).toEqual([
      { blockName: "acf/hero", tier: "visual", compileStatus: "ok" },
      { blockName: null, tier: "passthrough", compileStatus: null },
    ]);
  });
});

describe("ensureBaseDraftArtifacts", () => {
  function deps(over: Partial<ArtifactDeps> = {}): ArtifactDeps {
    return {
      artifactExists: vi.fn(async () => false),
      loadInventory: vi.fn(async () => [
        { block_name: "acf/hero", tier: "visual", compile_status: "ok" },
      ]),
      loadComponentSources: vi.fn(async () => ({ AcfHero: "export function AcfHero(){return null;}" })),
      loadShellSource: vi.fn(async () => null),
      loadProjectMeta: vi.fn(async () => ({ wpUrl: "https://example.com", tokens: null, themeCss: null })),
      bundle: vi.fn(async () => ({ js: "//bundle" })),
      buildCss: vi.fn(async () => "/*css*/"),
      upload: vi.fn(async () => {}),
      ...over,
    };
  }

  it("builds and uploads bundle + css when artifacts are missing", async () => {
    const d = deps();
    const out = await ensureBaseDraftArtifacts({ buildId: "b1" }, d);
    expect(d.bundle).toHaveBeenCalled();
    expect(d.upload).toHaveBeenCalledWith("drafts/base/b1/bundle.js", "//bundle", "text/javascript");
    expect(d.upload).toHaveBeenCalledWith("drafts/base/b1/draft.css", "/*css*/", "text/css");
    expect(out).toEqual({ bundlePath: "drafts/base/b1/bundle.js", cssPath: "drafts/base/b1/draft.css" });
  });

  it("skips building when both artifacts already exist", async () => {
    const d = deps({ artifactExists: vi.fn(async () => true) });
    await ensureBaseDraftArtifacts({ buildId: "b1" }, d);
    expect(d.bundle).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/artifacts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/web/lib/draft/artifacts.ts
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { emitDispatcherTsx, emitPassthroughTsx, emitThemeCss, type BlockInventoryRowForDispatch } from "@/lib/jab/compose-site-emit";
import { bundleDraftRuntime, draftComponentName } from "./bundle";
import { buildDraftCss } from "./css";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

/**
 * artifacts — ensures drafts/base/<buildId>/{bundle.js,draft.css} exist in
 * Storage for the read-only Phase 1 renderer. Built once per build, lazily
 * on first /draft request, then immutable (a build's components never
 * change after `ready`). Phase 2 supersedes this with per-version paths
 * written by the draft-edit worker at commit time.
 */
export function baseDraftArtifactPath(buildId: string, file: "bundle.js" | "draft.css"): string {
  return `drafts/base/${buildId}/${file}`;
}

interface InventoryRow {
  block_name: string | null;
  tier: string | null;
  compile_status: string | null;
}

export function dispatcherRowsFromInventory(rows: InventoryRow[]): BlockInventoryRowForDispatch[] {
  return rows.map((r) => ({ blockName: r.block_name, tier: r.tier, compileStatus: r.compile_status }));
}

export interface ArtifactDeps {
  artifactExists(path: string): Promise<boolean>;
  loadInventory(buildId: string): Promise<InventoryRow[]>;
  loadComponentSources(buildId: string, names: string[]): Promise<Record<string, string>>;
  loadShellSource(buildId: string, kind: "header" | "footer"): Promise<string | null>;
  loadProjectMeta(buildId: string): Promise<{ wpUrl: string; tokens: ThemeJsonTokens | null; themeCss: string | null }>;
  bundle: typeof bundleDraftRuntime;
  buildCss: typeof buildDraftCss;
  upload(path: string, contents: string, contentType: string): Promise<void>;
}

export async function ensureBaseDraftArtifacts(
  args: { buildId: string },
  deps: ArtifactDeps,
): Promise<{ bundlePath: string; cssPath: string }> {
  const bundlePath = baseDraftArtifactPath(args.buildId, "bundle.js");
  const cssPath = baseDraftArtifactPath(args.buildId, "draft.css");

  const [haveBundle, haveCss] = await Promise.all([
    deps.artifactExists(bundlePath),
    deps.artifactExists(cssPath),
  ]);
  if (haveBundle && haveCss) return { bundlePath, cssPath };

  const inventory = await deps.loadInventory(args.buildId);
  const dispatcherRows = dispatcherRowsFromInventory(inventory);
  const usableNames = dispatcherRows
    .filter((r) => r.blockName && r.blockName !== "core/image" && r.tier !== "passthrough" && r.compileStatus === "ok")
    .map((r) => draftComponentName(r.blockName as string));

  const [componentSources, headerSource, footerSource, meta] = await Promise.all([
    deps.loadComponentSources(args.buildId, usableNames),
    deps.loadShellSource(args.buildId, "header"),
    deps.loadShellSource(args.buildId, "footer"),
    deps.loadProjectMeta(args.buildId),
  ]);

  const dispatcherSource = emitDispatcherTsx(dispatcherRows);
  const passthroughSource = emitPassthroughTsx();

  const { js } = await deps.bundle({
    componentSources,
    dispatcherSource,
    passthroughSource,
    headerSource,
    footerSource,
    wpUrl: meta.wpUrl,
  });
  const css = await deps.buildCss({
    sources: [...Object.values(componentSources), headerSource ?? "", footerSource ?? ""],
    tokens: meta.tokens,
    themeCss: meta.themeCss,
  });

  await deps.upload(bundlePath, js, "text/javascript");
  await deps.upload(cssPath, css, "text/css");
  return { bundlePath, cssPath };
}

/* ---------------- production deps ---------------- */

export function defaultArtifactDeps(projectId: string): ArtifactDeps {
  const admin = createAdminClient();
  const storage = () => admin.storage.from(SITE_SCREENSHOTS_BUCKET);

  return {
    async artifactExists(path) {
      const dir = path.slice(0, path.lastIndexOf("/"));
      const name = path.slice(path.lastIndexOf("/") + 1);
      const { data } = await storage().list(dir);
      return (data ?? []).some((f) => f.name === name);
    },
    async loadInventory(buildId) {
      const { data, error } = await admin
        .from("block_inventory")
        .select("block_name, tier, compile_status")
        .eq("site_build_id", buildId);
      if (error) throw new Error(`draft loadInventory failed: ${error.message}`);
      return (data ?? []) as InventoryRow[];
    },
    async loadComponentSources(buildId, names) {
      const out: Record<string, string> = {};
      await Promise.all(
        names.map(async (name) => {
          const { data } = await storage().download(`builds/${buildId}/components/${name}.tsx`);
          if (data) out[name] = await data.text();
        }),
      );
      return out;
    },
    async loadShellSource(buildId, kind) {
      const file = kind === "header" ? "Header.tsx" : "Footer.tsx";
      const { data } = await storage().download(`builds/${buildId}/project/components/site/${file}`);
      return data ? await data.text() : null;
    },
    async loadProjectMeta() {
      const { data, error } = await admin
        .from("projects")
        .select("wp_url, design_tokens")
        .eq("id", projectId)
        .single();
      if (error || !data) throw new Error(`draft loadProjectMeta failed: ${error?.message ?? "no row"}`);
      const dt = (data.design_tokens ?? {}) as {
        themeJson?: ThemeJsonTokens | null;
        themeStylesheets?: Array<{ href: string; css: string }> | null;
      };
      const sheets = dt.themeStylesheets ?? [];
      return {
        wpUrl: data.wp_url as string,
        tokens: dt.themeJson ?? null,
        themeCss: sheets.length > 0 ? emitThemeCss(sheets as never) : null,
      };
    },
    bundle: bundleDraftRuntime,
    buildCss: buildDraftCss,
    upload: async (path, contents, contentType) => {
      const { error } = await storage().upload(path, Buffer.from(contents, "utf-8"), {
        contentType,
        upsert: true,
      });
      if (error) throw new Error(`draft artifact upload failed (${path}): ${error.message}`);
    },
  };
}
```

NOTE: verify the `design_tokens` JSON shape before wiring `loadProjectMeta` — compose-site resolves tokens via `resolveThemeTokens(themeJson, scraped)` (`lib/jab/global-styles.ts:146-152`). Mirror compose-site's exact argument extraction (search `resolveThemeTokens` in compose-site.ts) rather than guessing the column layout; same for where `themeStylesheets` actually lives. In-tree wins over the snippet.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/artifacts.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/draft/artifacts.ts apps/web/lib/draft/artifacts.test.ts
git commit -m "feat(draft): lazy base-build artifact builder (bundle + css to Storage)"
```

---

### Task 9: the four HTTP surfaces

**Files:**
- Create: `lib/draft/html-shell.ts` (pure HTML template — unit-testable)
- Create: `app/draft/[projectId]/[[...path]]/route.ts`
- Create: `app/api/draft/[projectId]/page/route.ts`
- Create: `app/api/draft/[projectId]/asset/[file]/route.ts`
- Test: `lib/draft/html-shell.test.ts`

- [ ] **Step 1: Write the failing test for the pure shell**

```typescript
// apps/web/lib/draft/html-shell.test.ts
import { describe, it, expect } from "vitest";
import { renderDraftShellHtml } from "./html-shell";

describe("renderDraftShellHtml", () => {
  const html = renderDraftShellHtml({
    projectId: "p1",
    token: "t.abc",
    initialPath: "/visit-us",
    fontLinkHrefs: ["https://fonts.googleapis.com/css2?family=Syne&display=swap"],
    version: "base-b1",
  });

  it("sets the #jab-app id and .jab-theme scope the CSS expects", () => {
    expect(html).toContain('<html id="jab-app"');
    expect(html).toContain('class="jab-theme"');
  });

  it("links css + module bundle through the token-gated asset route with a version cache-buster", () => {
    expect(html).toContain("/api/draft/p1/asset/draft.css?token=t.abc&v=base-b1");
    expect(html).toContain("/api/draft/p1/asset/bundle.js?token=t.abc&v=base-b1");
    expect(html).toContain('type="module"');
  });

  it("embeds the boot config with the initial path", () => {
    expect(html).toContain('"initialPath":"/visit-us"');
    expect(html).toContain('"apiBase":"/api/draft/p1"');
  });

  it("includes the font links", () => {
    expect(html).toContain("fonts.googleapis.com/css2?family=Syne");
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement the shell**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/html-shell.test.ts` → FAIL (module not found).

```typescript
// apps/web/lib/draft/html-shell.ts
/**
 * html-shell — the static document served at /draft/<projectId>/<path>.
 * Pure string template (unit-tested); the route handler adds headers.
 * <html id="jab-app"> matches Tailwind's `important: "#jab-app"` scope and
 * body.jab-theme matches the captured theme css — same as emitLayoutTsx.
 */
export interface DraftShellInput {
  projectId: string;
  token: string;
  initialPath: string;
  fontLinkHrefs: string[];
  /** Artifact version discriminator for cache busting (Phase 1: "base-<buildId>"). */
  version: string;
}

export function renderDraftShellHtml(input: DraftShellInput): string {
  const q = `token=${encodeURIComponent(input.token)}&v=${encodeURIComponent(input.version)}`;
  const apiBase = `/api/draft/${input.projectId}`;
  const boot = JSON.stringify({
    projectId: input.projectId,
    token: input.token,
    apiBase,
    initialPath: input.initialPath,
  });
  const fonts = input.fontLinkHrefs
    .map((href) => `<link rel="stylesheet" href="${href}">`)
    .join("\n    ");
  return `<!doctype html>
<html id="jab-app" lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>Draft preview</title>
    ${fonts}
    <link rel="stylesheet" href="${apiBase}/asset/draft.css?${q}">
  </head>
  <body class="jab-theme">
    <div id="root"></div>
    <script>window.__JAB_DRAFT__ = ${boot};</script>
    <script type="module" src="${apiBase}/asset/bundle.js?${q}"></script>
  </body>
</html>
`;
}
```

Run: `pnpm --filter @jab/web exec vitest run lib/draft/html-shell.test.ts` → PASS (4 tests).

- [ ] **Step 3: Implement the three route handlers**

```typescript
// apps/web/app/draft/[projectId]/[[...path]]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { verifyDraftToken } from "@/lib/draft/token";
import { renderDraftShellHtml } from "@/lib/draft/html-shell";
import { ensureBaseDraftArtifacts, defaultArtifactDeps } from "@/lib/draft/artifacts";
import { buildGoogleFontLinks } from "@/lib/jab/compose-site-emit";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveThemeTokens } from "@/lib/jab/global-styles";

export const dynamic = "force-dynamic";

/**
 * Serves the draft HTML shell. AUTHZ = the HMAC token (the iframe is
 * sandboxed without allow-same-origin → opaque origin → no cookies), so we
 * use the admin client keyed by the token-verified projectId. The CSP keeps
 * the LLM-generated bundle from talking to anything but this app + media
 * origins (spec §7.1).
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string; path?: string[] }> },
) {
  const { projectId, path = [] } = await ctx.params;
  const token = req.nextUrl.searchParams.get("token");
  if (!verifyDraftToken(projectId, token)) {
    return new NextResponse("draft token invalid or expired", { status: 401 });
  }

  const admin = createAdminClient();
  const { data: build, error } = await admin
    .from("site_builds")
    .select("id")
    .eq("project_id", projectId)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !build) {
    return new NextResponse("no ready build to preview — run a build first", { status: 404 });
  }

  try {
    await ensureBaseDraftArtifacts({ buildId: build.id }, defaultArtifactDeps(projectId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new NextResponse(`draft artifacts failed to build: ${msg}`, { status: 500 });
  }

  const { data: project } = await admin
    .from("projects")
    .select("design_tokens")
    .eq("id", projectId)
    .single();
  const dt = (project?.design_tokens ?? {}) as { themeJson?: unknown; scraped?: unknown };
  const tokens = resolveThemeTokens(dt.themeJson as never, dt.scraped as never);

  const html = renderDraftShellHtml({
    projectId,
    token: token as string,
    initialPath: "/" + path.join("/"),
    fontLinkHrefs: buildGoogleFontLinks(tokens),
    version: `base-${build.id}`,
  });
  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src * data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
    },
  });
}
```

```typescript
// apps/web/app/api/draft/[projectId]/page/route.ts
import { NextRequest, NextResponse } from "next/server";
import { verifyDraftToken } from "@/lib/draft/token";
import { loadDraftPageData, defaultDraftPageDeps } from "@/lib/draft/page-data";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const token = req.nextUrl.searchParams.get("token");
  if (!verifyDraftToken(projectId, token)) {
    return NextResponse.json({ kind: "error", message: "token invalid or expired" }, { status: 401 });
  }
  const path = req.nextUrl.searchParams.get("path") ?? "/";

  const admin = createAdminClient();
  const { data: project } = await admin
    .from("projects")
    .select("tenant_id")
    .eq("id", projectId)
    .single();
  if (!project) return NextResponse.json({ kind: "not_found" }, { status: 404 });

  const { data: build } = await admin
    .from("site_builds")
    .select("id")
    .eq("project_id", projectId)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!build) return NextResponse.json({ kind: "not_found" }, { status: 404 });

  const deps = await defaultDraftPageDeps(projectId, project.tenant_id);
  const result = await loadDraftPageData({ buildId: build.id, path }, deps);
  const status = result.kind === "not_found" ? 404 : result.kind === "error" ? 502 : 200;
  return NextResponse.json(result, { status, headers: { "cache-control": "no-store" } });
}
```

```typescript
// apps/web/app/api/draft/[projectId]/asset/[file]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { verifyDraftToken } from "@/lib/draft/token";
import { baseDraftArtifactPath } from "@/lib/draft/artifacts";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  "bundle.js": "text/javascript; charset=utf-8",
  "draft.css": "text/css; charset=utf-8",
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string; file: string }> },
) {
  const { projectId, file } = await ctx.params;
  const token = req.nextUrl.searchParams.get("token");
  if (!verifyDraftToken(projectId, token)) {
    return new NextResponse("token invalid or expired", { status: 401 });
  }
  const contentType = CONTENT_TYPES[file];
  if (!contentType) return new NextResponse("unknown asset", { status: 404 });

  const admin = createAdminClient();
  const { data: build } = await admin
    .from("site_builds")
    .select("id")
    .eq("project_id", projectId)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!build) return new NextResponse("no ready build", { status: 404 });

  const path = baseDraftArtifactPath(build.id, file as "bundle.js" | "draft.css");
  const { data, error } = await admin.storage.from(SITE_SCREENSHOTS_BUCKET).download(path);
  if (error || !data) return new NextResponse("artifact missing — reload the draft shell", { status: 404 });

  return new NextResponse(await data.arrayBuffer(), {
    headers: {
      "content-type": contentType,
      // ?v= in the URL is the cache discriminator — safe to cache hard.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
```

- [ ] **Step 4: Typecheck + run the draft suites**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean.

Run: `pnpm --filter @jab/web exec vitest run lib/draft/`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/draft/html-shell.ts apps/web/lib/draft/html-shell.test.ts "apps/web/app/draft/[projectId]/[[...path]]/route.ts" "apps/web/app/api/draft/[projectId]/page/route.ts" "apps/web/app/api/draft/[projectId]/asset/[file]/route.ts"
git commit -m "feat(draft): token-gated draft renderer HTTP surfaces (shell + page JSON + assets)"
```

---

### Task 10: full-suite gate

**Files:** none (verification only)

- [ ] **Step 1:** Run: `pnpm --filter @jab/web test` — Expected: ALL PASS (~900 pre-phase tests + ~29 new). Fix forward in the introducing task if not.
- [ ] **Step 2:** Run: `pnpm --filter @jab/web exec tsc --noEmit` — Expected: clean.
- [ ] **Step 3:** Commit only if fixes were needed:

```bash
git add -A apps/web
git commit -m "test(draft): full-suite green for phase 1 renderer"
```

---

### Task 11: live smoke against Two Roads (operator task — controlling session, NOT a subagent)

**Files:**
- Create: `scripts/smoke-draft-renderer.ts` (in `apps/web/scripts/`)

- [ ] **Step 1: Write the smoke script**

```typescript
// apps/web/scripts/smoke-draft-renderer.ts
/**
 * Phase-1 draft renderer smoke. Usage:
 *   pnpm --filter @jab/web exec tsx scripts/smoke-draft-renderer.ts <projectId> [baseUrl]
 * Requires the Next dev server running and .env.local secrets loaded.
 * Mints a token directly (same env secret) and asserts: shell 200, page JSON
 * for "/", assets served, garbage 404, and 401 without a token.
 */
import { mintDraftToken } from "../lib/draft/token";

const projectId = process.argv[2];
const baseUrl = process.argv[3] ?? "http://localhost:3000";
if (!projectId) {
  console.error("usage: tsx scripts/smoke-draft-renderer.ts <projectId> [baseUrl]");
  process.exit(1);
}

async function main() {
  const token = mintDraftToken(projectId);
  console.log(`draft URL: ${baseUrl}/draft/${projectId}/?token=${encodeURIComponent(token)}`);
  const q = `token=${encodeURIComponent(token)}`;
  const fails: string[] = [];
  const check = async (
    label: string,
    url: string,
    assert: (res: Response, body: string) => boolean,
  ) => {
    const res = await fetch(url);
    const body = await res.text();
    const ok = assert(res, body);
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (${res.status})`);
    if (!ok) fails.push(`${label}: ${res.status} ${body.slice(0, 200)}`);
  };

  await check("shell 401 without token", `${baseUrl}/draft/${projectId}/`, (r) => r.status === 401);
  await check("shell 200 with token", `${baseUrl}/draft/${projectId}/?${q}`, (r, b) => r.status === 200 && b.includes("__JAB_DRAFT__"));
  await check("page JSON for /", `${baseUrl}/api/draft/${projectId}/page?path=/&${q}`, (r, b) => r.status === 200 && JSON.parse(b).kind === "page");
  await check("css asset", `${baseUrl}/api/draft/${projectId}/asset/draft.css?${q}`, (r, b) => r.status === 200 && b.includes("jab-app"));
  await check("bundle asset", `${baseUrl}/api/draft/${projectId}/asset/bundle.js?${q}`, (r, b) => r.status === 200 && b.length > 10_000);
  await check("garbage path is not_found", `${baseUrl}/api/draft/${projectId}/page?path=/zz/yy/xx&${q}`, (r, b) => r.status === 404 && JSON.parse(b).kind === "not_found");

  if (fails.length) {
    console.error(`\nSMOKE FAIL\n${fails.join("\n")}`);
    process.exit(1);
  }
  console.log("\nSMOKE PASS");
}

void main();
```

- [ ] **Step 2: Run it** (dev server up, Two Roads project `075e33fd-8984-4e48-b58e-a9eab54d1828`):

```powershell
pnpm --filter @jab/web exec tsx scripts/smoke-draft-renderer.ts 075e33fd-8984-4e48-b58e-a9eab54d1828
```
Expected: `SMOKE PASS`. First shell request takes longest (lazy artifact build: bundle + Tailwind JIT + uploads).

- [ ] **Step 3: Manual browse** — open the `draft URL` the script printed: homepage renders with header/footer + brand styling; click into a page route and a `/beer/<slug>` detail (client-side nav, no full reload); compare side-by-side with the deployed preview; DevTools console shows no module errors. Assert the front-slug redirect: `/api/draft/<id>/page?path=/<front-slug>&token=...` returns `{"kind":"redirect","to":"/"}`.

- [ ] **Step 4: Commit + record**

```bash
git add apps/web/scripts/smoke-draft-renderer.ts
git commit -m "feat(draft): phase-1 renderer smoke script"
```

Record observed divergences (visual deltas vs deployed preview) in memory / the Phase 2 plan's context — they are the fidelity ledger spec §11 predicts.

---

## Self-review notes

- **Spec coverage (Phase-1 slice):** §7.1 routes → T9; §7.2 client renderer → T4; §7.3 bundling/shims → T4+T5; §7.4 token+sandbox security → T1+T9 (CSP, opaque-origin notes); §3 parity facts → T2 (abilityMetaFor extraction), T3 (route mirror), T6 (tailwindExtendFromTokens), T7 (shared runtimes). Pane/draft-table/edit-loop deliberately absent (Phase 2); the `sandbox` attribute lands on the workspace iframe when the pane adopts the draft URL in Phase 2 — Phase 1's surface is URL-only.
- **Type consistency:** `DraftPageRow` defined once (T3), imported by T7; `bundleDraftRuntime`/`buildDraftCss` signatures match T8's dep types; `draftComponentName` mirrors `toPascalCase`; token API (`mintDraftToken(projectId, nowMs?)`) consistent across T1/T9/T11.
- **Known in-tree-verification points (flagged inline, intentional):** exact body of `abilityMetaFor` (T2), `emitTailwindConfigTs` internals before extraction (T6), `dynamicListSpecsFromInventory` signature and `design_tokens` JSON layout (T7/T8). Each says: read the in-tree code first; in-tree wins.
