# Phase B + C Output Quality Follow-ups — Punch List

> **Source:** Phase D first end-to-end smoke against Two Roads build `982f0d57-5275-499a-92d8-5f00dc70dba1` on 2026-05-28. Phase D's deploy worker, polling, log capture, and DB persistence all worked correctly across 5 iterations. Each iteration captured a `next build` failure to `builds/<id>/build-log.txt` that revealed a different Phase B or Phase C output-quality bug. This document is the resulting punch list.
>
> **What this fixes:** real upstream bugs surfaced by an actual `next build` against Vercel. Until these land, every Phase D smoke against a freshly-composed build will fail at compile time.
>
> **What this does NOT fix:** the Phase D worker itself. Phase D is mechanically validated — the only Phase D code change discovered was the events parser shape fix (`85e2dd4`), already committed.

---

## Why parse-only validation is insufficient

Phase B's `validateTsx` calls `ts.createSourceFile(..., ScriptKind.TSX)` and reads `parseDiagnostics`. That catches **syntax errors only** — invalid JSX, mismatched braces, "expected `,` or `;`", etc. It does NOT catch:

- Module-resolution errors (imports pointing at paths that don't export the named symbol)
- Type errors (`unknown` not assignable to `BlockTreeRecord`, unsafe `as` casts without `unknown` bridge)
- "use client" / "use server" missing for hook usage
- Component name mismatches with import expectations
- Markdown fences inside the source

Every one of the bugs below would be caught instantly by `tsc --noEmit`. **The single largest leverage point is: run full tsc inside the Phase B per-component validate-gate, not just parseDiagnostics.**

Why we haven't done this yet: full tsc requires resolving every `@/lib/...` alias against a real project tree. In Phase B we don't have a project tree yet (Phase C composes it). Two design paths:

1. **Materialize a minimal stub tree per validate call.** Have Phase B emit a temp scratch dir with stub `lib/sdk/types.ts`, stub `lib/jab/ability-client.ts`, stub `tsconfig.json`, then run `tsc --noEmit` against the generated `.tsx` file. ~2-5 sec per component, accurate.
2. **Move compile-gate into Phase C.** Have Phase C run `tsc --noEmit` on the materialized project tree before uploading to Storage. Catches everything in one pass. Failure surface tied to Phase C run, not individual component generations. ~30 sec one-time per build.

Either is a real fix. Recommendation: option 2 (Phase C compile-gate) because it catches all interactions, not just per-component issues. Add it as a step.run in `compose-site.ts` after all file emissions, before the status transition to `building`.

---

## The bugs (9 categories, 5 distinct contracts violated)

Each section: **what surfaced**, **root cause**, **suggested fix**, **affected files in build `982f0d57`** (where applicable).

### 1. Components needing `"use client"` lack the directive

**Surface:** Vercel `next build` errors like:

```
You're importing a component that needs `useState`. This React Hook only works in a Client Component.
./components/blocks/AcfFlexPagePageBuilderContentWysiwyg.tsx:2:1
| import { useState } from "react";
```

**Root cause:** Phase B's prompt allows hooks (the shell prompt explicitly permits `useState` for the mobile menu toggle), but neither the prompt nor the validator enforces a `"use client"` declaration when hooks are present.

**Fix:** In `apps/web/lib/ai/component-generator.ts`, after `stripCodeFences`, scan the source for hook imports (`import { useState | useEffect | useRef | useCallback | useMemo | useReducer | useContext | useLayoutEffect | useTransition | useDeferredValue | useId | useSyncExternalStore | useImperativeHandle | useFormStatus | useFormState | useOptimistic } from "react"`) and prepend `"use client";\n\n` if absent and hooks are detected. Same logic in `apps/web/lib/ai/generate-shell.ts`. Mirror in any other LLM output path that emits component code.

**Affected in 982f0d57:** 1 file (`AcfFlexPagePageBuilderContentWysiwyg.tsx`).

---

### 2. Component exported names don't match the dispatcher's import contract

**Surface:**

```
Attempted import error: 'CptTemplateBeer' is not exported from './CptTemplateBeer'
```

**Root cause:** The dispatcher emits `import { CptTemplateBeer } from "./CptTemplateBeer"`, but the LLM-generated component exports `export function BeerLayout()` — a semantically meaningful name, not the contract-required filename-derived name. 19 of 21 Two Roads components hit this.

**Fix:** Phase B's `validateTsx` (in `component-generator.ts`) should also enforce that the source contains `export function ${expectedName}` or `export const ${expectedName}` where `expectedName` is the filename-without-extension that Phase C will write. Either:

- **Prompt-side:** Pin the expected component name in the prompt itself (`Generate a component exported as exactly \`function ${expectedName}()\``), then validate it in the gate.
- **Post-process:** After validation, scan for the actual exported name (regex on `export\s+function\s+(\w+)` or `export\s+default\s+function\s+(\w+)`), and if it doesn't match `expectedName`, append `\nexport { ${actualName} as ${expectedName} };` to coerce. Mechanical, no re-LLM cost.

**Recommendation:** post-process. The LLM is going to pick semantically meaningful names; fighting that costs tokens.

**Affected in 982f0d57:** 19 of 21 block components.

---

### 3. `emitHomepageTsx` doesn't cast `callAbility` result before `composeBlockTree`

**Surface:**

```
Type error: Argument of type 'unknown' is not assignable to parameter of type 'BlockTreeRecord'.
./app/page.tsx:10:35
const blocks = composeBlockTree(record, "page", [...], { acfFlexFields: ACF_FLEX_FIELDS });
```

**Root cause:** `JabClient.callAbility(...)` returns `Promise<unknown>` (the abilities surface is dynamic). The homepage template passes that `unknown` directly to `composeBlockTree`, which expects `BlockTreeRecord`. The catch-all template `emitCatchAllPageTsx` does the right thing (`record as Record<string, unknown>`); the homepage emitter forgot.

**Fix:** In `apps/web/lib/jab/compose-site-emit.ts emitHomepageTsx`, change the emitted call to:

```ts
const blocks = composeBlockTree(record as Parameters<typeof composeBlockTree>[0], "page", [...], { acfFlexFields: ACF_FLEX_FIELDS });
```

(Or use the same `as Record<string, unknown>` shape the catch-all uses, whichever stays type-correct as `composeBlockTree`'s signature evolves.)

**Affected in 982f0d57:** `app/page.tsx`.

---

### 4. `stripCodeFences` misses non-`tsx|ts|jsx|js` language tags

**Surface:** A `.tsx` file in Storage that starts with `` ```typescript `` and ends with `` ``` `` (literally), causing webpack: `Module parse failed: Export 'X' is not defined`.

**Root cause:** `stripCodeFences` regex in `component-generator.ts` and `generate-shell.ts`:

```ts
.replace(/^\s*```(?:tsx|ts|jsx|js)?\s*/i, "")
.replace(/\s*```\s*$/i, "");
```

The `(?:tsx|ts|jsx|js)?` doesn't match `typescript`, `javascript`, or any other word. The LLM occasionally uses the longer form.

**Fix:** Broaden the regex to accept any word characters: `^\s*```\w*\s*` for the leading fence; trailing fence regex is fine.

Also: switch from "strip leading fence" + "strip trailing fence" to a more robust line-based stripper that removes any line matching `^\s*```\w*\s*$`. The current regex assumes fence at the boundaries; a stray fence mid-file becomes invisible.

**Affected in 982f0d57:** 1 file (`CoreParagraph.tsx`).

---

### 5. Phase C's `substituteBlockNodeImport` regex doesn't match the actual Phase B output

**Surface:** After Phase C "substitution", components still contain `import type { BlockNode } from "@/lib/jab/ability-client"`, which doesn't resolve in the emitted project.

**Root cause:** In `apps/web/lib/inngest/functions/compose-site.ts`:

```ts
function substituteBlockNodeImport(src: string): string {
  return src.replace(
    /\/\/ Minimal BlockNode shape[\s\S]*?\}\s*\n/,
    `import type { BlockNode } from "@/lib/sdk/types";\n\n`,
  );
}
```

This regex looks for a `// Minimal BlockNode shape` comment block that Phase B never emits. Phase B emits `import type { BlockNode } from "@/lib/jab/ability-client"` directly — no comment, no inline interface definition.

**Fix:** Change the regex to match the actual import line:

```ts
function substituteBlockNodeImport(src: string): string {
  return src.replace(
    /import\s+type\s*\{\s*BlockNode\s*\}\s+from\s+["']@\/lib\/jab\/ability-client["']\s*;?\s*\n/,
    `import type { BlockNode } from "@/lib/sdk/types";\n`,
  );
}
```

Apply to ALL downloaded components in `download-components` step (not just the dispatcher, which had a different code path).

**Affected in 982f0d57:** 18 of 21 components imported BlockNode from the wrong path.

---

### 6. `@jab/core emitSdk` doesn't include `BlockNode` in the emitted `lib/sdk/types.ts`

**Surface:**

```
Type error: Module '"@/lib/sdk/types"' has no exported member 'BlockNode'.
```

**Root cause:** `@jab/core`'s `emitSdk` (in `packages/core/src/emit/`) generates per-tenant ability input/output types but not the WP-block primitive `BlockNode`. Phase C's `substituteBlockNodeImport` (bug #5) points imports at `@/lib/sdk/types`, but that file doesn't actually export `BlockNode`.

**Fix:** Choose one:

- **(a) `@jab/core` change:** add a static `BlockNode` interface declaration to the emitted `types.ts` output (it's the same shape for every project — `blockName`, `attrs`, `innerHTML`, `innerContent`, `innerBlocks`). One-time edit to the emitter template.
- **(b) Phase C change:** stop pointing the substitution at `@/lib/sdk/types`. Instead, point at `@/lib/compose-block-tree` (which already imports `BlockNode` via the substitution chain) and add a `BlockNode` re-export there. Or just inline a `BlockNode` interface in each component file as part of substitution.

**Recommendation:** (a) — add to `@jab/core`. `BlockNode` is part of the WP block contract, the same shape forever. Belongs in the SDK.

**Affected in 982f0d57:** all 21 components (after bug #5 is fixed) + `lib/compose-block-tree.ts`.

---

### 7. Dispatcher's `block: BlockNode` prop conflicts with `RenderableBlock`

**Surface:**

```
Type 'RenderableBlock' is not assignable to type 'BlockNode'.
  Types of property 'innerBlocks' are incompatible.
    Type 'RenderableBlock[] | undefined' is not assignable to type 'BlockNode[]'.
```

**Root cause:** `composeBlockTree` returns `RenderableBlock[]` where `innerBlocks?: RenderableBlock[]` (optional). The dispatcher declares `block: BlockNode` where `innerBlocks: BlockNode[]` (required). The strictness mismatch breaks the call site.

**Fix:** In `apps/web/lib/jab/compose-site-emit.ts emitDispatcherTsx`, change the prop type from `BlockNode` to a structurally-narrower shape — the dispatcher only reads `blockName` and `attrs`:

```tsx
export function BlockDispatcher({ block }: { block: { blockName: string | null; attrs: Record<string, unknown> } }) {
```

Or alternatively, import `RenderableBlock` from `@/lib/compose-block-tree` and use that.

Also fix the page templates so the cast is unnecessary in the first place.

**Affected in 982f0d57:** dispatcher + both page templates.

---

### 8. LLM emits unsafe TypeScript casts without `as unknown` bridge

**Surface:**

```
Type error: Conversion of type 'BeerPost' to type 'Record<string, unknown>' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
```

**Root cause:** The LLM occasionally emits `expr as SomeType` where SomeType lacks an index signature or sufficient overlap. TypeScript's safe-cast rules require an `as unknown as SomeType` bridge.

**Fix:** This is a category of "type errors only tsc catches." Bullet-proof fix is to run full tsc per component (see "Why parse-only validation is insufficient" above). Short-term mitigation: post-process by detecting `as Record<string, unknown>` casts and inserting the `unknown` bridge. But that's whack-a-mole — there will always be another category of unsafe cast.

**Recommendation:** ship the Phase C compile-gate (run `tsc --noEmit` on the materialized tree). Then individual components that fail get the same retry+fallback treatment they get for syntax errors.

**Affected in 982f0d57:** 1 file confirmed (`AcfFlexPagePageBuilderFeaturedBeer.tsx`); more likely lurking.

---

### 9. `getDeploymentEvents` joins events with `\n` — sometimes produces blank-line padding

**Surface:** Captured build logs have blank lines between events because Vercel's event text already ends in `\n`, and our join adds another.

**Root cause:** `client.ts getDeploymentEvents`:

```ts
return sorted.map((e) => e.text ?? e.payload?.text ?? "").join("\n");
```

Vercel returns events with `text` like `"Installing\n"` (trailing newline). Joining with `"\n"` gives `"Installing\n\nBuilding\n"`. Readable but doubled.

**Fix:** Strip trailing newline from each event before join, then add one newline between events:

```ts
return sorted.map((e) => (e.text ?? e.payload?.text ?? "").replace(/\n+$/, "")).join("\n");
```

Minor — not blocking. Cosmetic improvement for log readability.

**Affected:** Phase D — `apps/web/lib/vercel/client.ts`.

---

## Implementation order (suggested)

1. **Bug #6 (`@jab/core` BlockNode emission)** — foundational. Everything else assumes `BlockNode` is importable from the emitted SDK.
2. **Bug #5 (Phase C substituteBlockNodeImport regex)** — fixes the import chain for 18+ files. Cheap fix.
3. **Bug #7 (dispatcher prop type)** — single dispatcher file change. Eliminates the cast at page level.
4. **Bug #3 (homepage cast)** — single emit function change.
5. **Bug #2 (component name aliasing)** — post-process in component-generator.ts. Fixes 19 components on next regen.
6. **Bug #1 (`"use client"` directive)** — auto-prepend on hook detection.
7. **Bug #4 (stripCodeFences widening)** — one regex change.
8. **Phase C compile-gate** — bigger work. Catches bug #8 plus future categories. Run `tsc --noEmit` on the materialized tree as a final step before status transition.
9. **Bug #9 (events log readability)** — tiny cosmetic fix to client.ts.

Total estimated work: ~1-1.5 days. After landing, re-trigger Phase B + Phase C against build `982f0d57` (or compose a fresh build for a different pilot), then re-run `pnpm smoke:deploy` and expect green.

---

## Ad-hoc patcher scripts in this session

The following `apps/web/scripts/_patch-*.ts` and `apps/web/scripts/_diag-*.ts` files are one-off tooling created during this iteration. They are NOT part of the Phase D shipped surface. After Phase B/C upstream fixes land, they can be deleted.

- `_diag-vercel-deployment.ts` — query Vercel deployment state + events
- `_diag-storage-file.ts` — download a single Storage object to stdout
- `_diag-storage-list.ts` — recursive Storage prefix lister
- `_patch-use-client.ts` — prepend `"use client"` to components with hooks
- `_patch-component-exports.ts` — add filename-aliased exports + page-level cast
- `_patch-strip-fences.ts` — remove `^\s*```\w*\s*$` lines from generated files
- `_patch-blocknode-import.ts` — rewrite `@/lib/jab/ability-client` → `@/lib/sdk/types`
- `_patch-blocknode-export.ts` — append `BlockNode` interface to `lib/sdk/types.ts`
- `_patch-page-dispatcher-cast.ts` — add `as BlockNode` cast at dispatcher call sites

The shipped tools that earn their keep going forward:

- `read-build-log.ts` — operator tool for triaging future Phase D failures (already useful, keep)

---

## Done = ...

- All 9 fixes above land in their respective code locations.
- Phase B regenerates Two Roads' 21 components without manual Storage patches needed for compile.
- Phase C re-composes build `982f0d57` (or a fresh build); the materialized tree passes `tsc --noEmit` cleanly.
- Phase D's smoke runner against the freshly-composed build prints `[smoke] PASS — preview HEAD returned 200`.
- The ad-hoc `_patch-*.ts` and `_diag-vercel-deployment.ts` scripts get deleted (or moved to `scripts/_archive/`).
- CLAUDE.md Stage 4 row marked **Shipped** (no longer "mechanics shipped, awaiting Phase B/C").
