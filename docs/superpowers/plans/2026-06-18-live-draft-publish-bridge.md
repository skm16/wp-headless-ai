# Live Draft Publish Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user publish their Live Draft to production — the accumulated draft edits (component/shell patches + token overrides) become a real composed, deployed, reviewed, production build.

**Architecture:** Resurrect the deleted `edit-site.ts` clone model, applied to the FULL draft state. A new `publish-draft` Inngest worker clones the draft's base build (inventory rows + component/shell/source Storage, via the proven `*_CLONE_COLUMNS` + `listAllUnderPrefix` + `shellCloneObjects`), overlays the draft's effective unit versions (`effectiveUnitVersions` → patched TSX onto the cloned component/shell Storage), stamps the merged token override + union changed-slugs into the new build's `config`, and dispatches `site/compose.requested` → the EXISTING compose → deploy → verify → review → `publishBuildAction` pipeline. Tokens reach production per the chosen strategy: the build carries `config.tokens` (compose prefers it); `projects.design_tokens` is updated to the new brand ONLY when the build is promoted to production. The draft is locked (`status='publishing'`) during the flow, advancing to `published` on production-publish (a fresh draft then forks from the new build) or reverting to `active` on failure/cancel.

**Tech Stack:** TypeScript, Next.js App Router, Inngest, vitest. **No DB migration** — rides `site_builds.config` JSONB; `drafts.status` already allows `publishing`/`published`.

## Global Constraints

- **No new deployable-build machinery.** The bridge produces a `site_builds` row that flows through the EXISTING compose/deploy/verify/review/publish pipeline. The draft's esbuild bundle is NOT deployable — compose must run.
- **Reuse the edit-site clone blueprint.** The clone column sets (`PAGE_INVENTORY_CLONE_COLUMNS`, `BLOCK_INVENTORY_CLONE_COLUMNS`), `listAllUnderPrefix`, `shellCloneObjects`, `applyCarryForwardApprovals`, and the schema-derived completeness test all live in `edit-site.helpers.ts` and stay. `edit-site.ts` itself is deleted; its clone sequence (commit `82aa51f^`) is the blueprint.
- **Tokens commit on production-publish only.** The publish build carries `config.tokens` (merged override); compose prefers it over `projects.design_tokens`. `projects.design_tokens` is updated to that value ONLY inside `publishBuildAction` when the build is actually promoted — a failed/rejected/cancelled publish never mutates the project's brand.
- **Byte-identical when the draft has no token edits.** `config.tokens` is set only when active token deltas exist; otherwise compose reads `projects.design_tokens` exactly as today.
- **Draft lock is recoverable.** `active → publishing` at snapshot; `publishing → published` on production-publish; `publishing → active` on build failure or explicit cancel. A `publishing` draft blocks new edits (`draft-edit`'s `ensure-draft` already throws on non-`active`).
- **Loud failures; no silent strands.** A publish build that fails must unlock the draft (revert to `active`) so the user can retry.
- **Commit trailer on every commit:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Modify** `apps/web/lib/jab/build-config.ts` — `publish_draft` mode + `tokens` field; `configCarryForwardSource` helper.
- **Modify** `apps/web/lib/jab/compose-build-tokens.ts` (new pure) + `compose-site.ts` — prefer `config.tokens`.
- **Create** `apps/web/lib/inngest/functions/publish-draft.helpers.ts` (clone/overlay pure pieces) + `publish-draft.ts` (worker).
- **Modify** `apps/web/lib/inngest/edit-request-event.ts` or a new `apps/web/lib/inngest/publish-draft-event.ts` — `draft/publish.requested` event.
- **Modify** `apps/web/lib/inngest/functions/index.ts` (or wherever workers register) — register `publishDraft`.
- **Modify** `apps/web/lib/inngest/functions/verify-fidelity.ts` — carry-forward for `publish_draft` too.
- **Create** `apps/web/lib/actions/publish-draft-action.ts` — `publishDraftAction` + `cancelPublishAction`.
- **Modify** `apps/web/lib/actions/build-review.ts` — `publishBuildAction`: commit tokens + advance draft to `published`.
- **Modify** `apps/web/lib/inngest/shared-failure.ts` (`markBuildFailed`) — unlock draft on a `publish_draft` build failure.
- **Modify** the workspace UI (`app/(app)/projects/[id]/workspace/page.tsx` + a `PublishDraftButton` client component).
- Test files alongside each; docs (`live-draft` spec, fleet-gap register, `CLAUDE.md`).

---

### Task 1: BuildConfig `publish_draft` mode + carry-forward-source helper

**Files:** Modify `apps/web/lib/jab/build-config.ts`; Test `apps/web/lib/jab/build-config.test.ts`.

**Interfaces:**
- `BuildConfig` gains a third member:
  ```ts
  | {
      mode: "publish_draft";
      draft_id: string;
      base_build_id: string;
      source_build_id: string;      // = base_build_id; the carry-forward source
      changed_slugs: string[];      // union of all active draft edits' changed_slugs
      tokens?: ThemeJsonTokens;     // merged token override; absent when no token edits
      front_page_slug: string | null;
      show_on_front?: "page" | "posts";
      last_sync_watermark?: string;
      locale?: string;
    }
  ```
- `isPublishDraftConfig(c: unknown): c is Extract<BuildConfig, { mode: "publish_draft" }>`.
- `configCarryForwardSource(c: BuildConfig): { sourceBuildId: string; changedSlugs: string[] } | null` — returns the source+changed for BOTH `edit` and `publish_draft`; `null` for `full`. (verify uses this one path.)

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/jab/build-config.test.ts`:

```ts
import { isPublishDraftConfig, configCarryForwardSource, type BuildConfig } from "./build-config";

describe("publish_draft config", () => {
  const cfg: BuildConfig = {
    mode: "publish_draft", draft_id: "d", base_build_id: "b", source_build_id: "b",
    changed_slugs: ["home", "about"], front_page_slug: "home",
  };
  it("isPublishDraftConfig narrows correctly", () => {
    expect(isPublishDraftConfig(cfg)).toBe(true);
    expect(isPublishDraftConfig({ mode: "full" })).toBe(false);
    expect(isPublishDraftConfig({ mode: "edit" })).toBe(false);
  });
  it("configCarryForwardSource returns source+changed for publish_draft and edit, null for full", () => {
    expect(configCarryForwardSource(cfg)).toEqual({ sourceBuildId: "b", changedSlugs: ["home", "about"] });
    expect(configCarryForwardSource({
      mode: "edit", source_build_id: "s", changed_slugs: ["x"],
    } as BuildConfig)).toEqual({ sourceBuildId: "s", changedSlugs: ["x"] });
    expect(configCarryForwardSource({ mode: "full" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @jab/web exec vitest run lib/jab/build-config.test.ts -t "publish_draft"` → FAIL.

- [ ] **Step 3: Implement.** Add the union member (import `ThemeJsonTokens` from `@/lib/jab/global-styles`), the `isPublishDraftConfig` guard, and:

```ts
export function configCarryForwardSource(
  c: BuildConfig,
): { sourceBuildId: string; changedSlugs: string[] } | null {
  if (c.mode === "edit") return { sourceBuildId: c.source_build_id, changedSlugs: c.changed_slugs };
  if (c.mode === "publish_draft") return { sourceBuildId: c.source_build_id, changedSlugs: c.changed_slugs };
  return null;
}
```

- [ ] **Step 4: Run to verify it passes.** Full `build-config.test.ts` green.

- [ ] **Step 5: Commit.** `feat(publish): publish_draft BuildConfig mode + carry-forward-source helper`

---

### Task 2: Compose prefers `config.tokens`

**Files:** Create `apps/web/lib/jab/compose-build-tokens.ts` + test; Modify `apps/web/lib/inngest/functions/compose-site.ts`.

**Interfaces:** `resolveBuildTokens(config: BuildConfig, projectDesignTokens: unknown): ThemeJsonTokens | null` — returns `config.tokens` when the config carries it (publish_draft with token edits), else `resolveThemeTokens(...)` over `projectDesignTokens` (the existing path).

- [ ] **Step 1: Write the failing test** (`compose-build-tokens.test.ts`):

```ts
import { resolveBuildTokens } from "./compose-build-tokens";
describe("resolveBuildTokens", () => {
  const projectDt = { themeJson: { colorPalette: [{ slug: "primary", color: "#000" }] } };
  it("prefers config.tokens when present (publish_draft with token edits)", () => {
    const cfg = { mode: "publish_draft", tokens: { colorPalette: [{ slug: "primary", color: "#c00" }] } } as any;
    expect(resolveBuildTokens(cfg, projectDt)?.colorPalette).toEqual([{ slug: "primary", color: "#c00" }]);
  });
  it("falls back to resolveThemeTokens over projects.design_tokens otherwise", () => {
    expect(resolveBuildTokens({ mode: "full" } as any, projectDt)?.colorPalette).toEqual([{ slug: "primary", color: "#000" }]);
    expect(resolveBuildTokens({ mode: "publish_draft" } as any, projectDt)?.colorPalette).toEqual([{ slug: "primary", color: "#000" }]);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `compose-build-tokens.ts`:

```ts
import { resolveThemeTokens, type ThemeJsonTokens, type ScrapedBrandTokens } from "@/lib/jab/global-styles";
import type { BuildConfig } from "./build-config";

/**
 * Token source for compose. A publish_draft build whose draft had token edits
 * carries the already-merged tokens in config.tokens — compose prefers them so
 * the published clone reflects the brand edit WITHOUT mutating projects.design_tokens
 * (that commit happens only on production-publish, in publishBuildAction).
 * Every other build resolves the project's tokens exactly as before.
 */
export function resolveBuildTokens(
  config: BuildConfig,
  projectDesignTokens: unknown,
): ThemeJsonTokens | null {
  if (config.mode === "publish_draft" && config.tokens) return config.tokens;
  const dt = (projectDesignTokens ?? {}) as {
    themeJson?: ThemeJsonTokens | null;
    colors?: ScrapedBrandTokens["colors"];
    typography?: ScrapedBrandTokens["typography"];
  };
  return resolveThemeTokens(dt.themeJson, { colors: dt.colors, typography: dt.typography });
}
```

- [ ] **Step 4: Wire into compose-site.ts.** Find where compose resolves `themeTokens` (the `resolveThemeTokens(designTokens.themeJson, ...)` call, ~line 269). Replace with `resolveBuildTokens(config, project.design_tokens)`. (The `config` is already loaded by `load-build-config`; ensure it's in scope at the token-resolution site — if token resolution happens before config load, move the config load earlier or pass it.) Run `tsc --noEmit`.

- [ ] **Step 5: Run + commit.** `compose-build-tokens.test.ts` green; `feat(publish): compose prefers config.tokens for publish_draft builds`

---

### Task 3: Publish-draft clone/overlay helpers

**Files:** Create `apps/web/lib/inngest/functions/publish-draft.helpers.ts` + test.

**Interfaces:**
- `unitKeyToStoragePath(unitKey: string, buildId: string): string` — maps a draft `unit_key` to the build Storage path the overlay writes: a shell key `"shell:header"`/`"shell:footer"` → `buildShellStoragePath(buildId, kind)`; any other (a block name) → `builds/${buildId}/components/${draftComponentName(blockName)}.tsx`.
- `buildPublishDraftConfig(args: { draftId; baseBuildId; sourceConfig; changedSlugs; tokens }): Extract<BuildConfig, {mode:"publish_draft"}>` — assembles the config, carrying `front_page_slug`/`show_on_front`/`last_sync_watermark`/`locale` from the base build's config (via `carryForwardSourceConfig`), the union `changedSlugs`, and `tokens` only when non-empty.

- [ ] **Step 1: Write the failing test** (`publish-draft.helpers.test.ts`):

```ts
import { unitKeyToStoragePath, buildPublishDraftConfig } from "./publish-draft.helpers";
import { draftComponentName } from "@/lib/draft/bundle";
import { buildShellStoragePath } from "@/lib/jab/compose-site-emit"; // or wherever it lives

describe("unitKeyToStoragePath", () => {
  it("maps shell keys to the project shell path", () => {
    expect(unitKeyToStoragePath("shell:header", "B")).toBe(buildShellStoragePath("B", "header"));
    expect(unitKeyToStoragePath("shell:footer", "B")).toBe(buildShellStoragePath("B", "footer"));
  });
  it("maps a block name to the component path", () => {
    expect(unitKeyToStoragePath("core/cover", "B")).toBe(`builds/B/components/${draftComponentName("core/cover")}.tsx`);
  });
});

describe("buildPublishDraftConfig", () => {
  it("carries source config + union slugs + tokens", () => {
    const cfg = buildPublishDraftConfig({
      draftId: "d", baseBuildId: "b",
      sourceConfig: { front_page_slug: "home", show_on_front: "page", locale: "de_DE" },
      changedSlugs: ["home", "about"],
      tokens: { colorPalette: [{ slug: "primary", color: "#c00" }] },
    });
    expect(cfg.mode).toBe("publish_draft");
    expect(cfg.source_build_id).toBe("b");
    expect(cfg.changed_slugs).toEqual(["home", "about"]);
    expect(cfg.front_page_slug).toBe("home");
    expect(cfg.show_on_front).toBe("page");
    expect(cfg.locale).toBe("de_DE");
    expect(cfg.tokens?.colorPalette).toEqual([{ slug: "primary", color: "#c00" }]);
  });
  it("omits tokens when null", () => {
    const cfg = buildPublishDraftConfig({ draftId: "d", baseBuildId: "b", sourceConfig: {}, changedSlugs: [], tokens: null });
    expect(cfg.tokens).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `publish-draft.helpers.ts`:

```ts
import "server-only";
import { draftComponentName } from "@/lib/draft/bundle";
import { buildShellStoragePath } from "@/lib/jab/compose-site-emit";
import { carryForwardSourceConfig } from "@/lib/jab/build-config";
import type { BuildConfig } from "@/lib/jab/build-config";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

export function unitKeyToStoragePath(unitKey: string, buildId: string): string {
  if (unitKey === "shell:header") return buildShellStoragePath(buildId, "header");
  if (unitKey === "shell:footer") return buildShellStoragePath(buildId, "footer");
  return `builds/${buildId}/components/${draftComponentName(unitKey)}.tsx`;
}

export function buildPublishDraftConfig(args: {
  draftId: string;
  baseBuildId: string;
  sourceConfig: unknown;
  changedSlugs: string[];
  tokens: ThemeJsonTokens | null;
}): Extract<BuildConfig, { mode: "publish_draft" }> {
  const carried = carryForwardSourceConfig(args.sourceConfig);
  const cfg: Extract<BuildConfig, { mode: "publish_draft" }> = {
    mode: "publish_draft",
    draft_id: args.draftId,
    base_build_id: args.baseBuildId,
    source_build_id: args.baseBuildId,
    changed_slugs: args.changedSlugs,
    front_page_slug: carried.front_page_slug,
  };
  if (carried.show_on_front) cfg.show_on_front = carried.show_on_front;
  if (carried.last_sync_watermark) cfg.last_sync_watermark = carried.last_sync_watermark;
  if (carried.locale) cfg.locale = carried.locale;
  if (args.tokens) cfg.tokens = args.tokens;
  return cfg;
}
```

(`buildShellStoragePath` — confirm its module; the maps cite it at `compose-site-emit.ts:23` and it's used in `edit-site.helpers.ts shellCloneObjects`. Import from the same place `shellCloneObjects` does.)

- [ ] **Step 4: Run + commit.** Green; `feat(publish): publish-draft clone/overlay pure helpers`

---

### Task 4: The `publish-draft` worker

**Files:** Create `apps/web/lib/inngest/publish-draft-event.ts` + `apps/web/lib/inngest/functions/publish-draft.ts`; register the worker.

**Interfaces:** new event `DRAFT_PUBLISH_REQUESTED_EVENT = "draft/publish.requested"` with `{ projectId, tenantId, draftId, buildId }`. Worker `publishDraft`.

The worker mirrors the `edit-site.ts` clone sequence (blueprint = commit `82aa51f^`), but overlays the FULL draft state instead of one regenerated unit, and does NOT regenerate (compose reads the cloned+overlaid Storage). Sequence:

1. **load-draft-state** — `loadDraftVersions(draftId)` + `loadDraftSteps(draftId)` → `effectiveUnitVersions` (component/shell overrides) + `unionChangedSlugs(steps)` + `loadActiveTokenDeltas(draftId)` → merged token override (`mergeTokenDeltas` → `applyTokenOverride(baseTokens, merged)`; null when no token edits). Base tokens via `resolveThemeTokens(projects.design_tokens)`.
2. **stamp-config** — patch the build's `config` = `buildPublishDraftConfig({ draftId, baseBuildId, sourceConfig: baseBuild.config, changedSlugs, tokens })`.
3. **clone-block-inventory / clone-page-inventory** — SELECT `BLOCK_INVENTORY_CLONE_COLUMNS` / `PAGE_INVENTORY_CLONE_COLUMNS` from the base build, map `site_build_id`/`project_id` → the new build, INSERT. (Identical to edit-site.ts steps 4–5.)
4. **clone-storage** — `listAllUnderPrefix("builds/{base}/components")` + `"builds/{base}/source"` + `shellCloneObjects(base, new)`; copy each to the new build's path (fail-soft per file, as edit-site did).
5. **overlay-draft-units** — for each `[unitKey, version]` in `effectiveUnitVersions`, upload `version.tsx` to `unitKeyToStoragePath(unitKey, newBuildId)` (overwrites the cloned base file). This is the ONLY difference from edit-site's clone — instead of regenerating one unit, write all draft-patched units.
6. **dispatch-compose** — `step.sendEvent` `site/compose.requested` `{ projectId, tenantId, buildId }`. The build is `queued`; compose flips it to `composing` and the pipeline runs.

On any error: `markBuildFailed({ buildId, projectId, phase: "composing", error })` (which, per Task 8, unlocks the draft).

- [ ] **Step 1: Write the worker** (no unit test — Inngest worker, matches repo convention; the pure pieces are tested in Task 3, the clone columns by the existing completeness test). Use `edit-site.ts` (git: `git show 82aa51f^:apps/web/lib/inngest/functions/edit-site.ts`) as the structural blueprint for the clone steps; replace the single regenerate-target step with the overlay loop (step 5 above) and drop the LLM regen entirely.

- [ ] **Step 2: Register** `publishDraft` in the Inngest functions registry (alongside `draftEdit`, `composeSite`, etc.).

- [ ] **Step 3: Verify** `pnpm --filter @jab/web exec tsc --noEmit` clean.

- [ ] **Step 4: Commit.** `feat(publish): publish-draft worker — clone base + overlay draft units + dispatch compose`

---

### Task 5: Verify carry-forward for `publish_draft`

**Files:** Modify `apps/web/lib/inngest/functions/verify-fidelity.ts`; Test (the helper from Task 1 covers the branch).

- [ ] **Step 1:** Replace the `if (isEditConfig(config))` carry-forward block (~line 371) with `configCarryForwardSource(config)`:

```ts
const cf = configCarryForwardSource(config);
if (cf) {
  await step.run("carry-forward-approvals", async () => {
    const supabase = createAdminClient();
    if (await isBuildCancelled(supabase, buildId, projectId)) return { skipped: "cancelled" };
    return applyCarryForwardApprovals({ resultBuildId: buildId, sourceBuildId: cf.sourceBuildId, changedSlugs: cf.changedSlugs });
  });
}
```

(Import `configCarryForwardSource`. Drop the now-unused `isEditConfig` import if nothing else uses it.)

- [ ] **Step 2:** Add/confirm a `build-config.test.ts` case that `configCarryForwardSource` fires for publish_draft (covered in Task 1). Run `tsc` + the full suite.

- [ ] **Step 3: Commit.** `feat(publish): verify-fidelity carries approvals forward for publish_draft builds`

---

### Task 6: `publishDraftAction` + draft lock

**Files:** Create `apps/web/lib/actions/publish-draft-action.ts` + test.

**Interfaces:** `publishDraftAction(projectId): Promise<{ buildId: string }>` and `cancelPublishAction(projectId): Promise<{ ok: true } | { ok: false; error: string }>`.

`publishDraftAction`:
1. RLS-verify project membership; resolve tenant.
2. `findLiveDraft` — error if none; require ≥1 active (completed, non-undone) step (`loadDraftSteps` → `activeSteps`) — refuse "nothing to publish".
3. Concurrency: `autoFailStaleActiveBuild(projectId)` then refuse if another build is active (reuse the `evaluateEditConcurrency`/latest-build check from `requestWorkspaceEditAction`).
4. Insert `site_builds` row: `status='queued'`, `config` = a minimal placeholder (`{ mode: "publish_draft", draft_id, base_build_id, source_build_id: base_build_id, changed_slugs: [], front_page_slug: null }` — the worker fills the real config in stamp-config). Return its id.
5. CAS lock the draft: `UPDATE drafts SET status='publishing' WHERE id=draftId AND status='active'` — if 0 rows, another publish raced; throw.
6. Dispatch `draft/publish.requested` `{ projectId, tenantId, draftId, buildId }`. On dispatch failure: mark the build failed + revert draft to `active` (mirror `requestWorkspaceEditAction`'s cleanup).
7. `revalidatePath`; return `{ buildId }`.

`cancelPublishAction`: CAS `UPDATE drafts SET status='active' WHERE id=draftId AND status='publishing'`; mark the in-flight publish build cancelled (best-effort). Lets the user abandon a publish stuck at review and resume editing.

- [ ] **Step 1: Write tests** (mirror `workspace-edit.test.ts`'s mocked-supabase pattern): publish with no draft → error; with no active steps → "nothing to publish"; happy path inserts a queued publish_draft build, CAS-locks the draft to `publishing`, dispatches the event; `cancelPublishAction` flips `publishing`→`active`.

- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run + tsc. Step 5: Commit.** `feat(publish): publishDraftAction + cancelPublishAction (draft lock)`

---

### Task 7: `publishBuildAction` — commit tokens + advance draft to `published`

**Files:** Modify `apps/web/lib/actions/build-review.ts`; Test `apps/web/lib/actions/build-review.test.ts`.

- [ ] **Step 1:** In `publishBuildAction`, after the production deploy is recorded + superseded (the existing success path), add a `publish_draft` finalize block:

```ts
if (isPublishDraftConfig(build.config)) {
  const cfg = build.config;
  // Commit the brand: a token edit reaches production exactly here, never earlier.
  if (cfg.tokens) {
    const { data: proj } = await admin.from("projects").select("design_tokens").eq("id", build.project_id).single();
    const nextDt = { ...((proj?.design_tokens ?? {}) as object), themeJson: cfg.tokens };
    await admin.from("projects").update({ design_tokens: nextDt }).eq("id", build.project_id);
  }
  // Finalize the draft: a fresh draft will fork from this now-ready, now-published build.
  await admin.from("drafts").update({ status: "published" }).eq("id", cfg.draft_id).eq("status", "publishing");
}
```

(Commit tokens into the `themeJson` slot so `resolveThemeTokens` reads them as the canonical brand for future builds/drafts. Use the existing `admin` service-role client.)

- [ ] **Step 2: Test** that a publish_draft build, on publish, (a) writes `projects.design_tokens.themeJson` = `config.tokens` and (b) flips the draft to `published`; a non-publish_draft build does neither. (Extend the build-review test's mock.)

- [ ] **Step 3: Run + tsc + commit.** `feat(publish): commit draft tokens + advance draft to published on production-publish`

---

### Task 8: Unlock the draft on a `publish_draft` build failure

**Files:** Modify `apps/web/lib/inngest/shared-failure.ts` (`markBuildFailed`); Test.

- [ ] **Step 1:** In `markBuildFailed`, after marking the build failed, if the build's config `isPublishDraftConfig`, revert its draft: `UPDATE drafts SET status='active' WHERE id=config.draft_id AND status='publishing'`. (Load the build's config in `markBuildFailed`, or thread it — check the current signature; it has `{ buildId, projectId, phase, error }`, so read `config` from the build row.) This ensures a failed compose/deploy/verify unlocks the draft so the user can fix + retry. Idempotent (CAS on `publishing`).

- [ ] **Step 2: Test** that `markBuildFailed` on a publish_draft build flips its draft `publishing`→`active`; on a non-publish_draft build, touches no draft.

- [ ] **Step 3: Run + tsc + commit.** `fix(publish): unlock draft (publishing→active) when a publish build fails`

---

### Task 9: Workspace "Publish draft" UI

**Files:** Create `apps/web/app/(app)/projects/[id]/workspace/PublishDraftButton.tsx`; Modify the workspace page.

- [ ] **Step 1:** Add a `PublishDraftButton` client component shown in the edit-history panel header (next to "Discard draft") when there is ≥1 active draft step. On click → `publishDraftAction(projectId)` → `router.push("/projects/{id}/builds/{buildId}/progress")` (the existing progress page → review when ready). Show a `cancelPublishAction` affordance when the draft is `publishing` (so the user can abandon a publish). Disable + show "Publishing…" while a publish build is in flight.

- [ ] **Step 2:** Wire the workspace page to pass the draft status + active-step count to the button. (No new server data beyond what the page already loads — `loadDraftSteps`/the edit history already provide active steps; surface `draft.status`.)

- [ ] **Step 3: Run** `tsc --noEmit` + `pnpm --filter @jab/web test` (full suite green). **Commit.** `feat(publish): workspace Publish-draft button + cancel`

---

### Task 10: Documentation

**Files:** Modify `docs/superpowers/specs/2026-06-16-jab-fleet-gap-register.md` (note the publish bridge closes the production-reach residual for all draft edits incl. A3 tokens) + `CLAUDE.md` + the live-draft memory.

- [x] **Step 1:** Document the publish bridge: draft → clone base build + overlay effective units + merged token override in `config.tokens` → compose → deploy → verify → review → `publishBuildAction` (commits `projects.design_tokens` + advances draft to `published`); lifecycle `active→publishing→published` / `→active` on fail/cancel; no migration. Note it makes A3 token edits AND component/shell draft edits reach production.

- [x] **Step 2: Commit.** `docs(publish): record the Live Draft publish bridge`

---

## Operator step at merge

None — **no migration**. (Verify `drafts.status` CHECK already allows `publishing`/`published` on both Supabase projects — it does, per migration 0035; no DDL.)

## Validation (operator, post-merge)

The worker host is a production build reading `.env.local` (see saas-worker-host-prod-build). After merge + rebuild: make a token + a component edit in a Two Roads draft, click Publish, watch the progress → review screen (per-page fidelity + approve), publish to production, confirm the production site shows the edits and `projects.design_tokens` reflects the token change. Then confirm a fresh `active` draft forked from the new build. Test the unhappy path: cancel a publish at review → draft returns to `active`, edits intact.

## Out of scope (documented residuals)

- **Concurrent edit during publish** is intentionally blocked (draft locked to `publishing`); a user who wants to change something cancels the publish, edits, re-publishes.
- **Partial publish** (publish a subset of edits) — out of scope; publish snapshots the whole effective draft.
- **Per-build token isolation for non-publish_draft builds** — only publish_draft carries `config.tokens`; full/edit builds are unchanged.
```

