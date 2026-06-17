# Draft ↔ Deployed Parity (CSS preflight, image shim, origin rewrite) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last three confirmed divergences between the Live Draft preview pipeline and the deployed build pipeline, so a draft renders what actually publishes — box-sizing/preflight base resets, image-constraint, and source-origin link stripping all match the deployed site instead of silently differing.

**Architecture:** The draft pipeline and the deploy pipeline are two separate code paths that must produce the same pixels. The deploy path emits `@tailwind base;` ([compose-site-emit.ts:422](../../../apps/web/lib/jab/compose-site-emit.ts#L422)) → full Tailwind preflight (global box-sizing, `img` max-width, heading/button resets), constrains images with an inline `style` in the emitted MediaImage shim, and runs `rewriteWpOriginUrls` over every generated component during Phase B ([component-generator.ts:767-769](../../../apps/web/lib/ai/component-generator.ts#L767-L769)). The draft path does none of these three: `buildDraftCss` disables preflight and only re-adds list/anchor resets ([css.ts:35,52-56](../../../apps/web/lib/draft/css.ts#L35)); the draft `MediaImage` shim leans on un-scanned Tailwind classes ([media-image.tsx:29,34](../../../apps/web/lib/draft/runtime/media-image.tsx#L29)) that the draft JIT never emits; and `patchUnitSource` ([patch-component.ts:52-84](../../../apps/web/lib/ai/patch-component.ts#L52-L84)) — the Live Draft edit primitive — runs postprocess + validate + size cap but never `rewriteWpOriginUrls`. Each fix is mechanical and independent: (1) inline a literal preflight base in `buildDraftCss`, GLOBAL (not `.jab-theme`-scoped) to match deployed, placed before the captured theme CSS so theme + scoped resets still win on cascade order, mirroring `@tailwind base` sitting beneath utilities/theme; (2) constrain the draft `<img>` with an inline `style` independent of Tailwind; (3) thread `sourceHosts` into `patchUnitSource` and apply `rewriteWpOriginUrls` in the attempt loop, sourced from the project's `wp_url` via the same `hostVariants` helper Phase B uses.

**Tech Stack:** TypeScript, Next.js 15 App Router, Tailwind 3 JIT via PostCSS (`buildDraftCss`), React (`renderToStaticMarkup` for the shim test), Supabase JS (admin client) in the Inngest worker, Vitest. Server-only modules except the React runtime shim.

## Global Constraints

- **Fleet-agnostic.** Every change must work across arbitrary WordPress sites/themes — no hardcoded slugs, hosts, colors, or per-site assumptions. The preflight base, the image inline style, and the origin rewrite are all site-independent mechanics. Two Roads is a test target, not the spec.
- **No DB migration.** This plan touches zero schema. Task 3 reads the already-present `projects.wp_url` column (the same column Phase B reads at [generate-components.ts:155](../../../apps/web/lib/inngest/functions/generate-components.ts#L155)).
- **The preflight base is GLOBAL.** Deployed preflight (Tailwind `@tailwind base`) is global — it applies `box-sizing:border-box` to `*,::before,::after`, not under any scope. The draft replacement must match: a `.jab-theme`-scoped box-sizing would not reach shell/dispatcher markup outside `<main className="jab-theme">`. Place it BEFORE the captured theme CSS and the scoped resets so theme rules and the existing `.jab-theme` list/anchor resets still win on cascade order — exactly the position `@tailwind base` occupies beneath utilities/theme in the emitted `globals.css`.
- **The draft remains an ~8–15s approximation.** Publish-time verify is the authoritative fidelity gate (spec). These three fixes are not perfection-chasing; they are mechanical correctness gaps where the draft is *provably* wrong vs. what publishes, found by adversarial review `wo17mzyzw` (35/57, 2026-06-16).
- **Errors are loud; no swallowed failures** (CLAUDE.md). Task 3's `sourceHosts` derivation is the one deliberate fail-soft (invalid/missing `wp_url` → `[]` → no rewrite), matching Phase B's existing fail-soft at [generate-components.ts:176-183](../../../apps/web/lib/inngest/functions/generate-components.ts#L176-L183).
- Tests run with `pnpm --filter @jab/web test`; typecheck with `pnpm --filter @jab/web exec tsc --noEmit`. Run from repo root `c:\Projects\wp-headless`.

---

## Background — the three confirmed divergences

Confirmed against code by adversarial review `wo17mzyzw` (2026-06-16). This session already closed bundle MIME/CORS, middleware, Google Fonts, the logo proxy, the `.jab-theme` wrapper, the list/anchor base resets, and brand typography. These three remain:

1. **box-sizing / preflight base missing in draft.** `buildDraftCss` sets `corePlugins: { preflight: false }` ([css.ts:35](../../../apps/web/lib/draft/css.ts#L35)) — necessary, because Tailwind's preflight plugin reads `./css/preflight.css` via `__dirname`, which Next bundling can't resolve at runtime (ENOENT). But the draft then re-adds *only* list + anchor resets ([css.ts:52-56](../../../apps/web/lib/draft/css.ts#L52-L56)). There is **no** `box-sizing:border-box`, no `img/svg/video` max-width, no heading/button reset, no `body{margin:0}` anywhere in the draft CSS. The deployed site ships `@tailwind base;` ([compose-site-emit.ts:422](../../../apps/web/lib/jab/compose-site-emit.ts#L422)) → the full preflight. Every generated component is authored against Tailwind utilities (`w-*`/`p-*`/`border`/`max-w-*`) that *assume* border-box, so content that fits in the draft overflows in production. The deployed `important: "#jab-app"` strategy "scopes utilities only, leaving preflight/base global" ([compose-site-emit.ts:809-815](../../../apps/web/lib/jab/compose-site-emit.ts#L809-L815)) — so the draft must re-inject a GLOBAL preflight base, not a scoped one.

2. **draft image shim relies on un-scanned Tailwind classes.** The draft `MediaImage` shim renders `<img className="h-auto max-w-full">` with no width/height and no inline constraint ([media-image.tsx:29,34](../../../apps/web/lib/draft/runtime/media-image.tsx#L29)). But `buildDraftCss` only scans component sources + shell ([artifacts.ts:85,152](../../../apps/web/lib/draft/artifacts.ts#L85)) — the runtime shims under `lib/draft/runtime/` are resolved by the bundler ([bundle.ts:56](../../../apps/web/lib/draft/bundle.ts#L56)) but are **never fed to the CSS scanner**. `h-auto`/`max-w-full` appear in no scanned source, so the JIT emits nothing for them and the draft `core/image` renders unconstrained — overflowing its container. The deployed `MediaImage` constrains via inline `style={{maxWidth:"100%",height:"auto"}}`, independent of Tailwind. `core/image` is a WordPress core block on essentially every WP site, so this is fleet-wide.

3. **patch/draft-edit path skips `rewriteWpOriginUrls`.** `patchUnitSource` ([patch-component.ts:52-84](../../../apps/web/lib/ai/patch-component.ts#L52-L84)) — the Live Draft edit primitive — runs only `postprocessGeneratedTsx` → `validateTsx` → size cap. It never calls `rewriteWpOriginUrls`, unlike the full-build generator, which applies it whenever `sourceHosts` is present ([component-generator.ts:767-769](../../../apps/web/lib/ai/component-generator.ts#L767-L769)). So when a chat edit's guidance ("link to our events page") makes the LLM emit an absolute source-WP URL, that URL survives in the draft as a real off-clone navigation. The draft runtime's link interception only rewrites *root-relative* hrefs, so an absolute source-origin href escapes the clone entirely. The deployed Phase B build would have stripped it. The fix mirrors the generator exactly: thread `sourceHosts` (derived from `projects.wp_url` via `hostVariants`) into the patch options and apply the rewrite in the attempt loop.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| [apps/web/lib/draft/css.ts](../../../apps/web/lib/draft/css.ts) | Build the draft's Tailwind-JIT CSS | Add a literal GLOBAL `preflightBase` string; prepend it before `result.css` so it sits beneath utilities/theme/scoped-resets on cascade order |
| [apps/web/lib/draft/css.test.ts](../../../apps/web/lib/draft/css.test.ts) | Unit tests for `buildDraftCss` | Assert output contains `box-sizing:border-box` and that it precedes the captured-theme marker |
| [apps/web/lib/draft/runtime/media-image.tsx](../../../apps/web/lib/draft/runtime/media-image.tsx) | Draft-runtime `core/image` shim | Replace `className="h-auto max-w-full"` on both `<img>` returns with `style={{ maxWidth: "100%", height: "auto" }}` |
| apps/web/lib/draft/runtime/media-image.test.tsx | Regression test for the shim (create) | `renderToStaticMarkup` asserts inline `max-width`/`height` and no Tailwind-dependent class |
| [apps/web/lib/ai/patch-component.ts](../../../apps/web/lib/ai/patch-component.ts) | Live Draft edit primitive | Add `sourceHosts?: string[]` to `PatchUnitOptions`; apply `rewriteWpOriginUrls` in the attempt loop; belt-and-suspenders prompt line |
| [apps/web/lib/ai/patch-component.test.ts](../../../apps/web/lib/ai/patch-component.test.ts) | Unit tests for `patchUnitSource` (create if absent) | Rewrite asserted; byte-identical when no source-origin URL; prompt line |
| [apps/web/lib/inngest/functions/draft-edit.ts](../../../apps/web/lib/inngest/functions/draft-edit.ts) | Live Draft edit worker | Load `projects.wp_url`, derive `sourceHosts` via `hostVariants`, thread into `patchUnitSource` |

---

### Task 1: Inline a GLOBAL preflight base in `buildDraftCss`

**Files:**
- Modify: `apps/web/lib/draft/css.ts`
- Test: `apps/web/lib/draft/css.test.ts`

**Interfaces:**
- `buildDraftCss(input: BuildDraftCssInput): Promise<string>` keeps its signature. A new module-scope constant `PREFLIGHT_BASE: string` (the inlined static preflight) is prepended to the returned CSS, before `result.css`.

**Why prepend before `result.css` (not just before `themePart`):** The deployed `globals.css` is `@import theme.css; @tailwind base; @tailwind components; @tailwind utilities; <brand typography>` ([compose-site-emit.ts:421-425](../../../apps/web/lib/jab/compose-site-emit.ts#L421-L425)). `@tailwind base` (preflight) sits BENEATH utilities, the captured theme, and the brand-typography layer on source order — every one of those is meant to override the base resets. The draft must reproduce that exact precedence: the preflight base is the lowest-priority layer, so it goes FIRST in the returned string (`result.css` = utilities/components, then `themePart`, then `baseResets`, then `brandPart`). The single exception is `box-sizing` — it is a non-inherited, low-specificity universal rule that nothing else in the cascade re-declares, so source order is irrelevant for it; placing the whole base block first keeps it global and harmless to the rest.

- [ ] **Step 1: Write the failing test** (append to the `buildDraftCss` describe block in `css.test.ts`)

```ts
  // The deployed site ships `@tailwind base;` → full Tailwind preflight, which
  // gives every element `box-sizing: border-box`, `body{margin:0}`, and
  // constrained media. The draft disables preflight (it reads ./css/preflight.css
  // via __dirname, unresolvable under Next bundling), so generated components —
  // all authored against border-box-assuming utilities (w-*/p-*/border/max-w-*) —
  // overflow in the draft but not in production. buildDraftCss must re-inject a
  // GLOBAL (not .jab-theme-scoped) static preflight base, placed BEFORE the
  // captured theme CSS so theme + scoped resets still win on source order —
  // mirroring @tailwind base sitting beneath utilities/theme on the deployed site.
  it("injects a GLOBAL preflight base with box-sizing:border-box", async () => {
    const css = await buildDraftCss({
      sources: [`<div className="p-2"/>`],
      tokens: null,
      themeCss: null,
    });
    expect(css).toMatch(/\*\s*,\s*::before\s*,\s*::after\s*\{[^}]*box-sizing:\s*border-box/);
    // GLOBAL, not scoped — must NOT be qualified by .jab-theme.
    expect(css).not.toMatch(/\.jab-theme[^{]*\{[^}]*box-sizing:\s*border-box/);
  }, 30_000);

  it("orders the preflight base BEFORE the captured theme css", async () => {
    const css = await buildDraftCss({
      sources: [`<div className="p-2"/>`],
      tokens: null,
      themeCss: ".jab-theme .legacy { color: red; }",
    });
    const preflightIdx = css.search(/box-sizing:\s*border-box/);
    const themeIdx = css.indexOf(".jab-theme .legacy");
    expect(preflightIdx).toBeGreaterThanOrEqual(0);
    expect(themeIdx).toBeGreaterThan(preflightIdx);
  }, 30_000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jab/web test -- css`
Expected: FAIL — no `box-sizing:border-box` anywhere in the draft output; both new assertions fail.

- [ ] **Step 3: Implement the inlined preflight base** (`css.ts`)

Add the constant at module scope (after the imports, before `BuildDraftCssInput`):

```ts
/**
 * Static, inlined subset of Tailwind's preflight. The draft disables Tailwind's
 * own preflight plugin (it reads ./css/preflight.css via __dirname, which Next
 * production bundling rewrites to the route-chunk dir → ENOENT at runtime — see
 * the corePlugins note in buildDraftCss). The deployed site ships the FULL
 * preflight via `@tailwind base;` (compose-site-emit.ts emitGlobalsCss), so
 * every generated component is authored against border-box + reset media/heading
 * defaults. We re-inject the load-bearing subset here.
 *
 * GLOBAL, not `.jab-theme`-scoped: deployed preflight is global (the
 * `important: "#jab-app"` strategy "scopes utilities only, leaving preflight/base
 * global" — compose-site-emit.ts:809-815). A scoped box-sizing would not reach
 * shell/dispatcher markup rendered outside <main className="jab-theme">.
 *
 * Emitted FIRST in buildDraftCss's return (beneath utilities, the captured theme,
 * the scoped list/anchor resets, and brand typography) so every later layer wins
 * on source order — exactly the precedence `@tailwind base` has on the deployed
 * site. box-sizing is the priority line; the rest mirrors preflight's media,
 * heading, and form-control normalisation so utility-styled components lay out
 * identically to production.
 */
const PREFLIGHT_BASE = `/* --- preflight base (global, mirrors @tailwind base) --- */
*, ::before, ::after { box-sizing: border-box; }
body { margin: 0; }
img, svg, video, canvas, audio, iframe, embed, object { display: block; max-width: 100%; }
img, video { height: auto; }
h1, h2, h3, h4, h5, h6 { font-size: inherit; font-weight: inherit; }
button, input, optgroup, select, textarea { font: inherit; color: inherit; }
button, [type=button], [type=submit] { background-color: transparent; background-image: none; }
`;
```

Then prepend it in the return statement. Change the last line of `buildDraftCss`:

```ts
  // PREFLIGHT_BASE first → it sits beneath utilities (result.css), the captured
  // theme (themePart), the scoped list/anchor resets (baseResets), and brand
  // typography (brandPart) on source order — the same precedence @tailwind base
  // has on the deployed site, where every later layer is meant to override it.
  return `${PREFLIGHT_BASE}\n${result.css}${themePart}${baseResets}${brandPart}`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web test -- css`
Expected: PASS — both new assertions plus the pre-existing brand-typography, JIT-utility, theme-order, and base-reset tests stay green (the captured-theme-after-utilities test still holds because `result.css` precedes `themePart`, and `themePart` precedes nothing that moved).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/draft/css.ts apps/web/lib/draft/css.test.ts
git commit -m "fix(draft): inject global preflight base (box-sizing) to match deployed @tailwind base"
```

---

### Task 2: Constrain the draft image shim with an inline style

**Files:**
- Modify: `apps/web/lib/draft/runtime/media-image.tsx`
- Test: `apps/web/lib/draft/runtime/media-image.test.tsx` (create)

**Interfaces:**
- `MediaImage({ block })` keeps its signature and contract. Both `<img>` returns drop `className="h-auto max-w-full"` and gain `style={{ maxWidth: "100%", height: "auto" }}` — an inline constraint that does not depend on any JIT-emitted Tailwind class.

- [ ] **Step 1: Write the failing test** (`apps/web/lib/draft/runtime/media-image.test.tsx`)

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaImage } from "./media-image";

describe("draft MediaImage shim (deployed-parity image constraint)", () => {
  // buildDraftCss only scans component + shell sources (artifacts.ts:85,152),
  // NOT the runtime shims (bundle.ts resolves them, but the CSS JIT never sees
  // their TSX). So `h-auto`/`max-w-full` on the shim's <img> were never emitted —
  // the draft core/image rendered unconstrained. Constrain inline instead, like
  // the deployed MediaImage (style={{maxWidth:"100%",height:"auto"}}).
  it("constrains the structured-attrs <img> with an inline style, not a Tailwind class", () => {
    const html = renderToStaticMarkup(
      <MediaImage block={{ blockName: "core/image", attrs: { url: "https://wp.example/x.jpg", alt: "x" } }} />,
    );
    expect(html).toMatch(/max-width:\s*100%/);
    expect(html).toMatch(/height:\s*auto/);
    expect(html).not.toContain("max-w-full");
    expect(html).not.toContain("h-auto");
  });

  it("constrains the innerHTML-parsed <img> with the same inline style", () => {
    const html = renderToStaticMarkup(
      <MediaImage
        block={{ blockName: "core/image", attrs: {}, innerHTML: `<figure><img src="https://wp.example/y.png" alt="y"></figure>` }}
      />,
    );
    expect(html).toMatch(/max-width:\s*100%/);
    expect(html).toMatch(/height:\s*auto/);
    expect(html).not.toContain("max-w-full");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jab/web test -- media-image`
Expected: FAIL — the rendered markup carries `class="h-auto max-w-full"` and no inline `max-width`/`height`.

- [ ] **Step 3: Implement the inline constraint** (`media-image.tsx`)

Replace the structured-attrs return:

```tsx
  if (url) {
    return <img src={url} alt={alt} style={{ maxWidth: "100%", height: "auto" }} />;
  }
```

Replace the innerHTML-parsed return:

```tsx
  if (parsed) {
    return <img src={parsed.src} alt={parsed.alt} style={{ maxWidth: "100%", height: "auto" }} />;
  }
```

Update the file's leading doc comment to note the constraint is now inline (so it does not depend on the un-scanned draft JIT):

```tsx
/**
 * Draft-runtime MediaImage: same dispatcher contract as the emitted
 * components/blocks/_platform/MediaImage.tsx (props { block }), but always
 * renders a plain <img> — no next/image host validation needed in a draft.
 * Resolution order mirrors the emitted shim: structured attrs first, then
 * the first <img> found in innerHTML.
 *
 * Image constraint is INLINE (style maxWidth/height), like the deployed shim —
 * NOT a Tailwind class. buildDraftCss scans only component + shell sources
 * (artifacts.ts:85,152), never the runtime shims, so `h-auto`/`max-w-full`
 * here would JIT to nothing and the draft image would render unconstrained.
 */
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web test -- media-image`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/draft/runtime/media-image.tsx apps/web/lib/draft/runtime/media-image.test.tsx
git commit -m "fix(draft): constrain image shim inline (max-width/height), not via un-scanned Tailwind classes"
```

---

### Task 3: Apply `rewriteWpOriginUrls` in the patch/draft-edit path

**Files:**
- Modify: `apps/web/lib/ai/patch-component.ts`, `apps/web/lib/inngest/functions/draft-edit.ts`
- Test: `apps/web/lib/ai/patch-component.test.ts` (create if absent)

**Interfaces:**
- `PatchUnitOptions` gains `sourceHosts?: string[]` (optional; absent → no rewrite, the safe default for tests and any caller without a known origin).
- Inside `patchUnitSource`'s attempt loop, after `postprocessGeneratedTsx` and before the size cap, apply `if (opts.sourceHosts && opts.sourceHosts.length > 0) candidate = rewriteWpOriginUrls(candidate, { sourceHosts: opts.sourceHosts });` — mirrors [component-generator.ts:767-769](../../../apps/web/lib/ai/component-generator.ts#L767-L769).
- `buildPatchPrompt` gains one belt-and-suspenders line declaring source-host links internal (secondary to the deterministic rewrite).
- `draftEdit` loads `projects.wp_url` and derives `sourceHosts` via `hostVariants` (the SAME helper Phase B uses, imported from `@/lib/jab/rewrite-origin-links`), threading it into `patchUnitSource`.

- [ ] **Step 1: Write the failing tests** (`apps/web/lib/ai/patch-component.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { patchUnitSource, buildPatchPrompt } from "./patch-component";
import type { ModelClient } from "./model-client";

const USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** Single-shot stub: returns `text` once, with zero usage. */
function stubClient(text: string): ModelClient {
  return {
    async generate() {
      return { text, usage: USAGE };
    },
  } as unknown as ModelClient;
}

describe("patchUnitSource sourceHosts rewrite (draft ↔ deployed origin parity)", () => {
  it("rewrites an absolute source-origin href to a root-relative path", async () => {
    const tsx = `export function Foo() {\n  return <a href="https://wp.example/events">Events</a>;\n}\n`;
    const res = await patchUnitSource({
      currentTsx: "export function Foo() { return null; }",
      guidance: "link to our events page",
      exportName: "Foo",
      maxBytes: 10_000,
      client: stubClient(tsx),
      sourceHosts: ["wp.example", "www.wp.example"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tsx).toContain(`href="/events"`);
      expect(res.tsx).not.toContain("wp.example");
    }
  });

  it("is byte-identical when the edit introduces no source-origin URL", async () => {
    const tsx = `export function Foo() {\n  return <a href="/about">About</a>;\n}\n`;
    const res = await patchUnitSource({
      currentTsx: "export function Foo() { return null; }",
      guidance: "link to about",
      exportName: "Foo",
      maxBytes: 10_000,
      client: stubClient(tsx),
      sourceHosts: ["wp.example", "www.wp.example"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tsx).toContain(`href="/about"`);
  });

  it("leaves source-origin URLs alone when sourceHosts is absent (safe default)", async () => {
    const tsx = `export function Foo() {\n  return <a href="https://wp.example/events">Events</a>;\n}\n`;
    const res = await patchUnitSource({
      currentTsx: "export function Foo() { return null; }",
      guidance: "link to events",
      exportName: "Foo",
      maxBytes: 10_000,
      client: stubClient(tsx),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tsx).toContain("https://wp.example/events");
  });

  it("prompt declares source-host links internal (belt-and-suspenders, secondary)", () => {
    const { system } = buildPatchPrompt({
      currentTsx: "x",
      guidance: "y",
      exportName: "Foo",
      sourceHosts: ["wp.example"],
    });
    expect(system).toMatch(/wp\.example/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @jab/web test -- patch-component`
Expected: FAIL — `PatchUnitOptions`/`PatchPromptInput` reject `sourceHosts`; the rewrite assertion fails (the absolute URL survives); `buildPatchPrompt` ignores `sourceHosts`.

- [ ] **Step 3: Implement the patch-component change** (`patch-component.ts`)

Add the import at the top (after the existing imports):

```ts
import { rewriteWpOriginUrls } from "@/lib/jab/rewrite-origin-links";
```

Add `sourceHosts` to `PatchPromptInput` and emit the belt-and-suspenders line in `buildPatchPrompt`. Replace the `PatchPromptInput` interface and `buildPatchPrompt`:

```ts
export interface PatchPromptInput {
  currentTsx: string;
  guidance: string;
  exportName: string;
  /**
   * Source-WP host(s). When set, a belt-and-suspenders prompt line tells the
   * model these hosts are the SAME site (use root-relative paths). Secondary to
   * the deterministic rewriteWpOriginUrls pass applied in patchUnitSource — the
   * rewrite is the guarantee; the prompt line is a cheap nudge.
   */
  sourceHosts?: string[];
}

export function buildPatchPrompt(input: PatchPromptInput): { system: string; user: string } {
  const internalHostsLine =
    input.sourceHosts && input.sourceHosts.length > 0
      ? `\n- The hosts ${input.sourceHosts.join(", ")} are THIS site. Any link to them must be a root-relative path (e.g. "/events"), never an absolute URL.`
      : "";
  const system = `You are editing an existing React/Next.js component from a generated WordPress-clone site.

## Output contract
- Return ONLY the complete modified TypeScript/TSX source. No markdown fences. No prose.
- Keep the named export \`${input.exportName}\` and its exact props signature unchanged.
- Keep all imports as they are unless the edit requires removing one.
- Use Tailwind CSS classes for styling changes. No inline style objects unless a value is dynamic.
- Make the MINIMAL change that satisfies the instruction — do not refactor,
  reformat, rename, or "improve" anything the instruction doesn't ask for.
- Preserve all existing behavior outside the requested change.${internalHostsLine}`;
  const user = `## Current source
${input.currentTsx.trim()}

## Edit instruction
${input.guidance.trim()}`;
  return { system, user };
}
```

Add `sourceHosts` to `PatchUnitOptions`:

```ts
export interface PatchUnitOptions {
  currentTsx: string;
  guidance: string;
  exportName: string;
  /** MAX_COMPONENT_BYTES (10_000) for components, MAX_SHELL_BYTES (24_000) for shell. */
  maxBytes: number;
  client: ModelClient;
  /**
   * Source-WP host variants (bare + www). When set, an LLM-introduced absolute
   * source-origin URL is rewritten to a root-relative path — mirrors the Phase B
   * generator (component-generator.ts:767-769). Absent → no rewrite (safe
   * default; entry.tsx only intercepts root-relative hrefs, so an absolute
   * source URL would otherwise navigate off the clone).
   */
  sourceHosts?: string[];
}
```

Thread `sourceHosts` into the prompt and apply the rewrite in the attempt loop. Replace the body of `patchUnitSource` from `const prompt = ...` through the size-cap block:

```ts
export async function patchUnitSource(opts: PatchUnitOptions): Promise<PatchResult> {
  const prompt = buildPatchPrompt({
    currentTsx: opts.currentTsx,
    guidance: opts.guidance,
    exportName: opts.exportName,
    sourceHosts: opts.sourceHosts,
  });
  const usage: GenerateUsage[] = [];
  let lastError = "no attempts ran";

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await opts.client.generate({
      systemPrompt: prompt.system,
      userPrompt: prompt.user,
      cacheSystemPrompt: attempt === 0,
    });
    usage.push(result.usage);

    let candidate: string;
    try {
      candidate = postprocessGeneratedTsx(result.text, { expectedExportName: opts.exportName });
    } catch (err) {
      lastError = `postprocess: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    // Deterministic origin-strip — mirrors component-generator.ts:767-769. Runs
    // AFTER postprocess (canonical TSX) and BEFORE the size cap (rewriting only
    // ever shortens). entry.tsx intercepts only root-relative hrefs, so an
    // LLM-introduced absolute source URL would escape the clone without this.
    if (opts.sourceHosts && opts.sourceHosts.length > 0) {
      candidate = rewriteWpOriginUrls(candidate, { sourceHosts: opts.sourceHosts });
    }
    if (Buffer.byteLength(candidate, "utf-8") > opts.maxBytes) {
      lastError = `output exceeds ${opts.maxBytes} bytes`;
      continue;
    }
    const errors = validateTsx(candidate, `${opts.exportName}.tsx`);
    if (errors.length > 0) {
      lastError = `parse errors: ${errors.slice(0, 3).join("; ")}`;
      continue;
    }
    return { ok: true, tsx: candidate, attempts: attempt + 1, usage };
  }
  return { ok: false, error: lastError, attempts: 2, usage };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @jab/web test -- patch-component`
Expected: PASS (all four cases).

- [ ] **Step 5: Write the failing draft-edit threading test** — N/A (worker IO)

The `draftEdit` worker is exercised by the existing worker smoke (Inngest `step.run` boundaries are not unit-testable here). The threading is verified by the typecheck in Step 7 and by the `patch-component` unit tests above proving the option works. Skip a dedicated worker test — do NOT fabricate one.

- [ ] **Step 6: Thread `sourceHosts` through the worker** (`draft-edit.ts`)

Add the import (after the existing imports):

```ts
import { hostVariants } from "@/lib/jab/rewrite-origin-links";
```

Add a step that loads the project's `wp_url` and derives `sourceHosts`, placed AFTER the `current` source load (step 3) and BEFORE the patch step (step 4). Insert this block immediately before the `// 4. Patch LLM.` comment:

```ts
    // 3b. Derive source-WP host variants for origin-rewriting the patched TSX.
    // Same helper + same fail-soft as Phase B (generate-components.ts:176-183):
    // a missing/malformed wp_url yields [] → patchUnitSource skips the rewrite.
    // This is NOT a correctness gate for the edit — it only strips absolute
    // source-origin links the LLM may introduce, so it fails soft, not loud.
    const sourceHosts = await step.run("derive-source-hosts", async (): Promise<string[]> => {
      const { data } = await admin
        .from("projects")
        .select("wp_url")
        .eq("id", projectId)
        .eq("tenant_id", tenantId)
        .single<{ wp_url: string | null }>();
      if (!data?.wp_url) return [];
      try {
        return hostVariants(data.wp_url);
      } catch {
        return [];
      }
    });
```

Thread it into the `patchUnitSource` call inside the patch step. Replace the `patchUnitSource({ ... })` call:

```ts
      const result = await patchUnitSource({
        currentTsx: current.tsx,
        guidance,
        exportName: exportNameFor(scope, target),
        maxBytes: maxBytesFor(scope),
        client: modelClientForTier(scope === "shell" ? "visual" : "standard"),
        sourceHosts,
      });
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean (`sourceHosts` typed `string[]` flows into the optional `PatchUnitOptions.sourceHosts`; the new `derive-source-hosts` step's return type is explicit).

- [ ] **Step 8: Run the affected suites + full suite**

Run: `pnpm --filter @jab/web test -- "patch-component|draft-edit"` then `pnpm --filter @jab/web test`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/ai/patch-component.ts apps/web/lib/ai/patch-component.test.ts apps/web/lib/inngest/functions/draft-edit.ts
git commit -m "fix(draft): strip LLM-introduced source-origin links in the patch path (deployed parity)"
```

---

## Self-Review

**Spec coverage:**
- Divergence 1 (box-sizing/preflight base missing) → Task 1: inlined GLOBAL `PREFLIGHT_BASE`, prepended before `result.css`, asserted present + ordered before the captured-theme marker. ✓
- Divergence 2 (image shim relies on un-scanned Tailwind classes) → Task 2: both `<img>` returns use inline `style={{ maxWidth: "100%", height: "auto" }}`; `renderToStaticMarkup` asserts inline constraint + absence of `max-w-full`/`h-auto`. ✓
- Divergence 3 (patch path skips `rewriteWpOriginUrls`) → Task 3: `sourceHosts` added to `PatchUnitOptions`, rewrite applied after postprocess / before size cap (mirroring the generator), threaded from `projects.wp_url` via `hostVariants` with Phase B's fail-soft, plus the optional prompt line. ✓

**Placeholder scan:** every implementation step contains the actual code (the full `PREFLIGHT_BASE` string, both `<img>` returns, the complete rewritten `patchUnitSource`, the `derive-source-hosts` step). No `…`, no "fill in", no TODO.

**Type consistency:** `BuildDraftCssInput`/`buildDraftCss` signatures unchanged (Task 1 only changes the returned string). `MediaImage`'s props/return type unchanged (Task 2 only swaps `className` for `style`). `PatchUnitOptions.sourceHosts?: string[]` and `PatchPromptInput.sourceHosts?: string[]` are both optional, so all existing callers (and the `sourceHosts`-absent test) typecheck unchanged; the worker passes a non-optional `string[]`, which widens cleanly into the optional field. `hostVariants(string): string[]` and `rewriteWpOriginUrls(string, { sourceHosts: string[] }): string` are used with their real signatures from `@/lib/jab/rewrite-origin-links`.

**Cascade-order justification (Task 1):** the preflight base is emitted FIRST so it is the lowest-priority layer, exactly mirroring `@tailwind base` beneath utilities/theme/brand on the deployed site — the two new ordering assertions pin this, and the pre-existing theme-after-utilities / reset-after-theme tests still hold because nothing they reference moved.

## Out of scope (tracked elsewhere)

- Full Tailwind-preflight fidelity (the complete reset list) — `PREFLIGHT_BASE` carries the load-bearing subset (box-sizing, media, heading, form-control); the long-tail of preflight rules (e.g. `abbr`, `sub`/`sup`, table border-collapse) is deferred until a real draft/deploy mismatch surfaces one.
- Feeding the runtime shims under `lib/draft/runtime/` into the draft CSS scanner (so they could use Tailwind classes) — Task 2 sidesteps this with inline styles; widening the scanner's `sources` is a larger change with its own bundle/JIT implications.
- The non-cumulative shell-edit regen limitation (separate known residual; see MEMORY `shell-edit-regen-non-cumulative`).
These are real follow-ups; this plan is the mechanical-correctness floor for the three confirmed draft↔deployed divergences.
