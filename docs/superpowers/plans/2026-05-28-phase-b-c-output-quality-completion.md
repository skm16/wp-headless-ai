# Phase B/C Output Quality Completion Plan

> **Date:** 2026-05-28  
> **Purpose:** Turn the Phase B/C punch list into an executable coding-agent plan.  
> **Primary source:** `docs/superpowers/specs/2026-05-28-phase-b-c-output-quality-followups.md`  
> **Goal:** Generated WordPress-to-headless Next.js projects should compile and deploy without manual Storage patching, while preserving the "faithful to source WP" product promise.

---

## Context

The current SaaS v2 build pipeline has these live phases:

- **Phase A:** Discover WP content, block inventory, screenshots, DOM samples, theme CSS, shell DOM, and design tokens.
- **Phase B:** Generate one React component per block type and persist `.tsx` artifacts.
- **Phase C:** Compose a generated Next.js project tree from generated components, deterministic runtime files, SDK output, and shell components.
- **Phase D:** Deploy that project tree to Vercel and persist build logs on failure.

The first Vercel smoke against a generated Two Roads build proved the Phase D mechanics, but exposed upstream Phase B/C contract failures. This plan fixes those failures at the source.

---

## Success Criteria

Done means:

- Phase B generated components no longer require manual Storage patching for common compile failures.
- Phase C emits a project tree that passes `tsc --noEmit` before dispatching `site/deploy.requested`.
- A fresh compose of the Two Roads build, or a fresh equivalent build, reaches Vercel successfully.
- `pnpm smoke:deploy <projectId> <tenantId> <buildId>` reaches `verifying` and its preview `HEAD` check returns `200`.
- The ad-hoc patch scripts in `apps/web/scripts/_scratch/_patch-*.ts` are no longer needed for the covered failures.
- Tests document the contracts that previously broke.

---

## Guardrails For The Coding Agent

- Read current code before editing; some docs are stale compared with live code.
- Keep changes scoped to Phase B/C output quality and the small Phase D log cleanup.
- Do not redesign Phase E/F in this plan. Phase D currently dispatches `site/verify.requested`; the absence of a verify handler is known and separate.
- Prefer deterministic post-processing for mechanical contracts over prompt-only fixes.
- Add tests for every contract fixed here. These are generator contracts, so unit tests are cheap and valuable.
- Do not store decrypted WP credentials in logs, return values, Inngest step outputs, or build artifacts.

---

## Execution Overview

Implement in this order:

1. Add emitted SDK `BlockNode`.
2. Fix Phase C component/runtime import rewriting.
3. Normalize dispatcher/component prop contract.
4. Fix homepage type cast.
5. Add Phase B output post-processing.
6. Harden shell output post-processing.
7. Add Phase C compile gate.
8. Clean Vercel event log joining.
9. Run focused tests, then compose/deploy smoke.

Each step below includes files, implementation notes, tests, and acceptance checks.

---

## Step 1 - Emit `BlockNode` From `@jab/core`

### Problem

Phase C points emitted imports at `@/lib/sdk/types`, but `packages/core/src/sdk.ts` only emits ability input/output types. Generated project files that import `BlockNode` from `@/lib/sdk/types` fail.

### Files

- `packages/core/src/sdk.ts`
- Add or update tests under `packages/core` if test structure exists. If not, add coverage from `apps/web` tests that call `emitSdk`.

### Implementation

Append a static exported interface to the generated `types.ts` output:

```ts
export interface BlockNode {
  blockName: string | null;
  attrs: Record<string, unknown>;
  innerBlocks?: BlockNode[];
  innerHTML?: string;
  innerContent?: Array<string | null>;
}
```

Use optional `innerBlocks` and `innerHTML` so it is compatible with `RenderableBlock` and with runtime synthesized ACF/classic blocks.

Recommended implementation:

- Add a small `renderStaticBlockTypes()` helper in `sdk.ts`.
- Include it near the top of `renderTypesFile()` after the eslint/tslint header and before compiled ability sections.

### Tests

Add a test that:

- Calls `emitSdk()` with a minimal manifest.
- Reads `types.ts`.
- Asserts it contains `export interface BlockNode`.
- Asserts it contains `innerBlocks?: BlockNode[]`.

### Acceptance

- `@/lib/sdk/types` exports `BlockNode` in every emitted project.

---

## Step 2 - Fix Phase C Import Rewriting

### Problem

Phase B components import `BlockNode` from `@/lib/jab/ability-client`, which does not exist in generated projects. Phase C currently rewrites only the comment-delimited placeholder in `compose-block-tree-runtime.ts`, not downloaded generated components.

### Files

- `apps/web/lib/inngest/functions/compose-site.ts`
- `apps/web/lib/jab/compose-site-emit.test.ts` or a new focused test file for compose helpers

### Implementation

Add a reusable import rewrite helper:

```ts
function rewriteBlockNodeImports(src: string): string {
  return src
    .replace(
      /import\s+type\s*\{\s*BlockNode\s*\}\s+from\s+["']@\/lib\/jab\/ability-client["']\s*;?\s*\n/g,
      `import type { BlockNode } from "@/lib/sdk/types";\n`,
    )
    .replace(
      /\/\/ Minimal BlockNode shape[\s\S]*?export interface BlockNode\s*\{[\s\S]*?\}\s*\n/,
      `import type { BlockNode } from "@/lib/sdk/types";\n\n`,
    );
}
```

Then:

- Use it when emitting `lib/compose-block-tree.ts`.
- Use it on every downloaded component before uploading to `components/blocks/<Name>.tsx`.
- Use the same helper for passthrough fallback only if needed; current emitted passthrough already imports SDK types.

Keep the old placeholder behavior for the runtime file, but rename `substituteBlockNodeImport` to reflect the broader use.

### Tests

Add tests for:

- Rewrites `import type { BlockNode } from "@/lib/jab/ability-client";`.
- Rewrites single-quoted imports.
- Rewrites the runtime placeholder.
- Leaves already-correct `@/lib/sdk/types` imports unchanged.

If the helper remains private, test through an exported helper from a small utility module rather than testing by reflection.

### Acceptance

- No emitted project component imports `@/lib/jab/ability-client`.
- `lib/compose-block-tree.ts` imports `BlockNode` from `@/lib/sdk/types`.

---

## Step 3 - Normalize Component Prop Contract

### Problem

Phase B prompts say generated components accept `{ block: BlockNode }`, but the dispatcher emits:

```tsx
<Component {...(block.attrs as Record<string, never>)} />
```

That breaks correctly generated components. It also prevents recursive rendering of `innerBlocks`.

### Files

- `apps/web/lib/jab/compose-site-emit.ts`
- `apps/web/lib/jab/compose-site-emit.test.ts`
- `apps/web/lib/ai/component-generator.ts`

### Implementation

Change dispatcher case emission from attr spreading to block passing:

```tsx
case "core/heading": return <CoreHeading block={block} />;
```

Change dispatcher prop type to a renderable shape compatible with `composeBlockTree`:

```tsx
import type { RenderableBlock } from "@/lib/compose-block-tree";

export function BlockDispatcher({ block }: { block: RenderableBlock }) {
  ...
}
```

Export `RenderableBlock` from emitted `lib/compose-block-tree.ts` already exists in the runtime source. This avoids the `RenderableBlock` vs `BlockNode` mismatch surfaced by Vercel.

Update the component generator prompts:

- Keep the main block-component contract as `{ block: BlockNode }`.
- For `cpt_template`, do **not** ask for a component named `${Cpt}Layout` unless Phase C aliases it. Instead require the filename-derived export name like other blocks.
- For now, avoid requiring `children` for generated block components unless dispatcher recursion is implemented in this same step.

Recommended v1 choice:

- Keep recursion out of dispatcher for this bugfix pass.
- Let generated components inspect `block.innerBlocks` if they want, but deterministic recursive child rendering can be a follow-up once the component contract is stable.

### Tests

Update dispatcher tests:

- Assert case renders `<CoreHeading block={block} />`.
- Assert dispatcher imports `RenderableBlock`, not `BlockNode`.
- Assert default still renders `<Passthrough block={block} />`.

Add a prompt snapshot or string assertion:

- Standard/trivial prompts still specify `{ block: BlockNode }`.
- CPT template prompt does not require an export name that differs from the file/dispatcher name.

### Acceptance

- Dispatcher calls match Phase B prompt contract.
- Page templates can pass `RenderableBlock` values to dispatcher without casts.

---

## Step 4 - Fix Homepage `composeBlockTree` Cast

### Problem

`jabClient.callAbility()` returns unknown/dynamic output. The catch-all page casts before `composeBlockTree`; homepage does not.

### Files

- `apps/web/lib/jab/compose-site-emit.ts`
- `apps/web/lib/jab/compose-site-emit.test.ts`

### Implementation

Change homepage emitted code:

```ts
const blocks = composeBlockTree(
  record as Parameters<typeof composeBlockTree>[0],
  "page",
  [...],
  { acfFlexFields: ACF_FLEX_FIELDS },
);
```

Alternatively use:

```ts
record as Record<string, unknown>
```

Prefer `Parameters<typeof composeBlockTree>[0]` so the cast follows the runtime signature.

### Tests

Update homepage emitter test to assert the cast is present.

### Acceptance

- `app/page.tsx` does not pass `unknown` directly to `composeBlockTree`.

---

## Step 5 - Add Phase B Component Post-Processing

### Problem

LLM output can violate mechanical contracts:

- Markdown fences remain.
- Required export name does not match dispatcher import.
- Hook-using components lack `"use client"`.
- Imports point at the SaaS app path instead of generated SDK path.

Prompting helps but is not enough. Add deterministic cleanup.

### Files

- `apps/web/lib/ai/component-generator.ts`
- `apps/web/lib/ai/component-generator.test.ts`
- Optional new file: `apps/web/lib/ai/generated-tsx-postprocess.ts`

### Implementation

Create a reusable postprocessor:

```ts
interface PostprocessOptions {
  expectedExportName: string;
}

export function postprocessGeneratedTsx(source: string, opts: PostprocessOptions): string
```

It should:

1. Strip code fences line-by-line:

```ts
source
  .split(/\r?\n/)
  .filter((line) => !/^\s*```\w*\s*$/.test(line))
  .join("\n")
```

2. Rewrite `BlockNode` imports to `@/lib/sdk/types` for generated-project compatibility.

3. Ensure expected export exists:

- If `export function ExpectedName` or `export const ExpectedName` exists, leave it.
- Else find the first exported function/const/default function name.
- Append:

```ts
export { ActualName as ExpectedName };
```

- If no export can be found, let validation fail and retry/fallback.

4. Detect React hooks and prepend `"use client";` if absent.

Hook detection should include at least:

- `useState`
- `useEffect`
- `useRef`
- `useCallback`
- `useMemo`
- `useReducer`
- `useContext`
- `useLayoutEffect`
- `useTransition`
- `useDeferredValue`
- `useId`
- `useSyncExternalStore`
- `useImperativeHandle`
- `useOptimistic`

Check both named React imports and `React.useState` style references.

5. Preserve existing leading `"use client";` or `'use client';`.

Call this before size check and `validateTsx`.

Important:

- Compute `expectedExportName` from the same `toPascalCase(blockName)` logic used by `persist-generation.ts` and dispatcher.
- Keep postprocess deterministic and side-effect-free so tests are simple.

### Tests

Add tests for:

- Strips `tsx`, `typescript`, and unknown language fences.
- Strips standalone fence lines even if not at file boundaries.
- Adds `"use client";` for hook imports.
- Does not add duplicate `"use client";`.
- Rewrites BlockNode import.
- Appends alias export when LLM emits `export function BeerLayout`.
- Leaves correct export unchanged.

### Acceptance

- Generated components stored by Phase B match dispatcher import names.
- Common hook components compile as client components.
- Markdown fences do not reach Storage.

---

## Step 6 - Harden Phase C Shell Post-Processing

### Problem

`generate-shell.ts` has its own local `stripCodeFences()` that only handles `tsx|ts|jsx|js`, and shell components can also use hooks.

### Files

- `apps/web/lib/ai/generate-shell.ts`
- `apps/web/lib/ai/generate-shell.test.ts`
- Shared postprocess utility from Step 5

### Implementation

Reuse a lighter postprocessor for shell TSX:

- Strip fences line-by-line.
- Add `"use client";` if hooks are used.
- Enforce expected export name:
  - Header generation must export `Header`.
  - Footer generation must export `Footer`.

Do not rewrite BlockNode imports unless present; it is harmless if the shared helper does.

### Tests

Add tests for:

- `typescript` fences are stripped.
- hook-using header gets `"use client";`.
- wrong export name is aliased or corrected to `Header`/`Footer`.

### Acceptance

- Shell LLM output has the same mechanical guarantees as block output.

---

## Step 7 - Add Phase C Compile Gate

### Problem

Parse-only validation misses the exact failures Vercel exposed. The generated project should be typechecked before Phase C marks the build as ready for deploy.

### Files

- `apps/web/lib/inngest/functions/compose-site.ts`
- New helper file recommended: `apps/web/lib/jab/compile-generated-project.ts`
- `apps/web/lib/jab/download-project-tree.ts`
- Tests for compile helper where practical

### Implementation

Add a Phase C step after all project files have been uploaded and before `mark-built` / `dispatch-deploy`:

```ts
await step.run("compile-generated-project", async () => {
  ...
});
```

Recommended helper behavior:

1. Download the generated project tree from Storage using `downloadProjectTree()`.
2. Materialize it into a temp directory under the OS temp folder.
3. Run package-manager install/typecheck in that temp directory.

Preferred command strategy:

- If the emitted project has `package.json` with `typecheck`, run `pnpm install --frozen-lockfile=false` then `pnpm typecheck`.
- If dependency install is too slow for immediate v1, run `pnpm dlx tsc --noEmit` is not enough because dependencies/types must resolve. Prefer installing.

Practical first version:

- Use `pnpm install --ignore-scripts --frozen-lockfile=false`.
- Run `pnpm typecheck`.
- Capture stdout/stderr.
- On failure:
  - Upload `builds/<buildId>/compile-log.txt`.
  - Update `site_builds`:
    - `status = "failed"`
    - `failed_phase = "composing"`
    - `build_log_storage_path` or a new compile-log path column if available; if no column exists, use `error_text` with a short summary and log path.
  - Throw to stop deploy dispatch.

Security notes:

- Use `execFile`/`spawn` with args, not shell string interpolation.
- Never write `.env` with real WP credentials for typecheck. Typecheck should not need runtime env values.
- Clean up temp dirs after success/failure.

If running installs inside Inngest is too heavy:

- Implement the helper behind `JAB_COMPOSE_TYPECHECK=1`.
- Enable it in smoke/operator env first.
- Still keep the code path and tests.

### Tests

Unit test helper pieces:

- Dynamic route decode still works.
- Required files assertion still works.
- Compile failure result uploads/persists log can be tested with a mocked runner.

Integration/smoke:

- Use `pnpm smoke:compose`.
- Then run deploy smoke only after compile passes.

### Acceptance

- Phase C does not dispatch `site/deploy.requested` for a project with TS/import errors.
- Compile log is available for operator triage.

---

## Step 8 - Clean Vercel Event Log Joining

### Problem

Vercel event strings often already end with newlines. Joining with `"\n"` produces double blank lines.

### Files

- `apps/web/lib/vercel/client.ts`
- `apps/web/lib/vercel/client.test.ts`

### Implementation

Change:

```ts
return sorted.map((e) => e.text ?? e.payload?.text ?? "").join("\n");
```

To:

```ts
return sorted
  .map((e) => (e.text ?? e.payload?.text ?? "").replace(/\n+$/, ""))
  .join("\n");
```

### Tests

Add or update a test that mocked events with trailing newlines produce single-spaced logs.

### Acceptance

- Build logs remain readable without blank-line padding.

---

## Step 9 - Reconcile Docs And Scratch Scripts

### Problem

`docs/conversion-pipeline.md` says Phase C/D are not built, but live code now registers `composeSite` and `deploySite`. Scratch patchers document emergency fixes that should become obsolete.

### Files

- `docs/conversion-pipeline.md`
- `docs/superpowers/specs/2026-05-28-phase-b-c-output-quality-followups.md`
- `CLAUDE.md` if its status table tracks stages
- `apps/web/scripts/_scratch/_patch-*.ts`

### Implementation

After code is green:

- Update `conversion-pipeline.md` current-state sections to say Phase C/D are built but Phase E/F/orchestrator are not.
- Mark punch-list items complete or link this implementation plan.
- Either delete scratch patchers or move them to an archive folder after verifying no operator workflow still depends on them.

### Acceptance

- Docs no longer imply `site/compose.requested` has no handler.
- Scratch scripts are not presented as required operational tooling.

---

## Recommended Test Commands

Run from repo root unless noted:

```bash
pnpm --filter @jab/core test
pnpm --filter web test -- component-generator
pnpm --filter web test -- generate-shell
pnpm --filter web test -- compose-site-emit
pnpm --filter web test -- vercel
pnpm --filter web typecheck
```

If the repo does not define these exact filters, inspect `package.json` scripts and run the closest equivalents.

Then run smoke tests from `apps/web` with real env:

```bash
pnpm tsx scripts/smoke-generate-components.ts <projectId> <tenantId> <buildId>
pnpm tsx scripts/smoke-compose-site.ts <projectId> <tenantId> <buildId>
pnpm smoke:deploy <projectId> <tenantId> <buildId>
```

Expected smoke outcome after this plan:

- Phase B finishes with generated files in Storage.
- Phase C finishes with `site_builds.status = "building"` only after typecheck passes.
- Phase D reaches `site_builds.status = "verifying"` and preview `HEAD` returns `200`.

---

## Known Follow-Ups Not In This Plan

These matter, but should not block the compile/deploy stabilization work:

- Build Phase E `verify-fidelity` handler for `site/verify.requested`.
- Build Phase F review UI and approval/publish flow.
- Add top-level `site/build.requested` orchestrator.
- Improve recursive rendering of nested Gutenberg blocks.
- Use computed CSS more deeply for visual fidelity after compile reliability is stable.
- Replace naive theme CSS scoping with a robust CSS parser/rewriter if real generated previews show cascade problems.
- Add pagination for CPT list calls over 100 records.
- Add client-uploaded source screenshots for Cloudflare-protected sites.

---

## Agent Handoff Checklist

Before starting:

- [ ] Read the punch-list spec.
- [ ] Read `component-generator.ts`, `generate-shell.ts`, `compose-site.ts`, `compose-site-emit.ts`, and `sdk.ts`.
- [ ] Confirm current test scripts from package manifests.

During implementation:

- [ ] Keep each fix in small commits or separable patches.
- [ ] Add tests alongside each contract fix.
- [ ] Do not rely on prompt wording alone for mechanical contracts.
- [ ] Preserve generated project runtime env contract: `WP_URL`, `WP_USER`, `WP_APP_PASSWORD`.

Before final handoff:

- [ ] Run focused tests.
- [ ] Run typecheck if available.
- [ ] Run compose smoke.
- [ ] Run deploy smoke if Vercel/Supabase env is available.
- [ ] Update stale docs.
- [ ] Summarize any remaining failures with exact log paths.
