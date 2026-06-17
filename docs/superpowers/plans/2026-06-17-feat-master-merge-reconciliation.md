# feat/saas-e2e-loop → master Merge Reconciliation Plan

> **For the executing session:** this is a one-shot merge-execution plan, not a TDD feature plan. Work the ordered steps; the **Resolution table** is the source of truth for every conflicted path. Grounded in a 10-agent read-only 3-way analysis (workflow `w6ngd8s22`, 2026-06-17) over merge-base `32ae385`.

**Goal:** Land the 43 commits of `feat/saas-e2e-loop` (Live-Draft edit system + the 3 fleet-gap fixes executed 2026-06-17) onto `master` without regressing master's 97-commit line (the AI-call-optimization campaign + the draft renderer), producing a green `tsc --noEmit` + full `@jab/web` suite before the merge commit is finalized.

**Architecture of the divergence (the key insight):** the two lines are ~95 % **additive, not competing**. Master owns the AI-opt machinery — per-task model resolution (`getModelFor`), the shared SDK singleton (`getAnthropicClient`), the cached-prefix prompt split (`cachedSystemPrefix`), Message-Batch waves, the retry/`GenerationFailureKind` taxonomy, cross-build component reuse — almost entirely in files **the branch never touched**. The branch owns a **new edit path** (`draft-edit.ts` replaces `edit-site.ts`; build/verify once at publish) plus **small additive prompt/inventory deltas**. So the rule is: **base every AI-opt file on master and re-apply the branch's small deltas on top; take the branch wholesale for the draft-edit-system files and honor the `edit-site.ts` deletion.**

**Merge direction:** merge `feat/saas-e2e-loop` **INTO** `master` (master is the trunk).

---

## Global Constraints

- **Master's AI-opt campaign MUST survive intact.** Resolving any AI-opt file to "theirs/branch" silently reverts the campaign with **no compile error** — full pre-campaign token cost, no prompt caching, no batch path. This is the #1 failure mode. The AI-opt-bearing files are: `model.ts`, `client.ts`, `model-client.ts` (+test), `component-generator.ts` (+test), `edit-planner.ts` (+test), `generate-components.ts`, `generate-shell.ts`, `shell-prompts.ts`, `edit-cost-guard.ts`, `batch-client.ts`, `component-batch.ts`, `component-carry-forward.ts`, `sonnet-warmup.ts`, and `schema.ts`'s migration-0034 `block_inventory` columns.
- **The branch's Live-Draft edit path is the newer direction.** `edit-site.ts` is DELETED; `draft-edit.ts` replaces it; per-edit compose/deploy/verify is gone (build/verify happen once at publish).
- **Errors are loud.** The merged tree must `tsc --noEmit` clean and pass the full `pnpm --filter @jab/web test` suite **before** the merge commit is finalized. No swallowed conflict markers.
- **No push.** Produce a local merge commit on `master` only. Do not push or open a PR unless explicitly asked afterward. (`master` is currently ~286 commits ahead of `origin/master`; that is pre-existing and out of scope.)
- **Two Supabase projects** — local `ajfurojjxthhzkjqttri` ("JAB WP") + prod `celzwcxkrmsbwiswkxug` ("jab-prod"). Migration reconciliation (master's 0034 + branch's 0035) is a **separate, explicit step** (see §Migrations); the git merge does not apply DB changes.
- **No worktree on disk currently holds `master`** (main checkout is on `feat/saas-e2e-loop`; three unrelated `worktree-*` exist). The merge runs in the main checkout after switching to `master`, OR in a fresh dedicated worktree (see §Execution, step 1 for the trade-off).

---

## Resolution Table (source of truth)

Legend — **base=master, re-apply branch** = start from master's file, port the branch's small delta on top; **take branch** = accept the branch's file wholesale; **take master** = accept master's wholesale; **delete** = honor the branch's removal; **add (branch-only)** = file absent on master, bring it in.

| Path | Conflict | Resolution |
| --- | --- | --- |
| `apps/web/lib/ai/component-generator.ts` | content | **base=master, re-apply branch.** Keep master's `COMPONENT_SYSTEM_CORE`/`buildPerBuildSystemPrompt` split, `cachedSystemPrefix` call, `MAX_TOKENS_BY_TIER` raised-cap retry, `classifyAiError`/`isRetryableAiFailure` taxonomy, `GenerationFailureKind`, `buildRetryUserSuffix`, `buildComponentRequestParts`, batch helpers (`finalizeBatchGeneration`/`failedBatchComponent`/`mergeUsageIntoComponent`/`addUsage`/`ZERO_GENERATE_USAGE`). Re-apply branch: `import { rankThemeClassesForUnit } from "@/lib/jab/dead-class-detect"`; add optional trailing `themeClassNames?: string[]` to the five prompt builders + `GenerateComponentOptions` + `buildPerBuildSystemPrompt(tokens, sourceHost?, themeClassNames?)`; **render `renderBlockThemeClassSection(themeClassNames ?? [])` into `buildPerBuildSystemPrompt` (UNCACHED) — NOT into `COMPONENT_SYSTEM_CORE`** (cache hygiene); compute `rankThemeClassesForUnit({themeClassNames, sourceDom: entry.sourceDomSample})` per builder; forward `opts.themeClassNames` from `buildComponentRequestParts`. Port the branch's **softened `renderDomSampleSection` + acf_flex guidance** ("PREFER reusing it verbatim…") replacing master's "Translate … to Tailwind" wording. **Bump `COMPONENT_PROMPT_VERSION` 2 → 3.** |
| `apps/web/lib/ai/component-generator.test.ts` | add-add (tail) | **union.** Keep master's full import list + all master describe blocks; append the branch's `describe("block prompt — theme-class inventory + softened DOM directive + hex rule")`. Update master's `expect(COMPONENT_PROMPT_VERSION).toBe(2)` → `3`. Fix the branch's hex test: either relax its regex to `/Match by hex value/` **or** put the exact `Match by hex value, not by semantic name.` sentence in `buildPerBuildSystemPrompt`'s token section (master's differently-worded copy lives in `COMPONENT_SYSTEM_CORE`, which `visualPrompt` does not embed). |
| `apps/web/lib/ai/edit-planner.ts` | content | **base=master, re-apply branch (clean union — disjoint regions).** Keep master's `getModelFor("planner")`, `getAnthropicClient` singleton, `stableHeadSlice`, prompt-cache breakpoints, `PLANNER_COST_CAP_TOKENS` cost cap, max_tokens retry, `PlannerCallMeta`/`plannerMeta`. Re-apply branch: replace **only** `buildSystemPrompt`'s block-line `.map(...)` body with the `on ${pageCountIsFloor ? "at least " : ""}${pageCount} page(s)` phrasing, and add `export function buildSystemPromptForTest(siteMap: SiteMap): string`. Do **not** port the branch's stale `planEdit`/`AnthropicPlannerClient`/`PLANNER_MODEL`/imports. |
| `apps/web/lib/ai/edit-planner.test.ts` | content | **base=master.** Add `buildSystemPromptForTest` to the `./edit-planner` import; append the branch's `describe("buildSystemPrompt blast radius")`; add `pageCount` + `pageCountIsFloor` to **every** `blockTypes` fixture literal in the merged file (required fields after site-map.ts). |
| `apps/web/lib/draft/artifacts.ts` | content | **take branch** (strict superset: same `text/plain` MIME fix master shipped, plus `draftArtifactPath`/`VersionedArtifactArgs`/`buildVersionedDraftArtifacts` and the `resolveThemeTokens` scraped-token parity in `loadProjectMeta`). Comment wording is the only real overlap — keep either. |
| `apps/web/lib/inngest/functions/generate-components.ts` | content | **base=master, re-apply branch.** Keep master's warm-up, `JAB_BATCH_GENERATE` wave path, `JAB_COMPONENT_REUSE` carry-forward, `getModelFor`-by-tier, `reusedCount`, `processEntries`. Re-apply branch: `import { extractThemeClassNames } from "@/lib/ai/shell-prompts"`; insert the `load-theme-classes` `step.run` (UNCAPPED `extractThemeClassNames(sheets, Number.MAX_SAFE_INTEGER)`) after `load-tokens`; thread `themeClassNames` into **BOTH** the sync `generateComponent({…})` call **and** the batch-path `optionsForEntry` builder (so sync ≠ batch drift cannot happen). |
| `apps/web/lib/inngest/functions/edit-site.ts` | **modify/delete** | **delete** (honor branch deletion). `draft-edit.ts` is a complete functional replacement; master's only net-new logic here (`shellCloneObjects` shell-clone) is meaningless under the draft model (no per-edit build) and must NOT be ported. |
| `apps/web/lib/inngest/functions/edit-site.helpers.ts` | content (additive both sides) | **take branch** — keep `listAllUnderPrefix` (relocated here) + `SITE_SCREENSHOTS_BUCKET` import; **drop** master's `shellCloneObjects` + its `buildShellStoragePath` import (no caller after `edit-site.ts` deletion). Keep `loadSourcePagesForImpact` (used by `draft-edit.ts`) and `applyCarryForwardApprovals` (used by `verify-fidelity.ts`). |
| `apps/web/lib/inngest/functions/edit-site.helpers.test.ts` | (auto / one-sided) | **take branch** (no `shellCloneObjects` import/describe). NOTE the schema-completeness test still needs master's `block_inventory` columns — those come from `schema.ts` (auto-merged, master side). If the merged `helpers.test.ts` `EXCLUDED` set is the branch's older one, **add** the 4 migration-0034 columns (`input_tokens_cache_creation`, `failure_kind`, `prompt_inputs_hash`, `reused_from_build_id`) so the schema-derived test passes. |
| `apps/web/app/api/draft/[projectId]/page/route.ts` | add-add | **take branch** (newer iteration: `findLiveDraft` → `base_build_id`, CORS `Access-Control-Allow-Origin:*` + `Cache-Control:no-store` for the sandboxed null-origin iframe, raw `DraftPageDataResult` pass-through with `error→500`). Then port **one line** from master: `export const dynamic = "force-dynamic";` after the imports. |
| `apps/web/middleware.ts` | content (convergent) | **identical array on both sides** (`"/draft"` + `"/api/draft"` added to `PUBLIC_ROUTES`); keep the branch's more-detailed comment. Preserve BOTH path entries. |
| `apps/web/next.config.ts` | content (add-add key) | **take master** — `serverExternalPackages: ["esbuild","postcss","tailwindcss"]` is a strict superset of the branch's `["esbuild"]` and is **required** by the branch's own `lib/draft/css.ts` + `lib/jab/dead-class-detect.ts` (both runtime-import postcss/tailwind). |

### Companion files (auto-merge or one-sided — verify, don't assume)

| Path | Action | Why it matters |
| --- | --- | --- |
| `apps/web/lib/jab/site-map.ts` | **take branch** | Adds `SiteMapBlockType.pageCount`/`pageCountIsFloor` (REQUIRED) + `MAX_PAGE_SLUGS_PER_BLOCK` cap + Storage-listing shell detection. Merged `edit-planner.ts` `buildSystemPrompt` **will not compile** without it. Master left it at base. |
| `apps/web/lib/actions/discard-edit.ts` | **take branch import path** | Must import `listAllUnderPrefix` from `@/lib/inngest/functions/edit-site.helpers` (branch), NOT `…/edit-site` (master) — else dangling import the instant `edit-site.ts` is deleted. **Load-bearing.** |
| `apps/web/app/api/inngest/route.ts` | branch (auto — master untouched) | Must register `draftEdit`, never `editSite`. Verify exactly one consumer of `EDIT_REQUESTED_EVENT`; no stray `editSite` import. |
| `apps/web/lib/ai/patch-component.ts` | **add (branch-only) + fix** | Branch-only LLM patch primitive. **Hard compile break to fix:** its `client.generate({…, cacheSystemPrompt: attempt === 0})` uses the deleted merge-base field. Change to master's API — simplest safe form: `systemPrompt: prompt.system` always, drop the `cacheSystemPrompt` field (optionally `cachedSystemPrefix: attempt === 0 ? prompt.system : undefined`). Already carries today's css-parity `sourceHosts`/`routePathMap`/`rewriteWpOriginUrls` + the tenant-scoping nit fix — those ride along. |
| `apps/web/lib/inngest/functions/draft-edit.ts` (+ `.test.ts`) | **add (branch-only)** | The replacement worker; already AI-opt-correct (constructs its client via `modelClientForTier`). |
| `apps/web/lib/db/drafts.ts` | **add (branch-only)** | `ensureActiveDraft`/`findLiveDraft`/version helpers; imported by the draft route + worker. Absent on master — must land or tsc fails. |
| `apps/web/lib/jab/dead-class-detect.ts` (+ `.test.ts`) | **add (branch-only)** | The dead-class oracle + `rankThemeClassesForUnit`; imported by merged `component-generator.ts`. Imports `tailwindExtendFromTokens` (exists on master). |
| `apps/web/lib/draft/css.ts`, `apps/web/lib/draft/runtime/media-image.tsx` (+test), `apps/web/vitest.config.ts` | branch (one-sided — master untouched) | Today's Plan 3 (preflight base, inline image shim, the `lib/**/*.test.tsx` include glob). Not in the conflict set. |
| `apps/web/lib/draft/page-data.ts` | **take branch** | Branch passes the real `projects.manifest` into `loadDynamicListSpecs`; master untouched. The draft route depends on branch behavior. |
| `apps/web/lib/db/schema.ts` | auto-merge (verify both) | Must keep master's `block_inventory` migration-0034 columns AND the branch's `drafts`/`draft_unit_versions` tables. Both sides additive in different regions → auto-merges; confirm both survive. |
| `apps/web/lib/actions/workspace-edit.ts` | auto-merge (verify) | Not a merge-tree conflict, but master added a `.not("result_build_id","is",null)` guard on the `edit_in_review` query; confirm that guard survives and the payload still satisfies `draftEdit`. |
| `apps/web/lib/jab/edit-plan.ts` (+ `.test.ts`), `apps/web/lib/ai/generated-tsx-postprocess.ts` | auto-merge (verify) | In the overlapping set but merge-tree auto-merged them. Spot-check the result. |

### Known dead-but-harmless residue (do NOT chase during the merge)
`lib/jab/regenerate-unit.ts` (orphaned once `edit-site.ts` is gone), `compose-site.ts`/`verify-fidelity.ts`/`build-review.ts` `isEditConfig` branches, `build-config.ts` `mode:"edit"`, `edit-site.smoke.ts` — all pre-existing branch cleanup debt. `git grep` will surface edit-mode symbols after the merge; that is **not** evidence the delete was unsafe. The correctness invariant is: nothing dispatches `site/compose.requested` with a `mode:"edit"` config (only `generateComponents` dispatches compose, for full builds).

---

## Execution Sequence

**Step 0 — Safety net.** Tag the current branch tip and master tip so any mistake is trivially reversible:
```
git tag premerge-feat-2026-06-17 feat/saas-e2e-loop
git tag premerge-master-2026-06-17 master
```

**Step 1 — Choose the merge surface.** Recommended: a dedicated worktree to keep the main checkout untouched and isolate the (large) master checkout:
```
git worktree add ../wph-merge master
```
Then `pnpm install` in `../wph-merge` (fresh worktree has no `node_modules`; master's AI-opt campaign may have added deps). Alternative (no worktree): `git checkout master` in the main checkout + `pnpm install`. Either way you end up on `master` with deps synced. *(Note the per-worktree install cost; it buys isolation + a guaranteed-correct master `node_modules`.)*

**Step 2 — Start the merge (no commit yet).**
```
git merge --no-commit --no-ff feat/saas-e2e-loop
```
Expect the 10 conflicts from the Resolution table plus the `edit-site.ts` modify/delete.

**Step 3 — Resolve each conflicted path per the Resolution table.** Order: do the **delete** + **take branch** + **take master** files first (mechanical), then the four **base=master, re-apply branch** files (judgment), then the companion-file verifications.
- `git rm apps/web/lib/inngest/functions/edit-site.ts` (honor delete).
- For "take branch": `git checkout --theirs <path> && git add <path>` (artifacts.ts, edit-site.helpers.ts, the draft page route then add the `dynamic` line, page-data.ts, site-map.ts).
- For "take master": `git checkout --ours <path> && git add <path>` (next.config.ts).
- For the four re-apply files + the test files + middleware: hand-edit to the table's spec, then `git add`.
- Fix `patch-component.ts`'s `cacheSystemPrompt` field (it is added cleanly by the merge but won't compile against master's `model-client.ts`).
- Repoint `discard-edit.ts`'s import to `edit-site.helpers`.

**Step 4 — Sanity grep before building.**
```
git grep -n 'functions/edit-site"' apps/web        # expect ZERO (only edit-site.helpers / .smoke allowed)
git grep -n 'cacheSystemPrompt' apps/web           # expect ZERO in source
git grep -n '<<<<<<<\|>>>>>>>\|=======' apps/web    # expect ZERO conflict markers
```

**Step 5 — Typecheck, then full suite.**
```
pnpm --filter @jab/web typecheck      # tsc --noEmit, must exit 0
pnpm --filter @jab/web test           # full suite, must be all-green
```
Fix compile/test fallout strictly per the Resolution-table intent (the most likely failures are: missing `pageCount` on a stray `SiteMapBlockType` fixture; the hex regex; `COMPONENT_PROMPT_VERSION` assertion; a dangling `edit-site` import). If a failure implies a table decision was wrong, STOP and surface it — do not improvise an architectural change.

**Step 6 — Finalize the merge commit.**
```
git commit            # merge commit; body summarizes the reconciliation + this plan path
```
(If a worktree was used: the commit is already on `master`; remove the worktree with `git worktree remove ../wph-merge` once verified.)

**Step 7 — Report.** Summarize: conflicts resolved, suite/typecheck status, the dead-but-harmless residue list, and the migration follow-up (§Migrations) — then await direction on push.

---

## Migrations (separate from the git merge)

Master shipped **migration 0034** (`block_inventory` columns: `input_tokens_cache_creation`, `failure_kind`, `prompt_inputs_hash`, `reused_from_build_id`). The branch shipped **migration 0035** (`drafts`, `draft_unit_versions`, `workspace_edits` draft linkage). The merge-tree showed **no migration-file conflict** (different filenames), so both land on disk cleanly. Before exercising the merged app:
1. Enumerate `apps/web/.../migrations` (or `supabase/migrations`) on the merged tree; confirm there is **no 0034/0035 number collision** (master's 0034 vs any branch 0034) and that 0035 does not assume a different 0034 than master's.
2. Confirm/apply **0034 then 0035** to **both** Supabase projects (local `ajfurojjxthhzkjqttri` + prod `celzwcxkrmsbwiswkxug`) — per the standing rule that every migration goes to both. Verify via schema inspection (ledger rows may be absent on dashboard-applied migrations).
3. This is a post-merge operational step; it does **not** gate the merge commit, but it gates running the merged app.

---

## Rollback

If anything goes wrong before Step 6's commit: `git merge --abort` (restores master cleanly). After the commit, before any push: `git reset --hard premerge-master-2026-06-17` on master restores the pre-merge tip; the branch is untouched (`premerge-feat-2026-06-17`). Because nothing is pushed, rollback is fully local and lossless.

---

## Self-Review

**Coverage:** every merge-tree conflict (10 files / 8 groups) has a row; the `edit-site.ts` modify/delete is resolved with an architectural rationale (delete, confirmed by the dispatch-authority analysis: only `route.ts` registers workers and it auto-takes the branch's `draftEdit`); all branch-only files the conflicts depend on (`dead-class-detect.ts`, `draft-edit.ts`, `drafts.ts`, `patch-component.ts`) are listed as adds; the AI-opt files the branch never touched are pinned to master.

**Top risks, mitigated:** (1) silent AI-opt revert → "base=master" rule + the `git grep cacheSystemPrompt` gate + the full suite; (2) cache-hygiene regression → theme-class section into `buildPerBuildSystemPrompt` (uncached) + `COMPONENT_PROMPT_VERSION` 2→3; (3) batch/sync drift → thread `themeClassNames` into both call sites; (4) dangling `edit-site` import → `discard-edit.ts` repoint + the `git grep functions/edit-site"` gate; (5) `SiteMapBlockType` required-field fan-out → typecheck catches every fixture.

**Not resolved here (flagged, out of scope):** the dead-but-harmless edit-mode residue (separate cleanup); migration application to the two Supabase projects (operational, §Migrations); whether to push / open a PR afterward (your call).
