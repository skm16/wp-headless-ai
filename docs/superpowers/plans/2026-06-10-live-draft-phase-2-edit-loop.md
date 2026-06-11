# Live Draft Phase 2 — Draft Model + Edit Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chat edits patch draft component TSX and reflect in the workspace preview in ~8–15s — no `site_builds` row, no Vercel deploy, no verify — with per-edit undo and a draft-aware preview pane.

**Architecture:** Spec [`docs/superpowers/specs/2026-06-10-live-draft-system-design.md`](../specs/2026-06-10-live-draft-system-design.md) §§5–6, 9–10. Migration 0034 adds `drafts` + `draft_unit_versions` + `workspace_edits` columns. A new `draft-edit` Inngest worker replaces `edit-site` as the `site/edit.requested` handler: patch LLM on current TSX (full-regen fallback) → esbuild bundle gate → Tailwind JIT → versioned artifact commit. The pane gains a `draft` state rendered through Phase 1's renderer at per-version artifact paths.

**Tech Stack:** Supabase (migration + RLS), Inngest, Anthropic SDK via existing `ModelClient`, Phase 1 draft modules (`lib/draft/*`), Vitest.

**Branch:** `feat/saas-e2e-loop` (no worktree — parallel session shares this clone; commit early and often).

**Prerequisite:** Phase 1 plan fully landed ([`2026-06-10-live-draft-phase-1-renderer.md`](2026-06-10-live-draft-phase-1-renderer.md)) — this phase imports `bundleDraftRuntime`, `buildDraftCss`, `ensureBaseDraftArtifacts` deps, `verifyDraftToken`/`mintDraftToken`, and the draft routes.

**Test commands:**
- Single file: `pnpm --filter @jab/web exec vitest run <path-from-apps/web>`
- Full suite: `pnpm --filter @jab/web test`
- Typecheck: `pnpm --filter @jab/web exec tsc --noEmit`

---

## Context for implementers (read once)

- All paths relative to `apps/web/`.
- `workspace_edits` columns today (0024 + 0030): `id, project_id, tenant_id, source_build_id, result_build_id, user_id, scope, target, prompt, status, error_text, created_at, finished_at, regeneration_prompt, action, message_id, changed_slugs, change_reason, result_promoted_deployment_id`. Status CHECK: `queued|running|completed|failed|discarded`.
- The current `site/edit.requested` handler is `lib/inngest/functions/edit-site.ts` (`inngest.createFunction({ id: "edit-site", retries: 0 }, { event: EDIT_REQUESTED_EVENT }, ...)`), registered in `app/api/inngest/route.ts`. Event payload `SiteEditRequestedData` lives in `lib/inngest/edit-request-event.ts` (fields: `editId, projectId, tenantId, sourceBuildId, scope, target, prompt, regenerationPrompt?, action?, messageId?`).
- Chat dispatch path (`lib/actions/workspace-chat.ts:158-200`) and the manual form (`lib/actions/workspace-edit.ts`) both go through `requestWorkspaceEditAction` → `inngest.send({ name: EDIT_REQUESTED_EVENT, data: payload })`. NEITHER changes in this phase except noted glue.
- LLM plumbing: `modelClientForTier(tier)` (`lib/ai/model-client.ts:189-209`; visual/standard → Sonnet 4.6, trivial → Haiku 4.5; `JAB_GENERATE_MOCK=1` returns `MockModelClient`); `ModelClient.generate(opts) → { text, usage }`; `validateTsx(source, fileName) → string[]` and `MAX_COMPONENT_BYTES = 10_000` in `lib/ai/component-generator.ts`; `postprocessGeneratedTsx(source, opts)` in `lib/ai/generated-tsx-postprocess.ts` (fences → import rewrite → export name → use-client). `MAX_SHELL_BYTES = 24_000` in `lib/ai/generate-shell.ts`.
- Full-regen fallback plumbing: `regenerateComponentUnit(input, deps)` (`lib/jab/regenerate-unit.ts:113-158`) with injectable `RegenComponentDeps` — `persist` receives the `GeneratedComponent` (carries `.tsx`), so a custom `persist` can CAPTURE the TSX instead of writing Storage.
- Impact: `computeChangedPages({ scope, target, sourcePages })` (`lib/jab/edit-impact.ts:50-83`) + `loadSourcePagesForImpact(sourceBuildId)` (`lib/inngest/functions/edit-site.helpers.ts:38-49`).
- `isUniqueViolation` lives in `lib/db/pg-error.ts` (compose-site imports it).
- Pane/preview files: `lib/jab/workspace-preview-state.ts` (full current contents in spec-era form — `deriveWorkspacePreviewState(s: ProjectBuildState)`), `lib/actions/workspace-preview.ts` (`LoadWorkspacePreviewStateResult` with `hasOpenEdit`), `components/workspace-preview-pane.tsx` (`previewPaneStatusFor(state, hasOpenEdit)`, `isMeaningfulTransition(prev, next, prevOpen, nextOpen)`, 5s poll + `router.refresh()`), `app/(app)/projects/[id]/workspace/page.tsx` (builds `workspaceProject` literal; `loadWorkspaceEditHistory(projectId, limit)`).
- DB mock pattern for tests: `lib/db/auto-fail-stale-open-edits.test.ts` (mock `@/lib/supabase/admin`, chainable `from().select().eq().in()` fakes).
- `edit-site.helpers.ts` is shared with verify-fidelity (`applyCarryForwardApprovals`) and Phase 3 (clone columns) — it STAYS when `edit-site.ts` is deleted.

---

### Task 1: migration 0034 — `drafts`, `draft_unit_versions`, `workspace_edits` columns

**Files:**
- Create: `drizzle/migrations/0034_live_draft.sql`
- Modify: `lib/db/schema.ts` (add drizzle table defs — match how `pageInventory`/`blockInventory` are declared there; used by `getTableColumns`-style tests)

- [ ] **Step 1: Write the migration**

```sql
-- 0034_live_draft.sql
-- Live Draft system (spec docs/superpowers/specs/2026-06-10-live-draft-system-design.md §5)
-- drafts: one active draft per project; draft_unit_versions: immutable per-unit
-- TSX snapshots (the undo history); workspace_edits gains draft linkage.

CREATE TABLE IF NOT EXISTS public.drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  base_build_id uuid NOT NULL REFERENCES public.site_builds(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'publishing', 'published', 'discarded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One live draft per project ('publishing' included so a new draft can't
-- spawn mid-publish). Same pattern as 0031's one-active-build index.
CREATE UNIQUE INDEX IF NOT EXISTS drafts_one_active_per_project_idx
  ON public.drafts (project_id)
  WHERE status IN ('active', 'publishing');

CREATE TABLE IF NOT EXISTS public.draft_unit_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES public.drafts(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_key text NOT NULL,            -- block name ('acf/hero') or 'shell:header' / 'shell:footer'
  version_no integer NOT NULL,       -- per-unit, monotonic
  tsx text NOT NULL,                 -- full unit source after the edit (<= generation size caps)
  created_by_edit_id uuid REFERENCES public.workspace_edits(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, unit_key, version_no)
);

CREATE INDEX IF NOT EXISTS draft_unit_versions_draft_idx
  ON public.draft_unit_versions (draft_id);

ALTER TABLE public.workspace_edits
  ADD COLUMN IF NOT EXISTS draft_id uuid REFERENCES public.drafts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unit_version_id uuid REFERENCES public.draft_unit_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS undone_at timestamptz;

CREATE INDEX IF NOT EXISTS workspace_edits_draft_idx
  ON public.workspace_edits (draft_id);

-- RLS: read-only for tenant members (mirrors 0024's select policy); all
-- writes go through the service-role admin client.
ALTER TABLE public.drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_unit_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "drafts_tenant_select"
  ON public.drafts FOR SELECT
  USING (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
  );

CREATE POLICY "draft_unit_versions_tenant_select"
  ON public.draft_unit_versions FOR SELECT
  USING (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
  );
```

- [ ] **Step 2: Add drizzle schema defs**

In `lib/db/schema.ts`, declare `drafts` and `draftUnitVersions` tables and extend the existing `workspaceEdits` table object with `draft_id`, `unit_version_id`, `undone_at` — follow the file's existing declaration style exactly (open it first; mirror how `siteBuilds`/`workspaceEdits` declare uuid/text/timestamptz columns).

- [ ] **Step 3: Apply + verify (operator step — needs Supabase access)**

Apply 0034 to **local "JAB WP" (`ajfurojjxthhzkjqttri`)** via the Supabase MCP `apply_migration`, and record that **prod "jab-prod" (`celzwcxkrmsbwiswkxug`)** needs the same before any prod exercise (per [[two-supabase-projects-local-prod]] — apply EVERY migration to both). Verify: `drafts_one_active_per_project_idx` exists and `workspace_edits` shows the three new columns.

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm --filter @jab/web exec tsc --noEmit` — Expected: clean.

```bash
git add apps/web/drizzle/migrations/0034_live_draft.sql apps/web/lib/db/schema.ts
git commit -m "feat(draft): migration 0034 — drafts, draft_unit_versions, workspace_edits draft linkage"
```

---

### Task 2: pure draft state — `lib/draft/state.ts`

**Files:**
- Create: `lib/draft/state.ts`
- Test: `lib/draft/state.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/draft/state.test.ts
import { describe, it, expect } from "vitest";
import {
  effectiveUnitVersions,
  nextUnitVersionNo,
  unionChangedSlugs,
  type DraftVersionRow,
  type DraftStepRow,
} from "./state";

const v = (over: Partial<DraftVersionRow>): DraftVersionRow => ({
  id: "v1",
  unit_key: "acf/hero",
  version_no: 1,
  created_by_edit_id: "e1",
  ...over,
});
const s = (over: Partial<DraftStepRow>): DraftStepRow => ({
  id: "e1",
  status: "completed",
  undone_at: null,
  changed_slugs: null,
  created_at: "2026-06-10T12:00:00Z",
  ...over,
});

describe("effectiveUnitVersions", () => {
  it("picks the latest non-undone version per unit", () => {
    const versions = [
      v({ id: "v1", version_no: 1, created_by_edit_id: "e1" }),
      v({ id: "v2", version_no: 2, created_by_edit_id: "e2" }),
    ];
    const steps = [s({ id: "e1" }), s({ id: "e2" })];
    const eff = effectiveUnitVersions(versions, steps);
    expect(eff.get("acf/hero")?.id).toBe("v2");
  });

  it("falls back to the prior version when the latest step is undone (the undo)", () => {
    const versions = [
      v({ id: "v1", version_no: 1, created_by_edit_id: "e1" }),
      v({ id: "v2", version_no: 2, created_by_edit_id: "e2" }),
    ];
    const steps = [s({ id: "e1" }), s({ id: "e2", undone_at: "2026-06-10T13:00:00Z" })];
    expect(effectiveUnitVersions(versions, steps).get("acf/hero")?.id).toBe("v1");
  });

  it("drops the unit entirely when all its versions are undone (back to base)", () => {
    const versions = [v({ id: "v1", created_by_edit_id: "e1" })];
    const steps = [s({ id: "e1", undone_at: "2026-06-10T13:00:00Z" })];
    expect(effectiveUnitVersions(versions, steps).size).toBe(0);
  });

  it("keeps versions whose edit row is missing (defensive: never lose committed work)", () => {
    const versions = [v({ id: "v1", created_by_edit_id: "e-gone" })];
    expect(effectiveUnitVersions(versions, []).get("acf/hero")?.id).toBe("v1");
  });
});

describe("nextUnitVersionNo", () => {
  it("is 1 for a fresh unit and max+1 otherwise (counts undone versions too — ids never reuse)", () => {
    expect(nextUnitVersionNo([], "acf/hero")).toBe(1);
    const versions = [v({ version_no: 1 }), v({ version_no: 2 })];
    expect(nextUnitVersionNo(versions, "acf/hero")).toBe(3);
    expect(nextUnitVersionNo(versions, "shell:header")).toBe(1);
  });
});

describe("unionChangedSlugs", () => {
  it("unions changed_slugs across active completed steps only", () => {
    const steps = [
      s({ id: "e1", changed_slugs: ["home", "about"] }),
      s({ id: "e2", changed_slugs: ["about", "beers"] }),
      s({ id: "e3", changed_slugs: ["contact"], undone_at: "2026-06-10T13:00:00Z" }),
      s({ id: "e4", status: "failed", changed_slugs: ["never"] }),
    ];
    expect(unionChangedSlugs(steps).sort()).toEqual(["about", "beers", "home"]);
  });

  it("returns empty for no active steps", () => {
    expect(unionChangedSlugs([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/state.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/web/lib/draft/state.ts
/**
 * state — pure fold over draft snapshots + steps. The draft is a pure
 * function of (base build, active steps): spec §4. No IO here.
 */
export interface DraftVersionRow {
  id: string;
  unit_key: string;
  version_no: number;
  created_by_edit_id: string | null;
}

export interface DraftStepRow {
  id: string;
  status: string;
  undone_at: string | null;
  changed_slugs: string[] | null;
  created_at: string;
}

/** A version is ACTIVE unless its creating step exists and is undone. */
function isActiveVersion(version: DraftVersionRow, stepsById: Map<string, DraftStepRow>): boolean {
  if (!version.created_by_edit_id) return true;
  const step = stepsById.get(version.created_by_edit_id);
  if (!step) return true; // defensive: never lose committed work to a missing row
  return step.undone_at === null;
}

/** Latest active version per unit_key. Empty map entry = unit falls back to base build. */
export function effectiveUnitVersions<T extends DraftVersionRow>(
  versions: T[],
  steps: DraftStepRow[],
): Map<string, T> {
  const stepsById = new Map(steps.map((s) => [s.id, s]));
  const out = new Map<string, T>();
  for (const version of versions) {
    if (!isActiveVersion(version, stepsById)) continue;
    const cur = out.get(version.unit_key);
    if (!cur || version.version_no > cur.version_no) out.set(version.unit_key, version);
  }
  return out;
}

/** Per-unit version numbers are never reused — undone versions still count. */
export function nextUnitVersionNo(versions: DraftVersionRow[], unitKey: string): number {
  let max = 0;
  for (const v of versions) {
    if (v.unit_key === unitKey && v.version_no > max) max = v.version_no;
  }
  return max + 1;
}

/** Union of changed_slugs over ACTIVE (completed, not undone) steps — the publish blast radius. */
export function unionChangedSlugs(steps: DraftStepRow[]): string[] {
  const out = new Set<string>();
  for (const step of steps) {
    if (step.status !== "completed" || step.undone_at !== null) continue;
    for (const slug of step.changed_slugs ?? []) out.add(slug);
  }
  return [...out];
}

/** Steps that currently contribute to the draft (history UI + publish gate). */
export function activeSteps<T extends DraftStepRow>(steps: T[]): T[] {
  return steps.filter((s) => s.status === "completed" && s.undone_at === null);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/state.test.ts` — Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/draft/state.ts apps/web/lib/draft/state.test.ts
git commit -m "feat(draft): pure draft-state fold (effective units, undo, changed-slug union)"
```

---

### Task 3: patch LLM — `lib/ai/patch-component.ts`

**Files:**
- Create: `lib/ai/patch-component.ts`
- Test: `lib/ai/patch-component.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/ai/patch-component.test.ts
import { describe, it, expect, vi } from "vitest";
import { patchUnitSource, buildPatchPrompt } from "./patch-component";
import type { ModelClient } from "./model-client";

const CURRENT = `export function AcfHero({ block }: { block: { attrs: Record<string, unknown> } }) {
  return <h1 className="text-6xl">{String(block.attrs.title ?? "")}</h1>;
}
`;

function fakeClient(responses: string[]): ModelClient {
  const generate = vi.fn();
  for (const r of responses) generate.mockResolvedValueOnce({ text: r, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 } });
  return { generate } as unknown as ModelClient;
}

describe("buildPatchPrompt", () => {
  it("contains the current source, the instruction, and the keep-contract rules", () => {
    const p = buildPatchPrompt({ currentTsx: CURRENT, guidance: "make the headline smaller", exportName: "AcfHero" });
    expect(p.user).toContain(CURRENT.trim());
    expect(p.user).toContain("make the headline smaller");
    expect(p.system).toContain("AcfHero");
    expect(p.system).toMatch(/minimal/i); // minimal-diff rule
  });
});

describe("patchUnitSource", () => {
  it("returns the patched TSX when the model output validates", async () => {
    const patched = CURRENT.replace("text-6xl", "text-4xl");
    const result = await patchUnitSource({
      currentTsx: CURRENT,
      guidance: "make the headline smaller",
      exportName: "AcfHero",
      maxBytes: 10_000,
      client: fakeClient([patched]),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tsx).toContain("text-4xl");
  });

  it("retries once on invalid TSX, then succeeds", async () => {
    const patched = CURRENT.replace("text-6xl", "text-5xl");
    const result = await patchUnitSource({
      currentTsx: CURRENT,
      guidance: "smaller",
      exportName: "AcfHero",
      maxBytes: 10_000,
      client: fakeClient(["export function AcfHero({ <<<garbage", patched]),
    });
    expect(result.ok).toBe(true);
  });

  it("fails after two invalid attempts with the validation errors attached", async () => {
    const result = await patchUnitSource({
      currentTsx: CURRENT,
      guidance: "smaller",
      exportName: "AcfHero",
      maxBytes: 10_000,
      client: fakeClient(["<<<garbage", "<<<garbage again"]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });

  it("fails when the output exceeds maxBytes", async () => {
    const huge = CURRENT + "\n// " + "x".repeat(20_000);
    const result = await patchUnitSource({
      currentTsx: CURRENT,
      guidance: "smaller",
      exportName: "AcfHero",
      maxBytes: 10_000,
      client: fakeClient([huge, huge]),
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/patch-component.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/web/lib/ai/patch-component.ts
import "server-only";
import { validateTsx } from "./component-generator";
import { postprocessGeneratedTsx } from "./generated-tsx-postprocess";
import type { ModelClient, GenerateUsage } from "./model-client";

/**
 * patch-component — the Live Draft edit primitive (spec §6.2.3). Unlike the
 * Phase B generator (which re-derives a component from DOM samples and can
 * silently lose earlier edits), this takes the CURRENT draft TSX as input and
 * asks for a minimal modification — iterative chat edits compound instead of
 * resetting. Same validation discipline as generation: postprocess → parse
 * check → size cap, two attempts.
 */
export interface PatchPromptInput {
  currentTsx: string;
  guidance: string;
  exportName: string;
}

export function buildPatchPrompt(input: PatchPromptInput): { system: string; user: string } {
  const system = `You are editing an existing React/Next.js component from a generated WordPress-clone site.

## Output contract
- Return ONLY the complete modified TypeScript/TSX source. No markdown fences. No prose.
- Keep the named export \`${input.exportName}\` and its exact props signature unchanged.
- Keep all imports as they are unless the edit requires removing one.
- Use Tailwind CSS classes for styling changes. No inline style objects unless a value is dynamic.
- Make the MINIMAL change that satisfies the instruction — do not refactor,
  reformat, rename, or "improve" anything the instruction doesn't ask for.
- Preserve all existing behavior outside the requested change.`;
  const user = `## Current source
${input.currentTsx.trim()}

## Edit instruction
${input.guidance.trim()}`;
  return { system, user };
}

export type PatchResult =
  | { ok: true; tsx: string; attempts: number; usage: GenerateUsage[] }
  | { ok: false; error: string; attempts: number; usage: GenerateUsage[] };

export interface PatchUnitOptions {
  currentTsx: string;
  guidance: string;
  exportName: string;
  /** MAX_COMPONENT_BYTES (10_000) for components, MAX_SHELL_BYTES (24_000) for shell. */
  maxBytes: number;
  client: ModelClient;
}

export async function patchUnitSource(opts: PatchUnitOptions): Promise<PatchResult> {
  const prompt = buildPatchPrompt(opts);
  const usage: GenerateUsage[] = [];
  let lastError = "no attempts ran";

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await opts.client.generate({
      system: prompt.system,
      user: prompt.user,
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

NOTE: check the REAL signatures before wiring: `ModelClient.generate`'s `GenerateOptions` field names (`system`/`user`/`cacheSystemPrompt` shown here — open `lib/ai/model-client.ts` and match exactly), `GenerateUsage`'s shape, and `postprocessGeneratedTsx`'s `PostprocessOptions` (open `lib/ai/generated-tsx-postprocess.ts`; if the option is named differently than `expectedExportName`, use the in-tree name). In-tree wins; adjust the test fake to match.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/patch-component.test.ts` — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/patch-component.ts apps/web/lib/ai/patch-component.test.ts
git commit -m "feat(draft): patch LLM — minimal-diff unit edits over current draft TSX"
```

---

### Task 4: draft DB helpers — `lib/db/drafts.ts`

**Files:**
- Create: `lib/db/drafts.ts`
- Test: `lib/db/drafts.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/db/drafts.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

import { ensureActiveDraft, bumpDraftVersion } from "./drafts";

beforeEach(() => vi.clearAllMocks());

function selectChain(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const limit = vi.fn(() => ({ maybeSingle }));
  const order = vi.fn(() => ({ limit }));
  const in_ = vi.fn(() => ({ order, limit, maybeSingle }));
  const eq2 = vi.fn(() => ({ in: in_, order, limit, maybeSingle, eq: vi.fn(() => ({ order, limit, maybeSingle })) }));
  const select = vi.fn(() => ({ eq: eq2 }));
  return { select, eq2, in_ };
}

describe("ensureActiveDraft", () => {
  it("returns the existing live draft without inserting", async () => {
    const existing = { id: "d1", base_build_id: "b1", version: 3, status: "active" };
    const { select } = selectChain({ data: existing, error: null });
    const insert = vi.fn();
    mockFrom.mockReturnValue({ select, insert });
    await expect(ensureActiveDraft("p1", "t1")).resolves.toEqual(existing);
    expect(insert).not.toHaveBeenCalled();
  });

  it("creates a draft forked from the latest ready build when none is live", async () => {
    // 1st call: drafts select -> none; 2nd: site_builds select -> ready build; 3rd: drafts insert
    const noDraft = selectChain({ data: null, error: null });
    const readyBuild = selectChain({ data: { id: "b9" }, error: null });
    const inserted = { id: "d2", base_build_id: "b9", version: 0, status: "active" };
    const insertSingle = vi.fn().mockResolvedValue({ data: inserted, error: null });
    const insertSelect = vi.fn(() => ({ single: insertSingle }));
    const insert = vi.fn(() => ({ select: insertSelect }));
    mockFrom
      .mockReturnValueOnce({ select: noDraft.select })
      .mockReturnValueOnce({ select: readyBuild.select })
      .mockReturnValueOnce({ insert });
    await expect(ensureActiveDraft("p1", "t1")).resolves.toEqual(inserted);
    const payload = (insert.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(payload).toMatchObject({ project_id: "p1", tenant_id: "t1", base_build_id: "b9", status: "active" });
  });

  it("throws loudly when no ready build exists to fork from", async () => {
    const noDraft = selectChain({ data: null, error: null });
    const noBuild = selectChain({ data: null, error: null });
    mockFrom
      .mockReturnValueOnce({ select: noDraft.select })
      .mockReturnValueOnce({ select: noBuild.select });
    await expect(ensureActiveDraft("p1", "t1")).rejects.toThrow(/ready build/i);
  });
});

describe("bumpDraftVersion", () => {
  it("CAS-updates version and returns the new version", async () => {
    const updated = vi.fn().mockResolvedValue({ data: [{ id: "d1", version: 4 }], error: null });
    const selectAfter = vi.fn(() => updated());
    const eqVersion = vi.fn(() => ({ select: selectAfter }));
    const eqId = vi.fn(() => ({ eq: eqVersion }));
    const update = vi.fn(() => ({ eq: eqId }));
    mockFrom.mockReturnValue({ update });
    await expect(bumpDraftVersion("d1", 3)).resolves.toBe(4);
    expect(eqId).toHaveBeenCalledWith("id", "d1");
    expect(eqVersion).toHaveBeenCalledWith("version", 3);
  });

  it("throws when the CAS matches 0 rows (concurrent writer)", async () => {
    const selectAfter = vi.fn().mockResolvedValue({ data: [], error: null });
    const eqVersion = vi.fn(() => ({ select: selectAfter }));
    const eqId = vi.fn(() => ({ eq: eqVersion }));
    const update = vi.fn(() => ({ eq: eqId }));
    mockFrom.mockReturnValue({ update });
    await expect(bumpDraftVersion("d1", 3)).rejects.toThrow(/concurrent/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @jab/web exec vitest run lib/db/drafts.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/web/lib/db/drafts.ts
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUniqueViolation } from "@/lib/db/pg-error";

/**
 * drafts — service-role helpers for the Live Draft tables (migration 0034).
 * One live draft per project is enforced by drafts_one_active_per_project_idx;
 * ensureActiveDraft handles the insert race by re-selecting on conflict.
 */
export interface DraftRow {
  id: string;
  base_build_id: string;
  version: number;
  status: string;
}

const DRAFT_COLUMNS = "id, base_build_id, version, status";
const LIVE_STATUSES = ["active", "publishing"];

export async function findLiveDraft(projectId: string): Promise<DraftRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("drafts")
    .select(DRAFT_COLUMNS)
    .eq("project_id", projectId)
    .in("status", LIVE_STATUSES)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`findLiveDraft failed: ${error.message}`);
  return (data as DraftRow | null) ?? null;
}

export async function ensureActiveDraft(projectId: string, tenantId: string): Promise<DraftRow> {
  const existing = await findLiveDraft(projectId);
  if (existing) return existing;

  const admin = createAdminClient();
  const { data: build, error: buildErr } = await admin
    .from("site_builds")
    .select("id")
    .eq("project_id", projectId)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (buildErr) throw new Error(`ensureActiveDraft build lookup failed: ${buildErr.message}`);
  if (!build) {
    throw new Error("ensureActiveDraft: no ready build to fork a draft from — run a full build first");
  }

  const { data, error } = await admin
    .from("drafts")
    .insert({ project_id: projectId, tenant_id: tenantId, base_build_id: build.id, version: 0, status: "active" })
    .select(DRAFT_COLUMNS)
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findLiveDraft(projectId);
      if (raced) return raced;
    }
    throw new Error(`ensureActiveDraft insert failed: ${error.message}`);
  }
  return data as DraftRow;
}

/** CAS version bump — the LAST write of a commit (spec §6.2.6 ordering). */
export async function bumpDraftVersion(draftId: string, expectedVersion: number): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("drafts")
    .update({ version: expectedVersion + 1, updated_at: new Date().toISOString() })
    .eq("id", draftId)
    .eq("version", expectedVersion)
    .select("id, version");
  if (error) throw new Error(`bumpDraftVersion failed: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error(`bumpDraftVersion: concurrent writer moved draft ${draftId} past v${expectedVersion}`);
  }
  return (data[0] as { version: number }).version;
}

export interface DraftVersionWithTsx {
  id: string;
  unit_key: string;
  version_no: number;
  created_by_edit_id: string | null;
  tsx: string;
}

export async function loadDraftVersions(draftId: string): Promise<DraftVersionWithTsx[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("draft_unit_versions")
    .select("id, unit_key, version_no, created_by_edit_id, tsx")
    .eq("draft_id", draftId);
  if (error) throw new Error(`loadDraftVersions failed: ${error.message}`);
  return (data ?? []) as DraftVersionWithTsx[];
}

export async function loadDraftSteps(draftId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("workspace_edits")
    .select("id, status, undone_at, changed_slugs, created_at, scope, target")
    .eq("draft_id", draftId);
  if (error) throw new Error(`loadDraftSteps failed: ${error.message}`);
  return data ?? [];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @jab/web exec vitest run lib/db/drafts.test.ts` — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/db/drafts.ts apps/web/lib/db/drafts.test.ts
git commit -m "feat(draft): drafts DB helpers — ensureActiveDraft (race-safe), CAS version bump, loaders"
```

---

### Task 5: versioned draft artifacts — `buildVersionedDraftArtifacts`

**Files:**
- Modify: `lib/draft/artifacts.ts`
- Test: `lib/draft/artifacts.test.ts` (extend)

- [ ] **Step 1: Add failing tests**

Append to `lib/draft/artifacts.test.ts`:

```typescript
import { draftArtifactPath, buildVersionedDraftArtifacts } from "./artifacts";

describe("draftArtifactPath", () => {
  it("keys versioned artifacts by draft + version", () => {
    expect(draftArtifactPath("d1", 4, "bundle.js")).toBe("drafts/d1/v4/bundle.js");
    expect(draftArtifactPath("d1", 4, "draft.css")).toBe("drafts/d1/v4/draft.css");
  });
});

describe("buildVersionedDraftArtifacts", () => {
  it("applies unit overrides over base sources (component + shell) before bundling", async () => {
    const d = {
      artifactExists: vi.fn(async () => false),
      loadInventory: vi.fn(async () => [
        { block_name: "acf/hero", tier: "visual", compile_status: "ok" },
      ]),
      loadComponentSources: vi.fn(async () => ({ AcfHero: "export function AcfHero(){return <p>base</p>;}" })),
      loadShellSource: vi.fn(async (_b: string, kind: string) =>
        kind === "header" ? "export function Header(){return <header>base</header>;}" : null,
      ),
      loadProjectMeta: vi.fn(async () => ({ wpUrl: "https://x.com", tokens: null, themeCss: null })),
      bundle: vi.fn(async () => ({ js: "//bundle" })),
      buildCss: vi.fn(async () => "/*css*/"),
      upload: vi.fn(async () => {}),
    };
    const out = await buildVersionedDraftArtifacts(
      {
        draftId: "d1",
        nextVersion: 4,
        baseBuildId: "b1",
        overrides: new Map([
          ["acf/hero", "export function AcfHero(){return <p>edited</p>;}"],
          ["shell:header", "export function Header(){return <header>edited</header>;}"],
        ]),
      },
      d,
    );
    const bundleInput = (d.bundle as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(bundleInput.componentSources.AcfHero).toContain("edited");
    expect(bundleInput.headerSource).toContain("edited");
    expect(d.upload).toHaveBeenCalledWith("drafts/d1/v4/bundle.js", "//bundle", "text/javascript");
    expect(d.upload).toHaveBeenCalledWith("drafts/d1/v4/draft.css", "/*css*/", "text/css");
    expect(out).toEqual({ bundlePath: "drafts/d1/v4/bundle.js", cssPath: "drafts/d1/v4/draft.css" });
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/artifacts.test.ts` — Expected: new tests FAIL.

Append to `lib/draft/artifacts.ts`:

```typescript
export function draftArtifactPath(draftId: string, version: number, file: "bundle.js" | "draft.css"): string {
  return `drafts/${draftId}/v${version}/${file}`;
}

export interface VersionedArtifactArgs {
  draftId: string;
  nextVersion: number;
  baseBuildId: string;
  /** unit_key -> TSX. Component keys are block names; shell keys 'shell:header'/'shell:footer'. */
  overrides: Map<string, string>;
}

/**
 * Effective set = base build sources overridden by draft unit snapshots
 * (spec §5.2), bundled + JIT'd and uploaded at the NEXT version's path.
 * Callers (draft-edit worker commit, undo actions) bump drafts.version only
 * after this resolves — readers never see a version with missing artifacts.
 */
export async function buildVersionedDraftArtifacts(
  args: VersionedArtifactArgs,
  deps: ArtifactDeps,
): Promise<{ bundlePath: string; cssPath: string }> {
  const inventory = await deps.loadInventory(args.baseBuildId);
  const dispatcherRows = dispatcherRowsFromInventory(inventory);
  const usable = dispatcherRows.filter(
    (r) => r.blockName && r.blockName !== "core/image" && r.tier !== "passthrough" && r.compileStatus === "ok",
  );

  const [baseComponents, baseHeader, baseFooter, meta] = await Promise.all([
    deps.loadComponentSources(args.baseBuildId, usable.map((r) => draftComponentName(r.blockName as string))),
    deps.loadShellSource(args.baseBuildId, "header"),
    deps.loadShellSource(args.baseBuildId, "footer"),
    deps.loadProjectMeta(args.baseBuildId),
  ]);

  const componentSources: Record<string, string> = { ...baseComponents };
  for (const r of usable) {
    const override = args.overrides.get(r.blockName as string);
    if (override) componentSources[draftComponentName(r.blockName as string)] = override;
  }
  const headerSource = args.overrides.get("shell:header") ?? baseHeader;
  const footerSource = args.overrides.get("shell:footer") ?? baseFooter;

  const { js } = await deps.bundle({
    componentSources,
    dispatcherSource: emitDispatcherTsx(dispatcherRows),
    passthroughSource: emitPassthroughTsx(),
    headerSource,
    footerSource,
    wpUrl: meta.wpUrl,
  });
  const css = await deps.buildCss({
    sources: [...Object.values(componentSources), headerSource ?? "", footerSource ?? ""],
    tokens: meta.tokens,
    themeCss: meta.themeCss,
  });

  const bundlePath = draftArtifactPath(args.draftId, args.nextVersion, "bundle.js");
  const cssPath = draftArtifactPath(args.draftId, args.nextVersion, "draft.css");
  await deps.upload(bundlePath, js, "text/javascript");
  await deps.upload(cssPath, css, "text/css");
  return { bundlePath, cssPath };
}
```

- [ ] **Step 3: Run to verify pass + typecheck**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/artifacts.test.ts` — Expected: ALL PASS.
Run: `pnpm --filter @jab/web exec tsc --noEmit` — Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/draft/artifacts.ts apps/web/lib/draft/artifacts.test.ts
git commit -m "feat(draft): versioned artifact builder applies unit overrides over base build"
```

---

### Task 6: `draft-edit` worker replaces `edit-site`

**Files:**
- Create: `lib/inngest/functions/draft-edit.ts`
- Delete: `lib/inngest/functions/edit-site.ts` (KEEP `edit-site.helpers.ts` — verify-fidelity + Phase 3 use it)
- Modify: `app/api/inngest/route.ts` (swap `editSite` → `draftEdit` in the functions array)
- Test: `lib/inngest/functions/draft-edit.test.ts` (pure decision helpers only — worker glue is validated live in Task 11)

- [ ] **Step 1: Write the failing test for the worker's pure helpers**

```typescript
// apps/web/lib/inngest/functions/draft-edit.test.ts
import { describe, it, expect } from "vitest";
import { unitKeyFor, exportNameFor, maxBytesFor } from "./draft-edit";

describe("draft-edit pure helpers", () => {
  it("unitKeyFor maps component targets to block names and shell targets to shell: keys", () => {
    expect(unitKeyFor("component", "acf/hero")).toBe("acf/hero");
    expect(unitKeyFor("shell", "header")).toBe("shell:header");
    expect(unitKeyFor("shell", "footer")).toBe("shell:footer");
  });

  it("exportNameFor matches the dispatcher convention for components and Header/Footer for shell", () => {
    expect(exportNameFor("component", "acf/hero")).toBe("AcfHero");
    expect(exportNameFor("shell", "header")).toBe("Header");
    expect(exportNameFor("shell", "footer")).toBe("Footer");
  });

  it("maxBytesFor uses the component cap for components and the shell cap for shell", () => {
    expect(maxBytesFor("component")).toBe(10_000);
    expect(maxBytesFor("shell")).toBe(24_000);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @jab/web exec vitest run lib/inngest/functions/draft-edit.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement the worker**

```typescript
// apps/web/lib/inngest/functions/draft-edit.ts
import { inngest } from "@/lib/inngest/client";
import { EDIT_REQUESTED_EVENT, type SiteEditRequestedData } from "@/lib/inngest/edit-request-event";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureActiveDraft, bumpDraftVersion, loadDraftVersions, loadDraftSteps } from "@/lib/db/drafts";
import { effectiveUnitVersions, nextUnitVersionNo } from "@/lib/draft/state";
import { buildVersionedDraftArtifacts, defaultArtifactDeps } from "@/lib/draft/artifacts";
import { draftComponentName } from "@/lib/draft/bundle";
import { patchUnitSource } from "@/lib/ai/patch-component";
import { modelClientForTier } from "@/lib/ai/model-client";
import { computeChangedPages } from "@/lib/jab/edit-impact";
import { loadSourcePagesForImpact } from "./edit-site.helpers";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";

/**
 * draft-edit — Live Draft replacement for the retired edit-site worker
 * (spec §6.2). One chat/manual edit = one draft step: patch the unit's
 * current TSX, bundle-gate the whole effective set, commit a new draft
 * version. NO site_builds row, NO compose/deploy/verify — those run once
 * at publish (Phase 3).
 *
 * retries: 0 — same rationale as edit-site (no duplicate LLM spend);
 * stranded rows are swept by autoFailStaleOpenEdits.
 */
export function unitKeyFor(scope: "component" | "shell", target: string): string {
  return scope === "shell" ? `shell:${target}` : target;
}

export function exportNameFor(scope: "component" | "shell", target: string): string {
  if (scope === "shell") return target === "header" ? "Header" : "Footer";
  return draftComponentName(target);
}

export function maxBytesFor(scope: "component" | "shell"): number {
  return scope === "shell" ? 24_000 : 10_000;
}

export const draftEdit = inngest.createFunction(
  { id: "draft-edit", retries: 0 },
  { event: EDIT_REQUESTED_EVENT },
  async ({ event, step }) => {
    const data = event.data as SiteEditRequestedData;
    const { editId, projectId, tenantId, scope, target } = data;
    const guidance = data.regenerationPrompt ?? data.prompt;
    const admin = createAdminClient();

    const failEdit = async (message: string) => {
      await admin
        .from("workspace_edits")
        .update({ status: "failed", error_text: message, finished_at: new Date().toISOString() })
        .eq("id", editId)
        .in("status", ["queued", "running"]);
      if (data.messageId) {
        await admin
          .from("chat_messages")
          .update({ content: `That edit couldn't be applied: ${message}`, needs_clarification: true })
          .eq("id", data.messageId);
      }
    };

    // 1. Claim the edit (mirror of edit-site's mark-edit-running).
    await step.run("mark-edit-running", async () => {
      await admin
        .from("workspace_edits")
        .update({ status: "running" })
        .eq("id", editId)
        .in("status", ["queued", "running"]);
    });

    // 2. Ensure the draft + link the edit row to it.
    const draft = await step.run("ensure-draft", async () => {
      const d = await ensureActiveDraft(projectId, tenantId);
      if (d.status !== "active") {
        throw new Error(`draft ${d.id} is '${d.status}' — publish in progress, retry after it finishes`);
      }
      await admin.from("workspace_edits").update({ draft_id: d.id }).eq("id", editId);
      return d;
    }).catch(async (err) => {
      await failEdit(err instanceof Error ? err.message : String(err));
      return null;
    });
    if (!draft) return { failed: true };

    // 3. Load the unit's CURRENT source: latest active draft snapshot, else base build.
    const current = await step.run("load-current-source", async () => {
      const unitKey = unitKeyFor(scope, target);
      const [versions, steps] = await Promise.all([loadDraftVersions(draft.id), loadDraftSteps(draft.id)]);
      const effective = effectiveUnitVersions(versions, steps);
      const snapshot = effective.get(unitKey);
      if (snapshot) return { tsx: snapshot.tsx, versions };

      const storage = admin.storage.from(SITE_SCREENSHOTS_BUCKET);
      const path =
        scope === "shell"
          ? `builds/${draft.base_build_id}/project/components/site/${target === "header" ? "Header" : "Footer"}.tsx`
          : `builds/${draft.base_build_id}/components/${draftComponentName(target)}.tsx`;
      const { data: file } = await storage.download(path);
      if (!file) {
        throw new Error(`no source found for unit '${unitKey}' in draft or base build (${path})`);
      }
      return { tsx: await file.text(), versions };
    }).catch(async (err) => {
      await failEdit(err instanceof Error ? err.message : String(err));
      return null;
    });
    if (!current) return { failed: true };

    // 4. Patch LLM (minimal diff over current source). Tier: shell + visual
    //    components get the larger Sonnet budget; the patch prompt is small
    //    either way, so 'standard' is the safe default for components.
    const patched = await step.run("patch-unit", async () => {
      const result = await patchUnitSource({
        currentTsx: current.tsx,
        guidance,
        exportName: exportNameFor(scope, target),
        maxBytes: maxBytesFor(scope),
        client: modelClientForTier(scope === "shell" ? "visual" : "standard"),
      });
      if (!result.ok) throw new Error(`patch failed after ${result.attempts} attempts: ${result.error}`);
      return result.tsx;
    }).catch(async (err) => {
      await failEdit(err instanceof Error ? err.message : String(err));
      return null;
    });
    if (!patched) return { failed: true };

    // 5. Bundle gate + CSS over the WHOLE effective set (with this patch applied),
    //    then upload at v(N+1). Bundle failure = step failure, version doesn't move.
    const artifacts = await step.run("bundle-and-css", async () => {
      const steps = await loadDraftSteps(draft.id);
      const effective = effectiveUnitVersions(current.versions, steps);
      const overrides = new Map<string, string>();
      for (const [key, row] of effective) overrides.set(key, row.tsx);
      overrides.set(unitKeyFor(scope, target), patched);
      return buildVersionedDraftArtifacts(
        { draftId: draft.id, nextVersion: draft.version + 1, baseBuildId: draft.base_build_id, overrides },
        defaultArtifactDeps(projectId),
      );
    }).catch(async (err) => {
      await failEdit(`compile gate: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (!artifacts) return { failed: true };

    // 6. Commit: changed slugs -> version row -> edit row -> version bump (LAST).
    await step.run("commit", async () => {
      const sourcePages = await loadSourcePagesForImpact(draft.base_build_id);
      const impact = computeChangedPages({ scope, target, sourcePages });
      const changedSlugs =
        impact.reason === null ? sourcePages.map((p) => p.slug) : impact.changedSlugs;

      const unitKey = unitKeyFor(scope, target);
      const { data: versionRow, error: vErr } = await admin
        .from("draft_unit_versions")
        .insert({
          draft_id: draft.id,
          project_id: projectId,
          tenant_id: tenantId,
          unit_key: unitKey,
          version_no: nextUnitVersionNo(current.versions, unitKey),
          tsx: patched,
          created_by_edit_id: editId,
        })
        .select("id")
        .single();
      if (vErr) throw new Error(`version insert failed: ${vErr.message}`);

      const { error: eErr } = await admin
        .from("workspace_edits")
        .update({
          status: "completed",
          unit_version_id: versionRow.id,
          changed_slugs: changedSlugs,
          change_reason: impact.reason,
          finished_at: new Date().toISOString(),
        })
        .eq("id", editId)
        .eq("status", "running");
      if (eErr) throw new Error(`edit update failed: ${eErr.message}`);

      await bumpDraftVersion(draft.id, draft.version);
    }).catch(async (err) => {
      await failEdit(`commit: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });

    return { draftId: draft.id, version: draft.version + 1 };
  },
);
```

In `app/api/inngest/route.ts`: replace the `editSite` import with `import { draftEdit } from "@/lib/inngest/functions/draft-edit";` and swap it in the `functions: [...]` array. Delete `lib/inngest/functions/edit-site.ts` (its tests too, if any test imports the worker itself — `edit-site.helpers.test.ts` STAYS).

NOTE on `step.run(...).catch(...)`: Inngest's `step.run` returns the step's value; with `retries: 0` a thrown error fails the run. The `.catch` wrappers convert known failures into the visible `workspace_edits.failed` + chat patch (mirroring edit-site's lines 281–304 behavior) instead of a silent dead run. If the in-tree Inngest version's typing fights this pattern, restructure as try/catch INSIDE each `step.run` returning `{ ok, value | error }` — behavior, not shape, is the contract: every failure path must end in `failEdit(...)`.

NOTE on `"completed"` semantics: with no downstream build, `completed` now means **applied to the draft** (terminal). Check `lib/jab/workspace-edit-state.ts` (`deriveEditUiState`) — simplify its mapping so `completed` renders as "Applied" without consulting `result_build_id`, and update its test accordingly.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @jab/web exec vitest run lib/inngest/functions/draft-edit.test.ts` — Expected: PASS (3 tests).
Run: `pnpm --filter @jab/web exec tsc --noEmit` — Expected: clean (the edit-site deletion will surface any stale imports — fix them: `workspace-edit-state.ts`, tests referencing the worker).
Run: `pnpm --filter @jab/web test` — Expected: PASS after updating `deriveEditUiState` tests.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/lib/inngest apps/web/app/api/inngest/route.ts apps/web/lib/jab/workspace-edit-state.ts apps/web/lib/jab/workspace-edit-state.test.ts
git commit -m "feat(draft): draft-edit worker replaces edit-site — patch, bundle-gate, versioned commit"
```

---

### Task 7: draft-aware preview state + action + pane

**Files:**
- Modify: `lib/jab/workspace-preview-state.ts`
- Modify: `lib/actions/workspace-preview.ts`
- Modify: `components/workspace-preview-pane.tsx`
- Modify: `app/ui-kit/workspace-jab/workspace-jab-demo.tsx` (`WorkspaceProject` + `PreviewPane` branch)
- Modify: `app/(app)/projects/[id]/workspace/page.tsx`
- Tests: `lib/jab/workspace-preview-state.test.ts`, `lib/actions/workspace-preview.test.ts`, `components/workspace-preview-pane.test.tsx` (extend each)

- [ ] **Step 1: Extend the state derivation (failing tests first)**

Add to `lib/jab/workspace-preview-state.test.ts`:

```typescript
import { applyDraftToPreviewState, type DraftPreviewInfo } from "./workspace-preview-state";

describe("applyDraftToPreviewState", () => {
  const ready = { kind: "ready" as const, url: "https://x.vercel.app", buildId: "b1", deploymentId: "d1" };
  const draftInfo: DraftPreviewInfo = { draftId: "dr1", version: 3, activeStepCount: 2, status: "active" };

  it("switches to draft when an active draft has steps and the base state is ready", () => {
    expect(applyDraftToPreviewState(ready, draftInfo)).toEqual({
      kind: "draft", draftId: "dr1", version: 3, activeStepCount: 2, deployedUrl: "https://x.vercel.app",
    });
  });

  it("stays on the base state when the draft has zero active steps (spec: draft only when steps exist)", () => {
    expect(applyDraftToPreviewState(ready, { ...draftInfo, activeStepCount: 0 })).toBe(ready);
  });

  it("stays on the base state when there is no draft or it is not active", () => {
    expect(applyDraftToPreviewState(ready, null)).toBe(ready);
    expect(applyDraftToPreviewState(ready, { ...draftInfo, status: "discarded" })).toBe(ready);
  });

  it("never overrides building/failed/none states (publish/in-flight builds win the pane)", () => {
    const building = { kind: "building" as const, buildId: "b2", phase: "Composing" };
    expect(applyDraftToPreviewState(building, draftInfo)).toBe(building);
  });
});
```

Implement in `lib/jab/workspace-preview-state.ts` — add to the union and a pure applier (leave `deriveWorkspacePreviewState` untouched):

```typescript
export interface DraftPreviewInfo {
  draftId: string;
  version: number;
  activeStepCount: number;
  status: string;
}

export type WorkspacePreviewState =
  | { kind: "none" }
  | { kind: "building"; buildId: string; phase: string }
  | { kind: "ready"; url: string; buildId: string; deploymentId: string }
  | { kind: "draft"; draftId: string; version: number; activeStepCount: number; deployedUrl: string }
  | { kind: "failed"; buildId: string; failedPhase: string };

/**
 * Draft overlays the pane ONLY when (a) the underlying state is 'ready'
 * (a building/publishing pipeline always wins the pane) and (b) the draft
 * is active with >= 1 active step (spec §9 — pane source decision).
 */
export function applyDraftToPreviewState(
  base: WorkspacePreviewState,
  draft: DraftPreviewInfo | null,
): WorkspacePreviewState {
  if (!draft || draft.status !== "active" || draft.activeStepCount === 0) return base;
  if (base.kind !== "ready") return base;
  return {
    kind: "draft",
    draftId: draft.draftId,
    version: draft.version,
    activeStepCount: draft.activeStepCount,
    deployedUrl: base.url,
  };
}
```

- [ ] **Step 2: Action returns draft info (failing tests, then implement)**

Add to `lib/actions/workspace-preview.test.ts` (extend the existing harness — add a `mockLoadDraftPreviewInfo` to the hoisted mocks and a `vi.mock("@/lib/jab/draft-preview-info", ...)`):

```typescript
  it("applies the draft overlay when an active draft with steps exists", async () => {
    mockSingle.mockResolvedValue({ data: { id: "proj_1" }, error: null });
    mockLoadProjectBuildState.mockResolvedValue(readyBuildState());
    mockLoadDraftPreviewInfo.mockResolvedValue({ draftId: "dr1", version: 2, activeStepCount: 1, status: "active" });
    const result = await loadWorkspacePreviewStateAction("proj_1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.kind).toBe("draft");
  });
```

Create `lib/jab/draft-preview-info.ts`:

```typescript
// apps/web/lib/jab/draft-preview-info.ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DraftPreviewInfo } from "./workspace-preview-state";

/**
 * RLS-scoped read (drafts/workspace_edits SELECT policies from 0034) used by
 * the workspace page render AND the 5s preview poll. Head-count for steps —
 * no row payloads on a poll.
 */
export async function loadDraftPreviewInfo(
  client: SupabaseClient,
  projectId: string,
): Promise<DraftPreviewInfo | null> {
  const { data: draft, error } = await client
    .from("drafts")
    .select("id, version, status")
    .eq("project_id", projectId)
    .in("status", ["active", "publishing"])
    .limit(1)
    .maybeSingle();
  if (error || !draft) return null;

  const { count } = await client
    .from("workspace_edits")
    .select("id", { count: "exact", head: true })
    .eq("draft_id", draft.id)
    .eq("status", "completed")
    .is("undone_at", null);

  return { draftId: draft.id, version: draft.version, activeStepCount: count ?? 0, status: draft.status };
}
```

In `lib/actions/workspace-preview.ts`: import `loadDraftPreviewInfo` + `applyDraftToPreviewState`; after deriving `state`, add:

```typescript
  const draftInfo = await loadDraftPreviewInfo(supabase, projectId);
  const stateWithDraft = applyDraftToPreviewState(state, draftInfo);
```

Return `state: stateWithDraft` (skip the `assertPreviewReachable` call when `stateWithDraft.kind === "draft"` — the draft URL is same-app, no Vercel protection applies).

- [ ] **Step 3: Pane mapping + draft iframe (failing tests, then implement)**

Add to `components/workspace-preview-pane.test.tsx`:

```typescript
  it("maps draft state to a live iframe at the token URL with version cache-buster, polling only while an edit is open", () => {
    const draft: WorkspacePreviewState = {
      kind: "draft", draftId: "dr1", version: 3, activeStepCount: 1, deployedUrl: "https://x.vercel.app",
    };
    const mapped = previewPaneStatusFor(draft, false, "/draft/p1/?token=t");
    expect(mapped.status).toBe("live");
    expect(mapped.src).toBe("/draft/p1/?token=t&v=3");
    expect(mapped.shouldPoll).toBe(false);
    expect(previewPaneStatusFor(draft, true, "/draft/p1/?token=t").shouldPoll).toBe(true);
  });

  it("draft version change is a meaningful transition (reload the iframe)", () => {
    const d = (version: number): WorkspacePreviewState => ({
      kind: "draft", draftId: "dr1", version, activeStepCount: 1, deployedUrl: "u",
    });
    expect(isMeaningfulTransition(d(3), d(4), false, false)).toBe(true);
    expect(isMeaningfulTransition(d(3), d(3), false, false)).toBe(false);
  });
```

Implement in `components/workspace-preview-pane.tsx`:

- `previewPaneStatusFor(state, hasOpenEdit = false, draftBaseUrl?: string)` — add the case:

```typescript
    case "draft":
      return {
        status: "live",
        src: draftBaseUrl ? `${draftBaseUrl}&v=${state.version}` : undefined,
        shouldPoll: hasOpenEdit,
      };
```

- `isMeaningfulTransition`: add `if (prev.kind === "draft" && next.kind === "draft" && prev.version !== next.version) return true;`
- Component: new prop `draftBaseUrl?: string` (threaded like `displayDomain`); pass it to `previewPaneStatusFor`; when the rendered state is `draft`, render a "Draft" badge plus a "View deployed" toggle that swaps the iframe to `state.deployedUrl` (local `showDeployed` boolean, reset on version change); pass `sandbox="allow-scripts allow-forms allow-popups"` (NO `allow-same-origin` — spec §7.4) through `PreviewFrame` to `ScaledIframe` for the draft URL only (the Vercel preview keeps its current sandbox).
- Token-expiry recovery (spec §10): add a `useEffect` listening for `message` events where `e.data?.type === "jab:draft-token-expired"` (posted by the draft shell on a 401) → `router.refresh()` — the RSC re-render mints a fresh token into `draftBaseUrl`. No origin check needed beyond the type match: the handler's only effect is a refresh.

- [ ] **Step 4: Thread the page + shell props**

In `app/(app)/projects/[id]/workspace/page.tsx`: import `mintDraftToken` (`@/lib/draft/token`), `loadDraftPreviewInfo`, `applyDraftToPreviewState`; after `previewState` is computed, overlay the draft (`const draftInfo = await loadDraftPreviewInfo(supabase, project.id); const finalPreviewState = applyDraftToPreviewState(previewState, draftInfo);`), mint `const draftBaseUrl = draftInfo ? \`/draft/${project.id}/?token=${encodeURIComponent(mintDraftToken(project.id))}\` : undefined;` and add both to the `workspaceProject` literal. In `app/ui-kit/workspace-jab/workspace-jab-demo.tsx`: add `draftBaseUrl?: string` to `WorkspaceProject` and pass it to `<WorkspacePreviewPane draftBaseUrl={project.draftBaseUrl} ...>`.

- [ ] **Step 5: Run suites + typecheck + commit**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/workspace-preview-state.test.ts lib/actions/workspace-preview.test.ts components/workspace-preview-pane.test.tsx` — Expected: ALL PASS.
Run: `pnpm --filter @jab/web exec tsc --noEmit` — Expected: clean.

```bash
git add apps/web/lib/jab/workspace-preview-state.ts apps/web/lib/jab/workspace-preview-state.test.ts apps/web/lib/jab/draft-preview-info.ts apps/web/lib/actions/workspace-preview.ts apps/web/lib/actions/workspace-preview.test.ts apps/web/components/workspace-preview-pane.tsx apps/web/components/workspace-preview-pane.test.tsx apps/web/app/ui-kit/workspace-jab/workspace-jab-demo.tsx "apps/web/app/(app)/projects/[id]/workspace/page.tsx"
git commit -m "feat(draft): preview pane renders the draft (badge, toggle, sandboxed iframe, version polling)"
```

---

### Task 8: undo / revert / discard server actions

**Files:**
- Create: `lib/actions/draft-history.ts`
- Test: `lib/actions/draft-history.test.ts`

- [ ] **Step 1: Write the failing test (guard logic with mocked deps)**

```typescript
// apps/web/lib/actions/draft-history.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreateClient, mockAdmin, mockRebuild, mockHasOpenEdit } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
  mockAdmin: vi.fn(),
  mockRebuild: vi.fn(),
  mockHasOpenEdit: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mockCreateClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mockAdmin }));
vi.mock("@/lib/jab/open-edits", () => ({ hasOpenWorkspaceEdit: mockHasOpenEdit }));
vi.mock("@/lib/draft/rebuild", () => ({ rebuildDraftArtifacts: mockRebuild }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { undoLastDraftStepAction, discardDraftAction } from "./draft-history";

beforeEach(() => {
  vi.clearAllMocks();
  mockHasOpenEdit.mockResolvedValue(false);
});

function rlsProjectOk() {
  mockCreateClient.mockResolvedValue({
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: "p1" }, error: null }) }) }) }),
  });
}

describe("undoLastDraftStepAction", () => {
  it("refuses while an edit is in flight (no concurrent rebundles)", async () => {
    rlsProjectOk();
    mockHasOpenEdit.mockResolvedValue(true);
    const result = await undoLastDraftStepAction("p1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("edit_in_flight");
    expect(mockRebuild).not.toHaveBeenCalled();
  });
});

describe("discardDraftAction", () => {
  it("refuses while an edit is in flight", async () => {
    rlsProjectOk();
    mockHasOpenEdit.mockResolvedValue(true);
    const result = await discardDraftAction("p1");
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @jab/web exec vitest run lib/actions/draft-history.test.ts` — Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the rebuild helper + actions**

```typescript
// apps/web/lib/draft/rebuild.ts
import "server-only";
import { loadDraftVersions, loadDraftSteps, bumpDraftVersion, type DraftRow } from "@/lib/db/drafts";
import { effectiveUnitVersions } from "@/lib/draft/state";
import { buildVersionedDraftArtifacts, defaultArtifactDeps } from "@/lib/draft/artifacts";

/**
 * Recompute artifacts from the CURRENT effective set (after an undo/revert
 * marked steps undone) and bump the version. No LLM — pure reassembly, ~1-2s
 * (spec §6.3). Synchronous inside the server action for instant undo feel.
 */
export async function rebuildDraftArtifacts(projectId: string, draft: DraftRow): Promise<number> {
  const [versions, steps] = await Promise.all([loadDraftVersions(draft.id), loadDraftSteps(draft.id)]);
  const effective = effectiveUnitVersions(versions, steps);
  const overrides = new Map<string, string>();
  for (const [key, row] of effective) overrides.set(key, row.tsx);
  await buildVersionedDraftArtifacts(
    { draftId: draft.id, nextVersion: draft.version + 1, baseBuildId: draft.base_build_id, overrides },
    defaultArtifactDeps(projectId),
  );
  return bumpDraftVersion(draft.id, draft.version);
}
```

```typescript
// apps/web/lib/actions/draft-history.ts
"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasOpenWorkspaceEdit } from "@/lib/jab/open-edits";
import { findLiveDraft } from "@/lib/db/drafts";
import { rebuildDraftArtifacts } from "@/lib/draft/rebuild";

export type DraftHistoryResult =
  | { ok: true; version?: number }
  | { ok: false; reason: "not_found" | "no_draft" | "edit_in_flight" | "draft_not_active" | "nothing_to_undo" };

/** RLS membership proof + shared guards. Returns the live draft or a refusal. */
async function guard(projectId: string) {
  const supabase = await createClient();
  const { data: project } = await supabase.from("projects").select("id").eq("id", projectId).single();
  if (!project) return { fail: { ok: false, reason: "not_found" } as const };
  if (await hasOpenWorkspaceEdit(supabase, projectId)) {
    return { fail: { ok: false, reason: "edit_in_flight" } as const };
  }
  const draft = await findLiveDraft(projectId);
  if (!draft) return { fail: { ok: false, reason: "no_draft" } as const };
  if (draft.status !== "active") return { fail: { ok: false, reason: "draft_not_active" } as const };
  return { draft };
}

export async function undoLastDraftStepAction(projectId: string): Promise<DraftHistoryResult> {
  const g = await guard(projectId);
  if ("fail" in g) return g.fail;
  const admin = createAdminClient();

  const { data: last } = await admin
    .from("workspace_edits")
    .select("id")
    .eq("draft_id", g.draft.id)
    .eq("status", "completed")
    .is("undone_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!last) return { ok: false, reason: "nothing_to_undo" };

  await admin.from("workspace_edits").update({ undone_at: new Date().toISOString() }).eq("id", last.id);
  const version = await rebuildDraftArtifacts(projectId, g.draft);
  revalidatePath(`/projects/${projectId}/workspace`);
  return { ok: true, version };
}

export async function revertDraftToStepAction(projectId: string, editId: string): Promise<DraftHistoryResult> {
  const g = await guard(projectId);
  if ("fail" in g) return g.fail;
  const admin = createAdminClient();

  const { data: anchor } = await admin
    .from("workspace_edits")
    .select("id, created_at")
    .eq("id", editId)
    .eq("draft_id", g.draft.id)
    .maybeSingle();
  if (!anchor) return { ok: false, reason: "not_found" };

  // Linear history: everything AFTER the anchor becomes undone.
  await admin
    .from("workspace_edits")
    .update({ undone_at: new Date().toISOString() })
    .eq("draft_id", g.draft.id)
    .eq("status", "completed")
    .is("undone_at", null)
    .gt("created_at", anchor.created_at);
  const version = await rebuildDraftArtifacts(projectId, g.draft);
  revalidatePath(`/projects/${projectId}/workspace`);
  return { ok: true, version };
}

export async function discardDraftAction(projectId: string): Promise<DraftHistoryResult> {
  const g = await guard(projectId);
  if ("fail" in g) return g.fail;
  const admin = createAdminClient();
  await admin
    .from("drafts")
    .update({ status: "discarded", updated_at: new Date().toISOString() })
    .eq("id", g.draft.id)
    .eq("status", "active");
  revalidatePath(`/projects/${projectId}/workspace`);
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify pass + typecheck + commit**

Run: `pnpm --filter @jab/web exec vitest run lib/actions/draft-history.test.ts` — Expected: PASS.
Run: `pnpm --filter @jab/web exec tsc --noEmit` — Expected: clean.

```bash
git add apps/web/lib/draft/rebuild.ts apps/web/lib/actions/draft-history.ts apps/web/lib/actions/draft-history.test.ts
git commit -m "feat(draft): undo / revert-to-step / discard actions with synchronous rebundle"
```

---

### Task 9: history UI — undo controls + undone styling + chat label

**Files:**
- Modify: `app/(app)/projects/[id]/workspace/page.tsx` (history rows: pass `undoneAt`, draft step labels)
- Create: `app/(app)/projects/[id]/workspace/DraftHistoryControls.tsx` (client component: Undo / Revert / Discard buttons calling the Task 8 actions)
- Modify: `app/(app)/projects/[id]/workspace/ChatPanel.tsx` (completed draft edits label "Applied to draft" — no build links)
- Modify: `loadWorkspaceEditHistory` (same page file or its module) to select `undone_at` + `draft_id`

No new unit tests (presentation glue; `tsc` + Task 11 live validation are the gates). Keep the JAB brand patterns (`docs/jab-brand.md`) — reuse the existing chip/button classes in the file, don't invent new visual styles.

- [ ] **Step 1:** Extend `loadWorkspaceEditHistory`'s select with `undone_at, draft_id` and its row type with `undoneAt: string | null; draftId: string | null`.
- [ ] **Step 2:** In the history `<li>`: when `edit.undoneAt` render the row with `opacity-50 line-through` on the prompt span and an "Undone" chip; when the edit is the LATEST active completed draft step render an "Undo" button, earlier active steps an "↩ Revert to here" button — both in `DraftHistoryControls` (a `"use client"` component taking `{ projectId, editId, kind }`, calling `undoLastDraftStepAction` / `revertDraftToStepAction` with a pending state, then `router.refresh()`). Add a "Discard draft" button in the panel header when ≥1 active step exists.
- [ ] **Step 3:** In `ChatPanel.tsx`, where completed edits currently render build links ("View progress → / Review →" keyed on `buildId`), branch: if the message's edit is a draft edit (no `buildId`), render the static label `Applied to draft ✓` instead. (Search `buildId` in the file for the link block.)
- [ ] **Step 4:** Run: `pnpm --filter @jab/web exec tsc --noEmit` — Expected: clean.
- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(app)/projects/[id]/workspace/"
git commit -m "feat(draft): history undo/revert/discard controls + undone styling + chat draft label"
```

---

### Task 10: full-suite gate

- [ ] **Step 1:** Run: `pnpm --filter @jab/web test` — Expected: ALL PASS (Phase 1 + 2 additions; edit-site worker tests removed/replaced).
- [ ] **Step 2:** Run: `pnpm --filter @jab/web exec tsc --noEmit` — Expected: clean.
- [ ] **Step 3:** Commit if fixes were needed: `git add -A apps/web && git commit -m "test(draft): full-suite green for phase 2 edit loop"`

---

### Task 11: live e2e (operator task — controlling session, NOT a subagent)

Pre-reqs: migration 0034 applied (Task 1 Step 3), `JAB_CHAT_EDIT=1` in `apps/web/.env.local`, Next dev + Inngest dev servers restarted, Two Roads project `075e33fd-8984-4e48-b58e-a9eab54d1828`.

- [ ] **Scenario 1 — first edit:** chat `make the hero headline smaller` → assistant reply ~3-5s → within ~15s the pane switches to the Draft badge and shows the change. Assert NO new `site_builds` row exists (`select count(*) from site_builds where project_id='...' and created_at > now() - interval '10 minutes'` → 0).
- [ ] **Scenario 2 — compounding edit:** chat `now make it dark blue` → the result keeps the smaller size AND adds the color (the patch-not-regen proof — this was today's iterative-edit bug).
- [ ] **Scenario 3 — undo:** Undo button on the latest step → preview reverts to the post-step-1 state in ~2-3s, history row shows Undone.
- [ ] **Scenario 4 — clarify:** chat `make it nicer` → clarifying reply, no draft step, version unchanged.
- [ ] **Scenario 5 — shell edit:** chat `add a phone number to the header` → header updates in the draft; `draft_unit_versions` row with `unit_key='shell:header'`.
- [ ] **Scenario 6 — discard:** Discard draft → pane returns to the deployed Vercel preview.
- [ ] **Record results** (build/draft ids, latencies, divergences) in CLAUDE.md snapshot + memory.

**Hard rule (carried from the chat-completion campaign):** do not edit source files while an edit is in flight — dev-server HMR mid-recompile kills Inngest invocations; that class is swept by `autoFailStaleOpenEdits` but don't create it deliberately.

---

## Self-review notes

- **Spec coverage (Phase-2 slice):** §5.1-5.3 → T1; §5.2 effective-state → T2; §6.2 worker steps → T6 (patch T3, commit ordering T4+T6, bundle gate via Phase 1 T5); §6.3 undo/revert/discard → T8 (+rebuild helper); §6.4 pane reaction → T7; §9 pane source rules → T7 (`applyDraftToPreviewState`); §10 failure rows → T6 `failEdit` + T8 guards; §5.4 artifacts → Phase 2 T5. Artifact retention (keep last N=5) deferred to Phase 3's cleanup task — noted there.
- **Type consistency:** `DraftRow`/`DraftVersionWithTsx` (T4) consumed by T6+T8 rebuild; `effectiveUnitVersions` generic over tsx-bearing rows (T2) matches both call sites; `unitKeyFor`/`exportNameFor`/`maxBytesFor` defined T6, used in T6 only; `DraftPreviewInfo` defined T7 state file, used by `draft-preview-info.ts` + action; pane signature `previewPaneStatusFor(state, hasOpenEdit, draftBaseUrl?)` consistent between test and impl.
- **In-tree verification points (intentional):** `GenerateOptions`/`GenerateUsage`/`PostprocessOptions` exact field names (T3), drizzle schema declaration style (T1), `ChatPanel` build-link block location (T9), Inngest step error-typing pattern (T6). Each task says in-tree wins.
