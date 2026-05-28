# JAB SaaS v2 — Phase C: Compose & Shell — Design Spec

> **Status:** DRAFT (2026-05-27)
> **Stage:** 3 of 7 — per [`docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md`](../plans/2026-05-25-saas-v2-roadmap.md)
> **Architecture reference:** [`docs/saas-v2-component-pipeline.md`](../../saas-v2-component-pipeline.md) §4 Phase C (C₁–C₇), §6.6
> **Plugin floor:** v0.6.3
> **Predecessor:** Stage 1 Discovery shipped; Stage 2 Components T1–T15 shipped (tailwind-config emitter + live-model smoke land before Stage 3 implementation begins)
> **Successor:** Stage 4 Build & Deploy — Vercel adapter consumes the project tree this stage emits

---

## 0. Why this exists

Phase B produces a bag of `.tsx` files in Storage and a populated `block_inventory` / `page_inventory` keyed off the typed `BlockNode[]` trees from v0.6.x. Phase D needs a complete, compilable Next.js project to run `next build` against. **Phase C is the bridge.** It is the most deterministic phase of the pipeline — only the two shell LLM calls (Header, Footer) carry creative risk; everything else is file emission from data already in the DB.

The design pressure here is the opposite of Phase B's. Phase B is "creative output, must validate." Phase C is "boring output, must be exhaustive." If a single import path is wrong or a single dispatcher entry is missing, the entire `next build` in Phase D fails. **The spec optimizes for fail-fast detection, not for clever architecture.**

---

## 1. Goal

Given a completed Phase B build (a `site_builds` row with `status = 'composing'`, populated `block_inventory` + `page_inventory`, Phase B component `.tsx` files at `builds/<build_id>/components/*.tsx`, and `projects.design_tokens` populated with `themeJson` + `themeStylesheets` + `shellDom`), emit the **full Next.js project file tree** at `builds/<build_id>/project/` in Supabase Storage, ready for Phase D to download, `next build`, and deploy.

Success = Stage 4 can `next build` the emitted tree with zero hand-editing and zero scaffold reach-arounds.

---

## 2. Inputs

Phase C is a pure consumer of Stage 1 + Stage 2 outputs. No fresh WP probing. No new LLM calls except the shell pair.

| Source | Shape | Used for |
|---|---|---|
| `site_builds[id]` | `{ status, project_id }` | Status transitions; tenant scoping via FK |
| `block_inventory` (filtered by `site_build_id`) | rows of `{ block_name, kind, tier, compile_status, page_slugs }` | Dispatcher key set + compile-status filter (failed → passthrough) |
| `page_inventory` (filtered by `site_build_id`) | rows of `{ slug, post_type, title, route_path, paradigms[], block_count }` | Route emission, sitemap, runtime composition map |
| `projects.design_tokens` | `{ themeJson, themeStylesheets, shellDom: { header, footer }, raw }` | tailwind emit, shell LLM context, theme stylesheet bundle |
| `projects.manifest` | `Manifest` (v0.6.x shape) | SDK emit via `@jab/core` `emitSdk` |
| `projects.wp_url` + `wp_username` + `wp_app_password_encrypted` | for `.env.example` placeholders only — NOT for live calls | env scaffold |
| Storage: `builds/<build_id>/components/<Name>.tsx` | text/plain `.tsx` source | Downloaded + written into the project tree at `components/blocks/` |

**What Phase C deliberately does NOT consume:** the source screenshots (Phase E reuses them), `block_inventory.computed_styles` (already baked into Phase B component output), `block_inventory.attr_samples` (already consumed in Phase B). Each Phase C step pulls a tight slice of inputs — see §6.

---

## 3. Outputs — the emitted project tree

The full tree lives in Supabase Storage at `builds/<build_id>/project/` (private `site-screenshots` bucket, same as Phase B components — the bucket's MIME allowlist already permits `text/plain` which covers `.tsx`, `.ts`, `.json`, `.css`, `.md`, `.mjs`).

```
builds/<build_id>/project/
├── package.json
├── tsconfig.json
├── next.config.ts
├── tailwind.config.ts
├── postcss.config.mjs
├── .gitignore
├── .env.example
├── README.md
│
├── app/
│   ├── layout.tsx              ← Header + Footer composition + fonts
│   ├── page.tsx                ← homepage (deterministic from front-page slug)
│   ├── not-found.tsx
│   ├── robots.ts               ← derived from project's wp_url
│   ├── sitemap.ts              ← derived from page_inventory
│   ├── globals.css             ← Tailwind directives + theme stylesheet bundle import
│   └── [...slug]/
│       ├── page.tsx            ← catch-all dynamic route
│       └── route-map.ts        ← build-time path → { postType, paradigms } map
│
├── components/
│   ├── blocks/
│   │   ├── <Name>.tsx          ← downloaded from Phase B Storage (one per inventory row)
│   │   ├── _dispatcher.tsx     ← block_name → component map + passthrough fallback
│   │   └── _passthrough.tsx    ← sanitized-HTML fallback (DOMPurify)
│   └── site/
│       ├── Header.tsx          ← shell LLM output (C₆-a)
│       └── Footer.tsx          ← shell LLM output (C₆-b)
│
├── lib/
│   ├── sdk/                    ← emitSdk() from @jab/core
│   │   ├── types.ts
│   │   ├── client.ts
│   │   ├── abilities.ts
│   │   ├── index.ts
│   │   └── CLAUDE.md
│   ├── jab/
│   │   └── client.ts           ← renderJabClient() — kit-policy wrapper
│   ├── compose-block-tree.ts   ← paradigm-aware page → BlockNode[] runtime helper
│   └── acf-flex-fields.ts      ← build-time post_type → ACF flex field paths map
│
└── styles/
    └── theme.css               ← the source theme's stylesheet bundle, scoped under .jab-theme
```

**Path notes:**
- `builds/<build_id>/source/` is reserved for Phase A's source screenshots (`source/<viewport>/<slug>.png`). The project tree intentionally uses `/project/` to avoid name collision with that convention.
- The dispatcher (`_dispatcher.tsx`) and passthrough (`_passthrough.tsx`) are emitted by Phase C — they are NOT components Phase B generates. Their leading underscore signals "infrastructure, not a content block."
- `app/[...slug]/page.tsx` is the standard *required-segment* catch-all (single brackets), not the optional `[[...slug]]` variant — Next.js 15 rejects the optional catch-all when an explicit `app/page.tsx` is also present.

---

## 4. Storage layout

Phase C writes one Storage upload per emitted file. Upserts are idempotent; a re-run of Phase C against the same `build_id` overwrites cleanly. Each upload uses `contentType: "text/plain"` (no charset suffix — see [`apps/web/lib/ai/persist-generation.ts:51`](../../../apps/web/lib/ai/persist-generation.ts#L51) for the Phase B precedent and the MIME-allowlist gotcha).

| Path | Origin | Size budget |
|---|---|---|
| `builds/<build_id>/project/package.json` | static template | <1 KB |
| `builds/<build_id>/project/tsconfig.json` | static template | <1 KB |
| `builds/<build_id>/project/next.config.ts` | `@jab/core` `renderNextConfig()` | <1 KB |
| `builds/<build_id>/project/tailwind.config.ts` | `emitTailwindConfig(themeJsonTokens)` (Stage 2 deliverable; Phase C reuses) | <5 KB |
| `builds/<build_id>/project/postcss.config.mjs` | static template | <1 KB |
| `builds/<build_id>/project/.gitignore` | static template | <1 KB |
| `builds/<build_id>/project/.env.example` | `@jab/core` `renderEnvExample()` | <2 KB |
| `builds/<build_id>/project/README.md` | template w/ project name | <4 KB |
| `builds/<build_id>/project/app/layout.tsx` | deterministic from `themeJsonTokens.fontFamilies` + project name | <2 KB |
| `builds/<build_id>/project/app/page.tsx` | deterministic compose from front-page record | <2 KB |
| `builds/<build_id>/project/app/not-found.tsx` | static template | <1 KB |
| `builds/<build_id>/project/app/robots.ts` | derived from `projects.wp_url` | <1 KB |
| `builds/<build_id>/project/app/sitemap.ts` | derived from `page_inventory.route_path` | <4 KB |
| `builds/<build_id>/project/app/globals.css` | Tailwind directives + `@import "../styles/theme.css"` | <1 KB |
| `builds/<build_id>/project/app/[...slug]/page.tsx` | deterministic; uses `lib/compose-block-tree.ts` | <3 KB |
| `builds/<build_id>/project/app/[...slug]/route-map.ts` | deterministic from `page_inventory` | <8 KB |
| `builds/<build_id>/project/components/blocks/<Name>.tsx` | downloaded from Phase B Storage; on download failure → passthrough fallback substituted at emission time | per Phase B cap (≤8 KB) |
| `builds/<build_id>/project/components/blocks/_dispatcher.tsx` | deterministic from `block_inventory` | <8 KB |
| `builds/<build_id>/project/components/blocks/_passthrough.tsx` | static template | <2 KB |
| `builds/<build_id>/project/components/site/Header.tsx` | LLM output (C₆-a) — capped at 12 KB | ≤12 KB |
| `builds/<build_id>/project/components/site/Footer.tsx` | LLM output (C₆-b) — capped at 12 KB | ≤12 KB |
| `builds/<build_id>/project/lib/sdk/*` | `emitSdk(manifest)` | ~30–100 KB (manifest-dependent) |
| `builds/<build_id>/project/lib/jab/client.ts` | `renderJabClient()` | <2 KB |
| `builds/<build_id>/project/lib/compose-block-tree.ts` | static template (paradigm dispatcher) | <4 KB |
| `builds/<build_id>/project/lib/acf-flex-fields.ts` | deterministic from `block_inventory` acf_flex block names | <2 KB |
| `builds/<build_id>/project/styles/theme.css` | `themeStylesheets` array joined and wrapped in `.jab-theme` selector scope | ≤100 KB (Phase A cap) |

Total tree size for a Two-Roads-shaped site: ~300–500 KB across ~30 files. Comfortably under Inngest's per-step output size limits and Storage's per-object cap.

---

## 5. The compose-site Inngest worker

New worker: `apps/web/lib/inngest/functions/compose-site.ts`.

**Trigger:** `site/compose.requested` — already dispatched by `generateComponents` on clean exit ([`generate-components.ts:307`](../../../apps/web/lib/inngest/functions/generate-components.ts#L307)).

**Status machine:** `composing` on entry → `built` on clean exit (renaming Phase D's entry state to `built` is a Stage 4 concern; this spec writes `composing` → next event = `site/deploy.requested`).

**Retries:** `0` — same rationale as `discoverSite` and `generateComponents`. Recovery is re-triggering `site/compose.requested` with the same `buildId`.

**Step boundaries** (mirroring the `step.run` discipline from Phase A / B workers):

```ts
inngest.createFunction(
  { id: "compose-site", retries: 0 },
  { event: "site/compose.requested" },
  async ({ event, step }) => {
    // 1. Mark composing-phase
    // 2. Load inputs in parallel: block_inventory, page_inventory, design_tokens, manifest
    // 3. C₅ Emit SDK (deterministic, no inputs beyond manifest)
    // 4. C₄ Emit dispatcher (deterministic, no inputs beyond block_inventory)
    // 5. C₇ Emit chrome (deterministic — package.json, configs, robots, sitemap, etc.)
    // 6. C₂ Emit catch-all route + compose-block-tree.ts (deterministic)
    // 7. C₃ Emit CPT routes — GATED BY phase_c_emit_cpt_routes config flag (v1.1)
    // 8. Download Phase B component .tsx files in parallel batches → write to project tree
    // 9. C₆-a Generate Header.tsx (LLM, visual tier)
    // 10. C₆-b Generate Footer.tsx (LLM, visual tier)
    // 11. C₁ Emit homepage (app/page.tsx) — depends on front-page record + dispatcher
    // 12. Emit globals.css + styles/theme.css (depends on themeStylesheets)
    // 13. Emit app/layout.tsx (depends on Header + Footer existing)
    // 14. Update site_builds.status='built' + finished_at
    // 15. Dispatch site/deploy.requested
  }
);
```

Steps 3–7 can run as parallel `step.run` calls (no inter-step dependencies). Steps 8, 9, 10 are also parallel. Step 11 depends on the dispatcher existing (step 4) but doesn't write the homepage's component imports — those come from the dispatcher import. Step 13 (`layout.tsx`) depends on 9 + 10 (Header + Footer must exist in Storage before the layout's imports can be statically checked).

Practical sequencing — three serial waves:

1. **Parallel wave 1** (no LLM, no Storage round-trips for download): C₄ dispatcher, C₅ SDK, C₇ chrome, C₂ catch-all + compose-block-tree, C₃ CPT routes (gated), theme.css from themeStylesheets, C₁ homepage. All deterministic; all `step.run` boundaries.
2. **Parallel wave 2** (Storage round-trips + LLM): Component file downloads (batched), C₆-a Header LLM, C₆-b Footer LLM. The two LLM calls run in parallel.
3. **Serial finalization**: `app/layout.tsx` (depends on Header + Footer), then status update + deploy dispatch.

Total wall-clock target: ≤45 seconds. The two LLM calls dominate (~10s each at p50). Storage I/O is ~10s for ~30 sequential-equivalent uploads (batched in parallel of 8).

---

## 6. Step-by-step pipeline — C₁ through C₇

Mapping the architecture doc's C₁–C₇ to the worker steps above.

### C₁ — Homepage compose (`app/page.tsx`)

Deterministic. Resolves the WP front-page slug via the existing `resolveFrontPage(creds)` helper (see [`generate-components.ts:144`](../../../apps/web/lib/inngest/functions/generate-components.ts#L144)) — but Phase C resolves from `page_inventory` instead, because the front-page record was already fetched in Phase A and we want zero new WP traffic in Phase C.

Algorithm:
1. Look up the front-page `page_inventory` row by `route_path = '/'` (Phase A's `playwright-discovery.ts` normalizes the front-page route_path to `/`).
2. If found: emit `app/page.tsx` that calls the typed SDK fetcher (resolved the same way as the catch-all's `ROUTE_MAP[''].fetcher`) and renders `<main>{composeBlockTree(record).map(b => <BlockDispatcher key={b._key} block={b} />)}</main>`.
3. If not found (no static front-page; the WP install is configured with `show_on_front = 'posts'`): **hard-fail the compose-site worker** with an explicit error pointing the user back to the WP admin → Reading settings. Phase C v1 does NOT emit a latest-posts-feed homepage. Two Roads and the Stage 1/2 smoke targets all use a static front-page; the latest-posts case is a v1.1 deliverable tied to the gated CPT-list emit (§6 C₃) since both share the list-rendering pattern.

`composeBlockTree(record)` is the runtime helper in `lib/compose-block-tree.ts` — see §8.

**Emitted file shape:**

```tsx
// app/page.tsx
import { jabClient } from "@/lib/jab/client";
import { BlockDispatcher } from "@/components/blocks/_dispatcher";
import { composeBlockTree } from "@/lib/compose-block-tree";

export const revalidate = 60; // ISR floor

export default async function Page() {
  const record = await jabClient.getJabPageBySlug({ slug: "<frontPageSlug>", include: { blocks: true } });
  const blocks = composeBlockTree(record, "page", ["acf_flex", "acf_template", "gutenberg"]); // paradigms from page_inventory
  return (
    <main className="jab-theme">
      {blocks.map((b) => <BlockDispatcher key={b._key} block={b} />)}
    </main>
  );
}
```

`<frontPageSlug>` and the paradigms array are template-interpolated at emission time from the inventory row.

### C₂ — Catch-all route (`app/[...slug]/page.tsx`)

Deterministic — one template, parameter-driven at request time.

The catch-all must resolve a path like `/about` or `/beer/ipa` against the right `post_type`. Strategy:

1. Join `params.slug` to form the request path.
2. Look up the path in a build-time-emitted route map (object literal: `{ "about": "page", "ipa": "beer", ... }`) — this map is emitted from `page_inventory` rows alongside the catch-all file. **The catch-all does NOT call multiple SDK methods speculatively** — it knows the `(slug, post_type)` mapping ahead of time.
3. Call the SDK's `getJab<PostType>BySlug` ability for the resolved post_type.
4. Read `paradigms` for the page (also in the emitted route map).
5. Hand off to `composeBlockTree(record, post_type, paradigms)` and render via dispatcher.

`notFound()` if the path isn't in the route map.

**Emitted file shape (abbreviated):**

```tsx
// app/[...slug]/page.tsx
import { notFound } from "next/navigation";
import { jabClient } from "@/lib/jab/client";
import { BlockDispatcher } from "@/components/blocks/_dispatcher";
import { composeBlockTree } from "@/lib/compose-block-tree";
import { ROUTE_MAP } from "./route-map";

export const revalidate = 60;

export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const path = slug.join("/");
  const entry = ROUTE_MAP[path];
  if (!entry) notFound();
  const fetcher = (jabClient as Record<string, (args: { slug: string; include?: { blocks?: boolean } }) => Promise<unknown>>)[entry.fetcher];
  if (!fetcher) notFound();
  const record = await fetcher({ slug: path, include: { blocks: true } });
  const blocks = composeBlockTree(record, entry.postType, entry.paradigms);
  return (
    <main className="jab-theme">
      {blocks.map((b) => <BlockDispatcher key={b._key} block={b} />)}
    </main>
  );
}
```

The route-map file `app/[...slug]/route-map.ts` is emitted alongside, typed:

```ts
export const ROUTE_MAP: Record<string, { fetcher: string; postType: string; paradigms: string[] }> = {
  "about": { fetcher: "getJabPageBySlug", postType: "page", paradigms: ["acf_flex", "acf_template"] },
  "beer/ipa": { fetcher: "getJabBeerBySlug", postType: "beer", paradigms: ["acf_template"] },
  // ...
};
```

The `fetcher` field carries the typed SDK method name directly, so the catch-all does `jabClient[entry.fetcher]` instead of mangling the post_type string. The accessor is still loosely-typed at runtime (it's a string index into the SDK client), but the *route map* is fully typed and emitted from `block_inventory.kind + post_type` at Phase C emission time — no string transformations at runtime.

### C₃ — CPT archives + singles (conditional, v1.1)

The roadmap defers per-CPT routes (`app/{cpt}/page.tsx` for list, `app/{cpt}/[slug]/page.tsx` for single) to v1.1, but the scaffold should *support* emit-or-skip from day one.

**v1 default: skip.** The catch-all in C₂ already handles `/beer/ipa` via the route map. List pages (`/beer` showing all beers) are not emitted unless the config flag is set.

**Config flag:** `phase_c_emit_cpt_routes` — a boolean on `site_builds.config` (jsonb), defaulting `false`. When `true`, Phase C also emits `app/{cpt}/page.tsx` (list, paginated) + `app/{cpt}/[slug]/page.tsx` (single) per unique `post_type` in `page_inventory` other than `page` and `post`.

For v1, `phase_c_emit_cpt_routes` is always false. The structure exists so v1.1 just flips the flag and re-runs Phase C — no schema change required.

### C₄ — Block dispatcher (`components/blocks/_dispatcher.tsx`)

Deterministic from `block_inventory`. The dispatcher is a single React component with an exhaustive `switch` on `block.blockName`, falling through to `<Passthrough />` for unknowns.

Component name derivation mirrors `buildComponentStoragePath` ([`persist-generation.ts:19`](../../../apps/web/lib/ai/persist-generation.ts#L19)): `blockName.replace(non-alnum-underscore-slash chars with _).replace(/, _) → PascalCase`. So `acf_flex/page/page_builder/large_hero` → `AcfFlexPagePageBuilderLargeHero`. (Verbose, but unambiguous and machine-derived; no human reads dispatcher imports.)

Filter rules at emission time:
- Rows with `compile_status = 'failed'` are SKIPPED — they go to the passthrough branch in the switch.
- Rows with `tier = 'passthrough'` are SKIPPED — same.
- The `__null__` block-name row goes to the passthrough branch (classic-editor body content).

**Emitted file shape:**

```tsx
// components/blocks/_dispatcher.tsx
import type { BlockNode } from "@/lib/sdk/types";
import { Passthrough } from "./_passthrough";
import { CoreHeading } from "./CoreHeading";
import { CoreParagraph } from "./CoreParagraph";
import { AcfFlexPagePageBuilderLargeHero } from "./AcfFlexPagePageBuilderLargeHero";
// ...one import per non-passthrough, non-failed inventory row

export function BlockDispatcher({ block }: { block: BlockNode }) {
  switch (block.blockName) {
    case "core/heading": return <CoreHeading {...(block.attrs as any)} />;
    case "core/paragraph": return <CoreParagraph {...(block.attrs as any)} />;
    case "acf_flex/page/page_builder/large_hero": return <AcfFlexPagePageBuilderLargeHero {...(block.attrs as any)} />;
    // ...one case per inventory row
    default: return <Passthrough block={block} />;
  }
}
```

The `{...(block.attrs as any)}` spread is intentional — Phase B's generated component prop type is unioned in `lib/sdk/types.ts`'s BlockNode variant set, but TS can't narrow `block.attrs` to the matching variant inside the switch without help. The `as any` is a known compromise. Phase B compile-checks each component standalone; the dispatcher's compile-check is "does it parse," not "do the props line up." This is the pragmatic line; tightening it (typed discriminator on blockName) is a v1.1 nice-to-have.

### C₅ — SDK emit

Reuses `@jab/core` `emitSdk(manifest)` exactly as the current scaffold does ([`scaffold.ts:49`](../../../apps/web/lib/jab/scaffold.ts#L49)). The output `Map<filename, content>` keys (`types.ts`, `client.ts`, `abilities.ts`, `index.ts`, `CLAUDE.md`) get prefixed with `lib/sdk/` and uploaded to Storage at `builds/<build_id>/project/lib/sdk/<name>`.

Also reused: `renderJabClient()`, `renderNextConfig()`, `renderEnvExample()` from the same package. These are unchanged from the v1 scaffold.

### C₆ — Site shell (3 emissions, 2 of them LLM-driven)

Three sub-steps; two are LLM calls.

**C₆-a — Header LLM call.** Inputs:
- `projects.design_tokens.shellDom.header` (the captured `#masthead` / `<header>` outerHTML)
- `projects.design_tokens.themeJson.fontFamilies` + `colorPalette` (token names available)
- `projects.manifest.menus` (primary menu structure if `jab/get-menus` returned data — best-effort)
- `projects.logo_storage_path` (signed URL emitted into the prompt for vision input)
- The list of token names available in `tailwind.config.ts` (so the LLM picks from real tokens, not made-up ones)

System prompt (sketch — full content lives in `lib/ai/shell-prompts.ts`):

> You are a senior React/Next.js engineer. You will be given the rendered HTML of a WordPress site's header (the source DOM), the available Tailwind tokens (color, font, spacing) from the theme, and optionally a logo URL. Emit a single typed React component named `Header` that recreates the source header faithfully using ONLY Tailwind classes. The component receives no props. Use Next.js `<Link>` for nav. Do NOT import fonts. Do NOT use inline styles unless absolutely necessary. Output ONLY TSX — no prose, no markdown.

Output post-processing:
- Strip code fences if present.
- Standalone `tsc --noEmit` check against the file using `lib/ai/compile-check.ts` (the same helper Phase B uses).
- On compile failure: retry once with the error message appended. If second attempt fails: emit a deterministic fallback Header that renders the site name + a horizontal nav from the menu data.
- Cap output at 12 KB. Output exceeding the cap is treated as a generation failure (same retry/fallback path).

Model: Sonnet 4.6 (visual tier — uses the logo image input when available). Via the Stage 2 `ModelClient` seam — `lib/ai/model-client.ts`.

**C₆-b — Footer LLM call.** Identical contract to C₆-a but with `shellDom.footer` as input and `<Footer>` as the component name. Footer menus + WP site_info options (description, social URLs) are passed if available.

**C₆-c — `app/layout.tsx` emission.** DETERMINISTIC. Depends on Header + Footer existing in Storage (sequencing constraint in §5).

```tsx
// app/layout.tsx
import type { Metadata } from "next";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import "./globals.css";

export const metadata: Metadata = {
  title: "<Project Name>",
  description: "<from design_tokens.personality.description or fallback>",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <Header />
        {children}
        <Footer />
      </body>
    </html>
  );
}
```

The font-family rule from the architecture doc — "Do NOT import fonts; use theme font-family tokens" — means Phase C does NOT call `next/font`. The theme's font-family declarations are imported via `styles/theme.css` (the bundled source stylesheets) and surfaced via Tailwind tokens.

### C₇ — Misc chrome

- **`app/globals.css`** — Tailwind directives (`@tailwind base/components/utilities`) + a conditional `@import "../styles/theme.css"` line. The import is omitted entirely when `themeStylesheets` is empty (Cloudflare-protected sites with no captured CSS); the file would not exist and the import would fail `next build`.
- **`styles/theme.css`** — emitted only when `themeStylesheets` is non-empty. Joins each sheet's CSS body with a blank line separator and wraps the whole concatenated payload under a `.jab-theme` selector scope at emission time. Source @import resolution already happened browser-side in Phase A's capture, so the bundled CSS is self-contained.
- **`app/not-found.tsx`** — static template; brand-neutral 404 page.
- **`app/robots.ts`** — derived from `projects.wp_url`: `Disallow: /wp-admin/, /wp-login.php`. Sitemap pointer included.
- **`app/sitemap.ts`** — emits `MetadataRoute.Sitemap` from `page_inventory.route_path` rows. `lastModified` defaults to `new Date()` (per-page mod times not currently captured; v1.1 candidate).
- **`next.config.ts`** — from `@jab/core` `renderNextConfig()`. Unchanged from v1 scaffold.
- **`package.json`** — template duplicated from the v1 scaffold's `renderPackageJson()` ([`scaffold.ts:80`](../../../apps/web/lib/jab/scaffold.ts#L80)) into `lib/jab/compose-site-templates.ts` with `isomorphic-dompurify` added as a runtime dep (passthrough block dependency). The duplication is intentional — see §11 for the sunset rationale. v1 scaffold and Phase C scaffold coexist until Stage 7 retires the former.
- **`tsconfig.json`**, **`postcss.config.mjs`**, **`.gitignore`** — copied verbatim from scaffold v1.
- **`.env.example`** — from `@jab/core` `renderEnvExample()`. Unchanged.
- **`README.md`** — Phase C-specific template that explains "this project was generated by JAB SaaS Phase C, edits will be overwritten on next regen."

---

## 7. The block dispatcher (`_dispatcher.tsx`) — detailed

Already covered in §6 C₄. Two additional details worth pinning:

**Passthrough component (`_passthrough.tsx`)** — static template emitted by Phase C once. The full implementation pattern is documented in the architecture doc [§3 Decision 3](../../saas-v2-component-pipeline.md). The Phase C copy is identical except for the import path adjustment (`@/lib/sdk/types` for `BlockNode`). DOMPurify rationale and the sanitization-required-even-for-authenticated-content argument live there; Phase C does NOT re-litigate that decision, it just emits the file.

**Dispatcher's `key` prop** — the runtime `<BlockDispatcher>` receives `{ block, key }`. Generating stable React keys from BlockNode is non-trivial (no inherent ID). Phase C's runtime helper `composeBlockTree` (§8) tags each node with `_key: index-path` (e.g. `"0.2.1"` for the second grandchild of the first root block) so the dispatcher consumer can use that key. This is documented in `lib/compose-block-tree.ts`.

---

## 8. The runtime composition layer (`lib/compose-block-tree.ts`)

Static template, emitted by Phase C. Deterministic; no LLM.

This is the paradigm-aware bridge between a fetched WP record and a flat BlockNode[] array the dispatcher can render. It handles four paradigms (from `page_inventory.paradigms`):

| Paradigm | Source on record | Synthesis |
|---|---|---|
| `gutenberg` | `record.blocks: BlockNode[]` | Return as-is |
| `acf_flex` | `record.acf.<field>[]` with `acf_fc_layout` | Synthesize one BlockNode per flex item: `{ blockName: "acf_flex/<post_type>/<field>/<layout_name>", attrs: <fields>, innerBlocks: [], innerHTML: "" }` |
| `acf_template` | `record.acf.<fields...>` (no flex) | Synthesize ONE BlockNode: `{ blockName: "cpt_template/<post_type>", attrs: <full record>, innerBlocks: [], innerHTML: "" }` |
| `classic` | `record.content.rendered` | Synthesize ONE BlockNode: `{ blockName: null, attrs: {}, innerBlocks: [], innerHTML: record.content.rendered }` — routes to Passthrough |
| `unknown` | (none of above) | Return [] (renders empty `<main>`) |

When multiple paradigms apply (Two Roads homepage is `["acf_flex", "acf_template", "gutenberg"]`), the helper concatenates outputs in paradigm order. For Two Roads' homepage that means: ACF flex layouts first (the page builder), then the ACF template wrapper for any non-flex fields, then any Gutenberg blocks present in `record.blocks`.

ACF field path resolution: the synthesis needs to know which ACF field on the record contains the flex items. `page_inventory` doesn't currently carry that information; it's derived from the inventory's `acf_flex/<cpt>/<field>/<layout>` block names. The helper takes the inventory's block-name list as a compile-time constant (emitted by Phase C alongside the helper) and uses it to know which ACF fields to walk.

This is more "deterministic plumbing" than "clever code," and the helper is unit-testable in isolation — see §14.

---

## 9. The shell LLM contract — Header + Footer

Two structurally identical calls; described once. Inputs, prompt outline, output post-processing.

**Inputs (per call):**
- The captured DOM (`shellDom.header` or `shellDom.footer`) — outerHTML, ~5–10 KB typical.
- `themeJson` tokens — names available in tailwind.config.
- Menu data from `projects.manifest` if the `jab/get-menus` ability returned non-empty.
- Logo signed URL (Header only — vision input) from `projects.logo_storage_path`.
- Site name, tagline, social URLs from WP options surfaced in the manifest's `_self` ability output (when available).

**System prompt key constraints:**
1. **Output is TSX only.** No prose, no markdown fences.
2. **No font imports.** No `next/font`, no `<link rel="stylesheet">`. Font-family is inherited from `body` via the bundled theme stylesheet.
3. **Tailwind classes only.** The available token list is in the prompt; any class outside it is a generation error.
4. **Use Next.js `<Link>`** for internal navigation; `<a>` for external.
5. **Match the source DOM's structure faithfully** — same hierarchy of nav / logo / cart / search affordances.
6. **Static output** — no client state, no React hooks unless interactivity is unavoidable (mobile menu toggle is the one allowed exception).
7. **Component name + export default fixed** — `export function Header()` / `export function Footer()`. The wrapping layout import expects this exactly.

**Output validation:**
1. Strip code fences if present.
2. Standalone compile-check via `lib/ai/compile-check.ts` (reuses Phase B's helper).
3. Size cap: 12 KB. Over-cap is a generation failure.
4. On compile failure: retry once with the diagnostic appended to the prompt. Then fall back to a deterministic Header/Footer template (site name + flat nav list) — known-ugly but renderable.

**Missing-input handling:**
- If `shellDom.header` is `null` or empty (Phase A capture failed entirely), skip the LLM call and emit the deterministic fallback Header directly. Persist a `shell_generations` row with `compile_status = 'skipped'`, `model_used = null`, zero tokens. Same applies to Footer.
- If `themeJson.fontFamilies` is empty AND no `themeStylesheets` are present, the prompt's "Tailwind tokens available" list is whatever the inferred tokens (computed-CSS aggregates) carry. The constraint that font-family comes from the bundled stylesheet relaxes — fallback Header/Footer use Tailwind's default font stack.
- If `logo_storage_path` is null, Sonnet 4.6 falls back to the text-only variant — no signed URL passed.

**Model + provider:**
- Visual tier via the `ModelClient` seam — Sonnet 4.6 with vision when a logo URL is available, text-only otherwise.
- Prompt caching marks the system prompt + theme token list as ephemeral. The two shell calls happen in parallel within ~10s of each other, so the cache hit is reliable.

**Telemetry:** model + provider + token counts + compile_attempt_count per call are persisted in a new `shell_generations` table keyed `(site_build_id, shell_kind)` where `shell_kind ∈ ('header', 'footer')`. Mirror of the cost-telemetry columns on `block_inventory`.

**Why a new table and not extending `block_inventory`:** shells aren't blocks; their `block_name` doesn't fit (`shell/header` is arguably one but reserves a namespace prefix that has no other use). Phase F (review) treats shell drift as its own category. Cost rollup queries do a UNION ALL across `block_inventory` and `shell_generations` for the build's total.

---

## 10. Conditional emission: CPT routes

Already covered in §6 C₃. The single addition here is the **config flag location**:

- New column on `site_builds`: `config jsonb NOT NULL DEFAULT '{}'`. Phase C reads `config.phase_c_emit_cpt_routes`. Stage 4 (deploy) and Stage 7 (orchestration) can use the same column to carry other per-build flags as they emerge — keeps the schema flat.
- Default `false`. v1.1 ships a UI toggle (project settings → "advanced") that flips it.
- When `true`, Phase C iterates `page_inventory` post_types (excluding `page` and `post`), emits a list route + single route per CPT, and includes a `lib/cpt-routes.ts` map of `{ <cpt>: { listSlug, pageSize, sortBy } }` (defaults: `listSlug = cpt`, `pageSize = 12`, `sortBy = "date desc"`).

---

## 11. SDK + scaffold reuse from `@jab/core`

Phase C's reuse list — already-shipped, no changes needed:

| Function | Used for |
|---|---|
| `emitSdk(manifest)` | `lib/sdk/*` |
| `renderJabClient()` | `lib/jab/client.ts` |
| `renderNextConfig()` | `next.config.ts` |
| `renderEnvExample()` | `.env.example` |

Things Phase C does NOT reuse from the v1 scaffold:
- `renderProxyRoute()` — the strangler-fig proxy. Phase C is full-headless; the catch-all is `app/[...slug]/page.tsx`, not `route.ts`.
- `renderRootLayout()` — the v1 scaffold's layout was a placeholder with no Header / Footer composition. Phase C emits its own.
- `TAILWIND_CONFIG` / `GLOBALS_CSS` constants — both replaced (tailwind config comes from Stage 2's `emitTailwindConfig`; globals.css is templated to include the theme.css import).
- `renderPackageJson()` — extended with `isomorphic-dompurify`. Phase C emits its own; the v1 helper can be reused after that single dep is added in v1 core, but to avoid coupling we duplicate the template into `lib/jab/compose-site-templates.ts`.

**Sunset path:** Stage 7 deletes `apps/web/lib/jab/scaffold.ts` (the v1 helper) once the SaaS no longer needs the old CLI-export path. Until then, both coexist. The new code is in `lib/jab/compose-site-emit.ts` (template constants + small helpers) and `lib/inngest/functions/compose-site.ts` (the worker).

---

## 12. Cost + time budget

Per build (single execution of Phase C):

| Item | Wall-clock | LLM calls | Cost |
|---|---|---|---|
| Wave 1 (deterministic emissions) | ~10s | 0 | $0 |
| Wave 2 component downloads (batched 8-wide) | ~5–10s | 0 | $0 |
| Wave 2 Header LLM | ~10s (p50) | 1 | ~$0.04 |
| Wave 2 Footer LLM | ~10s (p50) | 1 | ~$0.04 |
| Wave 3 layout.tsx + finalize | <1s | 0 | $0 |
| **Total** | **~30–45s** | **2** | **~$0.08** |

Aligns with the architecture doc's §7 "Phase C: ~30s, 3 LLM calls, ~$0.10" budget. Slight reduction because we cut the architecture doc's hypothetical third LLM call (layout) — that emission is fully deterministic.

---

## 13. Risks + open questions

| Risk | Impact | Mitigation |
|---|---|---|
| `block_inventory` row has `compile_status = 'succeeded'` but the .tsx file is missing in Storage (race or upload failure not caught in Phase B) | `next build` fails in Phase D | During the component-download step, treat a Storage 404 as a compile failure → substitute passthrough fallback at the dispatcher emission. Log the discrepancy. |
| Shell LLM emits TSX referencing components/imports that don't exist (`<Logo />` from nowhere, etc.) | Compile failure at standalone check → fallback | Already covered by the post-processing compile-check + retry + deterministic fallback. The only residual risk is the fallback Header being visually ugly — that surfaces in Phase F review, which is the right place to surface it. |
| Theme stylesheet bundle injection conflicts with Tailwind reset | Visual drift on generated pages vs source | Wrap the theme.css import under a `.jab-theme` class scope. `<main className="jab-theme">` in page routes opts in; chrome/utility components stay un-affected. |
| `page_inventory.route_path` collisions (two records with same path across post_types) | Route-map has duplicate key → silent overwrite | At emission time, detect duplicates and fail the step with an explicit error. Adding a `(slug, post_type)` composite route map (catch-all reads post_type from query param when needed) is a v1.1 fix. |
| ACF field-path discovery for `acf_flex` paradigm pages | `composeBlockTree` doesn't know which field on the record holds the flex items | Phase C emits a `lib/acf-flex-fields.ts` constant: `{ <post_type>: [<field_path>, ...] }` derived from `block_inventory.block_name` strings (`acf_flex/<cpt>/<field>/<layout>` → extract `<field>`). The runtime helper uses this. |
| Phase B never ran (build was started but `generateComponents` failed mid-batch) — partial `block_inventory` | Dispatcher imports point to non-existent files | Compose-site worker's load-inventory step throws if any row has `compile_status = null` (means Phase B never reached that row). Phase F surfaces the failed build with a "Phase B incomplete; retry?" CTA. |
| Inngest step output size limit on the parallel-batch downloads | Step.run output > 4 MB | Component .tsx files are <8 KB each (capped in Phase B), so a 30-component batch is ~250 KB — well under. But the batch step shouldn't return the file contents in its output; it should return only the path list + success/failure status. |
| No static front-page on the WP install (`show_on_front = 'posts'`) | Phase C v1 hard-fails the compose-site worker per §6 C₁ | Surface a clear actionable error on the build's failed-row UI: "Set a static front page in WP admin → Settings → Reading, then rebuild." Latest-posts-feed homepage is a v1.1 deliverable tied to the CPT-list emit. |

**Open questions for the implementation plan to resolve:**

1. **`site_builds.config` column** — does the schema change land as a Stage 2-tail migration or as a Phase C migration? Recommend: Phase C migration (`0020_site_builds_config.sql`) because Stage 2 doesn't need it.
2. **`shell_generations` table** — should it land in this Phase or be deferred to Phase F when the review surface actually needs the per-shell cost data? Recommend: land it in Phase C so the worker writes it from day one; Phase F just reads it. New migration `0021_shell_generations.sql`.
3. **Storage path scoping for `text/plain` uploads beyond `.tsx`** — the bucket allowlist is `["image/png", "image/jpeg", "text/plain"]`. `.json`, `.ts`, `.mjs`, `.css`, `.md` files all upload with `contentType: "text/plain"` and that's safe. Confirmed; no MIME extension needed.
4. **Tailwind emit dependency** — Stage 2's `lib/jab/tailwind-config-emit.ts` is a not-yet-shipped deliverable. Phase C's plan should explicitly check whether it exists at implementation start and either:
   - (a) wait for it, or
   - (b) implement a minimal version inside Phase C and refactor when Stage 2 lands its full version.
   Recommend (a) — Stage 2 finishes within days, Phase C planning can absorb the wait.

---

## 14. Testing strategy

Three layers, mirroring Phase A and Phase B's approach.

### Unit tests (pure functions, vitest)

`apps/web/lib/jab/compose-site-emit.test.ts`:
- Dispatcher emission: given a `block_inventory` array, the output `_dispatcher.tsx` source parses, contains exactly N case branches, and PascalCases acf_flex names correctly.
- Route map emission: given a `page_inventory` array, the output `route-map.ts` has the right keys + post_type assignments + paradigm arrays.
- Sitemap emission: given page_inventory routes, the output URLs are absolute against `projects.wp_url`.
- robots.ts emission: WP-specific disallow rules present.
- Tailwind config wiring (delegated to Stage 2's test if its emitter exists; Phase C's test just asserts Phase C calls it).

`apps/web/lib/compose-block-tree.test.ts` (template logic — runs the *emitted* file's contents in vitest):
- Gutenberg paradigm: returns record.blocks unchanged.
- ACF flex paradigm: synthesizes one node per flex item with correctly-formed block_name.
- ACF template paradigm: synthesizes the wrapper node with full record as attrs.
- Classic paradigm: synthesizes the null-block-name node with innerHTML.
- Combined paradigms (Two Roads homepage shape): order is preserved per §8.

`apps/web/lib/ai/generate-shell.test.ts`:
- Mock ModelClient returns canned TSX → output passes compile-check → file written to Storage path.
- Mock ModelClient returns invalid TSX → fallback template substituted.
- Mock ModelClient returns over-cap TSX → fallback template substituted.

### Integration smoke (the runner script, mirrors `scripts/smoke-generate-components.ts`)

New: `apps/web/scripts/smoke-compose-site.ts`.

Usage:
```bash
pnpm smoke:compose <project_id> <tenant_id> <build_id>
```

(Builds on the existing Phase A + B smokes. The build_id is from a completed Phase B run; the smoke is a re-runnable post-Phase-B check.)

Asserts:
- Wall-clock ≤ 60s (10s slack over the 45s target).
- Storage contains all files listed in §3 — emits a delta against the expected file list.
- `package.json` + `tsconfig.json` parse as valid JSON.
- `_dispatcher.tsx` parses with `@babel/parser` (no full TS check — Stage 4's `next build` is the real validator).
- Header.tsx + Footer.tsx exist and parse.
- `shell_generations` table has exactly 2 rows for this build.
- `site_builds.status = 'built'` after the worker exits.
- `site/deploy.requested` event was dispatched.

### Live-stack smoke (deferred to Stage 4)

The full "does this thing actually `next build` and deploy" question belongs to Stage 4. Phase C's deliverable is "Storage tree exists + worker exits cleanly." Stage 4 ingests that tree and exercises it.

---

## 15. Out of scope for Phase C v1

- **CPT list/single routes** (`app/{cpt}/...`) — emit-or-skip exists, but flag defaults false. v1.1.
- **Per-page custom metadata** (per-route Metadata exports beyond `title` from page_inventory.title) — v1.1.
- **Image domain whitelisting in next.config.ts** — currently the v1 scaffold has no `images.domains` configured. v1.1 will add a Phase C step that derives image domains from `themeStylesheets` + `attr_samples` URL patterns. v1 ships without remote image optimization (uses default `<img>` tags inside generated components).
- **Internationalization** — `lang="en"` hardcoded in layout.tsx. v1.1 reads `wp_options.WPLANG`.
- **Per-component override files** — agency-uploaded replacements for a generated component. v1.2 / post-publish workflow.
- **Layout customization** (custom layout.tsx per route) — Next.js supports per-route `layout.tsx`; v1 uses only the root layout.
- **Edge runtime opt-in** — all routes are Node runtime. Edge is a Phase D / hosting concern.
- **OG image generation** — `app/opengraph-image.tsx` not emitted in v1. v1.2.
- **404 / 500 pages with brand styling** — v1 emits a static brand-neutral `not-found.tsx`. v1.1 styles it.

---

## 16. Handoff to writing-plans

This spec is complete enough to seed a TDD-grained implementation plan. The plan should produce:

- `docs/superpowers/plans/2026-05-27-saas-v2-phase-c-compose-shell.md`
- Followed by execution via `superpowers:subagent-driven-development` per the roadmap's recommendation.

Plan structure suggestion (writing-plans skill will refine):

1. **Setup tasks** (1–2 tasks): migrations `0020_site_builds_config.sql` + `0021_shell_generations.sql`; schema.ts mirror updates.
2. **Static template + helper tasks** (~6 tasks): emit-helpers in `lib/jab/compose-site-emit.ts`, the `lib/compose-block-tree.ts` template, the `lib/acf-flex-fields.ts` template emitter, the deterministic emissions (robots, sitemap, layout, not-found, package.json/tsconfig etc.).
3. **Dispatcher emission + tests** (1–2 tasks).
4. **Route-map + catch-all emission + tests** (1–2 tasks).
5. **Component-download pass + Storage-aware fallback** (1 task).
6. **Shell LLM module + tests** (2 tasks — one for Header, one for Footer).
7. **Worker assembly** (1 task): `lib/inngest/functions/compose-site.ts` ties it all together with the three-wave step.run sequencing.
8. **Smoke script** (1 task).
9. **End-to-end against the Two Roads pilot build** (1 task — runs the smoke; surfaces gaps for fast-follow).

Approximate task count: 14–16 TDD tasks. Comparable to Stage 1's discovery plan in scope.

---

## 17. Glossary (Phase C-specific additions to the architecture doc's §11)

- **Compose worker** — `apps/web/lib/inngest/functions/compose-site.ts`. The Phase C entrypoint.
- **Dispatcher** — `components/blocks/_dispatcher.tsx`. The runtime block-name → component switch.
- **Passthrough** — `components/blocks/_passthrough.tsx`. The DOMPurify-sanitized HTML fallback for unknown / failed / classic-editor blocks.
- **Route map** — `app/[...slug]/route-map.ts`. Build-time constant mapping path → `{ postType, paradigms }` for the catch-all route.
- **Compose-block-tree** — `lib/compose-block-tree.ts`. The paradigm-aware runtime helper that turns a fetched WP record into a flat BlockNode[] array.
- **ACF flex fields constant** — `lib/acf-flex-fields.ts`. Build-time constant mapping `post_type` → list of ACF field paths that contain flex layouts; consumed by compose-block-tree.
- **Shell** — `components/site/Header.tsx` + `Footer.tsx`. The two LLM-generated chrome components.
- **`shell_generations` table** — per-shell cost telemetry, mirror of `block_inventory`'s cost columns.
