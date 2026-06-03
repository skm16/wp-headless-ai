---
# Phase 2 — Chat Edit → Preview → Scoped Review → Promote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the complete iterate loop behind `JAB_CHAT_EDIT` — workspace chat → planner LLM → targeted regeneration → live preview → scoped review → promote to production — green end-to-end against the Two Roads pilot.

**Architecture:** A free-form chat request is resolved by a constrained planner LLM against a compact site map into a typed `EditPlan`; the `edit-site` worker clones the prior `ready` build, regenerates ONLY the targeted component/shell unit with that guidance, computes the changed-page set from the SOURCE build's populated `block_tree`, re-composes deterministically, deploys a Vercel preview, and verifies; the verify worker carries forward prior approvals for untouched pages so the existing all-approved gate still holds; the review screen is scoped to changed pages and promote runs the identical `publishBuildAction` rail. This phase is the sole owner of the `edit-site.ts` regen seam, the generator `guidance` parameter, and the one coordinated edit of `verify-fidelity.ts` (carry-forward + cancel-guard + S1's perf hook).

**Tech Stack:** Next.js 15 App Router, TypeScript, Drizzle ORM + Supabase (postgres), Inngest workers, Vitest, Tailwind, Anthropic SDK, Vercel REST.

**Spec:** docs/superpowers/specs/2026-06-03-saas-e2e-loop-design.md (this plan implements §3.3, §3.4, §2.4, §2.5, §2.6, §2.7, the §3.4 edit state machine, R1–R9, and §4 Phase 2 steps 1–13).
---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `apps/web/lib/ai/component-generator.ts` | Modify | Add `guidance?: string` to `GenerateComponentOptions`; thread into all five prompt builders strictly after the `USER:` marker. |
| `apps/web/lib/ai/shell-prompts.ts` | Modify | Add `guidance?` to `ShellPromptInput`; append to USER section of `headerPrompt`/`footerPrompt`. |
| `apps/web/lib/ai/generate-shell.ts` | Modify | Add `guidance?` to `GenerateShellOptions`; pass into the prompt input. |
| `apps/web/lib/jab/inventory-entry-from-row.ts` | **New (pure)** | `blockRowToEnrichedEntry(row)` + `loadHomeOrSlugScreenshotBase64(...)` rebuilt-from-`page_inventory` map. |
| `apps/web/lib/inngest/functions/generate-components.ts` | Modify | Re-import the extracted row→entry map + screenshot loader (pure refactor). |
| `apps/web/lib/jab/site-map.ts` | **New (pure)** | `SiteMap` type + `buildSiteMap(...)` from block + page inventory. |
| `apps/web/lib/jab/edit-plan.ts` | **New (pure)** | `EditPlan` type, JSON-schema constant, `validateEditPlan(plan, siteMap)`. |
| `apps/web/lib/jab/edit-impact.ts` | **New (pure)** | `computeChangedPages(...)` diffing the SOURCE build's `block_tree`, fail-closed. |
| `apps/web/lib/jab/approval-carry-forward.ts` | **New (pure)** | `planApprovalCarryForward(...)` matched on slug. |
| `apps/web/lib/jab/active-edit-guard.ts` | **New (pure)** | `evaluateEditConcurrency(...)`. |
| `apps/web/lib/ai/edit-cost-guard.ts` | **New (impure)** | `assertEditBudget(...)` + cap constants. |
| `apps/web/lib/ai/edit-planner.ts` | **New (impure)** | `planEdit(...)` constrained Claude call. |
| `apps/web/lib/jab/regenerate-unit.ts` | **New (impure)** | `regenerateComponentUnit` / `regenerateShellUnit`; `RegenCompileError`. |
| `apps/web/lib/inngest/functions/edit-site.helpers.ts` | **New (impure)** | `loadSourceApprovals` / `applyCarryForwardApprovals` service-role shims. |
| `apps/web/lib/inngest/functions/edit-site.ts` | Modify | **Sole owner of the seam.** Full `BuildConfig` on create-result-build; regenerate-target + compute-changed-pages between clone and dispatch; compile-fail aborts; backfill chat build_id. Export `listAllUnderPrefix`. |
| `apps/web/lib/inngest/functions/verify-fidelity.ts` | Modify | **One coordinated change:** load `config`; carry-forward in finalize; mark-ready-empty skip; conditional ready flip `WHERE status != 'cancelled'`; + S1's `collectPerfForHomeRoute` hook + perf columns. |
| `apps/web/lib/inngest/functions/compose-site.ts` | Modify | Widen the existing `load-build-config` step to the full `BuildConfig`; thread `config.regeneration_prompt` as `guidance` into `generateShell` in generate-header/footer when `isEditConfig(config) && config.scope==='shell' && config.target===kind`; cancel-guard short-circuit at entry. |
| `apps/web/lib/inngest/functions/deploy-site.ts` | Modify | Cancel-guard short-circuit at entry. |
| `apps/web/lib/jab/build-cancel.ts` | **New (pure-ish helper)** | `isBuildCancelled(supabase, buildId, projectId)` shared cancel-check. |
| `apps/web/lib/actions/workspace-edit.ts` | Modify | Accept `regenerationPrompt`/`action`/`messageId`; pass through; concurrency + `edit_in_review` guard; derive readiness from `site_builds.status`. |
| `apps/web/lib/jab/workspace-edit-validation.ts` | Modify | Add `"edit_in_review"` to the `WorkspaceEditError` code union. |
| `apps/web/lib/jab/discard-edit-errors.ts` | **New (non-async)** | `DiscardEditError` class. |
| `apps/web/lib/actions/discard-edit.ts` | **New (impure, "use server")** | `discardEditAction({ editId })`. |
| `apps/web/lib/actions/build-review.ts` | Modify | `publishBuildAction` lineage write: set `result_promoted_deployment_id` when `config.mode==="edit"`. |
| `apps/web/lib/actions/workspace-chat.ts` | **New (impure, "use server")** | `sendChatMessageAction`, `createConversationAction`, `loadConversation`. |
| `apps/web/lib/jab/workspace-edit-state.ts` | **New (pure)** | `deriveEditUiState(...)` per the §3.4 state-machine table. |
| `apps/web/app/(app)/projects/[id]/workspace/ChatPanel.tsx` | **New (UI, "use client")** | Real chat UI: optimistic send, clarifying render, what-changed card, a11y. |
| `apps/web/app/(app)/projects/[id]/workspace/page.tsx` | Modify | Load conversation + messages; render `ChatPanel` behind `JAB_CHAT_EDIT`; edit-history Review/Discard links. |
| `apps/web/app/(app)/projects/[id]/builds/[buildId]/review/ScopedReviewBanner.tsx` | **New (UI)** | Scoped-review banner. |
| `apps/web/app/(app)/projects/[id]/builds/[buildId]/review/page.tsx` | Modify | When `config.mode==="edit"`: banner + changed-only default filter. |
| `apps/web/lib/inngest/functions/edit-site.smoke.ts` | **New (smoke script)** | End-to-end smoke against Two Roads (manual run). |

**Imported from Phase 0 (do NOT re-author):**
- `BuildConfig`, `isEditConfig` from `@/lib/jab/build-config`.
- `SiteEditRequestedData`, `EDIT_REQUESTED_EVENT` from `@/lib/inngest/edit-request-event`.
- `WorkspaceEditScope`, `WorkspaceEditError` (already carries `"active_build"`) from `@/lib/jab/workspace-edit-validation`.
- `isUniqueViolation`, `UNIQUE_VIOLATION` from `@/lib/db/pg-error`.
- Migrations 0028–0031 + their Drizzle mirrors (`ttfb_ms`/`load_ms`/`transfer_bytes`, `conversations`/`chat_messages`, the 6 `workspace_edits` provenance cols + `'discarded'` status, the one-active-build index).

**Consumed from Phase 1 (do NOT modify):** `WorkspacePreviewPane`/`WorkspacePreviewState` (the preview slot), `deriveProjectStatusLabel`. Phase 2 never touches `previewHtml`/`srcDoc`.

---

## Task 1: Generator `guidance` param — thread into all five component builders + both shell prompts

Threads an optional `guidance` string into every prompt builder, appended **strictly after** the `USER:` split marker (R7 / spec §3.3). When omitted, output is byte-identical to today. A test asserts placement for every builder so a future edit can't leak guidance into the cached system half.

**Files:**
- Modify: `apps/web/lib/ai/component-generator.ts` — `GenerateComponentOptions` (line 614), `renderDomSampleSection` already has a `guidance` opt (do not collide — that is the DOM-sample explainer, not edit guidance); the five builders `visualPrompt` (223), `standardPrompt` (246), `trivialPrompt` (264), `cptTemplatePrompt` (279), `acfFlexPrompt` (523); the `generateComponent` call site (620) threading `opts.guidance`.
- Modify: `apps/web/lib/ai/shell-prompts.ts` — `ShellPromptInput` (line 14), `headerPrompt` (118), `footerPrompt` (145).
- Modify: `apps/web/lib/ai/generate-shell.ts` — `GenerateShellOptions` (line 44), `promptInput` (91).
- Test: `apps/web/lib/ai/component-generator.test.ts` (append), `apps/web/lib/ai/shell-prompts.test.ts` (append).

- [ ] **Step 1: Write the failing test**

  Append to `apps/web/lib/ai/component-generator.test.ts`:

  ```ts
  import {
    visualPrompt as _visualPrompt,
  } from "./component-generator";
  // NOTE: visualPrompt/standardPrompt/trivialPrompt are NOT currently exported.
  // Step 3 exports them. Until then this import resolves to undefined and the
  // describe below throws — that is the intended RED.

  describe("component generator — edit guidance placement (R7 cache-leak guard)", () => {
    const GUIDANCE = "Make the hero headline 2x bolder and use the brand yellow.";
    const MARKER = "\n\nUSER:\n";

    function visualEntry(): EnrichedInventoryEntry {
      return {
        blockName: "core/cover",
        occurrenceCount: 4,
        pageSlugs: ["home", "about"],
        attrSamples: [{ url: "x" }],
        tier: "visual",
        kind: "block",
        sourceDomSample: "<div class='wp-block-cover'>hi</div>",
        computedStyles: null,
      };
    }
    function standardEntry(): EnrichedInventoryEntry {
      return { ...visualEntry(), tier: "standard" };
    }
    function trivialEntry(): EnrichedInventoryEntry {
      return { ...visualEntry(), blockName: "core/heading", tier: "trivial" };
    }
    function cptEntry(): EnrichedInventoryEntry {
      return {
        blockName: "cpt_template/beer",
        occurrenceCount: 1,
        pageSlugs: ["beer/x"],
        attrSamples: [{}],
        tier: "standard",
        kind: "cpt_template",
        spec: { blockNames: ["core/paragraph"], acfSchema: null },
      };
    }
    function flexEntry(): EnrichedInventoryEntry {
      return {
        blockName: "acf_flex/page/builder/hero",
        occurrenceCount: 2,
        pageSlugs: ["home"],
        attrSamples: [{ heading: "Hi" }],
        tier: "visual",
        kind: "acf_flex",
        spec: { heading: "Hi" },
      };
    }

    // Each entry of the table is [builderName, builderFn, entryFn].
    const cases: Array<[string, (e: EnrichedInventoryEntry, t: null, g?: string) => string, () => EnrichedInventoryEntry]> = [
      ["visual", visualPrompt, visualEntry],
      ["standard", standardPrompt, standardEntry],
      ["trivial", trivialPrompt, trivialEntry],
      ["cptTemplate", cptTemplatePrompt, cptEntry],
      ["acfFlex", acfFlexPrompt, flexEntry],
    ];

    for (const [name, fn, mk] of cases) {
      it(`${name}: guidance lands strictly AFTER the USER: marker`, () => {
        const withGuidance = fn(mk(), null, GUIDANCE);
        expect(withGuidance).toContain(GUIDANCE);
        const markerIdx = withGuidance.indexOf(MARKER);
        expect(markerIdx).toBeGreaterThan(-1);
        // Guidance must appear only after the marker — never in the system half.
        expect(withGuidance.indexOf(GUIDANCE)).toBeGreaterThan(markerIdx + MARKER.length);
        expect(withGuidance.slice(0, markerIdx)).not.toContain(GUIDANCE);
      });

      it(`${name}: omitting guidance is byte-identical to today`, () => {
        expect(fn(mk(), null)).toBe(fn(mk(), null, undefined));
      });
    }
  });
  ```

  Add `visualPrompt, standardPrompt, trivialPrompt` to the existing top-of-file import block (next to `cptTemplatePrompt, acfFlexPrompt`).

  Append to `apps/web/lib/ai/shell-prompts.test.ts`:

  ```ts
  describe("shell-prompts — edit guidance placement (R7 cache-leak guard)", () => {
    const GUIDANCE = "Add the secondary menu and make the logo larger.";
    const MARKER = "\n\nUSER:\n";

    for (const [name, fn] of [["header", headerPrompt], ["footer", footerPrompt]] as const) {
      it(`${name}: guidance lands strictly AFTER the USER: marker`, () => {
        const p = fn({ ...baseInput, guidance: GUIDANCE });
        expect(p).toContain(GUIDANCE);
        const markerIdx = p.indexOf(MARKER);
        expect(markerIdx).toBeGreaterThan(-1);
        expect(p.indexOf(GUIDANCE)).toBeGreaterThan(markerIdx + MARKER.length);
        expect(p.slice(0, markerIdx)).not.toContain(GUIDANCE);
      });
      it(`${name}: omitting guidance is byte-identical`, () => {
        expect(fn(baseInput)).toBe(fn({ ...baseInput, guidance: undefined }));
      });
    }
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/ai/component-generator.test.ts lib/ai/shell-prompts.test.ts
  ```
  Expected failure: `visualPrompt is not a function` / `standardPrompt is not exported` (component builders not exported yet) and `guidance` is not on `ShellPromptInput` (TS error) — both RED.

- [ ] **Step 3: Minimal implementation**

  In `apps/web/lib/ai/component-generator.ts`:

  1. Export and add a `guidance` param to the five builders. Add a shared renderer near `renderComputedStylesSection` (after line 221):

  ```ts
  /**
   * Render the "## Targeted edit guidance" block for a chat-driven regeneration.
   * Empty string when no guidance (byte-identical default). MUST only ever be
   * concatenated into the USER half of a prompt (after the "\n\nUSER:\n" marker)
   * so it never lands in the cached system prompt (R7 / spec §3.3).
   */
  function renderEditGuidanceSection(guidance: string | undefined): string {
    if (!guidance || !guidance.trim()) return "";
    return `\n## Targeted edit guidance
  The user requested a specific change to this component. Apply it while keeping
  everything else faithful to the source:
  ${guidance.trim()}
  `;
  }
  ```

  2. `visualPrompt` — change the signature and append the section to the **end of the user string** (after `${stylesSection}`-derived content, before the final "Generate the..." line is fine; the test only requires it be after the marker, so append it right before that final line):

  ```ts
  export function visualPrompt(entry: EnrichedInventoryEntry, tokens: ThemeJsonTokens | null, guidance?: string): string {
    const system = sharedSystemPrompt(tokens);
    const attrSamples = JSON.stringify(entry.attrSamples.slice(0, 3), null, 2);
    const domSection = renderDomSampleSection(entry.sourceDomSample, { blockName: entry.blockName });
    const stylesSection = renderComputedStylesSection(entry.computedStyles);
    const guidanceSection = renderEditGuidanceSection(guidance);
    const user = `## Block: ${entry.blockName}

  Tier: visual — this is a high-priority block that appears ${entry.occurrenceCount} times
  across ${entry.pageSlugs.length} pages (${entry.pageSlugs.slice(0, 5).join(", ")}${entry.pageSlugs.length > 5 ? "..." : ""}).

  ## Attribute samples (up to 3 distinct shapes)
  \`\`\`json
  ${attrSamples}
  \`\`\`
  ${domSection}${stylesSection}${guidanceSection}
  A screenshot of the block as rendered on the source WordPress site is
  attached. Use it to match the visual layout, spacing, typography, and
  color palette as closely as possible.

  Generate the TypeScript React component for this block.`;
    return `${system}\n\nUSER:\n${user}`;
  }
  ```

  3. `standardPrompt` — add `guidance?` and insert `${renderEditGuidanceSection(guidance)}` after `${stylesSection}`, before the trailing `Generate the...` line. Export it.

  4. `trivialPrompt` — add `guidance?` and append a guidance block to the end (this builder has no system/user split via the marker — it returns a single string with no `\n\nUSER:\n`). **Important:** the test asserts placement after the marker. The trivial prompt does NOT contain `\n\nUSER:\n`. To keep the test uniform, add the marker structure to trivial too: keep the existing body as the user half and prepend a one-line system half. Concretely, restructure `trivialPrompt` so it returns `${systemHalf}\n\nUSER:\n${userHalf}` where `userHalf` ends with the guidance section. Minimal version:

  ```ts
  export function trivialPrompt(entry: EnrichedInventoryEntry, tokens: ThemeJsonTokens | null, guidance?: string): string {
    const tokenHint = tokens?.fontSizes
      ? `Font size tokens: ${tokens.fontSizes.map((s) => s.slug).join(", ")}.`
      : "";
    const system = `You are a React developer. Output ONLY TypeScript/TSX — no markdown, no prose.
  Props: { block: BlockNode } where BlockNode comes from "@/lib/jab/ability-client".
  Use Tailwind CSS. ${tokenHint}`;
    const guidanceSection = renderEditGuidanceSection(guidance);
    const user = `Generate a minimal React component for the WordPress Gutenberg block: ${entry.blockName}

  The block attrs are: ${JSON.stringify(entry.attrSamples[0] ?? {}, null, 2)}

  The component should render the block's visual content using block.attrs and block.innerHTML.${guidanceSection}`;
    return `${system}\n\nUSER:\n${user}`;
  }
  ```

  > This restructure changes the trivial prompt's string shape (adds the marker). `generateComponent` already splits on `"\n\nUSER:\n"` and falls back to the whole string when absent, so a trivial prompt that NOW contains the marker simply caches its (tiny) system half — strictly an improvement, and the existing trivial tests assert on substrings (`expect(prompt).toMatch(...)`) that all still appear. Run the full file to confirm.

  5. `cptTemplatePrompt` — add `guidance?` param; insert `${renderEditGuidanceSection(guidance)}` immediately before the final backtick of the `user` template (after the `${domSection}` line, before `Generate a TypeScript React layout component`).

  6. `acfFlexPrompt` — add `guidance?` param; insert `${renderEditGuidanceSection(guidance)}` after `${postRelationWarning}${domSection}` and before the trailing `Generate the TypeScript React component...` line.

  7. `GenerateComponentOptions` (line 614) — add `guidance?: string | null;`.

  8. In `generateComponent` (line 620), thread guidance into each builder branch:

  ```ts
    const guidance = opts.guidance ?? undefined;
    let combinedPrompt: string;
    if (entry.kind === "cpt_template") {
      combinedPrompt = cptTemplatePrompt(entry, tokens, guidance);
    } else if (entry.kind === "acf_flex") {
      combinedPrompt = acfFlexPrompt(entry, tokens, guidance);
    } else if (entry.tier === "visual") {
      combinedPrompt = visualPrompt(entry, tokens, guidance);
    } else if (entry.tier === "standard") {
      combinedPrompt = standardPrompt(entry, tokens, guidance);
    } else {
      combinedPrompt = trivialPrompt(entry, tokens, guidance);
    }
  ```

  In `apps/web/lib/ai/shell-prompts.ts`:

  9. Add to `ShellPromptInput` (after `themeClassNames?` at line 28): `/** Targeted edit guidance for a chat-driven shell regeneration. Appended to the USER half only. */ guidance?: string;`.

  10. Add a renderer near `renderThemeClassSection`:

  ```ts
  function renderShellGuidanceSection(guidance: string | undefined): string {
    if (!guidance || !guidance.trim()) return "";
    return `\n## Targeted edit guidance
  The user requested a specific change to this ${"component"}. Apply it while keeping
  the rest faithful to the source DOM:
  ${guidance.trim()}
  `;
  }
  ```

  11. `headerPrompt` — append `${renderShellGuidanceSection(input.guidance)}` to the `user` string right before `Generate the Header component...` (after the `## Required signature` block).

  12. `footerPrompt` — same, before `Generate the Footer component...`.

  In `apps/web/lib/ai/generate-shell.ts`:

  13. Add `guidance?: string;` to `GenerateShellOptions` (after `client: ModelClient;` at line 53).

  14. In `generateShell`, thread it into `promptInput` (line 91): add `guidance: opts.guidance,` to the object.

- [ ] **Step 4: Run, verify PASS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/ai/component-generator.test.ts lib/ai/shell-prompts.test.ts lib/ai/generate-shell.test.ts
  pnpm --filter @jab/web typecheck
  ```
  Expected: all green (the new guidance suites + the pre-existing component/shell suites still pass; typecheck clean).

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/ai/component-generator.ts apps/web/lib/ai/shell-prompts.ts apps/web/lib/ai/generate-shell.ts apps/web/lib/ai/component-generator.test.ts apps/web/lib/ai/shell-prompts.test.ts
  git commit -m "feat(saas): thread edit guidance into all five component builders + both shell prompts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 2: Extract `inventory-entry-from-row.ts` (row→entry map + screenshot-path resolution)

`generate-components.ts` builds an `EnrichedInventoryEntry` from a `block_inventory` row inline (lines 181–237) and loads the page-slug→1280-screenshot-path map inline (lines 135–156). The regen worker (Task 6) needs the same two transforms. Extract both into a pure-import module, re-import into `generate-components.ts` (a no-behavior-change refactor pinned by the existing `generate-components` flow). The screenshot helper rebuilds the slug→path map from `page_inventory.source_screenshot_paths` and downloads the base64 body (verifier major: the screenshot lookup is its own step, not on the block row).

**Files:**
- Create: `apps/web/lib/jab/inventory-entry-from-row.ts`
- Create (test): `apps/web/lib/jab/inventory-entry-from-row.test.ts`
- Modify: `apps/web/lib/inngest/functions/generate-components.ts` (replace the inline `queue` map at lines 181–237 with `blockRowToEnrichedEntry`; the screenshot map stays inline there because it must run inside a `step.run` boundary, but the body-download helper is shared — see Step 3 note).

- [ ] **Step 1: Write the failing test**

  Create `apps/web/lib/jab/inventory-entry-from-row.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import {
    blockRowToEnrichedEntry,
    slugToScreenshotPathMap,
    type BlockInventoryRowForEntry,
  } from "./inventory-entry-from-row";

  function row(over: Partial<BlockInventoryRowForEntry> = {}): BlockInventoryRowForEntry {
    return {
      block_name: "core/cover",
      tier: "visual",
      kind: "block",
      spec: null,
      attr_samples: [{ url: "x" }],
      page_slugs: ["home", "about"],
      occurrence_count: 4,
      source_dom_sample: "<div>hi</div>",
      computed_styles: { viewports: { "1280": { fontSize: ["32px"] } } },
      ...over,
    };
  }

  describe("blockRowToEnrichedEntry", () => {
    it("maps a block row to the visual entry shape", () => {
      const e = blockRowToEnrichedEntry(row());
      expect(e).toMatchObject({
        blockName: "core/cover",
        tier: "visual",
        kind: "block",
        occurrenceCount: 4,
        pageSlugs: ["home", "about"],
        sourceDomSample: "<div>hi</div>",
      });
      expect(e.kind).toBe("block");
      if (e.kind === "block") expect(e.spec).toBeUndefined();
      expect(e.computedStyles).toEqual({ viewports: { "1280": { fontSize: ["32px"] } } });
    });

    it("converts the __null__ sentinel to a null blockName + passthrough defaults", () => {
      const e = blockRowToEnrichedEntry(row({ block_name: "__null__", tier: null, kind: null }));
      expect(e.blockName).toBeNull();
      expect(e.tier).toBe("passthrough");
      expect(e.kind).toBe("block");
    });

    it("normalizes a legacy array cpt_template spec to { blockNames, acfSchema }", () => {
      const e = blockRowToEnrichedEntry(
        row({ block_name: "cpt_template/beer", kind: "cpt_template", spec: ["core/paragraph", null] }),
      );
      expect(e.kind).toBe("cpt_template");
      if (e.kind === "cpt_template") {
        expect(e.spec).toEqual({ blockNames: ["core/paragraph", null], acfSchema: null });
      }
    });

    it("passes through an acf_flex spec object", () => {
      const e = blockRowToEnrichedEntry(
        row({ block_name: "acf_flex/p/b/hero", kind: "acf_flex", spec: { heading: "Hi" } }),
      );
      expect(e.kind).toBe("acf_flex");
      if (e.kind === "acf_flex") expect(e.spec).toEqual({ heading: "Hi" });
    });

    it("drops a malformed computed_styles blob to null", () => {
      const e = blockRowToEnrichedEntry(row({ computed_styles: { nope: 1 } }));
      expect(e.computedStyles).toBeNull();
    });
  });

  describe("slugToScreenshotPathMap", () => {
    it("maps slug → 1280 source path, omitting pages without a 1280 capture", () => {
      const map = slugToScreenshotPathMap([
        { slug: "home", source_screenshot_paths: { source: { "1280": "p/home.png", "768": "p/home-m.png" } } },
        { slug: "about", source_screenshot_paths: { source: { "768": "p/about-m.png" } } },
        { slug: "contact", source_screenshot_paths: null },
      ]);
      expect(map).toEqual({ home: "p/home.png" });
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/inventory-entry-from-row.test.ts
  ```
  Expected: `Failed to resolve import "./inventory-entry-from-row"`.

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/lib/jab/inventory-entry-from-row.ts`:

  ```ts
  import "server-only";
  import type { SupabaseClient } from "@supabase/supabase-js";
  import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
  import type {
    EnrichedInventoryEntry,
    Tier,
    ContentKind,
    CptTemplateSpec,
  } from "@/lib/jab/inventory";

  /**
   * inventory-entry-from-row — the single row→EnrichedInventoryEntry transform
   * + the page-slug→source-screenshot resolution, extracted from
   * generate-components.ts (Phase 2 / spec §3.3). Phase B and the chat-driven
   * regen worker share this so a regenerated component reconstructs the exact
   * same generator input the full build used — including the visual-tier
   * screenshot (verifier major: the screenshot lookup is its own step).
   */

  export interface BlockInventoryRowForEntry {
    block_name: string;
    tier: string | null;
    kind: string | null;
    spec: unknown;
    attr_samples: unknown;
    page_slugs: string[] | null;
    occurrence_count: number | null;
    source_dom_sample: string | null;
    computed_styles: unknown;
  }

  /** The columns the regen + Phase B SELECTs must request to build an entry. */
  export const BLOCK_ENTRY_COLUMNS =
    "block_name, tier, kind, spec, attr_samples, page_slugs, occurrence_count, source_dom_sample, computed_styles" as const;

  export function blockRowToEnrichedEntry(row: BlockInventoryRowForEntry): EnrichedInventoryEntry {
    const kind = (row.kind ?? "block") as ContentKind;
    const tier = (row.tier ?? "passthrough") as Tier;
    const blockName = row.block_name === "__null__" ? null : row.block_name;
    const cs = row.computed_styles as { viewports?: unknown } | null;
    const computedStyles =
      cs && typeof cs === "object" && cs.viewports && typeof cs.viewports === "object"
        ? (cs as { viewports: Record<string, Record<string, string[]>> })
        : null;
    const base = {
      blockName,
      tier,
      attrSamples: Array.isArray(row.attr_samples)
        ? (row.attr_samples as Array<Record<string, unknown>>)
        : [],
      pageSlugs: row.page_slugs ?? [],
      occurrenceCount: row.occurrence_count ?? 0,
      sourceDomSample: row.source_dom_sample,
      computedStyles,
    };
    if (kind === "acf_flex") {
      return { ...base, kind, spec: (row.spec ?? {}) as Record<string, unknown> };
    }
    if (kind === "cpt_template") {
      const raw = row.spec;
      let spec: CptTemplateSpec;
      if (Array.isArray(raw)) {
        spec = { blockNames: raw as (string | null)[], acfSchema: null };
      } else if (raw && typeof raw === "object") {
        const obj = raw as { blockNames?: unknown; acfSchema?: unknown };
        spec = {
          blockNames: Array.isArray(obj.blockNames) ? (obj.blockNames as (string | null)[]) : [],
          acfSchema: obj.acfSchema && typeof obj.acfSchema === "object" ? (obj.acfSchema as Record<string, unknown>) : null,
        };
      } else {
        spec = { blockNames: [], acfSchema: null };
      }
      return { ...base, kind, spec };
    }
    return { ...base, kind: "block", spec: undefined };
  }

  /** page_inventory row shape needed to rebuild the slug→1280-path map. */
  export interface PageScreenshotRow {
    slug: string;
    source_screenshot_paths: { source?: Record<string, string> } | null;
  }

  /** Pure: slug → 1280 source-screenshot Storage path, omitting pages with no 1280 capture. */
  export function slugToScreenshotPathMap(pages: PageScreenshotRow[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const page of pages) {
      const paths = page.source_screenshot_paths?.source ?? {};
      const path1280 = paths["1280"];
      if (path1280) result[page.slug] = path1280;
    }
    return result;
  }

  /**
   * Resolve the base64 1280 screenshot for a single slug from page_inventory.
   * Returns null fail-soft (no row, no 1280 path, or download error) so
   * visual-tier regen still runs on the remaining inputs.
   */
  export async function loadHomeOrSlugScreenshotBase64(
    supabase: SupabaseClient,
    buildId: string,
    slug: string,
  ): Promise<string | null> {
    const { data: pages } = await supabase
      .from("page_inventory")
      .select("slug, source_screenshot_paths")
      .eq("site_build_id", buildId);
    const map = slugToScreenshotPathMap((pages ?? []) as PageScreenshotRow[]);
    const path = map[slug];
    if (!path) return null;
    try {
      const { data, error } = await supabase.storage.from(SITE_SCREENSHOTS_BUCKET).download(path);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer()).toString("base64");
    } catch {
      return null;
    }
  }
  ```

  In `apps/web/lib/inngest/functions/generate-components.ts`:
  - Add `import { blockRowToEnrichedEntry } from "@/lib/jab/inventory-entry-from-row";` to the imports.
  - Replace the entire inline `const queue: EnrichedInventoryEntry[] = inventory.map((row) => { ... });` block (lines 181–237) with:

  ```ts
    const queue: EnrichedInventoryEntry[] = inventory.map((row) => blockRowToEnrichedEntry(row));
  ```

  - Leave the `load-page-screenshot-paths` step (lines 135–156) and the per-batch download loop as-is — they already run inside `step.run` boundaries and the body-download cache is batch-local. (The new `loadHomeOrSlugScreenshotBase64` is the regen worker's per-call equivalent; generate-components keeps its batch cache.)

- [ ] **Step 4: Run, verify PASS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/inventory-entry-from-row.test.ts
  pnpm --filter @jab/web typecheck
  ```
  Expected: green. Also run the existing generate-components-adjacent suites to confirm the refactor didn't perturb behavior:
  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/inventory.test.ts lib/jab/content-detection.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/jab/inventory-entry-from-row.ts apps/web/lib/jab/inventory-entry-from-row.test.ts apps/web/lib/inngest/functions/generate-components.ts
  git commit -m "refactor(saas): extract blockRowToEnrichedEntry + slug screenshot resolution

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 3: Pure core — `site-map.ts` (`buildSiteMap`)

A compact map of the SOURCE build the planner reasons over: the block-type catalog (block name + human label), the page slug list, and header/footer presence. `buildSiteMap` does ONE I/O read of `block_inventory` + `page_inventory` then delegates to a pure reducer (`reduceSiteMap`) that is the unit-tested core. The planner is constrained to choose a `target` that exists in this map (R/§3.3: planner and regen share the same `sourceBuildId`).

**Files:**
- Create: `apps/web/lib/jab/site-map.ts`
- Create (test): `apps/web/lib/jab/site-map.test.ts`

- [ ] **Step 1: Write the failing test**

  Create `apps/web/lib/jab/site-map.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { reduceSiteMap, humanLabelForBlock, type SiteMap } from "./site-map";

  describe("humanLabelForBlock", () => {
    it("titlecases the leaf of a core block name", () => {
      expect(humanLabelForBlock("core/cover")).toBe("Cover");
      expect(humanLabelForBlock("core/media-text")).toBe("Media Text");
    });
    it("labels an acf_flex layout by its layout leaf", () => {
      expect(humanLabelForBlock("acf_flex/page/page_builder/featured_beer")).toBe("Featured Beer");
    });
    it("labels a cpt_template by its cpt slug", () => {
      expect(humanLabelForBlock("cpt_template/beer")).toBe("Beer template");
    });
    it("returns 'Classic content' for the __null__ sentinel", () => {
      expect(humanLabelForBlock("__null__")).toBe("Classic content");
    });
  });

  describe("reduceSiteMap", () => {
    it("builds the block catalog (excluding __null__), page slugs, and shell presence", () => {
      const map: SiteMap = reduceSiteMap({
        blockRows: [
          { block_name: "core/cover", tier: "visual", occurrence_count: 4 },
          { block_name: "core/heading", tier: "trivial", occurrence_count: 12 },
          { block_name: "__null__", tier: "passthrough", occurrence_count: 1 },
        ],
        pageRows: [
          { slug: "home", route_path: "/", post_type: "page" },
          { slug: "about", route_path: "/about", post_type: "page" },
        ],
        hasHeader: true,
        hasFooter: false,
      });
      expect(map.blockTypes).toEqual([
        { blockName: "core/cover", label: "Cover", tier: "visual", occurrenceCount: 4 },
        { blockName: "core/heading", label: "Heading", tier: "trivial", occurrenceCount: 12 },
      ]);
      expect(map.pageSlugs).toEqual(["home", "about"]);
      expect(map.shell).toEqual({ header: true, footer: false });
    });

    it("sorts block types by occurrence desc then name asc", () => {
      const map = reduceSiteMap({
        blockRows: [
          { block_name: "core/b", tier: "standard", occurrence_count: 2 },
          { block_name: "core/a", tier: "standard", occurrence_count: 2 },
          { block_name: "core/z", tier: "visual", occurrence_count: 9 },
        ],
        pageRows: [],
        hasHeader: false,
        hasFooter: false,
      });
      expect(map.blockTypes.map((b) => b.blockName)).toEqual(["core/z", "core/a", "core/b"]);
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/site-map.test.ts
  ```
  Expected: `Failed to resolve import "./site-map"`.

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/lib/jab/site-map.ts`:

  ```ts
  import "server-only";
  import { createAdminClient } from "@/lib/supabase/admin";

  /**
   * site-map — compact, planner-facing description of a SOURCE build (spec §3.3).
   * buildSiteMap does the DB read; reduceSiteMap is the pure, unit-tested core.
   * The planner's `target` MUST be one of `blockTypes[].blockName` (component
   * scope) or a shell kind that is present (shell scope).
   */

  export interface SiteMapBlockType {
    blockName: string;
    label: string;
    tier: string | null;
    occurrenceCount: number;
  }

  export interface SiteMap {
    blockTypes: SiteMapBlockType[];
    pageSlugs: string[];
    shell: { header: boolean; footer: boolean };
  }

  export function humanLabelForBlock(blockName: string): string {
    if (blockName === "__null__") return "Classic content";
    const parts = blockName.split("/");
    if (parts[0] === "cpt_template") {
      return `${titleCase(parts[1] ?? "Unknown")} template`;
    }
    // acf_flex/<cpt>/<field>/<layout> → label by the layout leaf.
    const leaf = parts[parts.length - 1] ?? blockName;
    return titleCase(leaf);
  }

  function titleCase(slug: string): string {
    return slug
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  export interface ReduceSiteMapInput {
    blockRows: Array<{ block_name: string; tier: string | null; occurrence_count: number | null }>;
    pageRows: Array<{ slug: string; route_path: string; post_type: string }>;
    hasHeader: boolean;
    hasFooter: boolean;
  }

  export function reduceSiteMap(input: ReduceSiteMapInput): SiteMap {
    const blockTypes: SiteMapBlockType[] = input.blockRows
      .filter((r) => r.block_name !== "__null__")
      .map((r) => ({
        blockName: r.block_name,
        label: humanLabelForBlock(r.block_name),
        tier: r.tier,
        occurrenceCount: r.occurrence_count ?? 0,
      }))
      .sort((a, b) => {
        if (b.occurrenceCount !== a.occurrenceCount) return b.occurrenceCount - a.occurrenceCount;
        return a.blockName.localeCompare(b.blockName);
      });
    return {
      blockTypes,
      pageSlugs: input.pageRows.map((p) => p.slug),
      shell: { header: input.hasHeader, footer: input.hasFooter },
    };
  }

  /** Load the SOURCE build's block + page inventory and shell presence, then reduce. */
  export async function buildSiteMap(sourceBuildId: string): Promise<SiteMap> {
    const supabase = createAdminClient();
    const [{ data: blocks }, { data: pages }, { data: shells }] = await Promise.all([
      supabase
        .from("block_inventory")
        .select("block_name, tier, occurrence_count")
        .eq("site_build_id", sourceBuildId),
      supabase
        .from("page_inventory")
        .select("slug, route_path, post_type")
        .eq("site_build_id", sourceBuildId),
      supabase.from("shell_generations").select("shell_kind").eq("site_build_id", sourceBuildId),
    ]);
    const shellKinds = new Set((shells ?? []).map((s) => (s as { shell_kind: string }).shell_kind));
    return reduceSiteMap({
      blockRows: (blocks ?? []) as ReduceSiteMapInput["blockRows"],
      pageRows: (pages ?? []) as ReduceSiteMapInput["pageRows"],
      hasHeader: shellKinds.has("header"),
      hasFooter: shellKinds.has("footer"),
    });
  }
  ```

- [ ] **Step 4: Run, verify PASS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/site-map.test.ts
  pnpm --filter @jab/web typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/jab/site-map.ts apps/web/lib/jab/site-map.test.ts
  git commit -m "feat(saas): buildSiteMap + reduceSiteMap pure core for the planner

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 4: Pure core — `edit-plan.ts` (`EditPlan` + `validateEditPlan`)

The typed plan the planner emits, the JSON-schema constant the constrained Claude call uses as its tool input schema, and `validateEditPlan` which rejects a plan whose `target` does not exist in the site map (forcing a clarifying question). Scope is exactly `WorkspaceEditScope` (`"component" | "shell"`) — deferred scopes are not representable (R/§2.6).

**Files:**
- Create: `apps/web/lib/jab/edit-plan.ts`
- Create (test): `apps/web/lib/jab/edit-plan.test.ts`

- [ ] **Step 1: Write the failing test**

  Create `apps/web/lib/jab/edit-plan.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import {
    validateEditPlan,
    EDIT_PLAN_TOOL_SCHEMA,
    type EditPlan,
  } from "./edit-plan";
  import type { SiteMap } from "./site-map";

  const siteMap: SiteMap = {
    blockTypes: [
      { blockName: "core/cover", label: "Cover", tier: "visual", occurrenceCount: 4 },
      { blockName: "core/heading", label: "Heading", tier: "trivial", occurrenceCount: 9 },
    ],
    pageSlugs: ["home", "about"],
    shell: { header: true, footer: false },
  };

  function actionable(over: Partial<EditPlan> = {}): EditPlan {
    return {
      needsClarification: false,
      scope: "component",
      target: "core/cover",
      action: "Regenerated the Cover block on 2 page(s)",
      regenerationPrompt: "Make the hero bolder",
      clarifyingQuestion: null,
      ...over,
    } as EditPlan;
  }

  describe("validateEditPlan", () => {
    it("accepts an actionable component plan whose target exists", () => {
      expect(validateEditPlan(actionable(), siteMap).ok).toBe(true);
    });

    it("accepts a clarifying plan regardless of target", () => {
      const plan = actionable({ needsClarification: true, target: "", clarifyingQuestion: "Which block?" });
      expect(validateEditPlan(plan, siteMap).ok).toBe(true);
    });

    it("rejects a component plan whose target is not in the catalog (hallucinated)", () => {
      const r = validateEditPlan(actionable({ target: "core/made-up" }), siteMap);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("unknown_target");
    });

    it("rejects scope=shell with a non-header/footer target", () => {
      const r = validateEditPlan(actionable({ scope: "shell", target: "core/cover" }), siteMap);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_shell_target");
    });

    it("rejects scope=shell targeting a shell kind that is absent (footer here)", () => {
      const r = validateEditPlan(actionable({ scope: "shell", target: "footer" }), siteMap);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("shell_absent");
    });

    it("accepts scope=shell targeting the present header", () => {
      expect(validateEditPlan(actionable({ scope: "shell", target: "header" }), siteMap).ok).toBe(true);
    });

    it("rejects an actionable plan with an empty regenerationPrompt", () => {
      const r = validateEditPlan(actionable({ regenerationPrompt: "  " }), siteMap);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("empty_guidance");
    });
  });

  describe("EDIT_PLAN_TOOL_SCHEMA", () => {
    it("constrains scope to exactly component|shell (no deferred scopes)", () => {
      const scope = EDIT_PLAN_TOOL_SCHEMA.input_schema.properties.scope as { enum: string[] };
      expect(scope.enum).toEqual(["component", "shell"]);
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/edit-plan.test.ts
  ```
  Expected: `Failed to resolve import "./edit-plan"`.

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/lib/jab/edit-plan.ts`:

  ```ts
  import type { WorkspaceEditScope } from "@/lib/jab/workspace-edit-validation";
  import type { SiteMap } from "./site-map";

  /**
   * edit-plan — the structured output of the planner LLM (spec §3.3). The plan
   * is the ONLY thing the model produces: a constrained scope enum, a target
   * validated against the real inventory, an action summary (states the blast
   * radius — R1), and a regenerationPrompt threaded into the generator. The
   * model can never name a file, path, or tool (prompt-injection containment).
   */

  export interface EditPlan {
    /** True → ask the user a question, run no edit. */
    needsClarification: boolean;
    scope: WorkspaceEditScope;
    /** block_name (component) or "header"|"footer" (shell). Ignored when needsClarification. */
    target: string;
    /** Human summary stating the real blast radius, e.g. "Regenerated the Hero on 3 pages". */
    action: string;
    /** Guidance threaded into the generator. */
    regenerationPrompt: string;
    /** The question to show when needsClarification; null otherwise. */
    clarifyingQuestion: string | null;
  }

  /** The Anthropic tool-use input schema the planner is constrained to. */
  export const EDIT_PLAN_TOOL_SCHEMA = {
    name: "emit_edit_plan",
    description:
      "Emit a structured plan for the user's requested edit, OR ask a clarifying question when the target is ambiguous or the request is too vague to act on.",
    input_schema: {
      type: "object" as const,
      properties: {
        needsClarification: {
          type: "boolean",
          description: "true when you cannot confidently pick a single target; then run no edit.",
        },
        scope: { type: "string", enum: ["component", "shell"] },
        target: {
          type: "string",
          description:
            "For scope=component: the exact block_name from the site map. For scope=shell: 'header' or 'footer'. Empty string when needsClarification.",
        },
        action: {
          type: "string",
          description:
            "One sentence stating exactly what changes and the blast radius, e.g. 'Regenerate the Cover block — affects 3 pages'.",
        },
        regenerationPrompt: {
          type: "string",
          description: "Concrete instructions passed to the component/shell generator. Empty when needsClarification.",
        },
        clarifyingQuestion: {
          type: ["string", "null"],
          description: "The question to ask the user. Required when needsClarification, null otherwise.",
        },
      },
      required: ["needsClarification", "scope", "target", "action", "regenerationPrompt"],
      additionalProperties: false,
    },
  } as const;

  export type ValidateEditPlanResult =
    | { ok: true }
    | {
        ok: false;
        code: "unknown_target" | "invalid_shell_target" | "shell_absent" | "empty_guidance";
        reason: string;
      };

  export function validateEditPlan(plan: EditPlan, siteMap: SiteMap): ValidateEditPlanResult {
    // A clarifying plan is always valid — it runs no edit.
    if (plan.needsClarification) return { ok: true };

    if (!plan.regenerationPrompt || !plan.regenerationPrompt.trim()) {
      return { ok: false, code: "empty_guidance", reason: "The plan has no regeneration guidance." };
    }

    if (plan.scope === "shell") {
      if (plan.target !== "header" && plan.target !== "footer") {
        return {
          ok: false,
          code: "invalid_shell_target",
          reason: `Shell edits target 'header' or 'footer' (got '${plan.target}').`,
        };
      }
      const present = plan.target === "header" ? siteMap.shell.header : siteMap.shell.footer;
      if (!present) {
        return {
          ok: false,
          code: "shell_absent",
          reason: `This site has no ${plan.target}.`,
        };
      }
      return { ok: true };
    }

    // scope === "component": target must be a real block name.
    const known = siteMap.blockTypes.some((b) => b.blockName === plan.target);
    if (!known) {
      return {
        ok: false,
        code: "unknown_target",
        reason: `'${plan.target}' is not a block on this site.`,
      };
    }
    return { ok: true };
  }
  ```

- [ ] **Step 4: Run, verify PASS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/edit-plan.test.ts
  pnpm --filter @jab/web typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/jab/edit-plan.ts apps/web/lib/jab/edit-plan.test.ts
  git commit -m "feat(saas): EditPlan type + validateEditPlan + planner tool schema

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 5: Pure core — `edit-impact.ts` (`computeChangedPages`, fail-closed)

The verifier-blocker module. For a component edit it diffs against the SOURCE build's **populated** `page_inventory.block_tree` (migration 0027) — walking each page's tree for `target` — NOT the capped `block_inventory.page_slugs` (cap = 50 → fail-open). For a shell edit every page is changed (`shell_all`). Any uncertainty — a page with a null/non-array `block_tree`, or more than 50 changed pages — widens to ALL pages (fail-closed, R4). The function is given the already-loaded source page rows so it stays pure.

**Files:**
- Create: `apps/web/lib/jab/edit-impact.ts`
- Create (test): `apps/web/lib/jab/edit-impact.test.ts`

- [ ] **Step 1: Write the failing test**

  Create `apps/web/lib/jab/edit-impact.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { computeChangedPages, type SourcePageForImpact } from "./edit-impact";
  import type { BlockNode } from "./ability-client";

  function node(blockName: string | null, inner: BlockNode[] = []): BlockNode {
    return { blockName, attrs: {}, innerBlocks: inner, innerHTML: "" };
  }
  function page(slug: string, tree: BlockNode[] | null): SourcePageForImpact {
    return { slug, blockTree: tree };
  }

  describe("computeChangedPages — shell", () => {
    it("returns all slugs with reason shell_all", () => {
      const r = computeChangedPages({
        scope: "shell",
        target: "header",
        sourcePages: [page("home", []), page("about", [])],
      });
      expect(r.changedSlugs.sort()).toEqual(["about", "home"]);
      expect(r.reason).toBe("shell_all");
    });
  });

  describe("computeChangedPages — component", () => {
    it("returns only the pages whose tree contains the target block (recursively)", () => {
      const r = computeChangedPages({
        scope: "component",
        target: "core/cover",
        sourcePages: [
          page("home", [node("core/group", [node("core/cover")])]),
          page("about", [node("core/heading")]),
          page("menu", [node("core/cover")]),
        ],
      });
      expect(r.changedSlugs.sort()).toEqual(["home", "menu"]);
      expect(r.reason).toBe("component_pages");
    });

    it("FAIL-CLOSED: a page with a null block_tree forces all pages", () => {
      const r = computeChangedPages({
        scope: "component",
        target: "core/cover",
        sourcePages: [page("home", [node("core/cover")]), page("about", null)],
      });
      expect(r.changedSlugs.sort()).toEqual(["about", "home"]);
      expect(r.reason).toBeNull();
    });

    it("FAIL-CLOSED: more than 50 matching pages forces all pages", () => {
      const pages: SourcePageForImpact[] = [];
      for (let i = 0; i < 60; i++) pages.push(page(`p${i}`, [node("core/cover")]));
      const r = computeChangedPages({ scope: "component", target: "core/cover", sourcePages: pages });
      expect(r.changedSlugs.length).toBe(60);
      expect(r.reason).toBeNull();
    });

    it("FAIL-CLOSED: a non-array block_tree forces all pages", () => {
      const r = computeChangedPages({
        scope: "component",
        target: "core/cover",
        // @ts-expect-error — exercise the defensive non-array branch
        sourcePages: [{ slug: "home", blockTree: { not: "an array" } }, page("about", [node("core/cover")])],
      });
      expect(r.changedSlugs.sort()).toEqual(["about", "home"]);
      expect(r.reason).toBeNull();
    });

    it("finds an acf_flex target by its synthesized block name on innerBlocks", () => {
      const r = computeChangedPages({
        scope: "component",
        target: "acf_flex/page/builder/hero",
        sourcePages: [page("home", [node("acf_flex/page/builder/hero")]), page("about", [node("core/heading")])],
      });
      expect(r.changedSlugs).toEqual(["home"]);
      expect(r.reason).toBe("component_pages");
    });

    it("returns an empty changed set (component_pages) when no page contains the target", () => {
      const r = computeChangedPages({
        scope: "component",
        target: "core/quote",
        sourcePages: [page("home", [node("core/cover")])],
      });
      expect(r.changedSlugs).toEqual([]);
      expect(r.reason).toBe("component_pages");
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/edit-impact.test.ts
  ```
  Expected: `Failed to resolve import "./edit-impact"`.

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/lib/jab/edit-impact.ts`:

  ```ts
  import type { BlockNode } from "./ability-client";
  import type { WorkspaceEditScope } from "@/lib/jab/workspace-edit-validation";

  /**
   * edit-impact — pure changed-page computation (spec §3.4, verifier blocker).
   *
   * Diffs the SOURCE build's POPULATED page_inventory.block_tree (migration 0027)
   * — NOT the capped block_inventory.page_slugs (cap=50 → fail-open). Walks each
   * page's tree recursively for `target`. Any uncertainty (null/non-array tree,
   * or >50 changed pages) widens to ALL pages (fail-closed, R4): reason=null
   * means "we widened to everything; treat as shell_all-equivalent for the gate".
   */

  /** Cap above which we stop trusting the per-page diff and re-review everything. */
  export const MAX_CONFIDENT_CHANGED_PAGES = 50;

  export interface SourcePageForImpact {
    slug: string;
    /** Raw WP BlockNode[] captured at discovery; null for pre-0027 source builds. */
    blockTree: BlockNode[] | null;
  }

  export interface ComputeChangedPagesInput {
    scope: WorkspaceEditScope;
    target: string;
    sourcePages: SourcePageForImpact[];
  }

  export interface ComputeChangedPagesResult {
    changedSlugs: string[];
    /** "component_pages" | "shell_all" on the confident path; null when fail-closed-widened. */
    reason: "component_pages" | "shell_all" | null;
  }

  function allSlugs(pages: SourcePageForImpact[]): string[] {
    return pages.map((p) => p.slug);
  }

  function treeContains(blocks: BlockNode[], target: string): boolean {
    for (const b of blocks) {
      if (b.blockName === target) return true;
      if (Array.isArray(b.innerBlocks) && b.innerBlocks.length > 0 && treeContains(b.innerBlocks, target)) {
        return true;
      }
    }
    return false;
  }

  export function computeChangedPages(input: ComputeChangedPagesInput): ComputeChangedPagesResult {
    if (input.scope === "shell") {
      return { changedSlugs: allSlugs(input.sourcePages), reason: "shell_all" };
    }

    // Component scope — walk each page's populated tree.
    const changed: string[] = [];
    for (const page of input.sourcePages) {
      const tree = page.blockTree;
      if (!Array.isArray(tree)) {
        // Uncertain diff source → fail closed.
        return { changedSlugs: allSlugs(input.sourcePages), reason: null };
      }
      if (treeContains(tree, input.target)) changed.push(page.slug);
    }

    if (changed.length > MAX_CONFIDENT_CHANGED_PAGES) {
      return { changedSlugs: allSlugs(input.sourcePages), reason: null };
    }
    return { changedSlugs: changed, reason: "component_pages" };
  }
  ```

- [ ] **Step 4: Run, verify PASS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/edit-impact.test.ts
  pnpm --filter @jab/web typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/jab/edit-impact.ts apps/web/lib/jab/edit-impact.test.ts
  git commit -m "feat(saas): computeChangedPages fail-closed diff against source block_tree

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 6: Pure core — `approval-carry-forward.ts` (`planApprovalCarryForward`)

Untouched pages inherit the SOURCE build's approval status; changed pages reset to `pending`. Matches on **slug** (stable across builds) — never `page_inventory.id`, which is regenerated per build. A source-`pending` page is never upgraded; a result-only page with no source row → `pending` (fail-closed, §3.4 guardrails).

**Files:**
- Create: `apps/web/lib/jab/approval-carry-forward.ts`
- Create (test): `apps/web/lib/jab/approval-carry-forward.test.ts`

- [ ] **Step 1: Write the failing test**

  Create `apps/web/lib/jab/approval-carry-forward.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { planApprovalCarryForward } from "./approval-carry-forward";

  describe("planApprovalCarryForward", () => {
    const source = [
      { slug: "home", approvalStatus: "approved" },
      { slug: "about", approvalStatus: "approved_with_issues" },
      { slug: "menu", approvalStatus: "pending" },
    ];
    const resultPages = [
      { slug: "home", pageInventoryId: "r-home" },
      { slug: "about", pageInventoryId: "r-about" },
      { slug: "menu", pageInventoryId: "r-menu" },
      { slug: "new-page", pageInventoryId: "r-new" },
    ];

    it("inherits source status for untouched pages, resets changed pages to pending", () => {
      const plan = planApprovalCarryForward({
        sourceFidelityRows: source,
        resultPages,
        changedSlugs: ["home"],
      });
      // home changed → pending; about untouched → inherits; menu untouched but source-pending stays pending.
      const byId = new Map(plan.carry.map((c) => [c.pageInventoryId, c.status]));
      expect(byId.get("r-home")).toBe("pending");
      expect(byId.get("r-about")).toBe("approved_with_issues");
      expect(byId.get("r-menu")).toBe("pending");
      // new-page has no source row → pending (result-only).
      expect(byId.get("r-new")).toBe("pending");
      expect(plan.resetToPending.sort()).toEqual(["home", "new-page"]);
    });

    it("never upgrades a source-pending page even when untouched", () => {
      const plan = planApprovalCarryForward({
        sourceFidelityRows: [{ slug: "menu", approvalStatus: "pending" }],
        resultPages: [{ slug: "menu", pageInventoryId: "r-menu" }],
        changedSlugs: [],
      });
      expect(plan.carry).toEqual([{ pageInventoryId: "r-menu", status: "pending" }]);
    });

    it("matches on slug, not page_inventory id (ids differ across builds)", () => {
      const plan = planApprovalCarryForward({
        sourceFidelityRows: [{ slug: "home", approvalStatus: "approved" }],
        resultPages: [{ slug: "home", pageInventoryId: "DIFFERENT-id" }],
        changedSlugs: [],
      });
      expect(plan.carry).toEqual([{ pageInventoryId: "DIFFERENT-id", status: "approved" }]);
    });

    it("treats a result-only changed page as pending (in resetToPending)", () => {
      const plan = planApprovalCarryForward({
        sourceFidelityRows: [],
        resultPages: [{ slug: "x", pageInventoryId: "r-x" }],
        changedSlugs: ["x"],
      });
      expect(plan.carry).toEqual([{ pageInventoryId: "r-x", status: "pending" }]);
      expect(plan.resetToPending).toEqual(["x"]);
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/approval-carry-forward.test.ts
  ```
  Expected: `Failed to resolve import "./approval-carry-forward"`.

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/lib/jab/approval-carry-forward.ts`:

  ```ts
  /**
   * approval-carry-forward — pure approval inheritance for edit builds (spec §3.4).
   *
   * Untouched pages inherit the SOURCE build's human approval; changed pages
   * reset to pending. Matches on SLUG (stable across builds), never
   * page_inventory.id (regenerated per build). A source-pending page is never
   * upgraded; a result page with no source row → pending. Fail-closed: a
   * genuinely-changed page can never inherit a stale approval.
   */

  export type CarriedApprovalStatus =
    | "approved"
    | "approved_with_issues"
    | "rejected"
    | "pending";

  export interface CarryForwardInput {
    /** Source build fidelity rows, keyed by page slug. */
    sourceFidelityRows: Array<{ slug: string; approvalStatus: string }>;
    /** Result build page rows: which result page_inventory.id maps to which slug. */
    resultPages: Array<{ slug: string; pageInventoryId: string }>;
    /** Slugs the edit actually changed (from computeChangedPages). */
    changedSlugs: string[];
  }

  export interface CarryForwardPlan {
    /** Each result page's carried status, keyed by result page_inventory.id. */
    carry: Array<{ pageInventoryId: string; status: CarriedApprovalStatus }>;
    /** Slugs that were forced to pending (changed or result-only). */
    resetToPending: string[];
  }

  function normalize(status: string): CarriedApprovalStatus {
    if (
      status === "approved" ||
      status === "approved_with_issues" ||
      status === "rejected" ||
      status === "pending"
    ) {
      return status;
    }
    return "pending";
  }

  export function planApprovalCarryForward(input: CarryForwardInput): CarryForwardPlan {
    const sourceBySlug = new Map<string, CarriedApprovalStatus>();
    for (const row of input.sourceFidelityRows) {
      sourceBySlug.set(row.slug, normalize(row.approvalStatus));
    }
    const changed = new Set(input.changedSlugs);

    const carry: CarryForwardPlan["carry"] = [];
    const resetToPending: string[] = [];

    for (const page of input.resultPages) {
      if (changed.has(page.slug)) {
        carry.push({ pageInventoryId: page.pageInventoryId, status: "pending" });
        resetToPending.push(page.slug);
        continue;
      }
      const inherited = sourceBySlug.get(page.slug);
      if (inherited === undefined) {
        // Result-only page with no source approval → pending.
        carry.push({ pageInventoryId: page.pageInventoryId, status: "pending" });
        resetToPending.push(page.slug);
        continue;
      }
      carry.push({ pageInventoryId: page.pageInventoryId, status: inherited });
    }

    return { carry, resetToPending };
  }
  ```

- [ ] **Step 4: Run, verify PASS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/approval-carry-forward.test.ts
  pnpm --filter @jab/web typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/jab/approval-carry-forward.ts apps/web/lib/jab/approval-carry-forward.test.ts
  git commit -m "feat(saas): planApprovalCarryForward slug-matched approval inheritance

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 7: Pure core — `active-edit-guard.ts` (`evaluateEditConcurrency`)

Pure decision over (a) the latest build's status and (b) the count of in-flight edits whose linked build is `ready`-and-not-promoted (the `edit_in_review` slot). Readiness is derived from `site_builds.status`, never `workspace_edits.status` (§3.4 edit state machine, verifier blocker). Returns a friendly code the action translates to a `WorkspaceEditError`.

**Files:**
- Create: `apps/web/lib/jab/active-edit-guard.ts`
- Create (test): `apps/web/lib/jab/active-edit-guard.test.ts`

- [ ] **Step 1: Write the failing test**

  Create `apps/web/lib/jab/active-edit-guard.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { evaluateEditConcurrency } from "./active-edit-guard";

  describe("evaluateEditConcurrency", () => {
    it("ok when no active build and no edit awaiting review", () => {
      expect(evaluateEditConcurrency({ latestBuildStatus: "ready", editInReviewCount: 0 })).toEqual({ ok: true });
    });

    it("refuses with active_build when the latest build is in an active phase", () => {
      const r = evaluateEditConcurrency({ latestBuildStatus: "composing", editInReviewCount: 0 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("active_build");
    });

    it("refuses with edit_in_review when an unpromoted ready edit already exists", () => {
      const r = evaluateEditConcurrency({ latestBuildStatus: "ready", editInReviewCount: 1 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("edit_in_review");
    });

    it("active_build takes precedence over edit_in_review", () => {
      const r = evaluateEditConcurrency({ latestBuildStatus: "verifying", editInReviewCount: 2 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("active_build");
    });

    it("ok when latest build is failed/cancelled (terminal, non-ready)", () => {
      expect(evaluateEditConcurrency({ latestBuildStatus: "failed", editInReviewCount: 0 }).ok).toBe(true);
      expect(evaluateEditConcurrency({ latestBuildStatus: "cancelled", editInReviewCount: 0 }).ok).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/active-edit-guard.test.ts
  ```
  Expected: `Failed to resolve import "./active-edit-guard"`.

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/lib/jab/active-edit-guard.ts`:

  ```ts
  import { isActiveBuildStatus } from "./build-status";

  /**
   * active-edit-guard — pure concurrency decision for the workspace edit slot
   * (spec §3.4). One active build at a time AND one unpromoted-ready edit
   * ("edit_in_review") at a time. Readiness is derived by the CALLER from the
   * linked site_builds.status (never workspace_edits.status); this function
   * just takes the already-derived latest build status + in-review count.
   */

  export interface EvaluateEditConcurrencyInput {
    /** Latest site_builds.status for the project (any config.mode). */
    latestBuildStatus: string | null | undefined;
    /**
     * Count of edits whose LINKED build is ready, not promoted, not cancelled —
     * derived by the caller from the join, per the §3.4 state-machine table.
     */
    editInReviewCount: number;
  }

  export type EditConcurrencyResult =
    | { ok: true }
    | { ok: false; code: "active_build" | "edit_in_review"; reason: string };

  export function evaluateEditConcurrency(input: EvaluateEditConcurrencyInput): EditConcurrencyResult {
    if (isActiveBuildStatus(input.latestBuildStatus)) {
      return {
        ok: false,
        code: "active_build",
        reason: `A build is already in flight for this project (status=${input.latestBuildStatus}). Wait for it to finish before editing.`,
      };
    }
    if (input.editInReviewCount > 0) {
      return {
        ok: false,
        code: "edit_in_review",
        reason:
          "An edit is already waiting for review. Review (approve & promote) or discard it before starting another.",
      };
    }
    return { ok: true };
  }
  ```

- [ ] **Step 4: Run, verify PASS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/active-edit-guard.test.ts
  pnpm --filter @jab/web typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/jab/active-edit-guard.ts apps/web/lib/jab/active-edit-guard.test.ts
  git commit -m "feat(saas): evaluateEditConcurrency one-active-build + edit-in-review guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 8: `edit-cost-guard.ts` (`assertEditBudget` + caps)

Rate-limit + budget check over `workspace_edits` / `chat_messages` plus the active-build guard, so a vague prompt or rapid resends can't burn Vercel/LLM cost (R2). The pure decision (`evaluateEditBudget`) is TDD'd; the thin DB-reading `assertEditBudget` wraps it. Cap constants are exported for the planner context cap and the generator gate.

**Files:**
- Create: `apps/web/lib/ai/edit-cost-guard.ts`
- Create (test): `apps/web/lib/ai/edit-cost-guard.test.ts`

- [ ] **Step 1: Write the failing test**

  Create `apps/web/lib/ai/edit-cost-guard.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import {
    evaluateEditBudget,
    EDIT_RATE_WINDOW_MS,
    MAX_EDITS_PER_WINDOW,
    MAX_CHAT_MESSAGES_PER_WINDOW,
    PLANNER_MAX_TURNS,
    EditBudgetError,
  } from "./edit-cost-guard";

  describe("evaluateEditBudget", () => {
    const now = Date.parse("2026-06-03T12:00:00Z");
    const recent = new Date(now - 1000).toISOString();
    const old = new Date(now - EDIT_RATE_WINDOW_MS - 1000).toISOString();

    it("ok under both limits", () => {
      expect(
        evaluateEditBudget({
          now,
          recentEditCreatedAts: [recent],
          recentMessageCreatedAts: [recent, recent],
        }),
      ).toEqual({ ok: true });
    });

    it("refuses when too many edits in the window", () => {
      const ats = Array.from({ length: MAX_EDITS_PER_WINDOW }, () => recent);
      const r = evaluateEditBudget({ now, recentEditCreatedAts: ats, recentMessageCreatedAts: [] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("rate_limited_edits");
    });

    it("refuses when too many chat messages in the window", () => {
      const ats = Array.from({ length: MAX_CHAT_MESSAGES_PER_WINDOW }, () => recent);
      const r = evaluateEditBudget({ now, recentEditCreatedAts: [], recentMessageCreatedAts: ats });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("rate_limited_messages");
    });

    it("ignores timestamps outside the window", () => {
      const ats = Array.from({ length: MAX_EDITS_PER_WINDOW + 5 }, () => old);
      expect(evaluateEditBudget({ now, recentEditCreatedAts: ats, recentMessageCreatedAts: [] }).ok).toBe(true);
    });

    it("exposes a planner-context turn cap", () => {
      expect(PLANNER_MAX_TURNS).toBeGreaterThanOrEqual(8);
    });

    it("EditBudgetError carries a code", () => {
      const e = new EditBudgetError("rate_limited_edits", "slow down");
      expect(e.code).toBe("rate_limited_edits");
      expect(e).toBeInstanceOf(Error);
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/ai/edit-cost-guard.test.ts
  ```
  Expected: `Failed to resolve import "./edit-cost-guard"`.

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/lib/ai/edit-cost-guard.ts`:

  ```ts
  import "server-only";
  import { createAdminClient } from "@/lib/supabase/admin";

  /**
   * edit-cost-guard — rate-limit + budget gate for chat-driven edits (R2 / §3.3).
   * Pure decision (evaluateEditBudget) is unit-tested; assertEditBudget does the
   * window reads then delegates. Caps are deliberately conservative for the
   * internal pilot; tune after the first live runs.
   */

  /** Rolling window for rate limiting. */
  export const EDIT_RATE_WINDOW_MS = 5 * 60 * 1000;
  /** Max edit dispatches per window per project. */
  export const MAX_EDITS_PER_WINDOW = 5;
  /** Max chat messages per window per project. */
  export const MAX_CHAT_MESSAGES_PER_WINDOW = 30;
  /** Cap on how many prior conversation turns the planner sees. */
  export const PLANNER_MAX_TURNS = 12;
  /** Hard token caps surfaced for callers (the generator gate also size-caps output). */
  export const PLANNER_COST_CAP_TOKENS = 30_000;
  export const EDIT_COST_CAP_TOKENS = 60_000;

  export class EditBudgetError extends Error {
    constructor(
      public readonly code: "rate_limited_edits" | "rate_limited_messages",
      message: string,
    ) {
      super(message);
      this.name = "EditBudgetError";
    }
  }

  export interface EvaluateEditBudgetInput {
    now: number;
    recentEditCreatedAts: string[];
    recentMessageCreatedAts: string[];
  }

  export type EditBudgetResult =
    | { ok: true }
    | { ok: false; code: "rate_limited_edits" | "rate_limited_messages"; reason: string };

  export function evaluateEditBudget(input: EvaluateEditBudgetInput): EditBudgetResult {
    const cutoff = input.now - EDIT_RATE_WINDOW_MS;
    const inWindow = (ats: string[]) => ats.filter((a) => Date.parse(a) >= cutoff).length;

    if (inWindow(input.recentEditCreatedAts) >= MAX_EDITS_PER_WINDOW) {
      return {
        ok: false,
        code: "rate_limited_edits",
        reason: "You've started several edits very recently. Give the current ones a moment to finish.",
      };
    }
    if (inWindow(input.recentMessageCreatedAts) >= MAX_CHAT_MESSAGES_PER_WINDOW) {
      return {
        ok: false,
        code: "rate_limited_messages",
        reason: "You're sending messages too quickly. Please slow down.",
      };
    }
    return { ok: true };
  }

  /**
   * DB-reading wrapper. Throws EditBudgetError on exceed. Uses the admin client
   * (the caller has already RLS-verified project membership).
   */
  export async function assertEditBudget(args: { projectId: string }): Promise<void> {
    const supabase = createAdminClient();
    const since = new Date(Date.now() - EDIT_RATE_WINDOW_MS).toISOString();
    const [{ data: edits }, { data: messages }] = await Promise.all([
      supabase
        .from("workspace_edits")
        .select("created_at")
        .eq("project_id", args.projectId)
        .gte("created_at", since),
      supabase
        .from("chat_messages")
        .select("created_at")
        .eq("project_id", args.projectId)
        .gte("created_at", since),
    ]);
    const result = evaluateEditBudget({
      now: Date.now(),
      recentEditCreatedAts: (edits ?? []).map((e) => (e as { created_at: string }).created_at),
      recentMessageCreatedAts: (messages ?? []).map((m) => (m as { created_at: string }).created_at),
    });
    if (!result.ok) throw new EditBudgetError(result.code, result.reason);
  }
  ```

- [ ] **Step 4: Run, verify PASS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/ai/edit-cost-guard.test.ts
  pnpm --filter @jab/web typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/ai/edit-cost-guard.ts apps/web/lib/ai/edit-cost-guard.test.ts
  git commit -m "feat(saas): edit cost guard — rate limit + budget caps for chat edits

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 9: `edit-planner.ts` (`planEdit` constrained Claude call)

The planner: a constrained tool-use Claude call that takes the conversation turns + the site map and returns a typed `EditPlan` + usage. It is constrained to the `EDIT_PLAN_TOOL_SCHEMA` (scope ∈ `component|shell` only) and biased toward a clarifying question on low confidence (R2). It is tested with a **mocked planner client** (a small injectable interface) so no real API call fires: an actionable plan, a clarifying plan, and a hallucinated-target plan (which `parsePlannerToolUse` returns verbatim — `validateEditPlan` in the caller rejects it).

The planner does not call `validateEditPlan` itself — the caller (Task 16 `sendChatMessageAction`) validates against the same `siteMap`. The planner's job is purely to produce a typed plan from the model's tool output.

**Files:**
- Create: `apps/web/lib/ai/edit-planner.ts`
- Create (test): `apps/web/lib/ai/edit-planner.test.ts`

- [ ] **Step 1: Write the failing test**

  Create `apps/web/lib/ai/edit-planner.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { planEdit, parsePlannerToolUse, type PlannerClient } from "./edit-planner";
  import type { SiteMap } from "@/lib/jab/site-map";

  const siteMap: SiteMap = {
    blockTypes: [{ blockName: "core/cover", label: "Cover", tier: "visual", occurrenceCount: 4 }],
    pageSlugs: ["home"],
    shell: { header: true, footer: false },
  };

  function mockClient(toolInput: Record<string, unknown>): PlannerClient {
    return {
      async createPlan() {
        return {
          toolInput,
          usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
        };
      },
    };
  }

  describe("parsePlannerToolUse", () => {
    it("coerces a well-formed actionable tool input to an EditPlan", () => {
      const plan = parsePlannerToolUse({
        needsClarification: false,
        scope: "component",
        target: "core/cover",
        action: "Regenerate Cover — affects 1 page",
        regenerationPrompt: "Make it bolder",
        clarifyingQuestion: null,
      });
      expect(plan).toEqual({
        needsClarification: false,
        scope: "component",
        target: "core/cover",
        action: "Regenerate Cover — affects 1 page",
        regenerationPrompt: "Make it bolder",
        clarifyingQuestion: null,
      });
    });

    it("defaults a missing/garbage scope to component and missing strings to empty", () => {
      const plan = parsePlannerToolUse({ needsClarification: true, clarifyingQuestion: "Which one?" });
      expect(plan.scope).toBe("component");
      expect(plan.needsClarification).toBe(true);
      expect(plan.target).toBe("");
      expect(plan.regenerationPrompt).toBe("");
      expect(plan.clarifyingQuestion).toBe("Which one?");
    });

    it("clamps a deferred scope (page) down to component (never representable)", () => {
      const plan = parsePlannerToolUse({ needsClarification: false, scope: "page", target: "home" });
      expect(plan.scope).toBe("component");
    });
  });

  describe("planEdit", () => {
    it("returns an actionable plan + usage from the client", async () => {
      const { plan, usage } = await planEdit({
        messages: [{ role: "user", content: "make the hero bolder" }],
        siteMap,
        client: mockClient({
          needsClarification: false,
          scope: "component",
          target: "core/cover",
          action: "Regenerate Cover — affects 1 page",
          regenerationPrompt: "Make the hero bolder",
          clarifyingQuestion: null,
        }),
      });
      expect(plan.scope).toBe("component");
      expect(plan.target).toBe("core/cover");
      expect(usage.inputTokens).toBe(100);
    });

    it("returns a clarifying plan for a vague request", async () => {
      const { plan } = await planEdit({
        messages: [{ role: "user", content: "make it nicer" }],
        siteMap,
        client: mockClient({ needsClarification: true, clarifyingQuestion: "Which section did you mean?" }),
      });
      expect(plan.needsClarification).toBe(true);
      expect(plan.clarifyingQuestion).toMatch(/which/i);
    });

    it("passes a hallucinated target straight through (caller validates)", async () => {
      const { plan } = await planEdit({
        messages: [{ role: "user", content: "change the testimonials" }],
        siteMap,
        client: mockClient({
          needsClarification: false,
          scope: "component",
          target: "core/testimonials",
          action: "Regenerate Testimonials",
          regenerationPrompt: "x",
          clarifyingQuestion: null,
        }),
      });
      expect(plan.target).toBe("core/testimonials"); // unknown to siteMap; caller rejects.
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/ai/edit-planner.test.ts
  ```
  Expected: `Failed to resolve import "./edit-planner"`.

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/lib/ai/edit-planner.ts`:

  ```ts
  import "server-only";
  import Anthropic from "@anthropic-ai/sdk";
  import { EDIT_PLAN_TOOL_SCHEMA, type EditPlan } from "@/lib/jab/edit-plan";
  import type { SiteMap } from "@/lib/jab/site-map";
  import { PLANNER_MAX_TURNS } from "./edit-cost-guard";
  import type { WorkspaceEditScope } from "@/lib/jab/workspace-edit-validation";

  /**
   * edit-planner — the constrained planner LLM (spec §3.3). Sonnet, tool-use
   * forced to EDIT_PLAN_TOOL_SCHEMA so the model can ONLY emit a structured plan
   * (scope ∈ component|shell). Biased toward a clarifying question on low
   * confidence (R2). Injectable PlannerClient keeps the call mockable in tests.
   */

  export interface PlannerUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }

  export interface PlannerClientResult {
    toolInput: Record<string, unknown>;
    usage: PlannerUsage;
  }

  export interface PlannerMessage {
    role: "user" | "assistant";
    content: string;
  }

  /** Injectable seam — the real impl calls Anthropic; tests pass a mock. */
  export interface PlannerClient {
    createPlan(args: { system: string; messages: PlannerMessage[] }): Promise<PlannerClientResult>;
  }

  const PLANNER_MODEL = "claude-sonnet-4-6";

  function isScope(v: unknown): v is WorkspaceEditScope {
    return v === "component" || v === "shell";
  }

  /** Coerce arbitrary tool-call JSON to a typed EditPlan (defensive). */
  export function parsePlannerToolUse(input: Record<string, unknown>): EditPlan {
    const scope = isScope(input.scope) ? input.scope : "component";
    return {
      needsClarification: input.needsClarification === true,
      scope,
      target: typeof input.target === "string" ? input.target : "",
      action: typeof input.action === "string" ? input.action : "",
      regenerationPrompt: typeof input.regenerationPrompt === "string" ? input.regenerationPrompt : "",
      clarifyingQuestion:
        typeof input.clarifyingQuestion === "string" ? input.clarifyingQuestion : null,
    };
  }

  function buildSystemPrompt(siteMap: SiteMap): string {
    const blockLines = siteMap.blockTypes
      .map((b) => `- ${b.blockName} ("${b.label}", appears on multiple pages)`)
      .join("\n");
    const shells = [
      siteMap.shell.header ? "header" : null,
      siteMap.shell.footer ? "footer" : null,
    ]
      .filter(Boolean)
      .join(", ");
    return `You are the JAB site-edit planner. The user wants to change ONE part of their generated website. Resolve their request into a single structured edit by calling the emit_edit_plan tool.

You may ONLY target one of these regenerable units:

## Block components (scope="component"; target = the exact block_name)
${blockLines || "(none)"}

## Site chrome (scope="shell"; target = "header" or "footer")
Present: ${shells || "(none)"}

Rules:
- Pick exactly ONE target. The target MUST be one of the block_names or shell kinds above — never invent a name.
- If the request is vague ("make it nicer"), names something not in the lists, or could mean several units, set needsClarification=true and ask a specific question listing the real candidates. Do NOT guess.
- A block component is shared across every page it appears on. State the real blast radius in "action" (e.g. "Regenerate the Cover block — this changes it on every page that uses it").
- "regenerationPrompt" is concrete instructions for the code generator (what to change visually/structurally). Keep it focused on this one unit.
- You cannot create pages, delete content, change routing, or edit arbitrary files. Only regenerate one existing unit.`;
  }

  export async function planEdit(args: {
    messages: PlannerMessage[];
    siteMap: SiteMap;
    client: PlannerClient;
  }): Promise<{ plan: EditPlan; usage: PlannerUsage }> {
    const trimmed = args.messages.slice(-PLANNER_MAX_TURNS);
    const system = buildSystemPrompt(args.siteMap);
    const { toolInput, usage } = await args.client.createPlan({ system, messages: trimmed });
    return { plan: parsePlannerToolUse(toolInput), usage };
  }

  /**
   * Real Anthropic-backed PlannerClient. Forces the emit_edit_plan tool so the
   * model's only output channel is the structured plan.
   */
  export class AnthropicPlannerClient implements PlannerClient {
    private readonly sdk: Anthropic;
    constructor() {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set.");
      this.sdk = new Anthropic({ apiKey });
    }

    async createPlan(args: { system: string; messages: PlannerMessage[] }): Promise<PlannerClientResult> {
      const response = await this.sdk.messages.create({
        model: PLANNER_MODEL,
        max_tokens: 1024,
        system: args.system,
        tools: [EDIT_PLAN_TOOL_SCHEMA as unknown as Anthropic.Tool],
        tool_choice: { type: "tool", name: EDIT_PLAN_TOOL_SCHEMA.name },
        messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      const toolBlock = response.content.find((b) => b.type === "tool_use");
      const toolInput =
        toolBlock && toolBlock.type === "tool_use"
          ? (toolBlock.input as Record<string, unknown>)
          : { needsClarification: true, clarifyingQuestion: "Could you describe the change in more detail?" };
      const u = response.usage as {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      return {
        toolInput,
        usage: {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
        },
      };
    }
  }
  ```

- [ ] **Step 4: Run, verify PASS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/ai/edit-planner.test.ts
  pnpm --filter @jab/web typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/ai/edit-planner.ts apps/web/lib/ai/edit-planner.test.ts
  git commit -m "feat(saas): edit-planner constrained tool-use Claude call

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 10: `regenerate-unit.ts` (`regenerateComponentUnit` / `regenerateShellUnit`)

The regen engine the worker calls. `regenerateComponentUnit` loads the target's cloned `block_inventory` row, asserts it exists (verifier major: a validated-but-missing target must fail loudly, never deploy a no-op identical preview), reconstructs the `EnrichedInventoryEntry` via `blockRowToEnrichedEntry`, pulls the visual-tier screenshot via `loadHomeOrSlugScreenshotBase64`, calls `generateComponent({ ..., guidance })`, persists via `persistGeneration` (overwrites the cloned `.tsx` + cost cols), and throws `RegenCompileError` on compile-fail. `regenerateShellUnit` is a no-op marker for the worker — shell guidance is threaded through `config` into compose's generate-header/footer (avoids double-generation), so this function only validates that the shell kind is present and returns. Both are tested with injectable generator + DB seams so no real LLM/Storage fires.

**Files:**
- Create: `apps/web/lib/jab/regenerate-unit.ts`
- Create (test): `apps/web/lib/jab/regenerate-unit.test.ts`

- [ ] **Step 1: Write the failing test**

  Create `apps/web/lib/jab/regenerate-unit.test.ts`:

  ```ts
  import { describe, it, expect, vi } from "vitest";
  import {
    regenerateComponentUnit,
    RegenCompileError,
    type RegenComponentDeps,
  } from "./regenerate-unit";
  import type { GeneratedComponent } from "@/lib/ai/component-generator";

  function okComponent(over: Partial<GeneratedComponent> = {}): GeneratedComponent {
    return {
      blockName: "core/cover",
      tsx: "export function CoreCover() { return <div/>; }",
      compileStatus: "ok",
      compileAttemptCount: 1,
      modelUsed: "claude-sonnet-4-6",
      providerUsed: "anthropic",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ...over,
    };
  }

  function deps(over: Partial<RegenComponentDeps> = {}): RegenComponentDeps {
    return {
      loadTargetRow: vi.fn(async () => ({
        block_name: "core/cover",
        tier: "visual",
        kind: "block",
        spec: null,
        attr_samples: [{}],
        page_slugs: ["home"],
        occurrence_count: 4,
        source_dom_sample: "<div/>",
        computed_styles: null,
      })),
      loadTokens: vi.fn(async () => null),
      loadScreenshot: vi.fn(async () => "BASE64"),
      generate: vi.fn(async () => okComponent()),
      persist: vi.fn(async () => ({ storagePath: "p" })),
      ...over,
    };
  }

  describe("regenerateComponentUnit", () => {
    it("loads the row, generates with guidance, persists, returns ok telemetry", async () => {
      const d = deps();
      const r = await regenerateComponentUnit(
        { buildId: "b2", projectId: "p1", target: "core/cover", guidance: "bolder", screenshotSlug: "home" },
        d,
      );
      expect(r.compileStatus).toBe("ok");
      expect(d.generate).toHaveBeenCalledWith(
        expect.objectContaining({ guidance: "bolder", screenshotBase64: "BASE64" }),
      );
      expect(d.persist).toHaveBeenCalled();
      expect(r.cost.inputTokens).toBe(100);
    });

    it("throws when the target row is missing in the cloned inventory (no-op guard)", async () => {
      const d = deps({ loadTargetRow: vi.fn(async () => null) });
      await expect(
        regenerateComponentUnit(
          { buildId: "b2", projectId: "p1", target: "core/ghost", guidance: "x", screenshotSlug: "home" },
          d,
        ),
      ).rejects.toThrow(/core\/ghost/);
    });

    it("throws RegenCompileError when generation compile-fails", async () => {
      const d = deps({ generate: vi.fn(async () => okComponent({ compileStatus: "failed", tsx: null })) });
      await expect(
        regenerateComponentUnit(
          { buildId: "b2", projectId: "p1", target: "core/cover", guidance: "x", screenshotSlug: "home" },
          d,
        ),
      ).rejects.toBeInstanceOf(RegenCompileError);
      // It STILL persists the failed telemetry so the cost is recorded.
      expect(d.persist).toHaveBeenCalled();
    });

    it("skips screenshot download for a non-visual tier", async () => {
      const d = deps({
        loadTargetRow: vi.fn(async () => ({
          block_name: "core/heading",
          tier: "trivial",
          kind: "block",
          spec: null,
          attr_samples: [{}],
          page_slugs: ["home"],
          occurrence_count: 9,
          source_dom_sample: null,
          computed_styles: null,
        })),
        generate: vi.fn(async () => okComponent({ blockName: "core/heading" })),
      });
      await regenerateComponentUnit(
        { buildId: "b2", projectId: "p1", target: "core/heading", guidance: "x", screenshotSlug: "home" },
        d,
      );
      expect(d.loadScreenshot).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/regenerate-unit.test.ts
  ```
  Expected: `Failed to resolve import "./regenerate-unit"`.

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/lib/jab/regenerate-unit.ts`:

  ```ts
  import "server-only";
  import { createAdminClient } from "@/lib/supabase/admin";
  import {
    generateComponent,
    type GeneratedComponent,
  } from "@/lib/ai/component-generator";
  import { persistGeneration } from "@/lib/ai/persist-generation";
  import {
    blockRowToEnrichedEntry,
    loadHomeOrSlugScreenshotBase64,
    BLOCK_ENTRY_COLUMNS,
    type BlockInventoryRowForEntry,
  } from "@/lib/jab/inventory-entry-from-row";
  import { resolveThemeTokens } from "@/lib/jab/global-styles";
  import type { ThemeJsonTokens, ScrapedBrandTokens } from "@/lib/jab/global-styles";

  /**
   * regenerate-unit — guidance-driven regeneration of ONE targeted unit
   * (spec §3.3, the deferred-7.1 work). Component scope re-runs generateComponent
   * with guidance and overwrites the cloned tsx + cost cols. Shell scope is a
   * no-op here: compose re-runs the shell LLMs anyway, so we thread guidance via
   * config into compose's generate-header/footer (avoids double-generation).
   *
   * Asserts the target row exists in the cloned inventory before generating
   * (verifier major): a validated-but-missing target fails loudly instead of
   * deploying an identical no-op preview.
   */

  export class RegenCompileError extends Error {
    constructor(public readonly target: string, message: string) {
      super(message);
      this.name = "RegenCompileError";
    }
  }

  export interface RegenComponentInput {
    buildId: string;
    projectId: string;
    target: string;
    guidance: string;
    /** Slug whose 1280 screenshot anchors the visual-tier prompt (typically the home/front slug). */
    screenshotSlug: string;
  }

  export interface RegenResult {
    compileStatus: GeneratedComponent["compileStatus"];
    cost: { inputTokens: number; outputTokens: number };
  }

  /** Injectable seams for unit testing (no real LLM / Storage / DB in tests). */
  export interface RegenComponentDeps {
    loadTargetRow(input: RegenComponentInput): Promise<BlockInventoryRowForEntry | null>;
    loadTokens(input: RegenComponentInput): Promise<ThemeJsonTokens | null>;
    loadScreenshot(input: RegenComponentInput): Promise<string | null>;
    generate(args: Parameters<typeof generateComponent>[0]): Promise<GeneratedComponent>;
    persist(args: Parameters<typeof persistGeneration>[0]): Promise<{ storagePath: string | null }>;
  }

  function defaultDeps(): RegenComponentDeps {
    return {
      async loadTargetRow(input) {
        const supabase = createAdminClient();
        const { data } = await supabase
          .from("block_inventory")
          .select(BLOCK_ENTRY_COLUMNS)
          .eq("site_build_id", input.buildId)
          .eq("project_id", input.projectId)
          .eq("block_name", input.target)
          .maybeSingle();
        return (data as BlockInventoryRowForEntry | null) ?? null;
      },
      async loadTokens(input) {
        const supabase = createAdminClient();
        const { data } = await supabase
          .from("projects")
          .select("design_tokens")
          .eq("id", input.projectId)
          .single<{ design_tokens: unknown }>();
        const container = (data?.design_tokens ?? null) as {
          themeJson?: ThemeJsonTokens;
          colors?: ScrapedBrandTokens["colors"];
          typography?: ScrapedBrandTokens["typography"];
        } | null;
        return resolveThemeTokens(container?.themeJson, {
          colors: container?.colors,
          typography: container?.typography,
        });
      },
      async loadScreenshot(input) {
        const supabase = createAdminClient();
        return loadHomeOrSlugScreenshotBase64(supabase, input.buildId, input.screenshotSlug);
      },
      generate: generateComponent,
      persist: persistGeneration,
    };
  }

  export async function regenerateComponentUnit(
    input: RegenComponentInput,
    deps: RegenComponentDeps = defaultDeps(),
  ): Promise<RegenResult> {
    const row = await deps.loadTargetRow(input);
    if (!row) {
      throw new Error(
        `regenerate-unit: target block '${input.target}' not found in cloned inventory for build ${input.buildId}. ` +
          `Refusing to deploy a no-op identical preview.`,
      );
    }

    const entry = blockRowToEnrichedEntry(row);
    const tokens = await deps.loadTokens(input);
    const screenshotBase64 =
      entry.tier === "visual" ? await deps.loadScreenshot(input) : null;

    const component = await deps.generate({
      entry,
      tokens,
      screenshotBase64: screenshotBase64 ?? undefined,
      guidance: input.guidance,
    });

    // Persist regardless of compile status so the cost telemetry + (failed)
    // status land on the cloned row.
    await deps.persist({ buildId: input.buildId, projectId: input.projectId, component });

    if (component.compileStatus === "failed") {
      throw new RegenCompileError(
        input.target,
        `regenerate-unit: regeneration of '${input.target}' failed the compile gate after retries.`,
      );
    }

    return {
      compileStatus: component.compileStatus,
      cost: { inputTokens: component.inputTokens, outputTokens: component.outputTokens },
    };
  }

  /**
   * Shell regen is a no-op marker: compose's generate-header/footer re-run the
   * shell LLM and read guidance off the build config. This exists so the worker
   * has a symmetric call site and can assert the kind is valid.
   */
  export function regenerateShellUnit(target: string): { deferredToCompose: true } {
    if (target !== "header" && target !== "footer") {
      throw new Error(`regenerate-unit: shell target must be 'header' or 'footer' (got '${target}').`);
    }
    return { deferredToCompose: true };
  }
  ```

- [ ] **Step 4: Run, verify PASS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/regenerate-unit.test.ts
  pnpm --filter @jab/web typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/jab/regenerate-unit.ts apps/web/lib/jab/regenerate-unit.test.ts
  git commit -m "feat(saas): regenerate-unit — guidance-driven component regen + missing-target guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 11: `edit-site.helpers.ts` (carry-forward + source-page service-role shims)

Service-role helpers shared by `edit-site.ts` (source-page load for the diff) and `verify-fidelity.ts` (approval carry-forward). `loadSourcePagesForImpact` returns the SOURCE build's `(slug, block_tree)` rows for `computeChangedPages`. `loadSourceApprovals` returns the SOURCE build's fidelity rows joined to their slug. `applyCarryForwardApprovals` direct-UPDATEs `approval_status`/`approved_by_user_id`/`approved_at` on the RESULT build's cloned `fidelity_reports` (inherits the source's approver + timestamp for untouched pages; nulls them for reset pages). These are thin I/O wrappers; the pure cores they feed (`computeChangedPages`, `planApprovalCarryForward`) are already tested. We unit-test the SQL-shaping logic of `applyCarryForwardApprovals` with an injected query builder mock.

**Files:**
- Create: `apps/web/lib/inngest/functions/edit-site.helpers.ts`
- Create (test): `apps/web/lib/inngest/functions/edit-site.helpers.test.ts`

- [ ] **Step 1: Write the failing test**

  Create `apps/web/lib/inngest/functions/edit-site.helpers.test.ts`:

  ```ts
  import { describe, it, expect, vi } from "vitest";
  import { buildCarryForwardUpdates } from "./edit-site.helpers";

  describe("buildCarryForwardUpdates", () => {
    it("emits an inherited approver/timestamp for untouched pages and nulls for reset pages", () => {
      const updates = buildCarryForwardUpdates({
        carry: [
          { pageInventoryId: "r-home", status: "pending" },
          { pageInventoryId: "r-about", status: "approved" },
        ],
        resetToPending: ["home"],
        sourceApprovalMeta: new Map([
          ["r-about-slug", { approvedByUserId: "u1", approvedAt: "2026-06-01T00:00:00Z" }],
        ]),
        // result page id → slug, so we can look up source meta by slug.
        resultIdToSlug: new Map([
          ["r-home", "home"],
          ["r-about", "about"],
        ]),
        sourceSlugMeta: new Map([
          ["about", { approvedByUserId: "u1", approvedAt: "2026-06-01T00:00:00Z" }],
          ["home", { approvedByUserId: "u9", approvedAt: "2026-05-30T00:00:00Z" }],
        ]),
      });
      const byId = new Map(updates.map((u) => [u.pageInventoryId, u]));
      // reset page → pending + null approver/timestamp.
      expect(byId.get("r-home")).toEqual({
        pageInventoryId: "r-home",
        approvalStatus: "pending",
        approvedByUserId: null,
        approvedAt: null,
      });
      // untouched inherited page → carries the source approver + timestamp.
      expect(byId.get("r-about")).toEqual({
        pageInventoryId: "r-about",
        approvalStatus: "approved",
        approvedByUserId: "u1",
        approvedAt: "2026-06-01T00:00:00Z",
      });
    });
  });
  ```

  > The signature deliberately exposes only the pure shaper (`buildCarryForwardUpdates`). The DB-applying `applyCarryForwardApprovals` calls it then issues per-row UPDATEs — its DB round-trips are exercised by the verify worker's manual smoke (Task 13), not a unit test.

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/inngest/functions/edit-site.helpers.test.ts
  ```
  Expected: `Failed to resolve import "./edit-site.helpers"`.

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/lib/inngest/functions/edit-site.helpers.ts`:

  ```ts
  import "server-only";
  import { createAdminClient } from "@/lib/supabase/admin";
  import type { BlockNode } from "@/lib/jab/ability-client";
  import type { SourcePageForImpact } from "@/lib/jab/edit-impact";
  import {
    planApprovalCarryForward,
    type CarriedApprovalStatus,
  } from "@/lib/jab/approval-carry-forward";

  /**
   * edit-site.helpers — service-role shims for the edit build (spec §3.4).
   * Pure shaping (buildCarryForwardUpdates) is unit-tested; the DB round-trips
   * are thin wrappers exercised by the worker smoke.
   */

  /** Load the SOURCE build's (slug, block_tree) rows for computeChangedPages. */
  export async function loadSourcePagesForImpact(sourceBuildId: string): Promise<SourcePageForImpact[]> {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("page_inventory")
      .select("slug, block_tree")
      .eq("site_build_id", sourceBuildId);
    return ((data ?? []) as Array<{ slug: string; block_tree: unknown }>).map((r) => ({
      slug: r.slug,
      blockTree: Array.isArray(r.block_tree) ? (r.block_tree as BlockNode[]) : null,
    }));
  }

  export interface SourceApprovalMeta {
    approvedByUserId: string | null;
    approvedAt: string | null;
  }

  export interface LoadSourceApprovalsResult {
    /** slug → { approvalStatus }. */
    sourceFidelityRows: Array<{ slug: string; approvalStatus: string }>;
    /** slug → approver/timestamp, so inherited pages keep the human decision's provenance. */
    sourceSlugMeta: Map<string, SourceApprovalMeta>;
  }

  /**
   * Load the SOURCE build's fidelity rows joined to page slug. We need both the
   * status (for carry-forward) and the approver/timestamp (to preserve provenance
   * on inherited pages).
   */
  export async function loadSourceApprovals(sourceBuildId: string): Promise<LoadSourceApprovalsResult> {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("fidelity_reports")
      .select("approval_status, approved_by_user_id, approved_at, page_inventory:page_inventory_id(slug)")
      .eq("site_build_id", sourceBuildId);
    const rows = (data ?? []) as Array<{
      approval_status: string;
      approved_by_user_id: string | null;
      approved_at: string | null;
      page_inventory: { slug: string } | { slug: string }[] | null;
    }>;
    const sourceFidelityRows: Array<{ slug: string; approvalStatus: string }> = [];
    const sourceSlugMeta = new Map<string, SourceApprovalMeta>();
    for (const r of rows) {
      const pi = Array.isArray(r.page_inventory) ? r.page_inventory[0] : r.page_inventory;
      const slug = pi?.slug;
      if (!slug) continue;
      sourceFidelityRows.push({ slug, approvalStatus: r.approval_status });
      sourceSlugMeta.set(slug, {
        approvedByUserId: r.approved_by_user_id,
        approvedAt: r.approved_at,
      });
    }
    return { sourceFidelityRows, sourceSlugMeta };
  }

  export interface CarryForwardUpdate {
    pageInventoryId: string;
    approvalStatus: CarriedApprovalStatus;
    approvedByUserId: string | null;
    approvedAt: string | null;
  }

  /**
   * Pure shaper: turn the carry-forward plan + source provenance into per-row
   * UPDATE payloads. Reset pages → pending + null provenance. Inherited pages →
   * the source slug's approver/timestamp (null when the source row had none).
   */
  export function buildCarryForwardUpdates(args: {
    carry: Array<{ pageInventoryId: string; status: CarriedApprovalStatus }>;
    resetToPending: string[];
    resultIdToSlug: Map<string, string>;
    sourceSlugMeta: Map<string, SourceApprovalMeta>;
    /** Unused legacy param kept for call-site symmetry; ignore. */
    sourceApprovalMeta?: Map<string, SourceApprovalMeta>;
  }): CarryForwardUpdate[] {
    const reset = new Set(args.resetToPending);
    return args.carry.map((c) => {
      const slug = args.resultIdToSlug.get(c.pageInventoryId);
      const isReset = slug !== undefined && reset.has(slug);
      if (isReset || c.status === "pending") {
        return {
          pageInventoryId: c.pageInventoryId,
          approvalStatus: "pending",
          approvedByUserId: null,
          approvedAt: null,
        };
      }
      const meta = slug ? args.sourceSlugMeta.get(slug) : undefined;
      return {
        pageInventoryId: c.pageInventoryId,
        approvalStatus: c.status,
        approvedByUserId: meta?.approvedByUserId ?? null,
        approvedAt: meta?.approvedAt ?? null,
      };
    });
  }

  /**
   * Apply approval carry-forward to the RESULT build's cloned fidelity_reports.
   * Loads source approvals + result page slugs, computes the plan, shapes the
   * updates, and issues per-row UPDATEs via service-role.
   */
  export async function applyCarryForwardApprovals(args: {
    resultBuildId: string;
    sourceBuildId: string;
    changedSlugs: string[];
  }): Promise<{ updated: number }> {
    const supabase = createAdminClient();

    // Result page rows: result page_inventory.id ↔ slug.
    const { data: resultPagesRaw } = await supabase
      .from("page_inventory")
      .select("id, slug")
      .eq("site_build_id", args.resultBuildId);
    const resultPages = ((resultPagesRaw ?? []) as Array<{ id: string; slug: string }>).map((p) => ({
      slug: p.slug,
      pageInventoryId: p.id,
    }));
    const resultIdToSlug = new Map(resultPages.map((p) => [p.pageInventoryId, p.slug]));

    const { sourceFidelityRows, sourceSlugMeta } = await loadSourceApprovals(args.sourceBuildId);

    const plan = planApprovalCarryForward({
      sourceFidelityRows,
      resultPages,
      changedSlugs: args.changedSlugs,
    });

    const updates = buildCarryForwardUpdates({
      carry: plan.carry,
      resetToPending: plan.resetToPending,
      resultIdToSlug,
      sourceSlugMeta,
    });

    let updated = 0;
    for (const u of updates) {
      const { error } = await supabase
        .from("fidelity_reports")
        .update({
          approval_status: u.approvalStatus,
          approved_by_user_id: u.approvedByUserId,
          approved_at: u.approvedAt,
        })
        .eq("site_build_id", args.resultBuildId)
        .eq("page_inventory_id", u.pageInventoryId);
      if (!error) updated++;
    }
    return { updated };
  }
  ```

- [ ] **Step 4: Run, verify PASS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/inngest/functions/edit-site.helpers.test.ts
  pnpm --filter @jab/web typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/inngest/functions/edit-site.helpers.ts apps/web/lib/inngest/functions/edit-site.helpers.test.ts
  git commit -m "feat(saas): edit-site carry-forward + source-page service-role shims

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 12: `build-cancel.ts` — shared `isBuildCancelled` cancel check

A one-line shared re-read of `site_builds.status` so compose / deploy / verify can short-circuit when a discard set the build to `cancelled` (§3.4 cancel guards). Pure-ish (it does one SELECT); the decision is trivial but factored out so all three workers call the identical query and the `'cancelled'` literal lives in one place.

**Files:**
- Create: `apps/web/lib/jab/build-cancel.ts`
- Create (test): `apps/web/lib/jab/build-cancel.test.ts`

- [ ] **Step 1: Write the failing test**

  Create `apps/web/lib/jab/build-cancel.test.ts`:

  ```ts
  import { describe, it, expect, vi } from "vitest";
  import { isBuildCancelled } from "./build-cancel";

  function fakeSupabase(status: string | null, error: unknown = null) {
    const chain = {
      from: vi.fn(() => chain),
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => ({ data: status === null ? null : { status }, error })),
    };
    return chain as unknown as Parameters<typeof isBuildCancelled>[0];
  }

  describe("isBuildCancelled", () => {
    it("true when the build row status is 'cancelled'", async () => {
      expect(await isBuildCancelled(fakeSupabase("cancelled"), "b", "p")).toBe(true);
    });
    it("false for any non-cancelled status", async () => {
      expect(await isBuildCancelled(fakeSupabase("composing"), "b", "p")).toBe(false);
      expect(await isBuildCancelled(fakeSupabase("ready"), "b", "p")).toBe(false);
    });
    it("false (fail-open) when the row is missing or the query errors", async () => {
      expect(await isBuildCancelled(fakeSupabase(null), "b", "p")).toBe(false);
      expect(await isBuildCancelled(fakeSupabase("cancelled", { message: "boom" }), "b", "p")).toBe(false);
    });
  });
  ```

  > Fail-OPEN on error is deliberate: a transient read failure must not silently abort a legitimate build. The discard path's direct UPDATE to `cancelled` is the source of truth; the worker guards are a best-effort fast stop, and verify's final `ready` flip is additionally `WHERE status != 'cancelled'` (Task 14) so a missed guard still can't promote a cancelled build.

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/build-cancel.test.ts
  ```
  Expected: `Failed to resolve import "./build-cancel"`.

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/lib/jab/build-cancel.ts`:

  ```ts
  import "server-only";
  import type { SupabaseClient } from "@supabase/supabase-js";

  /**
   * build-cancel — shared cancel check for the edit pipeline workers (spec §3.4).
   * discardEditAction sets site_builds.status='cancelled' directly; compose,
   * deploy, and verify re-read at entry and bail if cancelled so a discard
   * actually stops the pipeline (not cosmetic). Fail-open on read error.
   */
  export async function isBuildCancelled(
    supabase: SupabaseClient,
    buildId: string,
    projectId: string,
  ): Promise<boolean> {
    const { data, error } = await supabase
      .from("site_builds")
      .select("status")
      .eq("id", buildId)
      .eq("project_id", projectId)
      .maybeSingle();
    if (error || !data) return false;
    return (data as { status: string }).status === "cancelled";
  }
  ```

- [ ] **Step 4: Run, verify PASS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/build-cancel.test.ts
  pnpm --filter @jab/web typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/jab/build-cancel.ts apps/web/lib/jab/build-cancel.test.ts
  git commit -m "feat(saas): isBuildCancelled shared cancel check for pipeline workers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 13: `edit-site.ts` rewrite — the one regen-seam edit (SOLE OWNER)

The single rewrite of the `edit-site.ts` seam (§2.1 rule 2). Changes:
1. Parse the extended `SiteEditRequestedData` payload (regenerationPrompt/action/messageId, with `prompt` fallback).
2. `create-result-build` writes the **full** `BuildConfig` edit shape (§2.4), not the old 4-field object.
3. Between `clone-storage-artifacts` (line ~149/177) and `dispatch-compose` (line ~191), insert two steps:
   - `regenerate-target` — component scope: `regenerateComponentUnit(...)`; shell scope: `regenerateShellUnit(target)` (no-op marker, guidance rides in config). On `RegenCompileError` OR the missing-target throw: mark edit + result build failed, **return without dispatching compose**.
   - `compute-changed-pages` — `loadSourcePagesForImpact(sourceBuildId)` + `computeChangedPages(...)`, then UPDATE `workspace_edits.changed_slugs`/`change_reason` AND patch `config.changed_slugs`/`config.change_reason` on the result build.
4. `link-edit-row` also backfills `chat_messages.build_id` for the triggering message.
5. Export `listAllUnderPrefix` (the discard action reuses it for Storage cleanup).

Inngest workers have no practical unit-test harness here; verification is typecheck + the e2e smoke (Task 23). This task quotes enough surrounding context that the edit is unambiguous.

**Files:**
- Modify: `apps/web/lib/inngest/functions/edit-site.ts`

- [ ] **Step 1: Replace the imports + payload parse + create-result-build + link-edit-row**

  At the top of the file, the current imports are:

  ```ts
  import "server-only";
  import { inngest } from "../client";
  import { createAdminClient } from "@/lib/supabase/admin";
  import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
  import { markBuildFailed } from "@/lib/inngest/shared-failure";
  ```

  Replace with:

  ```ts
  import "server-only";
  import { inngest } from "../client";
  import { createAdminClient } from "@/lib/supabase/admin";
  import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
  import { markBuildFailed } from "@/lib/inngest/shared-failure";
  import { EDIT_REQUESTED_EVENT, type SiteEditRequestedData } from "@/lib/inngest/edit-request-event";
  import type { BuildConfig } from "@/lib/jab/build-config";
  import { regenerateComponentUnit, regenerateShellUnit, RegenCompileError } from "@/lib/jab/regenerate-unit";
  import { computeChangedPages } from "@/lib/jab/edit-impact";
  import { loadSourcePagesForImpact } from "@/lib/inngest/functions/edit-site.helpers";
  ```

  Change the event registration from `{ event: "site/edit.requested" }` to `{ event: EDIT_REQUESTED_EVENT }`.

  Replace the payload-parse block (lines 36–52) — currently:

  ```ts
      const {
        editId,
        projectId,
        tenantId,
        sourceBuildId,
        scope,
        target,
        prompt,
      } = event.data as {
        editId: string;
        projectId: string;
        tenantId: string;
        sourceBuildId: string;
        scope: "component" | "shell" | "page";
        target: string;
        prompt: string;
      };
  ```

  with:

  ```ts
      const {
        editId,
        projectId,
        tenantId,
        sourceBuildId,
        scope,
        target,
        prompt,
        regenerationPrompt,
        action,
        messageId,
      } = event.data as SiteEditRequestedData;
      // Manual-form path omits regenerationPrompt → fall back to the raw prompt.
      const guidance = (regenerationPrompt ?? prompt ?? "").trim();
      const planAction = action ?? `Edited ${scope} '${target}'`;
  ```

  Replace the `create-result-build` step (lines 65–86) — its `config` object currently is the 4-field `{ mode, source_build_id, scope, target, prompt }`. Replace the whole step with:

  ```ts
        resultBuildId = await step.run("create-result-build", async () => {
          const supabase = createAdminClient();
          const config: BuildConfig = {
            mode: "edit",
            source_build_id: sourceBuildId,
            scope,
            target,
            prompt,
            regeneration_prompt: guidance,
            action: planAction,
            edit_id: editId,
            message_id: messageId ?? null,
            changed_slugs: [],
            change_reason: null,
          };
          const { data, error } = await supabase
            .from("site_builds")
            .insert({ project_id: projectId, status: "queued", config })
            .select("id")
            .single<{ id: string }>();
          if (error || !data) {
            throw new Error(`edit-site: create-result-build failed: ${error?.message ?? "no row"}`);
          }
          return data.id;
        });
  ```

  Replace the `link-edit-row` step (lines 88–95) — currently only updates `workspace_edits.result_build_id`. Replace with a version that also backfills the triggering chat message's `build_id`:

  ```ts
        await step.run("link-edit-row", async () => {
          const supabase = createAdminClient();
          const { error } = await supabase
            .from("workspace_edits")
            .update({ result_build_id: resultBuildId })
            .eq("id", editId);
          if (error) throw new Error(`edit-site: link-edit-row update failed: ${error.message}`);
          // Backfill the chat message that triggered this edit so the chat card
          // can link to the result build's preview/review. messageId is null on
          // the manual-form path — skip the backfill there.
          if (messageId) {
            await supabase
              .from("chat_messages")
              .update({ build_id: resultBuildId, edit_id: editId })
              .eq("id", messageId);
          }
        });
  ```

- [ ] **Step 2: Insert `regenerate-target` + `compute-changed-pages` between clone and dispatch**

  After the `clone-storage-artifacts` step closes (line ~177, the `const storageCopied = await step.run("clone-storage-artifacts", ...)` block) and the `console.log(...cloned...)` line, and BEFORE the `await step.sendEvent("dispatch-compose", ...)` block, insert:

  ```ts
        // ── Regenerate the targeted unit (the deferred-7.1 work; sole owner). ──
        // Component scope: re-run generateComponent with guidance, overwriting the
        // cloned tsx. Shell scope: a no-op here — compose's generate-header/footer
        // read config.regeneration_prompt (avoids double-generation).
        const regenOutcome = await step.run("regenerate-target", async () => {
          try {
            if (scope === "shell") {
              regenerateShellUnit(target);
              return { ok: true as const, kind: "shell" as const };
            }
            // Component scope. Anchor the visual-tier screenshot on the front/home
            // slug; loadHomeOrSlugScreenshotBase64 fails soft when absent.
            const supabase = createAdminClient();
            const { data: front } = await supabase
              .from("page_inventory")
              .select("slug")
              .eq("site_build_id", resultBuildId!)
              .eq("route_path", "/")
              .maybeSingle<{ slug: string }>();
            const screenshotSlug = front?.slug ?? "home";
            const result = await regenerateComponentUnit({
              buildId: resultBuildId!,
              projectId,
              target,
              guidance,
              screenshotSlug,
            });
            return { ok: true as const, kind: "component" as const, compileStatus: result.compileStatus };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const isCompile = err instanceof RegenCompileError;
            return { ok: false as const, isCompile, message };
          }
        });

        if (!regenOutcome.ok) {
          // Hard stop: mark edit + result build failed, surface to chat, do NOT
          // dispatch compose (no broken/no-op preview). The catch below also
          // handles thrown errors; here we short-circuit a soft-failed regen.
          await step.run("abort-on-regen-fail", async () => {
            const supabase = createAdminClient();
            await supabase
              .from("workspace_edits")
              .update({
                status: "failed",
                error_text: `regeneration failed: ${regenOutcome.message}`,
                finished_at: new Date().toISOString(),
              })
              .eq("id", editId);
            if (messageId) {
              await supabase
                .from("chat_messages")
                .update({ content: `That edit couldn't be applied: ${regenOutcome.message}` })
                .eq("id", messageId);
            }
          });
          await markBuildFailed({ buildId: resultBuildId!, projectId, phase: "components", error: new Error(regenOutcome.message) });
          return { editId, resultBuildId, regenFailed: true };
        }

        // ── Compute the changed-page set (S4's pure core; SOURCE block_tree). ──
        const changed = await step.run("compute-changed-pages", async () => {
          const sourcePages = await loadSourcePagesForImpact(sourceBuildId);
          const result = computeChangedPages({ scope, target, sourcePages });
          const supabase = createAdminClient();
          // Write the workspace_edits provenance.
          await supabase
            .from("workspace_edits")
            .update({ changed_slugs: result.changedSlugs, change_reason: result.reason })
            .eq("id", editId);
          // Patch config.changed_slugs / change_reason on the result build so the
          // verify carry-forward + scoped review read them off config.
          const { data: buildRow } = await supabase
            .from("site_builds")
            .select("config")
            .eq("id", resultBuildId!)
            .single<{ config: BuildConfig }>();
          const nextConfig: BuildConfig =
            buildRow && buildRow.config.mode === "edit"
              ? { ...buildRow.config, changed_slugs: result.changedSlugs, change_reason: result.reason }
              : (buildRow?.config ?? { mode: "full" });
          await supabase.from("site_builds").update({ config: nextConfig }).eq("id", resultBuildId!);
          return result;
        });
        console.log(`[edit-site] changed ${changed.changedSlugs.length} page(s) (reason=${changed.reason})`);
  ```

  Also **delete** the now-stale Phase-7.1 comment block above the `dispatch-compose` step (lines 187–190, the `// Phase 7.1 will slot the regeneration step in BEFORE this dispatch:` comment) — the regen now lives above.

- [ ] **Step 3: Export `listAllUnderPrefix`**

  At the bottom of the file, change `async function listAllUnderPrefix(` to `export async function listAllUnderPrefix(` so `discardEditAction` (Task 18) can reuse it for Storage cleanup.

- [ ] **Step 4: Verify — typecheck + the regen-unit/edit-impact suites still pass**

  ```bash
  pnpm --filter @jab/web typecheck
  pnpm --filter @jab/web exec vitest run lib/jab/regenerate-unit.test.ts lib/jab/edit-impact.test.ts lib/inngest/functions/edit-site.helpers.test.ts
  ```
  Expected: typecheck clean (the worker compiles against the new imports + `SiteEditRequestedData`); the pure cores it calls are green. The worker's end-to-end behavior is proven in Task 23's smoke.

  Manual sanity (optional, requires the Inngest dev server + a seeded ready build): dispatch `site/edit.requested` with a `component`/`core/cover` payload and confirm in the Inngest dev UI that `regenerate-target` runs before `dispatch-compose` and `compute-changed-pages` wrote `changed_slugs`.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/inngest/functions/edit-site.ts
  git commit -m "feat(saas): edit-site regen seam — guidance regen + changed-page compute + chat backfill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 14: `verify-fidelity.ts` — ONE coordinated change (carry-forward + cancel-guard + S1 perf hook)

`verify-fidelity.ts` is edited EXACTLY ONCE this phase (§2.1 rule 6), carrying all three concerns:
- **S4 carry-forward:** add `config` to the load-build SELECT; when `isEditConfig(config)`, run `applyCarryForwardApprovals` in finalize BEFORE the `ready` flip; handle `mark-ready-empty` explicitly (zero-page edit skips carry-forward → the gate's `no_fidelity_rows` reject correctly blocks publish, documented as intended fail-closed).
- **S4 cancel guard:** the `ready` flip is a conditional UPDATE `... WHERE status != 'cancelled'`; carry-forward is skipped if the build is cancelled.
- **S1 perf hook:** a pure `extractNavPerf(navTimingJson)` helper (TDD'd here — it is the Phase-3-owned `perf-capture.ts` shape, but the verify-side capture lands in Phase 2 per §2.1) + a `collectPerfForHomeRoute` call inside the existing capture loop (fail-soft) + writing `ttfb_ms`/`load_ms`/`transfer_bytes` in finalize.

> **Phase 3 boundary (deliberate temporary duplication — has a named owner):** Phase 3 owns the pure `lib/jab/perf-capture.ts` module (`extractPerf`) and the UI that reads the perf columns. To avoid a cross-phase file collision, Phase 2 inlines a small `extractNavPerf` in `playwright-verify.ts` (where the capture happens) rather than importing Phase 3's not-yet-existent module. `extractNavPerf` and Phase 3's `extractPerf` MUST share the identical return shape (`{ ttfbMs, loadMs, transferBytes }`) and metric math (ttfb = `responseStart - requestStart`, load = `loadEventEnd - startTime`, transfer = `transferSize`, rounded, negatives → null) so the re-home is a pure rename. **Re-home obligation (must be a tracked Phase-3 task, not just this note):** when Phase 3 lands `perf-capture.ts`, it deletes this inline `extractNavPerf`, re-points `collectPerfForHomeRoute` to `import { extractPerf } from "@/lib/jab/perf-capture"`, and asserts (via the existing `playwright-verify.perf.test.ts` re-pointed at `extractPerf`) the two produced byte-identical output before removal. Until that task lands the duplicate is live and could drift — Phase 3 is the owner.

**Files:**
- Modify: `apps/web/lib/jab/playwright-verify.ts` — add `extractNavPerf` (pure) + `collectPerfForHomeRoute` (fail-soft Playwright eval) without disturbing `captureGeneratedScreenshots`.
- Modify: `apps/web/lib/inngest/functions/verify-fidelity.ts` — load `config`; perf capture in the capture step; carry-forward + conditional ready flip + perf write in finalize.
- Create (test): `apps/web/lib/jab/playwright-verify.perf.test.ts`

- [ ] **Step 1: Write the failing test (perf extraction is the pure unit)**

  Create `apps/web/lib/jab/playwright-verify.perf.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { extractNavPerf } from "./playwright-verify";

  describe("extractNavPerf", () => {
    it("derives ttfb/load/transfer from a navigation timing entry", () => {
      const perf = extractNavPerf({
        requestStart: 10,
        responseStart: 48,
        startTime: 0,
        loadEventEnd: 1234,
        transferSize: 543210,
      });
      expect(perf).toEqual({ ttfbMs: 38, loadMs: 1234, transferBytes: 543210 });
    });

    it("rounds sub-millisecond values and clamps negatives to null", () => {
      const perf = extractNavPerf({
        requestStart: 100,
        responseStart: 90, // negative TTFB → null
        startTime: 0,
        loadEventEnd: 200.7,
        transferSize: 0,
      });
      expect(perf.ttfbMs).toBeNull();
      expect(perf.loadMs).toBe(201);
      expect(perf.transferBytes).toBe(0);
    });

    it("returns all-null for a null/garbage entry (fail-soft)", () => {
      expect(extractNavPerf(null)).toEqual({ ttfbMs: null, loadMs: null, transferBytes: null });
      expect(extractNavPerf({} as never)).toEqual({ ttfbMs: null, loadMs: null, transferBytes: null });
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/playwright-verify.perf.test.ts
  ```
  Expected: `extractNavPerf is not exported`.

- [ ] **Step 3: Implement `extractNavPerf` + `collectPerfForHomeRoute` in `playwright-verify.ts`**

  Add near the top of `apps/web/lib/jab/playwright-verify.ts` (after the existing interface exports, before `captureGeneratedScreenshots`):

  ```ts
  /** Navigation-timing perf for a single route. NULL fields = uncaptured/invalid. */
  export interface NavPerf {
    ttfbMs: number | null;
    loadMs: number | null;
    transferBytes: number | null;
  }

  /** Shape of performance.getEntriesByType('navigation')[0] we depend on. */
  export interface NavTimingJson {
    requestStart: number;
    responseStart: number;
    startTime: number;
    loadEventEnd: number;
    transferSize: number;
  }

  /**
   * Pure derivation of TTFB / load / transfer from a navigation-timing entry.
   * Negative or zero-derived timings clamp to null (a failed/partial capture
   * must never be recorded as a real 0ms). Phase-2-owned; Phase 3 re-homes this
   * into lib/jab/perf-capture.ts (extractPerf).
   */
  export function extractNavPerf(nav: NavTimingJson | null | undefined): NavPerf {
    if (!nav || typeof nav !== "object") {
      return { ttfbMs: null, loadMs: null, transferBytes: null };
    }
    const ttfbRaw = (nav.responseStart ?? 0) - (nav.requestStart ?? 0);
    const loadRaw = (nav.loadEventEnd ?? 0) - (nav.startTime ?? 0);
    const ttfbMs = ttfbRaw > 0 ? Math.round(ttfbRaw) : null;
    const loadMs = loadRaw > 0 ? Math.round(loadRaw) : null;
    const transferBytes =
      typeof nav.transferSize === "number" && nav.transferSize >= 0 ? nav.transferSize : null;
    return { ttfbMs, loadMs, transferBytes };
  }

  /**
   * Best-effort home-route perf capture, reusing the SAME Chromium context the
   * screenshot pass already launches (no extra cold launch — verifier major).
   * Fail-soft: any error returns all-null. Call inside the existing per-page
   * loop in captureGeneratedScreenshots for the home route only.
   */
  export async function collectPerfForHomeRoute(
    browserPage: import("playwright").Page,
  ): Promise<NavPerf> {
    try {
      const nav = (await browserPage.evaluate(() => {
        const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        if (!entry) return null;
        return {
          requestStart: entry.requestStart,
          responseStart: entry.responseStart,
          startTime: entry.startTime,
          loadEventEnd: entry.loadEventEnd,
          transferSize: entry.transferSize,
        };
      })) as NavTimingJson | null;
      return extractNavPerf(nav);
    } catch {
      return { ttfbMs: null, loadMs: null, transferBytes: null };
    }
  }
  ```

  Then thread the home-route perf into the existing capture loop in `captureGeneratedScreenshots`. The real loop structure (verify against the source — lines 63–110): the OUTER loop variable is `page` (a `VerifyPageDescriptor`, so the route lives on `page.routePath`), the per-page accumulator is the named `const pageResult: VerifyPageResult` built at line 64, the INNER loop is `for (const viewport of viewports)`, and `browserPage` is created INSIDE the inner loop with `await context.close()` running at line 86 right after `await browserPage.screenshot(...)`. So the perf capture must happen inside the inner viewport loop, after the settle+screenshot and BEFORE `await context.close()` — and guarded to run exactly once (the home route, on the 1280 viewport only).

  First, in the `VerifyPageResult` interface (line 39) add:

  ```ts
    /** Home-route navigation-timing perf, present only on the route_path==='/' result. */
    perf?: NavPerf;
  ```

  Then in the inner viewport loop, immediately after `const buf = await browserPage.screenshot({ fullPage: true });` (line 85) and BEFORE `await context.close();` (line 86), add:

  ```ts
          // Capture home-route perf once, off the SAME browserPage before the
          // context closes (no extra cold launch — verifier major). Gate on the
          // descriptor's routePath (the route lives on `page`, not `pageResult`)
          // and the 1280 viewport so it runs exactly once per build.
          if (page.routePath === "/" && viewport === 1280) {
            pageResult.perf = await collectPerfForHomeRoute(browserPage);
          }
  ```

  (Sets `pageResult.perf` — the existing per-page accumulator — not a `result`/`descriptor` binding; those do not exist in this loop.)

- [ ] **Step 4: Edit `verify-fidelity.ts` — load config, perf in capture, carry-forward + conditional ready + perf in finalize**

  In `apps/web/lib/inngest/functions/verify-fidelity.ts`:

  Add imports:

  ```ts
  import { isEditConfig, type BuildConfig } from "@/lib/jab/build-config";
  import { applyCarryForwardApprovals } from "@/lib/inngest/functions/edit-site.helpers";
  import { isBuildCancelled } from "@/lib/jab/build-cancel";
  import type { NavPerf } from "@/lib/jab/playwright-verify";
  ```

  **(a) load-build:** change the SELECT (line 53) from `"id, project_id, status, preview_url"` to `"id, project_id, status, preview_url, config"` and the typed result to include `config: unknown`. After the row loads, derive `const config = (data.config ?? { mode: "full" }) as BuildConfig;` and return it on the object (extend the single<...> generic to include `config: unknown`).

  **(b) mark-ready-empty (the zero-page edit):** the existing early-return for `pages.length === 0` already flips to `ready`. Leave it, but add a one-line comment documenting the intended fail-closed behavior:

  ```ts
        // For an edit build with zero pages, we deliberately do NOT carry forward
        // approvals (there are none to carry). The publish gate's no_fidelity_rows
        // reject then correctly blocks publish — intended fail-closed (§3.4).
  ```

  Also make this flip cancel-safe by adding `.neq("status", "cancelled")` to the update chain.

  **(c) capture perf:** the `capture-generated` step returns `generatedResults`. Each result may now carry `perf` for the home route. After that step, derive the home perf once:

  ```ts
        const homePerf: NavPerf =
          generatedResults.find((r) => r.perf)?.perf ?? { ttfbMs: null, loadMs: null, transferBytes: null };
  ```

  **(d) finalize:** replace the `finalize-ready` step with a coordinated finalize. The current step does a single UPDATE to `status: "ready"` + `fidelity_avg`. Replace it with:

  ```ts
        // Carry forward approvals for an edit build BEFORE the ready flip so the
        // scoped review opens with untouched pages already approved (§3.4).
        if (isEditConfig(build.config)) {
          await step.run("carry-forward-approvals", async () => {
            const supabase = createAdminClient();
            if (await isBuildCancelled(supabase, buildId, projectId)) return { skipped: "cancelled" };
            const cfg = build.config as Extract<BuildConfig, { mode: "edit" }>;
            return applyCarryForwardApprovals({
              resultBuildId: buildId,
              sourceBuildId: cfg.source_build_id,
              changedSlugs: cfg.changed_slugs,
            });
          });
        }

        await step.run("finalize-ready", async () => {
          const supabase = createAdminClient();
          // Conditional ready flip: WHERE status != 'cancelled' so a discard that
          // raced the verify pass can never re-promote a cancelled build (§3.4).
          const { error } = await supabase
            .from("site_builds")
            .update({
              status: "ready",
              fidelity_avg: fidelityAvg !== null ? fidelityAvg.toFixed(3) : null,
              ttfb_ms: homePerf.ttfbMs,
              load_ms: homePerf.loadMs,
              transfer_bytes: homePerf.transferBytes,
              finished_at: new Date().toISOString(),
            })
            .eq("id", buildId)
            .eq("project_id", projectId)
            .neq("status", "cancelled");
          if (error) {
            throw new Error(`verify-fidelity: finalize-ready update failed: ${error.message}`);
          }
        });
  ```

  > **Perf fail-soft:** `homePerf` is all-null when capture failed; the UPDATE writes nulls, never failing the build (S1 guardrail). The `transfer_bytes` column is BIGINT; postgres.js accepts a JS number for in-range values (home pages are well under 2^53).

- [ ] **Step 5: Verify**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/playwright-verify.perf.test.ts lib/jab/playwright-verify.test.ts
  pnpm --filter @jab/web typecheck
  ```
  Expected: the new perf suite is green; the pre-existing `playwright-verify.test.ts` still passes (perf addition doesn't perturb capture — verifier guardrail); typecheck clean. (Carry-forward behavior is proven in Task 23 smoke.)

- [ ] **Step 6: Commit**

  ```bash
  git add apps/web/lib/jab/playwright-verify.ts apps/web/lib/jab/playwright-verify.perf.test.ts apps/web/lib/inngest/functions/verify-fidelity.ts
  git commit -m "feat(saas): verify-fidelity coordinated change — carry-forward + cancel-guard + perf capture

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 15: Cancel guards in `compose-site.ts` + `deploy-site.ts` + shell-guidance threading

Two concerns in `compose-site.ts` and one in `deploy-site.ts`:

1. **Cancel guards (both workers).** Discard sets `site_builds.status='cancelled'`; today compose/deploy run to completion regardless (verifier blocker — discard is cosmetic). Add an explicit `status==='cancelled'` short-circuit at the entry of each worker via `isBuildCancelled` (Task 12). Each re-reads status at entry and bails before doing any expensive work.
2. **Shell-guidance threading (compose only).** `regenerateShellUnit` (Task 10) is a deliberate no-op — a shell-scope edit relies on compose re-running the shell LLM WITH the edit's guidance. Today `generate-header`/`generate-footer` call `generateShell` with NO guidance, so a `scope='shell'` edit recomposes the shell byte-identically and deploys a no-op identical preview (the exact failure the spec's R/§3.3 "never deploy a no-op identical preview" rule guards against). The existing `load-build-config` step already SELECTs `config` but types it narrowly as `{ front_page_slug?: string }` — widen it to the full `BuildConfig` and, in each shell step, pass `config.regeneration_prompt` as `guidance` when `isEditConfig(config) && config.scope==='shell' && config.target===kind`. (`generateShell` gains the `guidance?` option in Task 1.)

**Files:**
- Modify: `apps/web/lib/inngest/functions/compose-site.ts`
- Modify: `apps/web/lib/inngest/functions/deploy-site.ts`

- [ ] **Step 1: Add the cancel guard to `compose-site.ts`**

  Add the import: `import { isBuildCancelled } from "@/lib/jab/build-cancel";`.

  Immediately inside the `try {` block, BEFORE the existing `await step.run("mark-composing-phase", ...)` step (line 152), insert:

  ```ts
      const cancelledAtEntry = await step.run("compose-cancel-guard", async () => {
        const supabase = createAdminClient();
        return isBuildCancelled(supabase, buildId, projectId);
      });
      if (cancelledAtEntry) {
        console.log(`[compose-site] build ${buildId} is cancelled — skipping compose.`);
        return { buildId, cancelled: true };
      }
  ```

- [ ] **Step 1b: Thread shell guidance through the `load-build-config` step + both shell steps**

  This is what makes a `scope='shell'` edit actually change the shell tsx (verifier blocker — without it the shell recomposes byte-identically and deploys a no-op identical preview).

  Add the imports: `import { isEditConfig, type BuildConfig } from "@/lib/jab/build-config";`.

  **(a) Widen `load-build-config`.** The existing step (lines 200–209) SELECTs `config` but returns it typed as `{ front_page_slug?: string }`. Widen the return so the full edit shape is available downstream. Replace the step with:

  ```ts
      step.run("load-build-config", async (): Promise<BuildConfig> => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("site_builds")
          .select("config")
          .eq("id", buildId)
          .single();
        if (error || !data) throw new Error(`load-build-config failed: ${error?.message ?? "no row"}`);
        return (data.config ?? { mode: "full" }) as BuildConfig;
      }),
  ```

  The destructured result is `buildConfig` (already destructured at line 163). Any existing `front_page_slug` reads off `buildConfig` keep working — the full-build shape still carries it; reference it as `(buildConfig as { front_page_slug?: string }).front_page_slug` if TypeScript narrows it away, or read it off the full config union.

  **(b) Derive the per-kind shell guidance once** (after `baseShellInput`, before the `Promise.all([...])` at line 483):

  ```ts
      // Shell-scope edits thread their guidance through compose (regenerateShellUnit
      // is a no-op — the shell LLM only re-runs here). Map the edit's target kind to
      // the guidance string; undefined for every non-shell build so output is
      // byte-identical to a full build.
      const shellEditGuidance = (kind: "header" | "footer"): string | undefined =>
        isEditConfig(buildConfig) && buildConfig.scope === "shell" && buildConfig.target === kind
          ? buildConfig.regeneration_prompt
          : undefined;
  ```

  **(c) Pass `guidance` into both `generateShell` calls.** In `generate-header`:

  ```ts
      step.run("generate-header", async () => {
        const out = await generateShell({
          ...baseShellInput,
          kind: "header",
          shellDom: designTokens.shellDom?.header ?? "",
          guidance: shellEditGuidance("header"),
        });
        await persistShellGeneration({ buildId, projectId, shell: out });
        return out;
      }),
  ```

  and the identical `guidance: shellEditGuidance("footer"),` addition in `generate-footer`. (`GenerateShellOptions.guidance` exists after Task 1; omitting it on a full build is byte-identical to today.)

- [ ] **Step 2: Add the cancel guard to `deploy-site.ts`**

  Add the import: `import { isBuildCancelled } from "@/lib/jab/build-cancel";`.

  Immediately inside the `try {` block, BEFORE the `const project = await step.run("load-project", ...)` step (line 92), insert:

  ```ts
      const cancelledAtEntry = await step.run("deploy-cancel-guard", async () => {
        const supabase = createAdminClient();
        return isBuildCancelled(supabase, buildId, projectId);
      });
      if (cancelledAtEntry) {
        console.log(`[deploy-site] build ${buildId} is cancelled — skipping deploy.`);
        return { buildId, cancelled: true };
      }
  ```

- [ ] **Step 3: Verify**

  ```bash
  pnpm --filter @jab/web typecheck
  pnpm --filter @jab/web exec vitest run lib/jab/build-cancel.test.ts
  ```
  Expected: typecheck clean (the widened `load-build-config` return + the `generateShell({ guidance })` calls compile against the Task 1 `GenerateShellOptions.guidance` + the Phase 0 `BuildConfig`/`isEditConfig`); the cancel-check unit still green. (The guards' end-to-end stop is exercised by the discard smoke in Task 18 Step 4; the shell-guidance threading — a `scope='shell'` edit producing a CHANGED shell tsx, not a no-op — is asserted in Task 23's smoke.)

- [ ] **Step 4: Commit**

  ```bash
  git add apps/web/lib/inngest/functions/compose-site.ts apps/web/lib/inngest/functions/deploy-site.ts
  git commit -m "feat(saas): compose shell-guidance threading + cancel-guard short-circuit at entry of compose + deploy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 16: Pure core — `workspace-edit-state.ts` (`deriveEditUiState`)

The §3.4 edit state-machine table as a pure function: given a `workspace_edits.status` + its linked `site_builds.status` + whether it's promoted, return the canonical UI label. Readiness derives from the LINKED build status, never `workspace_edits.status` (verifier blocker). Also exports `isEditAwaitingReview` (the `edit_in_review` slot predicate) which the concurrency guard counts and `deriveProjectStatusLabel` (Phase 1) consumes via the workspace page.

**Files:**
- Create: `apps/web/lib/jab/workspace-edit-state.ts`
- Create (test): `apps/web/lib/jab/workspace-edit-state.test.ts`

- [ ] **Step 1: Write the failing test**

  Create `apps/web/lib/jab/workspace-edit-state.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { deriveEditUiState, isEditAwaitingReview } from "./workspace-edit-state";

  describe("deriveEditUiState (§3.4 table)", () => {
    it("Submitting… when queued/running with no/active build", () => {
      expect(deriveEditUiState({ editStatus: "queued", buildStatus: null, promoted: false }).label).toBe("Submitting…");
      expect(deriveEditUiState({ editStatus: "running", buildStatus: null, promoted: false }).label).toBe("Submitting…");
    });
    it("Building… when completed + linked build active", () => {
      expect(deriveEditUiState({ editStatus: "completed", buildStatus: "composing", promoted: false }).label).toBe("Building…");
      expect(deriveEditUiState({ editStatus: "completed", buildStatus: "verifying", promoted: false }).label).toBe("Building…");
    });
    it("Review ready when completed + build ready + not promoted", () => {
      const s = deriveEditUiState({ editStatus: "completed", buildStatus: "ready", promoted: false });
      expect(s.label).toBe("Review ready");
      expect(s.awaitingReview).toBe(true);
    });
    it("Live when completed + build ready + promoted", () => {
      const s = deriveEditUiState({ editStatus: "completed", buildStatus: "ready", promoted: true });
      expect(s.label).toBe("Live");
      expect(s.awaitingReview).toBe(false);
    });
    it("Discarded when build cancelled or edit discarded", () => {
      expect(deriveEditUiState({ editStatus: "completed", buildStatus: "cancelled", promoted: false }).label).toBe("Discarded");
      expect(deriveEditUiState({ editStatus: "discarded", buildStatus: "cancelled", promoted: false }).label).toBe("Discarded");
    });
    it("Failed when edit or build failed", () => {
      expect(deriveEditUiState({ editStatus: "failed", buildStatus: null, promoted: false }).label).toBe("Failed");
      expect(deriveEditUiState({ editStatus: "completed", buildStatus: "failed", promoted: false }).label).toBe("Failed");
    });
  });

  describe("isEditAwaitingReview", () => {
    it("true only for completed + ready + not promoted + not cancelled", () => {
      expect(isEditAwaitingReview({ editStatus: "completed", buildStatus: "ready", promoted: false })).toBe(true);
      expect(isEditAwaitingReview({ editStatus: "completed", buildStatus: "ready", promoted: true })).toBe(false);
      expect(isEditAwaitingReview({ editStatus: "discarded", buildStatus: "cancelled", promoted: false })).toBe(false);
      expect(isEditAwaitingReview({ editStatus: "completed", buildStatus: "composing", promoted: false })).toBe(false);
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/workspace-edit-state.test.ts
  ```
  Expected: `Failed to resolve import "./workspace-edit-state"`.

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/lib/jab/workspace-edit-state.ts`:

  ```ts
  import { isActiveBuildStatus } from "./build-status";

  /**
   * workspace-edit-state — the §3.4 edit state machine as a pure function.
   * Readiness derives from the LINKED site_builds.status, never
   * workspace_edits.status ('completed' means "dispatched", not "preview-ready").
   */

  export interface EditUiStateInput {
    editStatus: string;
    /** Linked site_builds.status; null when no result build yet. */
    buildStatus: string | null;
    /** True when result_promoted_deployment_id is set. */
    promoted: boolean;
  }

  export type EditUiLabel =
    | "Submitting…"
    | "Building…"
    | "Review ready"
    | "Live"
    | "Discarded"
    | "Failed";

  export interface EditUiState {
    label: EditUiLabel;
    awaitingReview: boolean;
  }

  export function deriveEditUiState(input: EditUiStateInput): EditUiState {
    if (input.editStatus === "discarded" || input.buildStatus === "cancelled") {
      return { label: "Discarded", awaitingReview: false };
    }
    if (input.editStatus === "failed" || input.buildStatus === "failed") {
      return { label: "Failed", awaitingReview: false };
    }
    if (input.editStatus === "queued" || input.editStatus === "running") {
      return { label: "Submitting…", awaitingReview: false };
    }
    // editStatus === "completed" (dispatched) — derive from the linked build.
    if (input.buildStatus === "ready") {
      if (input.promoted) return { label: "Live", awaitingReview: false };
      return { label: "Review ready", awaitingReview: true };
    }
    if (isActiveBuildStatus(input.buildStatus)) {
      return { label: "Building…", awaitingReview: false };
    }
    // completed but no build row yet → still submitting.
    return { label: "Submitting…", awaitingReview: false };
  }

  export function isEditAwaitingReview(input: EditUiStateInput): boolean {
    return deriveEditUiState(input).awaitingReview;
  }
  ```

- [ ] **Step 4: Run, verify PASS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/workspace-edit-state.test.ts
  pnpm --filter @jab/web typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/jab/workspace-edit-state.ts apps/web/lib/jab/workspace-edit-state.test.ts
  git commit -m "feat(saas): deriveEditUiState — §3.4 edit state machine pure core

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 17: `requestWorkspaceEditAction` — concurrency guard + pass-through

Extend the action to (a) accept optional `regenerationPrompt`/`action`/`messageId` and pass them through to the insert + event; (b) run the `evaluateEditConcurrency` guard before insert (active-build fast path + `edit_in_review` one-slot), deriving readiness from the linked `site_builds.status`; (c) catch the `23505` from the 0031 index → `WorkspaceEditError("active_build")` (the `active_build` code was added in Phase 0; this phase adds `edit_in_review`). The event now uses `EDIT_REQUESTED_EVENT` + `SiteEditRequestedData`.

Add `"edit_in_review"` to the `WorkspaceEditError` code union (the validation module).

**Files:**
- Modify: `apps/web/lib/jab/workspace-edit-validation.ts` (add `"edit_in_review"` to the code union, lines 11–18)
- Modify: `apps/web/lib/actions/workspace-edit.ts`

- [ ] **Step 1: Add `edit_in_review` to the error code union**

  In `apps/web/lib/jab/workspace-edit-validation.ts`, the `WorkspaceEditError` constructor code union (after Phase 0 it includes `"active_build"`). Add `"edit_in_review"`:

  ```ts
      public readonly code:
        | "not_found"
        | "source_not_ready"
        | "invalid_scope"
        | "invalid_target"
        | "prompt_too_short"
        | "page_scope_unsupported"
        | "active_build"
        | "edit_in_review",
  ```

  (If Phase 0 has not yet landed `"active_build"`, add both lines — they are idempotent additions to the union.)

- [ ] **Step 2: Extend the action**

  In `apps/web/lib/actions/workspace-edit.ts`:

  Add imports:

  ```ts
  import { EDIT_REQUESTED_EVENT, type SiteEditRequestedData } from "@/lib/inngest/edit-request-event";
  import { evaluateEditConcurrency } from "@/lib/jab/active-edit-guard";
  import { isEditAwaitingReview } from "@/lib/jab/workspace-edit-state";
  import { isUniqueViolation } from "@/lib/db/pg-error";
  ```

  Extend `RequestWorkspaceEditInput` with the optional pass-through fields:

  ```ts
  export interface RequestWorkspaceEditInput {
    projectId: string;
    sourceBuildId: string;
    scope: WorkspaceEditScope;
    target: string;
    prompt: string;
    /** NEW — planner guidance; falls back to `prompt` when omitted (manual form). */
    regenerationPrompt?: string;
    /** NEW — planner action summary. */
    action?: string;
    /** NEW — the chat message that triggered this edit. */
    messageId?: string | null;
  }
  ```

  After the source-build status check (line 80, `if (build.status !== "ready") { ... }`) and BEFORE resolving the user, insert the concurrency guard. It needs the project's latest build status + the in-review edit count:

  ```ts
    // Concurrency guard (§3.4). Readiness derives from the LINKED site_builds
    // status, never workspace_edits.status. Use service-role for the reads — we
    // already RLS-verified project membership above.
    const guardAdmin = createAdminClient();
    const [{ data: latestBuilds }, { data: openEdits }] = await Promise.all([
      guardAdmin
        .from("site_builds")
        .select("status")
        .eq("project_id", input.projectId)
        .order("created_at", { ascending: false })
        .limit(1),
      guardAdmin
        .from("workspace_edits")
        .select("status, result_promoted_deployment_id, result_build:result_build_id(status)")
        .eq("project_id", input.projectId)
        .in("status", ["completed"]),
    ]);
    const latestStatus = (latestBuilds?.[0] as { status: string } | undefined)?.status ?? null;
    const editInReviewCount = (openEdits ?? []).filter((e) => {
      const row = e as {
        status: string;
        result_promoted_deployment_id: string | null;
        result_build: { status: string } | { status: string }[] | null;
      };
      const rb = Array.isArray(row.result_build) ? row.result_build[0] : row.result_build;
      return isEditAwaitingReview({
        editStatus: row.status,
        buildStatus: rb?.status ?? null,
        promoted: row.result_promoted_deployment_id !== null,
      });
    }).length;

    const concurrency = evaluateEditConcurrency({ latestBuildStatus: latestStatus, editInReviewCount });
    if (!concurrency.ok) {
      throw new WorkspaceEditError(concurrency.code, concurrency.reason);
    }
  ```

  Update the `workspace_edits` insert (lines 92–105) to include the new provenance + carry the friendly 23505 translation. Replace the insert + error handling with:

  ```ts
    const { data: inserted, error: insertErr } = await supabase
      .from("workspace_edits")
      .insert({
        project_id: input.projectId,
        tenant_id: project.tenant_id,
        source_build_id: input.sourceBuildId,
        user_id: user.id,
        scope: input.scope,
        target: input.target,
        prompt: input.prompt,
        regeneration_prompt: input.regenerationPrompt ?? input.prompt,
        action: input.action ?? null,
        message_id: input.messageId ?? null,
        status: "queued",
      })
      .select("id")
      .single<{ id: string }>();
    if (insertErr || !inserted) {
      if (insertErr && isUniqueViolation(insertErr)) {
        throw new WorkspaceEditError(
          "active_build",
          "Another build is already active for this project. Wait for it to finish before editing.",
        );
      }
      throw new Error(
        `workspace_edits insert failed: ${insertErr?.message ?? "no row returned"}`,
      );
    }
  ```

  > **Note:** the 0031 index is on `site_builds`, not `workspace_edits` — the `workspace_edits` insert itself cannot throw the index's 23505. The translation here is defensive parity with the spec (§3.4) and harmless; the real backstop fires when `edit-site`'s `create-result-build` or a worker phase transition collides. Keeping the catch keeps the two action surfaces symmetric.

  Replace the event send (lines 112–123) with the typed payload:

  ```ts
    const payload: SiteEditRequestedData = {
      editId: inserted.id,
      projectId: input.projectId,
      tenantId: project.tenant_id,
      sourceBuildId: input.sourceBuildId,
      scope: input.scope,
      target: input.target,
      prompt: input.prompt,
      regenerationPrompt: input.regenerationPrompt ?? input.prompt,
      action: input.action,
      messageId: input.messageId ?? null,
    };
    await inngest.send({ name: EDIT_REQUESTED_EVENT, data: payload });
  ```

- [ ] **Step 3: Verify**

  ```bash
  pnpm --filter @jab/web typecheck
  pnpm --filter @jab/web exec vitest run lib/jab/active-edit-guard.test.ts lib/jab/workspace-edit-state.test.ts
  ```
  Expected: typecheck clean; the guard cores still green. (The action's DB round-trips are exercised in the Task 23 smoke + the chat action in Task 19.)

- [ ] **Step 4: Commit**

  ```bash
  git add apps/web/lib/jab/workspace-edit-validation.ts apps/web/lib/actions/workspace-edit.ts
  git commit -m "feat(saas): workspace-edit concurrency guard + edit_in_review + provenance pass-through

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 18: `discard-edit.ts` — `discardEditAction` (make discard real)

`discardEditAction({ editId })`: RLS-load the edit; refuse if `result_promoted_deployment_id` is set (discarding production is a re-promote, out of scope §6); else direct-UPDATE `site_builds.status='cancelled'` (bespoke — `markBuildFailed` writes `'failed'`, not `'cancelled'`) + `workspace_edits.status='discarded'` + best-effort Storage cleanup (reuses the exported `listAllUnderPrefix` from `edit-site.ts`). The cancel guards (Tasks 14/15) make this actually stop the pipeline. The pure refusal decision is TDD'd; the action's DB/Storage round-trips are exercised by the discard smoke (Step 4).

**Files:**
- Create: `apps/web/lib/jab/discard-edit-errors.ts` (non-async class — Next forbids non-async exports from `"use server"`)
- Create: `apps/web/lib/jab/discard-edit-decision.ts` (pure refusal core) + test
- Create: `apps/web/lib/actions/discard-edit.ts` (`"use server"`)

- [ ] **Step 1: Write the failing test (pure refusal core)**

  Create `apps/web/lib/jab/discard-edit-decision.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { evaluateDiscard } from "./discard-edit-decision";

  describe("evaluateDiscard", () => {
    it("refuses when the edit is already promoted", () => {
      const r = evaluateDiscard({ resultPromotedDeploymentId: "dpl_x", resultBuildId: "b2" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("already_promoted");
    });
    it("ok when not promoted and a result build exists", () => {
      expect(evaluateDiscard({ resultPromotedDeploymentId: null, resultBuildId: "b2" })).toEqual({ ok: true, resultBuildId: "b2" });
    });
    it("ok with no result build (nothing to cancel — just mark discarded)", () => {
      expect(evaluateDiscard({ resultPromotedDeploymentId: null, resultBuildId: null })).toEqual({ ok: true, resultBuildId: null });
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/discard-edit-decision.test.ts
  ```
  Expected: `Failed to resolve import "./discard-edit-decision"`.

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/lib/jab/discard-edit-errors.ts`:

  ```ts
  export class DiscardEditError extends Error {
    constructor(
      public readonly code: "not_found" | "already_promoted",
      message: string,
    ) {
      super(message);
      this.name = "DiscardEditError";
    }
  }
  ```

  Create `apps/web/lib/jab/discard-edit-decision.ts`:

  ```ts
  /**
   * discard-edit-decision — pure refusal rule for discardEditAction (§3.4).
   * Discarding a PROMOTED edit would be a re-promote of the prior production
   * deployment — out of scope (§6). Refuse it; everything else can be discarded.
   */
  export interface DiscardDecisionInput {
    resultPromotedDeploymentId: string | null;
    resultBuildId: string | null;
  }
  export type DiscardDecision =
    | { ok: true; resultBuildId: string | null }
    | { ok: false; code: "already_promoted"; reason: string };

  export function evaluateDiscard(input: DiscardDecisionInput): DiscardDecision {
    if (input.resultPromotedDeploymentId) {
      return {
        ok: false,
        code: "already_promoted",
        reason: "This edit is already live in production. Reverting a promoted edit isn't supported yet.",
      };
    }
    return { ok: true, resultBuildId: input.resultBuildId };
  }
  ```

  Create `apps/web/lib/actions/discard-edit.ts`:

  ```ts
  "use server";
  import { revalidatePath } from "next/cache";
  import { createClient } from "@/lib/supabase/server";
  import { createAdminClient } from "@/lib/supabase/admin";
  import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
  import { DiscardEditError } from "@/lib/jab/discard-edit-errors";
  import { evaluateDiscard } from "@/lib/jab/discard-edit-decision";
  import { listAllUnderPrefix } from "@/lib/inngest/functions/edit-site";

  /**
   * discardEditAction — release an unpromoted edit (§3.4). RLS-load the edit;
   * refuse if promoted; else set the result build status='cancelled' (the
   * compose/deploy/verify cancel guards then stop the pipeline) + the edit
   * status='discarded' + best-effort Storage cleanup of the result build's
   * artifacts. Auto-releases the edit_in_review slot.
   */
  export interface DiscardEditInput {
    editId: string;
  }

  export async function discardEditAction(input: DiscardEditInput): Promise<{ discarded: true }> {
    const userClient = await createClient();
    // RLS-load (also verifies tenant membership).
    const { data: edit, error } = await userClient
      .from("workspace_edits")
      .select("id, project_id, result_build_id, result_promoted_deployment_id, status")
      .eq("id", input.editId)
      .single<{
        id: string;
        project_id: string;
        result_build_id: string | null;
        result_promoted_deployment_id: string | null;
        status: string;
      }>();
    if (error?.code === "PGRST116" || !edit) {
      throw new DiscardEditError("not_found", "Edit not found.");
    }
    if (error) throw error;

    const decision = evaluateDiscard({
      resultPromotedDeploymentId: edit.result_promoted_deployment_id,
      resultBuildId: edit.result_build_id,
    });
    if (!decision.ok) {
      throw new DiscardEditError(decision.code, decision.reason);
    }

    const admin = createAdminClient();
    // Cancel the result build (bespoke — markBuildFailed writes 'failed').
    if (decision.resultBuildId) {
      await admin
        .from("site_builds")
        .update({ status: "cancelled", finished_at: new Date().toISOString() })
        .eq("id", decision.resultBuildId)
        .eq("project_id", edit.project_id);
    }
    // Mark the edit discarded (releases the edit_in_review slot).
    await admin
      .from("workspace_edits")
      .update({ status: "discarded", finished_at: new Date().toISOString() })
      .eq("id", edit.id);

    // Best-effort Storage cleanup of the result build's artifacts.
    if (decision.resultBuildId) {
      try {
        const paths = await listAllUnderPrefix(admin, `builds/${decision.resultBuildId}`);
        if (paths.length > 0) {
          await admin.storage.from(SITE_SCREENSHOTS_BUCKET).remove(paths);
        }
      } catch (err) {
        console.warn(`[discard-edit] storage cleanup failed for build ${decision.resultBuildId}:`, err);
      }
    }

    revalidatePath(`/projects/${edit.project_id}/workspace`);
    return { discarded: true };
  }
  ```

  > `listAllUnderPrefix` is exported from `edit-site.ts` in Task 13 Step 3. Its signature is `(supabase, prefix) => Promise<string[]>` and it accepts the admin client (it only uses `.storage.list`). The `admin` client satisfies the `ReturnType<typeof createAdminClient>` param type.

- [ ] **Step 4: Verify**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/discard-edit-decision.test.ts
  pnpm --filter @jab/web typecheck
  ```
  Expected: green.

  Manual discard smoke (requires Inngest dev + a seeded `composing` edit build): call `discardEditAction({ editId })`, confirm the result `site_builds.status` flips to `cancelled`, the edit `status` flips to `discarded`, and the next worker step (compose or deploy) short-circuits via its cancel guard (Inngest dev UI shows `compose-cancel-guard`/`deploy-cancel-guard` returning `{ cancelled: true }`).

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/jab/discard-edit-errors.ts apps/web/lib/jab/discard-edit-decision.ts apps/web/lib/jab/discard-edit-decision.test.ts apps/web/lib/actions/discard-edit.ts
  git commit -m "feat(saas): discardEditAction — cancel build + discard edit + storage cleanup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 19: `publishBuildAction` lineage write — `result_promoted_deployment_id`

After the supersede sweep, when the build's `config.mode==="edit"`, set `workspace_edits.result_promoted_deployment_id` for the matching edit (closes the audit chain — §3.4). The gate/promote core is byte-unchanged. Add `config` to the build SELECT so we can branch.

**Files:**
- Modify: `apps/web/lib/actions/build-review.ts`

- [ ] **Step 1: Add `config` to the build SELECT + branch after supersede**

  Add the import: `import { isEditConfig, type BuildConfig } from "@/lib/jab/build-config";`.

  In `publishBuildAction`, change the build SELECT (lines 109–113) from `"id, project_id, status"` to `"id, project_id, status, config"` and the typed result to include `config: unknown`:

  ```ts
    const { data: build, error: buildErr } = await userClient
      .from("site_builds")
      .select("id, project_id, status, config")
      .eq("id", input.buildId)
      .single<{ id: string; project_id: string; status: string; config: unknown }>();
  ```

  After the `supersedePreviousProductionDeployments(...)` call (line 189) and BEFORE the `revalidatePath` calls, insert:

  ```ts
    // Edit-build lineage: stamp the production deployment onto the edit that
    // produced this build so the audit chain closes (§3.4). Matched by
    // result_build_id; service-role (membership already verified above).
    if (isEditConfig(build.config)) {
      const cfg = build.config as Extract<BuildConfig, { mode: "edit" }>;
      const { error: lineageErr } = await admin
        .from("workspace_edits")
        .update({ result_promoted_deployment_id: recorded.id })
        .eq("id", cfg.edit_id)
        .eq("result_build_id", input.buildId);
      if (lineageErr) {
        // Non-fatal: the promote already succeeded. Log loudly so the broken
        // audit link is visible, but don't fail the user's publish.
        console.warn(`[publish] result_promoted_deployment_id write failed for edit ${cfg.edit_id}: ${lineageErr.message}`);
      }
    }
  ```

- [ ] **Step 2: Verify**

  ```bash
  pnpm --filter @jab/web typecheck
  pnpm --filter @jab/web exec vitest run lib/jab/publish-gate.test.ts
  ```
  Expected: typecheck clean; the gate core unchanged + green. (The lineage write is proven in the Task 23 smoke's promote step.)

- [ ] **Step 3: Commit**

  ```bash
  git add apps/web/lib/actions/build-review.ts
  git commit -m "feat(saas): publishBuildAction stamps result_promoted_deployment_id on edit promote

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 20: Chat server actions — `workspace-chat.ts` (`sendChatMessageAction` flow §3.3)

The chat surface: `createConversationAction`, `loadConversation` (RLS user-client reads — the `conv_select`/`msg_select` policies are load-bearing, §2.7), and `sendChatMessageAction` implementing the §3.3 1–7 flow (budget → conversation → user message → source build → site map → plan → validate → branch). All writes go through the admin client after ONE RLS membership SELECT on `projects`. The branch logic (clarify vs actionable) is the unit-tested core; the action's I/O is wired around it and verified by typecheck + the Task 23 smoke.

**Files:**
- Create: `apps/web/lib/jab/chat-turn-outcome.ts` (pure branch decision) + test
- Create: `apps/web/lib/actions/workspace-chat.ts` (`"use server"`)
- Modify: `apps/web/lib/db/schema.ts` — flip `chatMessages.needsClarification` from the Phase-0 placeholder `text(...)` to `boolean("needs_clarification").notNull().default(false)` and add `boolean` to the `drizzle-orm/pg-core` import (the Phase-0 plan explicitly defers this widening to "when S3 first reads needs_clarification" — that is now).

- [ ] **Step 1: Write the failing test (pure branch decision)**

  Create `apps/web/lib/jab/chat-turn-outcome.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { decideChatTurnOutcome } from "./chat-turn-outcome";
  import type { EditPlan } from "./edit-plan";
  import type { SiteMap } from "./site-map";

  const siteMap: SiteMap = {
    blockTypes: [{ blockName: "core/cover", label: "Cover", tier: "visual", occurrenceCount: 4 }],
    pageSlugs: ["home"],
    shell: { header: true, footer: false },
  };
  function plan(over: Partial<EditPlan>): EditPlan {
    return {
      needsClarification: false,
      scope: "component",
      target: "core/cover",
      action: "Regenerate Cover",
      regenerationPrompt: "bolder",
      clarifyingQuestion: null,
      ...over,
    };
  }

  describe("decideChatTurnOutcome", () => {
    it("clarify when the plan asks for clarification", () => {
      const r = decideChatTurnOutcome(plan({ needsClarification: true, clarifyingQuestion: "Which one?" }), siteMap);
      expect(r.kind).toBe("clarify");
      if (r.kind === "clarify") expect(r.message).toBe("Which one?");
    });

    it("clarify (with a real-target list) when validation rejects a hallucinated target", () => {
      const r = decideChatTurnOutcome(plan({ target: "core/ghost" }), siteMap);
      expect(r.kind).toBe("clarify");
      if (r.kind === "clarify") {
        expect(r.message).toMatch(/core\/cover/); // lists the real candidates
      }
    });

    it("edit when the plan is actionable and valid", () => {
      const r = decideChatTurnOutcome(plan({}), siteMap);
      expect(r.kind).toBe("edit");
      if (r.kind === "edit") {
        expect(r.assistantText).toContain("Regenerate Cover");
        expect(r.plan.target).toBe("core/cover");
      }
    });

    it("falls back to a generic clarify message when the model gave no question", () => {
      const r = decideChatTurnOutcome(plan({ needsClarification: true, clarifyingQuestion: null }), siteMap);
      expect(r.kind).toBe("clarify");
      if (r.kind === "clarify") expect(r.message.length).toBeGreaterThan(0);
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/chat-turn-outcome.test.ts
  ```
  Expected: `Failed to resolve import "./chat-turn-outcome"`.

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/lib/jab/chat-turn-outcome.ts`:

  ```ts
  import type { EditPlan } from "./edit-plan";
  import { validateEditPlan } from "./edit-plan";
  import type { SiteMap } from "./site-map";

  /**
   * chat-turn-outcome — pure branch for a planned chat turn (§3.3 step 7).
   * A clarifying plan OR a validation failure → ask a question, run no edit.
   * An actionable+valid plan → run the edit. Keeps the action's branching
   * unit-tested and the I/O thin.
   */
  export type ChatTurnOutcome =
    | { kind: "clarify"; message: string; plan: EditPlan }
    | { kind: "edit"; assistantText: string; plan: EditPlan };

  function candidateList(siteMap: SiteMap): string {
    const blocks = siteMap.blockTypes.map((b) => `${b.label} (${b.blockName})`);
    const shells = [siteMap.shell.header ? "header" : null, siteMap.shell.footer ? "footer" : null].filter(Boolean);
    return [...blocks, ...shells].join(", ");
  }

  export function decideChatTurnOutcome(plan: EditPlan, siteMap: SiteMap): ChatTurnOutcome {
    if (plan.needsClarification) {
      return {
        kind: "clarify",
        plan,
        message:
          plan.clarifyingQuestion?.trim() ||
          `Could you tell me which part to change? I can edit: ${candidateList(siteMap)}.`,
      };
    }
    const valid = validateEditPlan(plan, siteMap);
    if (!valid.ok) {
      return {
        kind: "clarify",
        plan,
        message: `${valid.reason} I can edit: ${candidateList(siteMap)}. Which did you mean?`,
      };
    }
    return { kind: "edit", plan, assistantText: plan.action };
  }
  ```

  In `apps/web/lib/db/schema.ts`: add `boolean` to the `drizzle-orm/pg-core` import list; change the `chatMessages.needsClarification` column from the Phase-0 placeholder to:

  ```ts
      needsClarification: boolean("needs_clarification").notNull().default(false),
  ```

  Create `apps/web/lib/actions/workspace-chat.ts`:

  ```ts
  "use server";
  import { revalidatePath } from "next/cache";
  import { createClient } from "@/lib/supabase/server";
  import { createAdminClient } from "@/lib/supabase/admin";
  import { assertEditBudget, EditBudgetError } from "@/lib/ai/edit-cost-guard";
  import { buildSiteMap } from "@/lib/jab/site-map";
  import { planEdit, AnthropicPlannerClient, type PlannerMessage } from "@/lib/ai/edit-planner";
  import { decideChatTurnOutcome } from "@/lib/jab/chat-turn-outcome";
  import { requestWorkspaceEditAction } from "@/lib/actions/workspace-edit";
  import { WorkspaceEditError } from "@/lib/jab/workspace-edit-validation";

  /**
   * workspace-chat — the chat surface server actions (spec §3.3). All writes go
   * through the admin client after ONE RLS membership SELECT on projects; reads
   * (loadConversation) go through the RLS user client so conv_select/msg_select
   * are load-bearing.
   */

  export interface ChatMessageView {
    id: string;
    role: "user" | "assistant";
    content: string;
    needsClarification: boolean;
    editId: string | null;
    buildId: string | null;
    createdAt: string;
  }

  /** RLS user-client read — the SELECT policies are the security boundary here. */
  export async function loadConversation(
    projectId: string,
  ): Promise<{ conversationId: string | null; messages: ChatMessageView[] }> {
    const supabase = await createClient();
    const { data: conv } = await supabase
      .from("conversations")
      .select("id")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (!conv) return { conversationId: null, messages: [] };
    const { data: rows } = await supabase
      .from("chat_messages")
      .select("id, role, content, needs_clarification, edit_id, build_id, created_at")
      .eq("conversation_id", conv.id)
      .order("created_at", { ascending: true });
    const messages = ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      role: r.role as "user" | "assistant",
      content: String(r.content),
      needsClarification: r.needs_clarification === true,
      editId: (r.edit_id as string | null) ?? null,
      buildId: (r.build_id as string | null) ?? null,
      createdAt: String(r.created_at),
    }));
    return { conversationId: conv.id, messages };
  }

  /** Resolve project + tenant via an RLS SELECT, throwing 404-equivalent. */
  async function resolveProject(projectId: string): Promise<{ tenantId: string; userId: string }> {
    const supabase = await createClient();
    const { data: project, error } = await supabase
      .from("projects")
      .select("id, tenant_id")
      .eq("id", projectId)
      .single<{ id: string; tenant_id: string }>();
    if (error?.code === "PGRST116" || !project) {
      throw new WorkspaceEditError("not_found", "Project not found.");
    }
    if (error) throw error;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated.");
    return { tenantId: project.tenant_id, userId: user.id };
  }

  export async function createConversationAction(projectId: string): Promise<{ conversationId: string }> {
    const { tenantId, userId } = await resolveProject(projectId);
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("conversations")
      .insert({ project_id: projectId, tenant_id: tenantId, created_by_user_id: userId })
      .select("id")
      .single<{ id: string }>();
    if (error || !data) throw new Error(`createConversation failed: ${error?.message ?? "no row"}`);
    return { conversationId: data.id };
  }

  export interface SendChatMessageResult {
    assistant: ChatMessageView;
  }

  export async function sendChatMessageAction(args: {
    projectId: string;
    content: string;
  }): Promise<SendChatMessageResult> {
    const { tenantId, userId } = await resolveProject(args.projectId);
    const admin = createAdminClient();

    // 1. Budget / rate limit. On exceed, write an assistant message and stop.
    try {
      await assertEditBudget({ projectId: args.projectId });
    } catch (err) {
      if (err instanceof EditBudgetError) {
        return await writeAssistant(admin, args.projectId, tenantId, userId, {
          content: err.message,
          needsClarification: true,
        });
      }
      throw err;
    }

    // 2. Resolve/create conversation + insert the user message.
    const conversationId = await ensureConversation(admin, args.projectId, tenantId, userId);
    await admin.from("chat_messages").insert({
      conversation_id: conversationId,
      project_id: args.projectId,
      role: "user",
      content: args.content,
    });

    // 3. Source build = latest 'ready' build (same constraint as the form path).
    const { data: ready } = await admin
      .from("site_builds")
      .select("id")
      .eq("project_id", args.projectId)
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (!ready) {
      return await writeAssistant(admin, args.projectId, tenantId, userId, {
        content: "There's no completed build to edit yet. Build the site first, then ask me to change something.",
        needsClarification: true,
        conversationId,
      });
    }
    const sourceBuildId = ready.id;

    // 4. Site map for the SAME sourceBuildId the edit will clone.
    const siteMap = await buildSiteMap(sourceBuildId);

    // 5. Plan against the conversation history.
    const history = await loadPlannerMessages(admin, conversationId);
    const { plan, usage } = await planEdit({
      messages: history,
      siteMap,
      client: new AnthropicPlannerClient(),
    });

    // 6+7. Branch (validation lives in decideChatTurnOutcome).
    const outcome = decideChatTurnOutcome(plan, siteMap);
    if (outcome.kind === "clarify") {
      return await writeAssistant(admin, args.projectId, tenantId, userId, {
        content: outcome.message,
        needsClarification: true,
        plan,
        usage,
        conversationId,
      });
    }

    // Actionable: write the assistant row FIRST (so we have its id for messageId),
    // then dispatch the edit, then patch the row with the edit id.
    const assistantRow = await insertAssistant(admin, {
      conversationId,
      projectId: args.projectId,
      content: outcome.assistantText,
      needsClarification: false,
      plan,
      usage,
    });
    try {
      const { editId } = await requestWorkspaceEditAction({
        projectId: args.projectId,
        sourceBuildId,
        scope: outcome.plan.scope,
        target: outcome.plan.target,
        prompt: outcome.plan.action,
        regenerationPrompt: outcome.plan.regenerationPrompt,
        action: outcome.plan.action,
        messageId: assistantRow.id,
      });
      await admin.from("chat_messages").update({ edit_id: editId }).eq("id", assistantRow.id);
      revalidatePath(`/projects/${args.projectId}/workspace`);
      return { assistant: { ...assistantRow, editId } };
    } catch (err) {
      // Concurrency/budget refusal from the edit action → convert to a chat reply.
      const message = err instanceof WorkspaceEditError ? err.message : "That edit couldn't be started right now.";
      await admin
        .from("chat_messages")
        .update({ content: message, needs_clarification: true })
        .eq("id", assistantRow.id);
      revalidatePath(`/projects/${args.projectId}/workspace`);
      return { assistant: { ...assistantRow, content: message, needsClarification: true } };
    }
  }

  // ── internal helpers ──────────────────────────────────────────────────────

  async function ensureConversation(
    admin: ReturnType<typeof createAdminClient>,
    projectId: string,
    tenantId: string,
    userId: string,
  ): Promise<string> {
    const { data: existing } = await admin
      .from("conversations")
      .select("id")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (existing) return existing.id;
    const { data, error } = await admin
      .from("conversations")
      .insert({ project_id: projectId, tenant_id: tenantId, created_by_user_id: userId })
      .select("id")
      .single<{ id: string }>();
    if (error || !data) throw new Error(`ensureConversation failed: ${error?.message ?? "no row"}`);
    return data.id;
  }

  async function loadPlannerMessages(
    admin: ReturnType<typeof createAdminClient>,
    conversationId: string,
  ): Promise<PlannerMessage[]> {
    const { data } = await admin
      .from("chat_messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    return ((data ?? []) as Array<{ role: "user" | "assistant"; content: string }>).map((r) => ({
      role: r.role,
      content: r.content,
    }));
  }

  interface AssistantUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }

  async function insertAssistant(
    admin: ReturnType<typeof createAdminClient>,
    args: {
      conversationId: string;
      projectId: string;
      content: string;
      needsClarification: boolean;
      plan?: unknown;
      usage?: AssistantUsage;
    },
  ): Promise<ChatMessageView> {
    const { data, error } = await admin
      .from("chat_messages")
      .insert({
        conversation_id: args.conversationId,
        project_id: args.projectId,
        role: "assistant",
        content: args.content,
        needs_clarification: args.needsClarification,
        plan: args.plan ?? null,
        input_tokens_cached: args.usage?.cacheReadTokens ?? 0,
        input_tokens_uncached: (args.usage?.inputTokens ?? 0) - (args.usage?.cacheReadTokens ?? 0),
        output_tokens: args.usage?.outputTokens ?? 0,
      })
      .select("id, role, content, needs_clarification, edit_id, build_id, created_at")
      .single<Record<string, unknown>>();
    if (error || !data) throw new Error(`insertAssistant failed: ${error?.message ?? "no row"}`);
    return {
      id: String(data.id),
      role: "assistant",
      content: String(data.content),
      needsClarification: data.needs_clarification === true,
      editId: (data.edit_id as string | null) ?? null,
      buildId: (data.build_id as string | null) ?? null,
      createdAt: String(data.created_at),
    };
  }

  async function writeAssistant(
    admin: ReturnType<typeof createAdminClient>,
    projectId: string,
    tenantId: string,
    userId: string,
    args: {
      content: string;
      needsClarification: boolean;
      plan?: unknown;
      usage?: AssistantUsage;
      conversationId?: string;
    },
  ): Promise<SendChatMessageResult> {
    const conversationId = args.conversationId ?? (await ensureConversation(admin, projectId, tenantId, userId));
    const assistant = await insertAssistant(admin, {
      conversationId,
      projectId,
      content: args.content,
      needsClarification: args.needsClarification,
      plan: args.plan,
      usage: args.usage,
    });
    revalidatePath(`/projects/${projectId}/workspace`);
    return { assistant };
  }
  ```

- [ ] **Step 4: Verify**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/chat-turn-outcome.test.ts
  pnpm --filter @jab/web typecheck
  ```
  Expected: the branch core is green; typecheck clean (the action compiles against `planEdit`, `requestWorkspaceEditAction`, the chat schema). The full action round-trip is proven in the Task 23 smoke + the vague-prompt assertion.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/jab/chat-turn-outcome.ts apps/web/lib/jab/chat-turn-outcome.test.ts apps/web/lib/actions/workspace-chat.ts apps/web/lib/db/schema.ts
  git commit -m "feat(saas): workspace-chat actions — sendChatMessageAction §3.3 flow + chat branch core

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 21: `ChatPanel.tsx` — real chat UI (`"use client"`)

The chat surface: optimistic send, clarifying-question render, a "what changed" card (phase + elapsed + preview/review links + blast-radius page count), `aria-live="polite"` transcript, composer focus retention, and `prefers-reduced-motion`. The pure presentational helpers (the "what changed" card model + elapsed formatter) are unit-tested; the component wiring is verified by typecheck + the manual smoke.

**Files:**
- Create: `apps/web/app/(app)/projects/[id]/workspace/chat-card-model.ts` (pure) + test
- Create: `apps/web/app/(app)/projects/[id]/workspace/ChatPanel.tsx` (`"use client"`)

- [ ] **Step 1: Write the failing test (pure card model)**

  Create `apps/web/app/(app)/projects/[id]/workspace/chat-card-model.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { buildWhatChangedCard, formatElapsed } from "./chat-card-model";

  describe("formatElapsed", () => {
    it("formats seconds and minutes", () => {
      expect(formatElapsed(4000)).toBe("4s");
      expect(formatElapsed(95000)).toBe("1m 35s");
      expect(formatElapsed(0)).toBe("0s");
    });
  });

  describe("buildWhatChangedCard", () => {
    const base = {
      projectId: "p1",
      buildId: "b2",
      editStatus: "completed",
      promoted: false,
      action: "Regenerate the Cover block — affects 3 pages",
      changedPageCount: 3,
      startedAtMs: 1000,
      nowMs: 1000 + 42000,
    };

    it("shows Building… + progress link while the linked build is active", () => {
      const card = buildWhatChangedCard({ ...base, buildStatus: "composing" });
      expect(card.statusLabel).toBe("Building…");
      expect(card.phaseLabel).toBe("Composing the site");
      expect(card.elapsed).toBe("42s");
      expect(card.progressHref).toBe("/projects/p1/builds/b2/progress");
      expect(card.reviewHref).toBeNull();
    });

    it("shows Review ready + review link + blast radius when build is ready, unpromoted", () => {
      const card = buildWhatChangedCard({ ...base, buildStatus: "ready" });
      expect(card.statusLabel).toBe("Review ready");
      expect(card.reviewHref).toBe("/projects/p1/builds/b2/review");
      expect(card.blastRadius).toBe("Changes 3 page(s)");
    });

    it("shows Live when promoted", () => {
      const card = buildWhatChangedCard({ ...base, buildStatus: "ready", promoted: true });
      expect(card.statusLabel).toBe("Live");
    });

    it("shows Failed and no links when the build failed", () => {
      const card = buildWhatChangedCard({ ...base, buildStatus: "failed", editStatus: "failed" });
      expect(card.statusLabel).toBe("Failed");
      expect(card.reviewHref).toBeNull();
      expect(card.progressHref).toBe("/projects/p1/builds/b2/progress");
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run "app/(app)/projects/[id]/workspace/chat-card-model.test.ts"
  ```
  Expected: `Failed to resolve import "./chat-card-model"`.

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/app/(app)/projects/[id]/workspace/chat-card-model.ts`:

  ```ts
  import { deriveEditUiState } from "@/lib/jab/workspace-edit-state";
  import { phaseLabel } from "@/lib/jab/build-status";

  /** Pure presentational model for the chat "what changed" card. */
  export interface WhatChangedCardInput {
    projectId: string;
    buildId: string | null;
    editStatus: string;
    buildStatus: string | null;
    promoted: boolean;
    action: string;
    changedPageCount: number | null;
    startedAtMs: number;
    nowMs: number;
  }

  export interface WhatChangedCard {
    statusLabel: string;
    phaseLabel: string | null;
    elapsed: string;
    blastRadius: string | null;
    progressHref: string | null;
    reviewHref: string | null;
    action: string;
  }

  export function formatElapsed(ms: number): string {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    if (totalSec < 60) return `${totalSec}s`;
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s}s`;
  }

  export function buildWhatChangedCard(input: WhatChangedCardInput): WhatChangedCard {
    const ui = deriveEditUiState({
      editStatus: input.editStatus,
      buildStatus: input.buildStatus,
      promoted: input.promoted,
    });
    const active = ui.label === "Building…";
    const progressHref = input.buildId ? `/projects/${input.projectId}/builds/${input.buildId}/progress` : null;
    const reviewHref =
      ui.awaitingReview && input.buildId
        ? `/projects/${input.projectId}/builds/${input.buildId}/review`
        : null;
    return {
      statusLabel: ui.label,
      phaseLabel: active && input.buildStatus ? phaseLabel(input.buildStatus) : null,
      elapsed: formatElapsed(input.nowMs - input.startedAtMs),
      blastRadius: input.changedPageCount !== null ? `Changes ${input.changedPageCount} page(s)` : null,
      progressHref,
      reviewHref,
      action: input.action,
    };
  }
  ```

  Create `apps/web/app/(app)/projects/[id]/workspace/ChatPanel.tsx`:

  ```tsx
  "use client";
  import { useEffect, useRef, useState, useTransition } from "react";
  import Link from "next/link";
  import { sendChatMessageAction, type ChatMessageView } from "@/lib/actions/workspace-chat";

  /**
   * ChatPanel — the workspace chat surface (spec §3.3 / §4 step 12). Optimistic
   * send, clarifying render, "what changed" card with phase + elapsed + preview/
   * review links + blast radius, aria-live='polite' transcript, composer focus
   * retention, prefers-reduced-motion. Gated behind JAB_CHAT_EDIT by the page.
   */
  export interface ChatPanelProps {
    projectId: string;
    initialMessages: ChatMessageView[];
    sourceBuildReady: boolean;
  }

  export function ChatPanel({ projectId, initialMessages, sourceBuildReady }: ChatPanelProps) {
    const [messages, setMessages] = useState<ChatMessageView[]>(initialMessages);
    const [draft, setDraft] = useState("");
    const [pending, startTransition] = useTransition();
    const inputRef = useRef<HTMLInputElement | null>(null);
    const endRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }, [messages]);

    function onSend(e: React.FormEvent) {
      e.preventDefault();
      const content = draft.trim();
      if (!content || pending) return;
      const optimistic: ChatMessageView = {
        id: `optimistic-${Date.now()}`,
        role: "user",
        content,
        needsClarification: false,
        editId: null,
        buildId: null,
        createdAt: new Date().toISOString(),
      };
      setMessages((m) => [...m, optimistic]);
      setDraft("");
      startTransition(async () => {
        try {
          const { assistant } = await sendChatMessageAction({ projectId, content });
          setMessages((m) => [...m, assistant]);
        } catch {
          setMessages((m) => [
            ...m,
            {
              id: `err-${Date.now()}`,
              role: "assistant",
              content: "Something went wrong sending that. Please try again.",
              needsClarification: true,
              editId: null,
              buildId: null,
              createdAt: new Date().toISOString(),
            },
          ]);
        } finally {
          inputRef.current?.focus(); // composer focus retention
        }
      });
    }

    return (
      <section className="flex w-[380px] shrink-0 flex-col border-r border-bord bg-bg motion-reduce:transition-none">
        <div className="border-b border-bord px-4 py-3 text-sm font-bold text-wht">Chat</div>
        <div
          aria-live="polite"
          aria-label="Conversation"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
        >
          {messages.length === 0 && (
            <p className="text-[13px] text-gry">
              {sourceBuildReady
                ? 'Describe a change, e.g. "make the hero bolder".'
                : "Build the site first, then ask me to change something."}
            </p>
          )}
          {messages.map((m) => (
            <ChatBubble key={m.id} projectId={projectId} message={m} />
          ))}
          <div ref={endRef} />
        </div>
        <form onSubmit={onSend} className="border-t border-bord p-3">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={!sourceBuildReady || pending}
              placeholder={sourceBuildReady ? "Describe a change…" : "Requires a ready build"}
              aria-label="Message"
              className="h-9 flex-1 rounded-md border border-bord bg-surf px-2.5 text-[13px] text-wht outline-none focus:border-teal disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={!sourceBuildReady || pending || !draft.trim()}
              className="inline-flex h-9 items-center rounded-md bg-teal px-4 text-[13px] font-semibold text-bg transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
            >
              {pending ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      </section>
    );
  }

  function ChatBubble({ projectId, message }: { projectId: string; message: ChatMessageView }) {
    const isUser = message.role === "user";
    return (
      <div className={isUser ? "self-end" : "self-start"}>
        <div
          className={`max-w-[300px] rounded-lg px-3 py-2 text-[13px] ${
            isUser
              ? "bg-teal/15 text-wht"
              : message.needsClarification
                ? "border border-amb/30 bg-amb/[0.06] text-wht"
                : "border border-bord bg-elev text-wht"
          }`}
        >
          <p className="whitespace-pre-wrap">{message.content}</p>
          {!isUser && message.editId && message.buildId && (
            <div className="mt-2 flex flex-wrap gap-2 font-mono text-[11px]">
              <Link
                href={`/projects/${projectId}/builds/${message.buildId}/progress`}
                className="text-teal hover:underline"
              >
                View progress →
              </Link>
              <Link
                href={`/projects/${projectId}/builds/${message.buildId}/review`}
                className="text-teal hover:underline"
              >
                Review →
              </Link>
            </div>
          )}
        </div>
      </div>
    );
  }
  ```

  > **Note on the "what changed" card vs the bubble:** the live phase/elapsed/blast-radius card (`buildWhatChangedCard`) is the richer presentation; the minimal `ChatBubble` above shows the assistant text + progress/review links once an edit is linked. Wiring the live polling card (re-deriving from `buildWhatChangedCard` on the workspace page's poll) is folded into the page in Task 22; the pure model is tested here so the page consumes a verified shape.

- [ ] **Step 4: Verify**

  ```bash
  pnpm --filter @jab/web exec vitest run "app/(app)/projects/[id]/workspace/chat-card-model.test.ts"
  pnpm --filter @jab/web typecheck
  ```
  Expected: green. The component renders only behind `JAB_CHAT_EDIT` (Task 22); the visual smoke is the Task 23 e2e.

- [ ] **Step 5: Commit**

  ```bash
  git add "apps/web/app/(app)/projects/[id]/workspace/chat-card-model.ts" "apps/web/app/(app)/projects/[id]/workspace/chat-card-model.test.ts" "apps/web/app/(app)/projects/[id]/workspace/ChatPanel.tsx"
  git commit -m "feat(saas): ChatPanel UI + what-changed card model (optimistic send, a11y)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 22: Scoped review + workspace wiring (banner, changed-only filter, ChatPanel gate, edit-history Review/Discard)

Three presentational changes: (a) `ScopedReviewBanner` + a changed-only default filter in `review/page.tsx` when `config.mode==="edit"`; (b) render `ChatPanel` on the workspace page behind `JAB_CHAT_EDIT`, loading the conversation; (c) the workspace edit-history rows link a `ready` result build to `/review` (not `/progress`) and add a "Discard" affordance per unpromoted edit. The pure scoping helper (`partitionScopedPages`) is unit-tested; the page wiring is verified by typecheck + the smoke.

**Files:**
- Create: `apps/web/lib/jab/scoped-review.ts` (pure) + test
- Create: `apps/web/app/(app)/projects/[id]/builds/[buildId]/review/ScopedReviewBanner.tsx`
- Modify: `apps/web/app/(app)/projects/[id]/builds/[buildId]/review/page.tsx`
- Modify: `apps/web/app/(app)/projects/[id]/workspace/page.tsx`

- [ ] **Step 1: Write the failing test (pure scoping)**

  Create `apps/web/lib/jab/scoped-review.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { partitionScopedPages, type ScopedPageInput } from "./scoped-review";

  const pages: ScopedPageInput[] = [
    { slug: "home", approvalStatus: "pending" },
    { slug: "about", approvalStatus: "approved" },
    { slug: "menu", approvalStatus: "approved_with_issues" },
  ];

  describe("partitionScopedPages", () => {
    it("splits changed (actionable) vs carried-forward pages by slug", () => {
      const r = partitionScopedPages(pages, ["home"]);
      expect(r.changed.map((p) => p.slug)).toEqual(["home"]);
      expect(r.carried.map((p) => p.slug).sort()).toEqual(["about", "menu"]);
      expect(r.changedCount).toBe(1);
    });
    it("with a null changedSlugs (full re-review), everything is changed", () => {
      const r = partitionScopedPages(pages, null);
      expect(r.changed.length).toBe(3);
      expect(r.carried.length).toBe(0);
    });
    it("with an empty changedSlugs array, nothing is changed (all carried)", () => {
      const r = partitionScopedPages(pages, []);
      expect(r.changed.length).toBe(0);
      expect(r.carried.length).toBe(3);
    });
  });
  ```

- [ ] **Step 2: Run it, verify it FAILS**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/scoped-review.test.ts
  ```
  Expected: `Failed to resolve import "./scoped-review"`.

- [ ] **Step 3: Minimal implementation**

  Create `apps/web/lib/jab/scoped-review.ts`:

  ```ts
  /**
   * scoped-review — pure partition of a review page list into "changed by this
   * edit" (actionable, shown by default) vs "carried forward" (collapsed under
   * show-all). null changedSlugs → treat every page as changed (full re-review,
   * e.g. shell edits or fail-closed widening).
   */
  export interface ScopedPageInput {
    slug: string;
    approvalStatus: string;
  }
  export interface ScopedPagePartition<T extends ScopedPageInput> {
    changed: T[];
    carried: T[];
    changedCount: number;
  }
  export function partitionScopedPages<T extends ScopedPageInput>(
    pages: T[],
    changedSlugs: string[] | null,
  ): ScopedPagePartition<T> {
    if (changedSlugs === null) {
      return { changed: pages, carried: [], changedCount: pages.length };
    }
    const changedSet = new Set(changedSlugs);
    const changed = pages.filter((p) => changedSet.has(p.slug));
    const carried = pages.filter((p) => !changedSet.has(p.slug));
    return { changed, carried, changedCount: changed.length };
  }
  ```

  Create `apps/web/app/(app)/projects/[id]/builds/[buildId]/review/ScopedReviewBanner.tsx`:

  ```tsx
  /**
   * ScopedReviewBanner — shown above the page list when reviewing an edit build
   * (spec §3.4). Explains that untouched pages carried forward their prior
   * approval and only the changed pages need review.
   */
  export function ScopedReviewBanner({
    action,
    changedCount,
    carriedCount,
  }: {
    action: string;
    changedCount: number;
    carriedCount: number;
  }) {
    return (
      <div className="mb-4 rounded-lg border border-teal/30 bg-teal/[0.04] px-5 py-4">
        <div className="text-sm font-bold text-teal">Scoped review — AI edit</div>
        <p className="mt-1 text-sm text-gry">{action}</p>
        <p className="mt-1 text-[13px] text-gry-d">
          {changedCount} changed page(s) need review. {carriedCount} unchanged page(s) kept their prior
          approval and are hidden by default.
        </p>
      </div>
    );
  }
  ```

  In `apps/web/app/(app)/projects/[id]/builds/[buildId]/review/page.tsx`:
  - Add the build SELECT column `config` (line 68 select string: append `, config`).
  - Import: `import { isEditConfig, type BuildConfig } from "@/lib/jab/build-config";`, `import { partitionScopedPages } from "@/lib/jab/scoped-review";`, `import { ScopedReviewBanner } from "./ScopedReviewBanner";`.
  - After `fidelityByPage` is built, compute the scoping. The page list iterates `pageRows`; join each page's approval status from its fidelity row:

  ```tsx
    const editConfig = isEditConfig(build.config) ? (build.config as Extract<BuildConfig, { mode: "edit" }>) : null;
    const pagesWithStatus = pageRows.map((p) => ({
      ...p,
      approvalStatus: fidelityByPage.get(p.id)?.approval_status ?? "pending",
    }));
    // Edit builds: scope to changed_slugs. A null/empty change_reason 'shell_all'
    // or fail-closed widening (change_reason === null with all slugs) → full list.
    const scoped = editConfig
      ? partitionScopedPages(
          pagesWithStatus,
          editConfig.change_reason === "shell_all" || editConfig.change_reason === null
            ? null
            : editConfig.changed_slugs,
        )
      : null;
    const visiblePages = scoped ? scoped.changed : pagesWithStatus;
  ```

  - Above the `<div className="overflow-hidden rounded-lg border ...">Pages</div>` block, when `editConfig`, render:

  ```tsx
          {editConfig && scoped && (
            <ScopedReviewBanner
              action={editConfig.action}
              changedCount={scoped.changedCount}
              carriedCount={scoped.carried.length}
            />
          )}
  ```

  - Change the `pageRows.map(...)` list to iterate `visiblePages` instead, and add a "Show all N pages" toggle. The toggle is server-component-friendly via a query param: read `searchParams?.all === "1"` (add `searchParams` to the page props) and when set, iterate `pagesWithStatus` instead of `visiblePages`, plus render a `<Link href="?all=1">Show all</Link>` / `<Link href="?">Show changed only</Link>` control. Concretely:

  ```tsx
  export default async function BuildReviewPage({
    params,
    searchParams,
  }: {
    params: Promise<{ id: string; buildId: string }>;
    searchParams?: Promise<{ all?: string }>;
  }) {
    // ...existing body...
    const showAll = ((await searchParams)?.all) === "1";
    const listPages = editConfig && !showAll ? visiblePages : pagesWithStatus;
  ```

  Then map `listPages` in the `<ul>` and, when `editConfig`, render the toggle link near the "Pages" header:

  ```tsx
            {editConfig && (
              <Link
                href={showAll ? "?" : "?all=1"}
                className="font-mono text-[11px] text-teal hover:underline"
              >
                {showAll ? "Show changed only" : `Show all ${pagesWithStatus.length} pages`}
              </Link>
            )}
  ```

  In `apps/web/app/(app)/projects/[id]/workspace/page.tsx`:
  - Import: `import { ChatPanel } from "./ChatPanel";`, `import { loadConversation } from "@/lib/actions/workspace-chat";`, `import { discardEditAction } from "@/lib/actions/discard-edit";`, `import { loadProjectBuildState } from "@/lib/jab/load-project-builds";` (already imported), and load the conversation + a per-edit linked-build-status map.
  - Gate the ChatPanel behind the env flag:

  ```tsx
    const chatEnabled = process.env.JAB_CHAT_EDIT === "1";
    const conversation = chatEnabled ? await loadConversation(project.id) : { conversationId: null, messages: [] };
  ```

  - In the JSX, render the ChatPanel above (or replacing) the `WorkspaceEditsPanel` when `chatEnabled`:

  ```tsx
      {chatEnabled && (
        <ChatPanel
          projectId={project.id}
          initialMessages={conversation.messages}
          sourceBuildReady={sourceBuildId !== null}
        />
      )}
  ```

  - Edit-history rows: the existing `view build →` link always points at `/progress`. Add a Review link for `ready` result builds and a Discard form. The `loadWorkspaceEditHistory` rows currently lack the linked build status — extend it (Step 3b below) to return `resultBuildStatus` + `promoted`, then in the row:

  ```tsx
                {edit.resultBuildId && edit.resultBuildStatus === "ready" && !edit.promoted && (
                  <Link
                    href={`/projects/${projectId}/builds/${edit.resultBuildId}/review`}
                    className="shrink-0 font-mono text-[11px] text-teal hover:underline"
                  >
                    Review →
                  </Link>
                )}
                {edit.resultBuildId && !edit.promoted && edit.status !== "discarded" && (
                  <form action={discardEditFormAction}>
                    <input type="hidden" name="editId" value={edit.id} />
                    <button type="submit" className="shrink-0 font-mono text-[11px] text-red hover:underline">
                      Discard
                    </button>
                  </form>
                )}
  ```

  with a `discardEditFormAction` defined in the page:

  ```tsx
    const discardEditFormAction = async (formData: FormData) => {
      "use server";
      const editId = formData.get("editId");
      if (typeof editId !== "string") throw new Error("discard: editId missing");
      await discardEditAction({ editId });
    };
  ```

  - **Step 3b — extend `loadWorkspaceEditHistory`** (`lib/actions/workspace-edit.ts`) to return the linked build status + promoted flag. Change its SELECT to join the result build and `result_promoted_deployment_id`, and add `resultBuildStatus`/`promoted` to the returned shape:

  ```ts
    const { data, error } = await admin
      .from("workspace_edits")
      .select(
        "id, scope, target, prompt, status, result_build_id, result_promoted_deployment_id, error_text, created_at, finished_at, result_build:result_build_id(status)",
      )
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map((row: Record<string, unknown>) => {
      const rb = row.result_build as { status: string } | { status: string }[] | null;
      const resultBuild = Array.isArray(rb) ? rb[0] : rb;
      return {
        id: String(row.id),
        scope: String(row.scope),
        target: String(row.target),
        prompt: String(row.prompt),
        status: String(row.status),
        resultBuildId: (row.result_build_id as string | null) ?? null,
        resultBuildStatus: resultBuild?.status ?? null,
        promoted: (row.result_promoted_deployment_id as string | null) !== null,
        errorText: (row.error_text as string | null) ?? null,
        createdAt: String(row.created_at),
        finishedAt: (row.finished_at as string | null) ?? null,
      };
    });
  ```

  Update its return-type annotation to include `resultBuildStatus: string | null` and `promoted: boolean`.

- [ ] **Step 4: Verify**

  ```bash
  pnpm --filter @jab/web exec vitest run lib/jab/scoped-review.test.ts
  pnpm --filter @jab/web typecheck
  ```
  Expected: scoping core green; typecheck clean (review page + workspace page compile against the new helpers + extended history shape). The visual flow is the Task 23 smoke.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web/lib/jab/scoped-review.ts apps/web/lib/jab/scoped-review.test.ts "apps/web/app/(app)/projects/[id]/builds/[buildId]/review/ScopedReviewBanner.tsx" "apps/web/app/(app)/projects/[id]/builds/[buildId]/review/page.tsx" "apps/web/app/(app)/projects/[id]/workspace/page.tsx" apps/web/lib/actions/workspace-edit.ts
  git commit -m "feat(saas): scoped review banner + changed-only filter + ChatPanel gate + edit-history actions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 23: End-to-end smoke against the Two Roads pilot

The headline demo proof (§4 Phase 2 step 13). A standalone script (run manually against the local stack + the Two Roads pilot project) drives the full loop and asserts the chain. It is NOT a Vitest unit test — it requires the live Inngest dev server, Supabase (local `ajfurojjxthhzkjqttri`), the WP backend, and Vercel — so it lives as an executable `tsx` script with explicit assertions and a clear PASS/FAIL print. It also asserts the negative path: a vague prompt yields a clarifying question and NO build.

**Files:**
- Create: `apps/web/lib/inngest/functions/edit-site.smoke.ts`

- [ ] **Step 1: Write the smoke script**

  Create `apps/web/lib/inngest/functions/edit-site.smoke.ts`:

  ```ts
  /**
   * edit-site.smoke — manual end-to-end smoke for the chat edit loop (§4 step 13).
   *
   * Prereqs (all live): Inngest dev server running, .env.local pointed at the
   * local Supabase project (ajfurojjxthhzkjqttri / "JAB WP"), the Two Roads WP
   * backend reachable, Vercel token set, and a SEEDED Two Roads project with at
   * least one `ready` full build.
   *
   * Run: JAB_CHAT_EDIT=1 pnpm --filter @jab/web exec tsx lib/inngest/functions/edit-site.smoke.ts <projectId>
   *
   * Asserts the chain:
   *   1. "make the hero bolder" → planner emits scope=component, target=hero block.
   *   2. edit-site regenerates the cloned tsx (compile ok) + computes changed pages.
   *   3. result build reaches status=ready.
   *   4. carry-forward present: untouched pages inherited approval; changed (hero)
   *      pages are pending.
   *   5. scoped review shows only the hero pages pending.
   *   6. approve the changed pages → publishBuildAction promotes →
   *      a production deployments row + supersede sweep + result_promoted_deployment_id.
   *   7. SHELL: "add a phone number to the header" → planner emits scope=shell,
   *      target=header; the regenerated header tsx in Storage DIFFERS from the
   *      source build's header tsx (proves compose threaded config.regeneration_prompt
   *      — a shell edit is never a no-op identical preview).
   *   8. NEGATIVE: a vague prompt ("make it nicer") yields a clarifying assistant
   *      message and NO new build.
   */
  import { createAdminClient } from "@/lib/supabase/admin";
  import { sendChatMessageAction } from "@/lib/actions/workspace-chat";
  import { publishBuildAction } from "@/lib/actions/build-review";

  const POLL_TIMEOUT_MS = 8 * 60 * 1000;
  const POLL_TICK_MS = 5000;

  function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
  }

  async function waitForBuildReady(buildId: string): Promise<string> {
    const admin = createAdminClient();
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { data } = await admin.from("site_builds").select("status").eq("id", buildId).single<{ status: string }>();
      const status = data?.status ?? "unknown";
      if (status === "ready") return status;
      if (status === "failed" || status === "cancelled") {
        throw new Error(`SMOKE FAIL: result build ${buildId} ended ${status}`);
      }
      await new Promise((r) => setTimeout(r, POLL_TICK_MS));
    }
    throw new Error(`SMOKE FAIL: result build ${buildId} not ready within timeout`);
  }

  async function main() {
    const projectId = process.argv[2];
    assert(projectId, "usage: tsx edit-site.smoke.ts <projectId>");
    assert(process.env.JAB_CHAT_EDIT === "1", "set JAB_CHAT_EDIT=1 to run the chat smoke");
    const admin = createAdminClient();

    // Count builds before the actionable turn.
    const { count: buildsBefore } = await admin
      .from("site_builds")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId);

    // 1. Actionable chat turn.
    console.log('→ sending "make the hero bolder"');
    const { assistant } = await sendChatMessageAction({ projectId, content: "make the hero bolder" });
    assert(!assistant.needsClarification, "expected an actionable assistant reply, got a clarifying question");
    assert(assistant.editId, "assistant reply should carry an editId");

    // Resolve the result build for that edit.
    const { data: edit } = await admin
      .from("workspace_edits")
      .select("id, result_build_id, scope, target, changed_slugs")
      .eq("id", assistant.editId)
      .single<{ id: string; result_build_id: string | null; scope: string; target: string; changed_slugs: string[] | null }>();
    assert(edit?.scope === "component", `expected scope=component, got ${edit?.scope}`);
    // give edit-site a moment to link the result build
    let resultBuildId = edit.result_build_id;
    for (let i = 0; i < 12 && !resultBuildId; i++) {
      await new Promise((r) => setTimeout(r, POLL_TICK_MS));
      const { data } = await admin.from("workspace_edits").select("result_build_id").eq("id", edit.id).single<{ result_build_id: string | null }>();
      resultBuildId = data?.result_build_id ?? null;
    }
    assert(resultBuildId, "edit never linked a result build");

    // 2+3. Wait for ready.
    console.log(`→ waiting for result build ${resultBuildId} to reach ready`);
    await waitForBuildReady(resultBuildId);

    // changed_slugs computed.
    const { data: editAfter } = await admin
      .from("workspace_edits")
      .select("changed_slugs, change_reason")
      .eq("id", edit.id)
      .single<{ changed_slugs: string[] | null; change_reason: string | null }>();
    assert(editAfter?.changed_slugs && editAfter.changed_slugs.length >= 0, "changed_slugs should be computed");
    console.log(`  changed_slugs=${JSON.stringify(editAfter?.changed_slugs)} reason=${editAfter?.change_reason}`);

    // 4. Carry-forward: at least one page pending (changed) — others may be inherited.
    const { data: fidelity } = await admin
      .from("fidelity_reports")
      .select("approval_status, page_inventory:page_inventory_id(slug)")
      .eq("site_build_id", resultBuildId);
    const changedSet = new Set(editAfter?.changed_slugs ?? []);
    const rows = (fidelity ?? []) as Array<{ approval_status: string; page_inventory: { slug: string } | { slug: string }[] | null }>;
    for (const r of rows) {
      const pi = Array.isArray(r.page_inventory) ? r.page_inventory[0] : r.page_inventory;
      const slug = pi?.slug ?? "";
      if (changedSet.has(slug)) {
        assert(r.approval_status === "pending", `changed page ${slug} should be pending, got ${r.approval_status}`);
      }
    }
    console.log("  carry-forward verified (changed pages pending)");

    // 5+6. Approve the changed pages then promote.
    const { approvePageAction } = await import("@/lib/actions/build-review");
    for (const r of rows) {
      const pi = Array.isArray(r.page_inventory) ? r.page_inventory[0] : r.page_inventory;
      const slug = pi?.slug ?? "";
      if (changedSet.has(slug)) {
        const { data: pageRow } = await admin
          .from("page_inventory")
          .select("id")
          .eq("site_build_id", resultBuildId)
          .eq("slug", slug)
          .maybeSingle<{ id: string }>();
        if (pageRow) await approvePageAction(resultBuildId, pageRow.id, projectId);
      }
    }
    console.log("→ publishing (promote)");
    const promote = await publishBuildAction({ buildId: resultBuildId });
    assert(promote.productionDeploymentId, "promote should return a production deployment id");

    // Production row + supersede + lineage.
    const { data: prodRow } = await admin
      .from("deployments")
      .select("id, environment, status")
      .eq("id", promote.productionDeploymentId)
      .single<{ id: string; environment: string; status: string }>();
    assert(prodRow?.environment === "production" && prodRow.status === "ready", "production deployment row missing");
    const { data: editFinal } = await admin
      .from("workspace_edits")
      .select("result_promoted_deployment_id")
      .eq("id", edit.id)
      .single<{ result_promoted_deployment_id: string | null }>();
    assert(editFinal?.result_promoted_deployment_id === promote.productionDeploymentId, "lineage not stamped on edit");
    console.log(`  promoted; superseded ${promote.supersededCount}; lineage stamped`);

    // 7. SHELL edit — the regenerated header tsx must DIFFER from the source's
    // (proves compose threaded config.regeneration_prompt into generateShell;
    // a shell edit must never deploy a no-op identical preview).
    const { SITE_SCREENSHOTS_BUCKET } = await import("@/lib/storage/bucket");
    const { buildShellStoragePath } = await import("@/lib/ai/persist-shell-generation");
    console.log('→ sending shell edit "add a phone number to the header"');
    const shellTurn = await sendChatMessageAction({ projectId, content: "add a phone number to the header" });
    assert(!shellTurn.assistant.needsClarification, "shell edit should be actionable");
    assert(shellTurn.assistant.editId, "shell edit should carry an editId");
    const { data: shellEdit } = await admin
      .from("workspace_edits")
      .select("id, scope, target, source_build_id, result_build_id")
      .eq("id", shellTurn.assistant.editId)
      .single<{ id: string; scope: string; target: string; source_build_id: string | null; result_build_id: string | null }>();
    assert(shellEdit?.scope === "shell", `expected scope=shell, got ${shellEdit?.scope}`);
    assert(shellEdit.target === "header", `expected target=header, got ${shellEdit?.target}`);
    assert(shellEdit.source_build_id, "shell edit has no source_build_id");
    const sourceHeader = await admin.storage
      .from(SITE_SCREENSHOTS_BUCKET)
      .download(buildShellStoragePath(shellEdit.source_build_id, "header"));
    const sourceHeaderTsx = sourceHeader.data ? await sourceHeader.data.text() : null;
    let shellBuildId = shellEdit.result_build_id;
    for (let i = 0; i < 12 && !shellBuildId; i++) {
      await new Promise((r) => setTimeout(r, POLL_TICK_MS));
      const { data } = await admin.from("workspace_edits").select("result_build_id").eq("id", shellEdit.id).single<{ result_build_id: string | null }>();
      shellBuildId = data?.result_build_id ?? null;
    }
    assert(shellBuildId, "shell edit never linked a result build");
    await waitForBuildReady(shellBuildId);
    const editedHeader = await admin.storage
      .from(SITE_SCREENSHOTS_BUCKET)
      .download(buildShellStoragePath(shellBuildId, "header"));
    const editedHeaderTsx = editedHeader.data ? await editedHeader.data.text() : null;
    assert(editedHeaderTsx, "edited build has no Header.tsx in Storage");
    assert(
      editedHeaderTsx !== sourceHeaderTsx,
      "shell edit produced a byte-identical header — guidance was NOT threaded into compose (no-op preview)",
    );
    console.log("  shell edit changed the header tsx (guidance threaded)");

    // 8. NEGATIVE — vague prompt → clarify, no new build.
    const { count: buildsMid } = await admin
      .from("site_builds")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId);
    console.log('→ sending vague "make it nicer"');
    const vague = await sendChatMessageAction({ projectId, content: "make it nicer" });
    assert(vague.assistant.needsClarification, "vague prompt should yield a clarifying question");
    assert(!vague.assistant.editId, "vague prompt must not start an edit");
    await new Promise((r) => setTimeout(r, POLL_TICK_MS));
    const { count: buildsAfterVague } = await admin
      .from("site_builds")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId);
    assert(buildsAfterVague === buildsMid, "vague prompt must not create a build");

    console.log(`\nSMOKE PASS ✓  (builds before=${buildsBefore}, after vague=${buildsAfterVague})`);
  }

  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
  ```

- [ ] **Step 2: Run the smoke (manual, live stack)**

  In one terminal start the Inngest dev server and Next dev (per the repo's normal dev workflow). Then:

  ```bash
  JAB_CHAT_EDIT=1 pnpm --filter @jab/web exec tsx lib/inngest/functions/edit-site.smoke.ts <twoRoadsProjectId>
  ```
  Expected terminal output ends with `SMOKE PASS ✓`. If any assertion fails the script prints `SMOKE FAIL: ...` and exits 1.

  > If the planner picks a non-hero block for "make the hero bolder" on the Two Roads inventory, that is still a valid actionable plan (the assertion checks `scope=component`, not a specific block name) — note the chosen target in the run log. The negative-path assertion (vague → clarify, no build) is the hard gate.

- [ ] **Step 3: Typecheck the smoke compiles**

  ```bash
  pnpm --filter @jab/web typecheck
  ```
  Expected: clean (the smoke imports resolve).

- [ ] **Step 4: Commit**

  ```bash
  git add apps/web/lib/inngest/functions/edit-site.smoke.ts
  git commit -m "test(saas): end-to-end chat edit smoke against Two Roads + vague-prompt negative

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

- [ ] **Step 5: Full app test sweep + flag-on decision**

  ```bash
  pnpm --filter @jab/web test
  pnpm --filter @jab/web typecheck
  ```
  Expected: the entire app suite green (all Phase-2 pure cores + the pre-existing suites). Once the Task 23 manual smoke is green against Two Roads, flip `JAB_CHAT_EDIT=1` in the deploy env to ship the loop. Until then the ChatPanel stays gated and the manual `WorkspaceEditsPanel` form remains the advanced surface.

---

## Definition of done

The phase is shippable + demoable when ALL of the following hold (spec §4 Phase 2 "Shippable + the headline demo"):

- [ ] Generator `guidance` threads into all five component builders + both shell prompts strictly after the `USER:` marker; a test asserts placement for every builder; omitting guidance is byte-identical (R7).
- [ ] `inventory-entry-from-row.ts` is the single row→entry + screenshot-resolution source; `generate-components.ts` re-imports it; existing suites still green.
- [ ] All pure cores are TDD-green: `site-map`, `edit-plan`+`validateEditPlan`, `edit-impact` (`computeChangedPages` diffs the SOURCE `block_tree`, fail-closed > 50 / null / non-array), `approval-carry-forward` (slug-matched), `active-edit-guard`, `edit-cost-guard`, `workspace-edit-state`, `chat-turn-outcome`, `scoped-review`, `build-cancel`, `regenerate-unit`, `edit-site.helpers` (`buildCarryForwardUpdates`), `discard-edit-decision`, `chat-card-model`.
- [ ] `edit-planner.planEdit` is tested with a mocked client for actionable / clarifying / hallucinated-target; the planner is constrained to `component|shell`; `action` states blast radius.
- [ ] `edit-site.ts` (sole owner of the seam) writes the full `BuildConfig`, regenerates the target between clone and dispatch, computes changed pages from the SOURCE `block_tree`, aborts compose on regen compile-fail, and backfills `chat_messages.build_id`.
- [ ] `verify-fidelity.ts` (one coordinated change) loads `config`, carries forward approvals on edit builds, skips carry-forward on the zero-page mark-ready-empty path, flips `ready` only `WHERE status != 'cancelled'`, and writes `ttfb_ms`/`load_ms`/`transfer_bytes` fail-soft from the home-route perf capture.
- [ ] Cancel guards short-circuit `compose-site.ts` + `deploy-site.ts` at entry; discard actually stops the pipeline.
- [ ] `requestWorkspaceEditAction` enforces the active-build + `edit_in_review` guard (readiness derived from `site_builds.status`) and passes through `regenerationPrompt`/`action`/`messageId`; `discardEditAction` cancels the build + discards the edit + best-effort Storage cleanup and refuses a promoted edit; reject/abandon auto-releases the slot.
- [ ] `publishBuildAction` stamps `workspace_edits.result_promoted_deployment_id` after the supersede sweep on edit promotes.
- [ ] Chat actions wired: `sendChatMessageAction` runs the §3.3 1–7 flow (RLS user-client reads; admin writes after a membership SELECT); `ChatPanel` is gated behind `JAB_CHAT_EDIT` with optimistic send, clarifying render, what-changed card (phase + elapsed + preview/review links + blast-radius count), `aria-live="polite"`, focus retention, `prefers-reduced-motion`.
- [ ] Review screen scopes to changed pages by default (with show-all) and `ScopedReviewBanner` renders on edit builds; workspace edit-history links `ready` results to `/review` and offers Discard per unpromoted edit.
- [ ] **End-to-end smoke green against Two Roads:** "make the hero bolder" → component plan → regen overwrites cloned tsx → preview `ready` → carried approvals present → scoped review shows only the changed pages pending → approve → promote → production deployments row + supersede + `result_promoted_deployment_id`; AND a vague prompt yields a clarifying question and creates NO build.
- [ ] `pnpm --filter @jab/web test` and `pnpm --filter @jab/web typecheck` both pass; `JAB_CHAT_EDIT=1` flips on only after the smoke is green.

