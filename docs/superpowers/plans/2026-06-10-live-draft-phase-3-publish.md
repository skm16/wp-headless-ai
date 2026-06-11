# Live Draft Phase 3 — Publish Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Publish draft" materializes the accumulated draft into ONE `site_builds` row and runs the existing compose → compile gate → deploy → verify → review → promote pipeline exactly once; the draft lifecycle closes (`published`) or recovers (`active`) accordingly.

**Architecture:** Spec [`docs/superpowers/specs/2026-06-10-live-draft-system-design.md`](../specs/2026-06-10-live-draft-system-design.md) §8 (+§5.4 cleanup, §9 publishing pane). New `draft_publish` BuildConfig variant; `materializeDraftToBuild` clones inventories (the one place cloning still happens — once per publish) and writes base + override component/shell files into the new build's Storage prefixes; compose reuses the materialized shell instead of regenerating; verify carry-forward treats `base_build_id` as the approval source with the steps' changed-slug union reset to pending.

**Tech Stack:** existing pipeline workers (compose/deploy/verify untouched except two seams), Supabase, Vitest.

**Branch:** `feat/saas-e2e-loop` (no worktree — parallel session shares this clone; commit early and often).

**Prerequisites:** Phase 1 + Phase 2 plans fully landed (drafts tables, draft-edit worker, draft pane). Migration 0034 applied to BOTH Supabase projects before live validation.

**Test commands:**
- Single file: `pnpm --filter @jab/web exec vitest run <path-from-apps/web>`
- Full suite: `pnpm --filter @jab/web test`
- Typecheck: `pnpm --filter @jab/web exec tsc --noEmit`

---

## Context for implementers (read once)

- All paths relative to `apps/web/`.
- `BuildConfig` (`lib/jab/build-config.ts:17-43`) is a union of `{ mode: "full" }` and the `mode: "edit"` shape; `isEditConfig` narrows it. `carryForwardSourceConfig(sourceConfig)` extracts `front_page_slug` + `last_sync_watermark`.
- Clone column constants live in `lib/inngest/functions/edit-site.helpers.ts`: `PAGE_INVENTORY_CLONE_COLUMNS` / `BLOCK_INVENTORY_CLONE_COLUMNS` (kept when edit-site was deleted in Phase 2). The retired edit-site worker's clone steps (read source rows → rebind `site_build_id` → bulk insert) are the pattern to re-create here; `applyCarryForwardApprovals({ resultBuildId, sourceBuildId, changedSlugs })` is exported from the same helpers file and already called by verify-fidelity for edit builds.
- Shell reuse seam (`compose-site.ts:660-715`): `shellEditGuidance(kind)` returns guidance only for edit configs; `shouldReuseShell({ skipEnabled, hasEditGuidance, artifactExists })` (`lib/ai/persist-shell-generation.ts`) gates reuse; `buildShellStoragePath(buildId, kind)` → `builds/<id>/project/components/site/Header|Footer.tsx`; `shellArtifactExists(buildId, kind)`.
- Publish path: `evaluatePublishGate` (`lib/jab/publish-gate.ts:31-72`) + `publishBuildAction` (`lib/actions/build-review.ts:104-225` — RLS load → gate → `vercel.requestPromote` → production deployments row → supersede sweep → edit-build audit stamp).
- Failure helper: `markBuildFailed` (shared by the four workers — find it via Grep, it sets `site_builds.status='failed'` + `failed_phase` + `error_text`).
- Component storage: `builds/<buildId>/components/<PascalName>.tsx` (`buildComponentStoragePath`), draft snapshots in `draft_unit_versions.tsx` keyed by `unit_key` (block name or `shell:header|footer`); `draftComponentName(blockName)` from `lib/draft/bundle.ts`.
- Draft helpers from Phase 2: `findLiveDraft`, `loadDraftVersions`, `loadDraftSteps` (`lib/db/drafts.ts`); `effectiveUnitVersions`, `unionChangedSlugs`, `activeSteps` (`lib/draft/state.ts`); `draftArtifactPath` (`lib/draft/artifacts.ts`); `hasOpenWorkspaceEdit` (`lib/jab/open-edits.ts`).
- Trigger entry: `triggerBuildAction` is the single user-facing full-build entry point (Phase 7 orchestration). Pane `building` state derives from `site_builds` status via `deriveWorkspacePreviewState`; `applyDraftToPreviewState` (Phase 2) already yields to non-`ready` base states, so a publishing build takes over the pane with zero extra work.

---

### Task 1: `draft_publish` BuildConfig variant

**Files:**
- Modify: `lib/jab/build-config.ts`
- Test: `lib/jab/build-config.test.ts` (extend; create if absent)

- [ ] **Step 1: Write the failing test**

```typescript
// append to apps/web/lib/jab/build-config.test.ts (create the file with this if absent)
import { describe, it, expect } from "vitest";
import { isDraftPublishConfig, isEditConfig } from "./build-config";

describe("isDraftPublishConfig", () => {
  const cfg = {
    mode: "draft_publish",
    draft_id: "dr1",
    base_build_id: "b1",
    changed_slugs: ["home"],
    change_reason: "component_pages",
    front_page_slug: "home",
  };

  it("narrows draft_publish configs", () => {
    expect(isDraftPublishConfig(cfg)).toBe(true);
    expect(isEditConfig(cfg)).toBe(false);
  });

  it("rejects other modes and junk", () => {
    expect(isDraftPublishConfig({ mode: "full" })).toBe(false);
    expect(isDraftPublishConfig({ mode: "edit" })).toBe(false);
    expect(isDraftPublishConfig(null)).toBe(false);
    expect(isDraftPublishConfig("draft_publish")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/build-config.test.ts` — Expected: FAIL (`isDraftPublishConfig` not exported).

- [ ] **Step 3: Implement**

In `lib/jab/build-config.ts`, extend the union with a third variant (after the `mode: "edit"` member):

```typescript
  | {
      mode: "draft_publish";
      /** The draft being published (drafts.id). */
      draft_id: string;
      /** Approval-carry-forward + inventory-clone source (drafts.base_build_id). */
      base_build_id: string;
      /** Union of changed_slugs over the draft's active steps (lib/draft/state.ts unionChangedSlugs). */
      changed_slugs: string[];
      change_reason: "component_pages" | "shell_all" | null;
      front_page_slug: string | null;
      last_sync_watermark?: string;
    }
```

And add the guard below `isEditConfig`:

```typescript
export function isDraftPublishConfig(
  config: unknown,
): config is Extract<BuildConfig, { mode: "draft_publish" }> {
  return (
    typeof config === "object" &&
    config !== null &&
    (config as { mode?: unknown }).mode === "draft_publish"
  );
}
```

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/build-config.test.ts` — Expected: PASS.
Run: `pnpm --filter @jab/web exec tsc --noEmit` — Expected: clean (any exhaustive switches over `config.mode` will surface here — extend them).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/build-config.ts apps/web/lib/jab/build-config.test.ts
git commit -m "feat(draft): draft_publish BuildConfig variant + guard"
```

---

### Task 2: `materializeDraftToBuild`

**Files:**
- Create: `lib/draft/materialize.ts`
- Test: `lib/draft/materialize.test.ts`

- [ ] **Step 1: Write the failing test (pure planning + orchestration with mocked IO)**

```typescript
// apps/web/lib/draft/materialize.test.ts
import { describe, it, expect, vi } from "vitest";
import { planComponentWrites, materializeDraftToBuild, type MaterializeDeps } from "./materialize";

describe("planComponentWrites", () => {
  it("plans base copies for untouched units and override writes for drafted ones", () => {
    const plan = planComponentWrites({
      baseComponentNames: ["AcfHero", "CoreHeading"],
      overrides: new Map([
        ["acf/hero", "export function AcfHero(){return <p>edited</p>;}"],
        ["shell:header", "export function Header(){return <header/>;}"],
      ]),
    });
    expect(plan.componentCopies).toEqual(["CoreHeading"]); // untouched → byte copy
    expect(plan.componentWrites).toEqual([{ name: "AcfHero", tsx: "export function AcfHero(){return <p>edited</p>;}" }]);
    expect(plan.shellWrites).toEqual([{ kind: "header", tsx: "export function Header(){return <header/>;}" }]);
    expect(plan.shellCopies).toEqual(["footer"]); // no footer override → copy base
  });
});

describe("materializeDraftToBuild", () => {
  function deps(over: Partial<MaterializeDeps> = {}): MaterializeDeps {
    return {
      cloneInventories: vi.fn(async () => {}),
      listBaseComponentNames: vi.fn(async () => ["AcfHero"]),
      copyStorageObject: vi.fn(async () => {}),
      writeStorageObject: vi.fn(async () => {}),
      ...over,
    };
  }

  it("clones inventories then copies/writes components and shell into the new build's prefixes", async () => {
    const d = deps();
    await materializeDraftToBuild(
      {
        newBuildId: "nb1",
        baseBuildId: "b1",
        overrides: new Map([["acf/hero", "export function AcfHero(){return <p>e</p>;}"]]),
      },
      d,
    );
    expect(d.cloneInventories).toHaveBeenCalledWith("b1", "nb1");
    expect(d.writeStorageObject).toHaveBeenCalledWith(
      "builds/nb1/components/AcfHero.tsx",
      "export function AcfHero(){return <p>e</p>;}",
    );
    // shell: no overrides → both copied from base project prefix
    expect(d.copyStorageObject).toHaveBeenCalledWith(
      "builds/b1/project/components/site/Header.tsx",
      "builds/nb1/project/components/site/Header.tsx",
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/materialize.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/web/lib/draft/materialize.ts
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import {
  PAGE_INVENTORY_CLONE_COLUMNS,
  BLOCK_INVENTORY_CLONE_COLUMNS,
} from "@/lib/inngest/functions/edit-site.helpers";
import { draftComponentName } from "./bundle";

/**
 * materialize — turns the draft's effective state into a REAL build's
 * artifact set (spec §8.3-8.4): clone base inventories (the ONE place
 * cloning still happens — once per publish, not per edit), copy untouched
 * base components byte-for-byte, write draft overrides, and place the shell
 * (override or base copy) where compose's reuse seam picks it up.
 */
export interface MaterializePlan {
  componentCopies: string[]; // PascalCase names copied from base
  componentWrites: Array<{ name: string; tsx: string }>;
  shellWrites: Array<{ kind: "header" | "footer"; tsx: string }>;
  shellCopies: Array<"header" | "footer">;
}

export function planComponentWrites(args: {
  baseComponentNames: string[];
  overrides: Map<string, string>;
}): MaterializePlan {
  const overriddenNames = new Map<string, string>(); // PascalName -> tsx
  const shellWrites: MaterializePlan["shellWrites"] = [];
  for (const [unitKey, tsx] of args.overrides) {
    if (unitKey === "shell:header") shellWrites.push({ kind: "header", tsx });
    else if (unitKey === "shell:footer") shellWrites.push({ kind: "footer", tsx });
    else overriddenNames.set(draftComponentName(unitKey), tsx);
  }
  const componentWrites = [...overriddenNames].map(([name, tsx]) => ({ name, tsx }));
  const componentCopies = args.baseComponentNames.filter((n) => !overriddenNames.has(n));
  const writtenKinds = new Set(shellWrites.map((s) => s.kind));
  const shellCopies = (["header", "footer"] as const).filter((k) => !writtenKinds.has(k));
  return { componentCopies, componentWrites, shellWrites, shellCopies };
}

export interface MaterializeDeps {
  cloneInventories(baseBuildId: string, newBuildId: string): Promise<void>;
  listBaseComponentNames(baseBuildId: string): Promise<string[]>;
  copyStorageObject(from: string, to: string): Promise<void>;
  writeStorageObject(path: string, contents: string): Promise<void>;
}

const shellFile = (kind: "header" | "footer") => (kind === "header" ? "Header.tsx" : "Footer.tsx");

export async function materializeDraftToBuild(
  args: { newBuildId: string; baseBuildId: string; overrides: Map<string, string> },
  deps: MaterializeDeps,
): Promise<void> {
  await deps.cloneInventories(args.baseBuildId, args.newBuildId);
  const baseNames = await deps.listBaseComponentNames(args.baseBuildId);
  const plan = planComponentWrites({ baseComponentNames: baseNames, overrides: args.overrides });

  for (const name of plan.componentCopies) {
    await deps.copyStorageObject(
      `builds/${args.baseBuildId}/components/${name}.tsx`,
      `builds/${args.newBuildId}/components/${name}.tsx`,
    );
  }
  for (const w of plan.componentWrites) {
    await deps.writeStorageObject(`builds/${args.newBuildId}/components/${w.name}.tsx`, w.tsx);
  }
  for (const kind of plan.shellCopies) {
    await deps.copyStorageObject(
      `builds/${args.baseBuildId}/project/components/site/${shellFile(kind)}`,
      `builds/${args.newBuildId}/project/components/site/${shellFile(kind)}`,
    );
  }
  for (const w of plan.shellWrites) {
    await deps.writeStorageObject(
      `builds/${args.newBuildId}/project/components/site/${shellFile(w.kind)}`,
      w.tsx,
    );
  }
}

/* ---------------- production deps ---------------- */

export function defaultMaterializeDeps(projectId: string, tenantId: string): MaterializeDeps {
  const admin = createAdminClient();
  const storage = () => admin.storage.from(SITE_SCREENSHOTS_BUCKET);

  return {
    async cloneInventories(baseBuildId, newBuildId) {
      // Mirror the retired edit-site clone steps: read source rows with the
      // shared column constants, rebind site_build_id, bulk insert.
      for (const [table, columns] of [
        ["block_inventory", BLOCK_INVENTORY_CLONE_COLUMNS],
        ["page_inventory", PAGE_INVENTORY_CLONE_COLUMNS],
      ] as const) {
        const { data, error } = await admin.from(table).select(columns).eq("site_build_id", baseBuildId);
        if (error) throw new Error(`materialize clone ${table} read failed: ${error.message}`);
        if (!data || data.length === 0) continue;
        const rows = (data as Array<Record<string, unknown>>).map((r) => ({
          ...r,
          site_build_id: newBuildId,
          project_id: projectId,
          tenant_id: tenantId,
        }));
        const { error: insErr } = await admin.from(table).insert(rows);
        if (insErr) throw new Error(`materialize clone ${table} insert failed: ${insErr.message}`);
      }
    },
    async listBaseComponentNames(baseBuildId) {
      const { data, error } = await storage().list(`builds/${baseBuildId}/components`);
      if (error) throw new Error(`materialize list components failed: ${error.message}`);
      return (data ?? [])
        .filter((f) => f.name.endsWith(".tsx"))
        .map((f) => f.name.replace(/\.tsx$/, ""));
    },
    async copyStorageObject(from, to) {
      const { error } = await storage().copy(from, to);
      if (error) throw new Error(`materialize copy ${from} -> ${to} failed: ${error.message}`);
    },
    async writeStorageObject(path, contents) {
      const { error } = await storage().upload(path, Buffer.from(contents, "utf-8"), {
        contentType: "text/plain",
        upsert: true,
      });
      if (error) throw new Error(`materialize write ${path} failed: ${error.message}`);
    },
  };
}
```

NOTE: confirm against the retired edit-site clone steps (git history `git show HEAD~N:apps/web/lib/inngest/functions/edit-site.ts`, or the helpers' schema-completeness test) whether the clone inserts also need `project_id`/`tenant_id` explicitly (they did in edit-site) and whether the select-string columns parse into row objects directly (Supabase returns them as object keys — yes). In-tree/git-history wins.

- [ ] **Step 4: Run to verify pass + commit**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/materialize.test.ts` — Expected: PASS.

```bash
git add apps/web/lib/draft/materialize.ts apps/web/lib/draft/materialize.test.ts
git commit -m "feat(draft): materializeDraftToBuild — inventory clone + base/override component+shell writes"
```

---

### Task 3: `publishDraftAction`

**Files:**
- Create: `lib/actions/publish-draft.ts`
- Test: `lib/actions/publish-draft.test.ts`

- [ ] **Step 1: Write the failing test (guards; pipeline IO mocked)**

```typescript
// apps/web/lib/actions/publish-draft.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreateClient, mockAdmin, mockFindLiveDraft, mockHasOpenEdit, mockMaterialize, mockSend } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
  mockAdmin: vi.fn(),
  mockFindLiveDraft: vi.fn(),
  mockHasOpenEdit: vi.fn(),
  mockMaterialize: vi.fn(),
  mockSend: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mockCreateClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mockAdmin }));
vi.mock("@/lib/db/drafts", () => ({ findLiveDraft: mockFindLiveDraft }));
vi.mock("@/lib/jab/open-edits", () => ({ hasOpenWorkspaceEdit: mockHasOpenEdit }));
vi.mock("@/lib/draft/materialize", () => ({
  materializeDraftToBuild: mockMaterialize,
  defaultMaterializeDeps: vi.fn(() => ({})),
}));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: mockSend } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { publishDraftAction } from "./publish-draft";

beforeEach(() => {
  vi.clearAllMocks();
  mockHasOpenEdit.mockResolvedValue(false);
  mockCreateClient.mockResolvedValue({
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: "p1", tenant_id: "t1" }, error: null }) }) }) }),
  });
});

describe("publishDraftAction guards", () => {
  it("refuses when no live draft exists", async () => {
    mockFindLiveDraft.mockResolvedValue(null);
    const r = await publishDraftAction("p1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_draft");
  });

  it("refuses while an edit is in flight", async () => {
    mockFindLiveDraft.mockResolvedValue({ id: "dr1", base_build_id: "b1", version: 2, status: "active" });
    mockHasOpenEdit.mockResolvedValue(true);
    const r = await publishDraftAction("p1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("edit_in_flight");
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it("refuses when the draft is already publishing", async () => {
    mockFindLiveDraft.mockResolvedValue({ id: "dr1", base_build_id: "b1", version: 2, status: "publishing" });
    const r = await publishDraftAction("p1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("draft_not_active");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @jab/web exec vitest run lib/actions/publish-draft.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/web/lib/actions/publish-draft.ts
"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { findLiveDraft, loadDraftVersions, loadDraftSteps } from "@/lib/db/drafts";
import { effectiveUnitVersions, unionChangedSlugs, activeSteps } from "@/lib/draft/state";
import { materializeDraftToBuild, defaultMaterializeDeps } from "@/lib/draft/materialize";
import { hasOpenWorkspaceEdit } from "@/lib/jab/open-edits";
import { carryForwardSourceConfig, type BuildConfig } from "@/lib/jab/build-config";

export type PublishDraftResult =
  | { ok: true; buildId: string }
  | { ok: false; reason: "not_found" | "no_draft" | "draft_not_active" | "no_steps" | "edit_in_flight" | "dispatch_failed" };

/**
 * publishDraftAction — spec §8. ONE build per publish: materialize the
 * draft's effective state into a new site_builds artifact set, then dispatch
 * the unchanged compose → tsc gate → deploy → verify → review → promote
 * chain. On any failure before dispatch succeeds, the draft returns to
 * 'active' (steps intact) and the build is failed loudly.
 */
export async function publishDraftAction(projectId: string): Promise<PublishDraftResult> {
  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("id, tenant_id")
    .eq("id", projectId)
    .single();
  if (!project) return { ok: false, reason: "not_found" };

  const draft = await findLiveDraft(projectId);
  if (!draft) return { ok: false, reason: "no_draft" };
  if (draft.status !== "active") return { ok: false, reason: "draft_not_active" };
  if (await hasOpenWorkspaceEdit(supabase, projectId)) return { ok: false, reason: "edit_in_flight" };

  const admin = createAdminClient();
  const [versions, steps] = await Promise.all([loadDraftVersions(draft.id), loadDraftSteps(draft.id)]);
  const live = activeSteps(steps);
  if (live.length === 0) return { ok: false, reason: "no_steps" };

  // Claim the draft (CAS on status) so concurrent publishes can't double-build.
  const { data: claimed } = await admin
    .from("drafts")
    .update({ status: "publishing", updated_at: new Date().toISOString() })
    .eq("id", draft.id)
    .eq("status", "active")
    .select("id");
  if (!claimed || claimed.length === 0) return { ok: false, reason: "draft_not_active" };

  const revertDraft = async () => {
    await admin.from("drafts").update({ status: "active" }).eq("id", draft.id).eq("status", "publishing");
  };

  try {
    // Carry the base build's front_page_slug/watermark like edit builds did.
    const { data: baseBuild } = await admin
      .from("site_builds")
      .select("config")
      .eq("id", draft.base_build_id)
      .single();
    const carried = carryForwardSourceConfig(baseBuild?.config ?? null);

    const changeReasons = new Set(live.map((s) => (s as { change_reason?: string | null }).change_reason ?? null));
    const config: Extract<BuildConfig, { mode: "draft_publish" }> = {
      mode: "draft_publish",
      draft_id: draft.id,
      base_build_id: draft.base_build_id,
      changed_slugs: unionChangedSlugs(steps),
      change_reason: changeReasons.has("shell_all") ? "shell_all" : changeReasons.has(null) ? null : "component_pages",
      front_page_slug: carried.front_page_slug,
      ...(carried.last_sync_watermark ? { last_sync_watermark: carried.last_sync_watermark } : {}),
    };

    const { data: build, error: buildErr } = await admin
      .from("site_builds")
      .insert({ project_id: projectId, tenant_id: project.tenant_id, status: "queued", config })
      .select("id")
      .single();
    if (buildErr || !build) throw new Error(`publish build insert failed: ${buildErr?.message ?? "no row"}`);

    const effective = effectiveUnitVersions(versions, steps);
    const overrides = new Map<string, string>();
    for (const [key, row] of effective) overrides.set(key, row.tsx);
    await materializeDraftToBuild(
      { newBuildId: build.id, baseBuildId: draft.base_build_id, overrides },
      defaultMaterializeDeps(projectId, project.tenant_id),
    );

    await inngest.send({
      name: "site/compose.requested",
      data: { projectId, tenantId: project.tenant_id, buildId: build.id },
    });

    revalidatePath(`/projects/${projectId}/workspace`);
    return { ok: true, buildId: build.id };
  } catch (err) {
    await revertDraft();
    console.error(`[publish-draft] ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, reason: "dispatch_failed" };
  }
}
```

NOTE: the `site_builds` insert may need additional NOT NULL columns — check the insert the retired edit-site used (`create-result-build`, git history) and mirror it. The `tenant_id` column existence on `site_builds`/inventories: verify in `drizzle/migrations/0014_saas_v2_schema.sql`; if inventories carry `project_id` only, drop `tenant_id` from the clone rebind in Task 2. In-tree wins.

- [ ] **Step 4: Run to verify pass + commit**

Run: `pnpm --filter @jab/web exec vitest run lib/actions/publish-draft.test.ts` — Expected: PASS.

```bash
git add apps/web/lib/actions/publish-draft.ts apps/web/lib/actions/publish-draft.test.ts
git commit -m "feat(draft): publishDraftAction — claim, materialize, one-build dispatch, revert on failure"
```

---

### Task 4: compose shell reuse + verify carry-forward for `draft_publish`

**Files:**
- Modify: `lib/inngest/functions/compose-site.ts` (shell reuse condition)
- Modify: `lib/inngest/functions/verify-fidelity.ts` (carry-forward condition)
- Test: extend `lib/ai/persist-shell-generation.test.ts` (or wherever `shouldReuseShell` is tested) — no new logic in `shouldReuseShell` itself, only its inputs change

- [ ] **Step 1: Compose seam**

In `compose-site.ts`, where `skipShellRegen` is computed (lines ~669):

```typescript
    // Draft publishes materialized the shell (override or base copy) into
    // this build's artifact path — regenerating would discard the user's
    // draft shell edits. Reuse is MANDATORY for draft_publish, env-gated
    // otherwise (JAB_SKIP_SHELL_REGEN).
    const draftPublish = isDraftPublishConfig(buildConfig);
    const skipShellRegen =
      draftPublish ||
      process.env.JAB_SKIP_SHELL_REGEN === "1" ||
      process.env.JAB_SKIP_SHELL_REGEN === "true";
```

(`isDraftPublishConfig` import joins the existing `isEditConfig` import from `@/lib/jab/build-config`.) `shellEditGuidance` already returns `undefined` for non-edit configs, so `hasEditGuidance` stays false and `shouldReuseShell` reuses the materialized artifact. Verify `shellArtifactExists` checks the SAME path materialize wrote (`builds/<id>/project/components/site/...`) — it does (`buildShellStoragePath`).

- [ ] **Step 2: Verify seam**

In `verify-fidelity.ts`, find the carry-forward call (step `carry-forward-approvals`, lines ~281-289) — it currently gates on the edit config and passes `config.source_build_id` + `config.changed_slugs`. Extend:

```typescript
      const cfg = buildConfig; // however the worker names its loaded config
      const carrySource = isEditConfig(cfg)
        ? { sourceBuildId: cfg.source_build_id, changedSlugs: cfg.changed_slugs }
        : isDraftPublishConfig(cfg)
          ? { sourceBuildId: cfg.base_build_id, changedSlugs: cfg.changed_slugs }
          : null;
      if (carrySource) {
        await applyCarryForwardApprovals({
          resultBuildId: buildId,
          sourceBuildId: carrySource.sourceBuildId,
          changedSlugs: carrySource.changedSlugs,
        });
      }
```

Match the worker's actual local naming/structure (open the file; the shape above is the contract: edit → `source_build_id`, draft_publish → `base_build_id`, both reset `changed_slugs` to pending and inherit the rest).

- [ ] **Step 3: Typecheck + targeted suites + commit**

Run: `pnpm --filter @jab/web exec tsc --noEmit` — Expected: clean.
Run: `pnpm --filter @jab/web test` — Expected: PASS (compose/verify suites cover the touched seams).

```bash
git add apps/web/lib/inngest/functions/compose-site.ts apps/web/lib/inngest/functions/verify-fidelity.ts
git commit -m "feat(draft): compose reuses materialized draft shell; verify carries approvals from base build"
```

---

### Task 5: lifecycle closure — published on promote, active on failure

**Files:**
- Modify: `lib/actions/build-review.ts` (`publishBuildAction` — after the supersede sweep)
- Modify: the shared `markBuildFailed` helper (Grep `markBuildFailed` — used by all four workers)
- Test: `lib/jab/draft-lifecycle.test.ts` (pure helper)

- [ ] **Step 1: Pure helper + failing test**

```typescript
// apps/web/lib/jab/draft-lifecycle.test.ts
import { describe, it, expect } from "vitest";
import { draftLifecycleTransition } from "./draft-lifecycle";

describe("draftLifecycleTransition", () => {
  it("promote of a draft_publish build -> published", () => {
    expect(
      draftLifecycleTransition({ mode: "draft_publish", draft_id: "dr1" }, "promoted"),
    ).toEqual({ draftId: "dr1", to: "published" });
  });

  it("failure of a draft_publish build -> back to active (steps intact)", () => {
    expect(
      draftLifecycleTransition({ mode: "draft_publish", draft_id: "dr1" }, "failed"),
    ).toEqual({ draftId: "dr1", to: "active" });
  });

  it("non-draft builds produce no transition", () => {
    expect(draftLifecycleTransition({ mode: "full" }, "failed")).toBeNull();
    expect(draftLifecycleTransition({ mode: "edit" }, "promoted")).toBeNull();
    expect(draftLifecycleTransition(null, "failed")).toBeNull();
  });
});
```

```typescript
// apps/web/lib/jab/draft-lifecycle.ts
import { isDraftPublishConfig } from "./build-config";

/**
 * Pure mapping from (build config, pipeline outcome) to the draft status
 * write the caller must perform (spec §8.6). Promote closes the draft;
 * failure reopens it with steps intact so the user can fix + retry.
 */
export function draftLifecycleTransition(
  config: unknown,
  outcome: "promoted" | "failed",
): { draftId: string; to: "published" | "active" } | null {
  if (!isDraftPublishConfig(config)) return null;
  return { draftId: config.draft_id, to: outcome === "promoted" ? "published" : "active" };
}
```

Run: `pnpm --filter @jab/web exec vitest run lib/jab/draft-lifecycle.test.ts` — Expected: PASS (3 tests) after implementing.

- [ ] **Step 2: Wire the two call sites**

(a) `publishBuildAction` (`lib/actions/build-review.ts`): after the production deployments row + supersede sweep (and alongside the existing edit-build audit stamp ~line 198), load the build's `config`, compute `draftLifecycleTransition(config, "promoted")`, and when non-null:

```typescript
  await admin
    .from("drafts")
    .update({ status: "published", updated_at: new Date().toISOString() })
    .eq("id", transition.draftId)
    .eq("status", "publishing");
```

(b) `markBuildFailed`: after writing the failed build row, compute `draftLifecycleTransition(config, "failed")` (the helper receives or can load the build's config — match its current signature; if it doesn't carry config, load it by buildId inside) and when non-null flip the draft back:

```typescript
  await admin
    .from("drafts")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", transition.draftId)
    .eq("status", "publishing");
```

- [ ] **Step 3: Typecheck + full suite + commit**

Run: `pnpm --filter @jab/web exec tsc --noEmit` && `pnpm --filter @jab/web test` — Expected: clean / PASS.

```bash
git add apps/web/lib/jab/draft-lifecycle.ts apps/web/lib/jab/draft-lifecycle.test.ts apps/web/lib/actions/build-review.ts apps/web/lib/db/*.ts apps/web/lib/inngest/functions/*.ts
git commit -m "feat(draft): draft lifecycle closes on promote, reopens on pipeline failure"
```

---

### Task 6: workspace publish button + staleness notice + trigger guard

**Files:**
- Modify: `app/(app)/projects/[id]/workspace/page.tsx` + `DraftHistoryControls.tsx` (Phase 2 Task 9 component — add Publish)
- Modify: `lib/actions/trigger-build.ts` (or wherever `triggerBuildAction` lives — Grep it)

- [ ] **Step 1: Publish button** — in the workspace edits panel header (next to Discard from Phase 2), when ≥1 active step exists and no build is active: a "Publish draft" button calling `publishDraftAction(projectId)`; on `ok` route to `/projects/${projectId}/builds/${buildId}/progress`; on refusal show the reason inline (reuse the panel's existing error styling).
- [ ] **Step 2: Staleness notice** — the workspace page already loads `draftInfo` (Phase 2 Task 7) and `loadProjectBuildState`. When `draftInfo` is active-with-steps and its draft's `base_build_id !== buildState.latestReadyBuild?.id`, render a notice above the history list: `"This draft is based on an older build. Publish it or discard it — newer builds won't include these edits until published."` (Add `base_build_id` to `loadDraftPreviewInfo`'s select + `DraftPreviewInfo` type.)
- [ ] **Step 3: Trigger guard** — in `triggerBuildAction`, before dispatch: if `findLiveDraft(projectId)` returns an active draft with ≥1 active step, do NOT block, but include `warning: "an active draft with unpublished edits exists — the new build will not include them"` in the success result, and surface it where the action's result is rendered.
- [ ] **Step 4:** Run: `pnpm --filter @jab/web exec tsc --noEmit` — Expected: clean. Commit:

```bash
git add "apps/web/app/(app)/projects/[id]/workspace/" apps/web/lib/actions/
git commit -m "feat(draft): publish button, base-staleness notice, trigger-build warning"
```

---

### Task 7: draft artifact retention

**Files:**
- Modify: `lib/draft/artifacts.ts` (+ call sites: draft-edit worker commit, rebuild helper, discard action)
- Test: `lib/draft/artifacts.test.ts` (extend)

- [ ] **Step 1: Failing test**

```typescript
import { pruneDraftArtifactVersions } from "./artifacts";

describe("pruneDraftArtifactVersions", () => {
  it("removes version folders older than the newest N (default 5)", async () => {
    const removed: string[] = [];
    await pruneDraftArtifactVersions(
      { draftId: "d1", currentVersion: 9, keep: 5 },
      { removePrefix: async (p) => { removed.push(p); } },
    );
    expect(removed).toEqual(["drafts/d1/v4", "drafts/d1/v3", "drafts/d1/v2", "drafts/d1/v1"]);
  });

  it("removes nothing when version <= keep", async () => {
    const removed: string[] = [];
    await pruneDraftArtifactVersions(
      { draftId: "d1", currentVersion: 3, keep: 5 },
      { removePrefix: async (p) => { removed.push(p); } },
    );
    expect(removed).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
export interface PruneDeps {
  removePrefix(prefix: string): Promise<void>;
}

/**
 * Bounded retention (spec §5.4): keep the newest `keep` versions during an
 * active draft. Version numbers are dense (every commit/undo bumps by 1),
 * so pruning is arithmetic — no listing needed. Fail-soft per prefix: a
 * missed prune never blocks a commit.
 */
export async function pruneDraftArtifactVersions(
  args: { draftId: string; currentVersion: number; keep?: number },
  deps: PruneDeps,
): Promise<void> {
  const keep = args.keep ?? 5;
  for (let v = args.currentVersion - keep; v >= 1; v--) {
    try {
      await deps.removePrefix(`drafts/${args.draftId}/v${v}`);
    } catch {
      // fail-soft: orphaned artifacts cost pennies; never block the commit
    }
  }
}
```

Production `removePrefix`: list the prefix via the Storage API and `remove()` the file paths (both files are known names — `bundle.js`, `draft.css` — so remove those two directly). Call sites: end of the draft-edit worker `commit` step and `rebuildDraftArtifacts` (with the new version), and on `discardDraftAction` remove ALL versions (loop 1..version) plus on `published` keep only the final version.

- [ ] **Step 3:** Run the artifacts suite + typecheck; commit:

```bash
git add apps/web/lib/draft/artifacts.ts apps/web/lib/draft/artifacts.test.ts apps/web/lib/inngest/functions/draft-edit.ts apps/web/lib/draft/rebuild.ts apps/web/lib/actions/draft-history.ts
git commit -m "feat(draft): bounded artifact retention (keep 5; full cleanup on discard)"
```

---

### Task 8: full-suite gate

- [ ] Run: `pnpm --filter @jab/web test` — Expected: ALL PASS.
- [ ] Run: `pnpm --filter @jab/web exec tsc --noEmit` — Expected: clean.
- [ ] Commit if fixes were needed: `git add -A apps/web && git commit -m "test(draft): full-suite green for phase 3 publish lane"`

---

### Task 9: live e2e publish (operator task — controlling session, NOT a subagent)

Pre-reqs: 0034 on BOTH Supabase projects, `JAB_CHAT_EDIT=1`, dev servers fresh, Two Roads project `075e33fd-8984-4e48-b58e-a9eab54d1828`, an active draft with 2-3 steps from the Phase 2 validation (or create one).

- [ ] **Publish:** click "Publish draft" → routed to build progress → ONE new `site_builds` row (`config.mode='draft_publish'`); draft status `publishing`; pane follows the build.
- [ ] **Pipeline:** compose log shows the shell REUSED (not regenerated); compile gate green; Vercel deploy ready; verify runs.
- [ ] **Review:** review screen shows exactly the changed-slug union pending; untouched pages carry approvals from the base build.
- [ ] **Promote:** approve changed pages → publish → production promote succeeds → draft status `published`; deployed site shows the accumulated edits; chat history intact.
- [ ] **Failure recovery (deliberate):** start another draft, make one edit, temporarily break the publish (e.g. revoke the Vercel token in env) → build fails loudly → draft returns to `active` with its step intact. Restore env.
- [ ] **Record:** update CLAUDE.md's current-state section + memory (Live Draft shipped; edit-site retired; per-edit Vercel/verify spend eliminated; residuals).

---

## Self-review notes

- **Spec coverage (Phase-3 slice):** §8.1-8.2 guards+claim → T3; §8.3-8.4 materialize+shell reuse → T2+T4; §8.5 unchanged pipeline + carry-forward → T4; §8.6 lifecycle → T5; §8 staleness + trigger guard → T6; §5.4 retention → T7; §9 publishing pane → no-op by design (`applyDraftToPreviewState` yields to non-ready states — noted in Context). Review/publish gate (`evaluatePublishGate`) deliberately untouched.
- **Type consistency:** `draft_publish` config fields (T1) match `publishDraftAction`'s literal (T3) and the two seam reads (T4) and `draftLifecycleTransition` (T5); `materializeDraftToBuild` args (T2) match T3's call; `unionChangedSlugs`/`activeSteps`/`effectiveUnitVersions` imported from Phase 2's `lib/draft/state.ts` with the same signatures.
- **In-tree verification points (intentional):** site_builds insert NOT NULL columns + inventory tenant/project rebind (T2/T3 — consult git history of edit-site's create-result-build/clone steps), `markBuildFailed` signature (T5), `triggerBuildAction` location/result shape (T6), verify worker's config local naming (T4). In-tree wins.
