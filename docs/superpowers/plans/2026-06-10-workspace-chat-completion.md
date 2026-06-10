# Workspace Chat Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workspace's AI surfaces real and visibly alive — real ChatPanel instead of demo theater, a feedback loop after every edit submit (polling + live refresh), readable failures, and self-healing stranded edits.

**Architecture:** Spec at [`docs/superpowers/specs/2026-06-10-workspace-chat-completion-design.md`](../specs/2026-06-10-workspace-chat-completion-design.md). Four tracks: (A) enable + de-mock the chat slot, (B) visible lifecycle via a `hasOpenEdit` poll signal + `router.refresh()` on meaningful transitions + a pure transcript-merge, (C) `autoFailStaleOpenEdits` sweep mirroring the existing build sweep, (D) live e2e validation. Builds on the left-rail campaign (`8a1db56`…`c6385aa`): `chatSurface`/`editsSurface` slots + `LeftColumn` already exist.

**Tech Stack:** Next.js 15 App Router (RSC + server actions), Supabase (RLS user client + service-role admin), Inngest, Vitest. App lives at `apps/web` (`@jab/web`). All paths below are relative to `apps/web/` unless prefixed with `docs/`.

**Branch:** `feat/saas-e2e-loop` (already checked out; do NOT create a worktree — a parallel session shares this clone, commit early and often).

**Test commands:**
- Single file: `pnpm --filter @jab/web exec vitest run <path-from-apps/web>`
- Full suite: `pnpm --filter @jab/web test`
- Typecheck: `pnpm --filter @jab/web exec tsc --noEmit`

---

## Context for implementers (read once)

- The workspace page `app/(app)/projects/[id]/workspace/page.tsx` is an RSC (`force-dynamic`) that mounts two real surfaces into the `WorkspaceJabDemo` shell (`app/ui-kit/workspace-jab/workspace-jab-demo.tsx`) via slot props. When `JAB_CHAT_EDIT !== "1"` the chat slot is `undefined` and the shell falls back to a **mock** `AIPanel` that fakes a streaming animation — this campaign removes that fallback for real projects.
- `workspace_edits` rows: `status` ∈ `queued | running | completed | failed | discarded`. **`completed` means "dispatched"**, not done — UI labels derive from the linked build via `deriveEditUiState` (`lib/jab/workspace-edit-state.ts`).
- The preview pane (`components/workspace-preview-pane.tsx`) polls `loadWorkspacePreviewStateAction` every 5 s, but **only while its state is `building`**. An edit's result build is created asynchronously by the `edit-site` worker, so right after submit the derived state is still `ready` → no polling → the UI never notices the edit. That's the central bug.
- `lib/db/auto-fail-stale-build.ts` is the sweep pattern to mirror (compare-and-set, returns `healed > 0`). Its test `lib/db/auto-fail-stale-build.test.ts` is the mock pattern to mirror.
- Do not break the pinned ordering in `lib/actions/workspace-chat.test.ts` (flag → length → membership → budget → persist).

---

### Task 1: `open-edits` helper — `OPEN_EDIT_STATUSES` + `hasOpenWorkspaceEdit`

**Files:**
- Create: `lib/jab/open-edits.ts`
- Test: `lib/jab/open-edits.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/jab/open-edits.test.ts
import { describe, it, expect, vi } from "vitest";
import { OPEN_EDIT_STATUSES, hasOpenWorkspaceEdit } from "./open-edits";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Chainable fake: .from("workspace_edits").select(..., {count,head}).eq(...).in(...) */
function fakeClient(result: { count: number | null; error: { message: string } | null }) {
  const inFn = vi.fn().mockResolvedValue(result);
  const eqFn = vi.fn(() => ({ in: inFn }));
  const selectFn = vi.fn(() => ({ eq: eqFn }));
  const fromFn = vi.fn(() => ({ select: selectFn }));
  return { client: { from: fromFn } as unknown as SupabaseClient, fromFn, selectFn, eqFn, inFn };
}

describe("OPEN_EDIT_STATUSES", () => {
  it("is exactly queued + running ('completed' means dispatched — the linked build covers it)", () => {
    expect([...OPEN_EDIT_STATUSES]).toEqual(["queued", "running"]);
  });
});

describe("hasOpenWorkspaceEdit", () => {
  it("returns true when at least one open edit exists", async () => {
    const { client, fromFn, selectFn, eqFn, inFn } = fakeClient({ count: 2, error: null });
    await expect(hasOpenWorkspaceEdit(client, "proj-1")).resolves.toBe(true);
    expect(fromFn).toHaveBeenCalledWith("workspace_edits");
    // head-count query — no row payload crosses the wire on a 5s poll
    expect(selectFn).toHaveBeenCalledWith("id", { count: "exact", head: true });
    expect(eqFn).toHaveBeenCalledWith("project_id", "proj-1");
    expect(inFn).toHaveBeenCalledWith("status", ["queued", "running"]);
  });

  it("returns false when count is 0", async () => {
    const { client } = fakeClient({ count: 0, error: null });
    await expect(hasOpenWorkspaceEdit(client, "proj-1")).resolves.toBe(false);
  });

  it("returns false when count is null", async () => {
    const { client } = fakeClient({ count: null, error: null });
    await expect(hasOpenWorkspaceEdit(client, "proj-1")).resolves.toBe(false);
  });

  it("fails soft (false) on a query error — polling just stops early, never throws to the pane", async () => {
    const { client } = fakeClient({ count: null, error: { message: "boom" } });
    await expect(hasOpenWorkspaceEdit(client, "proj-1")).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/open-edits.test.ts`
Expected: FAIL — `Cannot find module './open-edits'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

```typescript
// apps/web/lib/jab/open-edits.ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * open-edits — shared vocabulary + cheap existence probe for in-flight
 * workspace edits.
 *
 * "Open" = the edit row itself is still moving (queued/running). A
 * status='completed' edit is NOT open — completed means "dispatched to the
 * pipeline"; from that point the LINKED build's active status is the signal
 * (ProjectBuildState.hasActiveBuild covers it). Keeping 'completed' out of
 * this set avoids polling forever on edits whose builds already finished.
 */
export const OPEN_EDIT_STATUSES = ["queued", "running"] as const;
export type OpenEditStatus = (typeof OPEN_EDIT_STATUSES)[number];

/**
 * Head-count probe used by the preview-pane poll (5s cadence) and the
 * workspace page render. RLS applies when called with the user client —
 * unauthorized callers see 0 rows, which reads as "nothing open".
 * Fails soft on query errors: a transient read failure must degrade to
 * "stop polling early", never throw into the pane.
 */
export async function hasOpenWorkspaceEdit(
  client: SupabaseClient,
  projectId: string,
): Promise<boolean> {
  const { count, error } = await client
    .from("workspace_edits")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .in("status", [...OPEN_EDIT_STATUSES]);
  if (error) {
    console.warn(`[open-edits] count failed for project ${projectId}: ${error.message}`);
    return false;
  }
  return (count ?? 0) > 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/open-edits.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/open-edits.ts apps/web/lib/jab/open-edits.test.ts
git commit -m "feat(workspace): open-edits helper — OPEN_EDIT_STATUSES + hasOpenWorkspaceEdit probe"
```

---

### Task 2: `loadWorkspacePreviewStateAction` returns `hasOpenEdit`

**Files:**
- Modify: `lib/actions/workspace-preview.ts`
- Test: `lib/actions/workspace-preview.test.ts`

- [ ] **Step 1: Add the failing tests**

In `lib/actions/workspace-preview.test.ts`, add a mock for the new module. In the `vi.hoisted` block (currently destructures `{ mockSingle, mockCreateClient, mockLoadProjectBuildState, mockAssertReachable }`), add `mockHasOpenEdit`:

```typescript
const { mockSingle, mockCreateClient, mockLoadProjectBuildState, mockAssertReachable, mockHasOpenEdit } =
  vi.hoisted(() => {
    const mockSingle = vi.fn();
    const mockCreateClient = vi.fn(async () => ({
      from: () => ({
        select: () => ({ eq: () => ({ single: mockSingle }) }),
      }),
    }));
    const mockLoadProjectBuildState = vi.fn();
    const mockAssertReachable = vi.fn();
    const mockHasOpenEdit = vi.fn();
    return { mockSingle, mockCreateClient, mockLoadProjectBuildState, mockAssertReachable, mockHasOpenEdit };
  });
```

After the existing `vi.mock("@/lib/vercel/preview-protection", ...)` block, add:

```typescript
vi.mock("@/lib/jab/open-edits", () => ({
  hasOpenWorkspaceEdit: mockHasOpenEdit,
}));
```

In `beforeEach`, after `mockAssertReachable.mockResolvedValue(undefined);` add:

```typescript
  mockHasOpenEdit.mockResolvedValue(false);
```

Append these tests inside the existing `describe("loadWorkspacePreviewStateAction", ...)`:

```typescript
  it("returns hasOpenEdit=false by default", async () => {
    mockSingle.mockResolvedValue({ data: { id: "proj_1" }, error: null });
    mockLoadProjectBuildState.mockResolvedValue(readyBuildState());
    const result = await loadWorkspacePreviewStateAction("proj_1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hasOpenEdit).toBe(false);
  });

  it("returns hasOpenEdit=true when an open workspace edit exists", async () => {
    mockSingle.mockResolvedValue({ data: { id: "proj_1" }, error: null });
    mockLoadProjectBuildState.mockResolvedValue(readyBuildState());
    mockHasOpenEdit.mockResolvedValue(true);
    const result = await loadWorkspacePreviewStateAction("proj_1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hasOpenEdit).toBe(true);
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm --filter @jab/web exec vitest run lib/actions/workspace-preview.test.ts`
Expected: the two new tests FAIL (`hasOpenEdit` is `undefined`); the four existing tests still pass.

- [ ] **Step 3: Implement**

In `lib/actions/workspace-preview.ts`:

Add the import (after the `preview-protection` import):

```typescript
import { hasOpenWorkspaceEdit } from "@/lib/jab/open-edits";
```

Change the result type:

```typescript
export type LoadWorkspacePreviewStateResult =
  | { ok: false; reason: "not_found" }
  | {
      ok: true;
      state: WorkspacePreviewState;
      protected: boolean;
      /**
       * True while any workspace_edits row for the project is queued/running.
       * The pane keeps polling on this even when state is 'ready' — it covers
       * the window between edit dispatch and the worker creating the result
       * build (during which the derived state is still 'ready').
       */
      hasOpenEdit: boolean;
    };
```

In the action body, after `const state = deriveWorkspacePreviewState(buildState);` add:

```typescript
  const hasOpenEdit = await hasOpenWorkspaceEdit(supabase, projectId);
```

Change the final return to:

```typescript
  return { ok: true, state, protected: isProtected, hasOpenEdit };
```

- [ ] **Step 4: Run the test file to verify all pass**

Run: `pnpm --filter @jab/web exec vitest run lib/actions/workspace-preview.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/actions/workspace-preview.ts apps/web/lib/actions/workspace-preview.test.ts
git commit -m "feat(workspace): preview-state poll action reports hasOpenEdit"
```

---

### Task 3: pure pane logic — `previewPaneStatusFor(state, hasOpenEdit)` + `isMeaningfulTransition`

**Files:**
- Modify: `components/workspace-preview-pane.tsx` (pure exported functions only in this task)
- Test: `components/workspace-preview-pane.test.tsx`

- [ ] **Step 1: Update/extend the tests**

In `components/workspace-preview-pane.test.tsx`, REPLACE the test `"only the 'building' kind should drive polling"` with:

```typescript
  it("polls while building, regardless of hasOpenEdit", () => {
    expect(previewPaneStatusFor({ kind: "building", buildId: "b", phase: "x" }, false).shouldPoll).toBe(true);
    expect(previewPaneStatusFor({ kind: "building", buildId: "b", phase: "x" }, true).shouldPoll).toBe(true);
  });

  it("polls on ready+hasOpenEdit — the dispatch→result-build window", () => {
    const ready: WorkspacePreviewState = { kind: "ready", url: "u", buildId: "b", deploymentId: "d" };
    expect(previewPaneStatusFor(ready, true).shouldPoll).toBe(true);
    expect(previewPaneStatusFor(ready, false).shouldPoll).toBe(false);
  });

  it("never polls on none/failed (no edit can be open without a ready build)", () => {
    expect(previewPaneStatusFor({ kind: "none" }, true).shouldPoll).toBe(false);
    expect(previewPaneStatusFor({ kind: "none" }, false).shouldPoll).toBe(false);
    expect(previewPaneStatusFor({ kind: "failed", buildId: "b", failedPhase: "x" }, true).shouldPoll).toBe(false);
    expect(previewPaneStatusFor({ kind: "failed", buildId: "b", failedPhase: "x" }, false).shouldPoll).toBe(false);
  });
```

The four existing mapping tests (`'ready' -> 'live'` etc.) call `previewPaneStatusFor(s)` with one arg — leave them as-is; the new param defaults to `false`.

Add a new describe block at the end of the file:

```typescript
describe("isMeaningfulTransition", () => {
  const ready = (url: string): WorkspacePreviewState => ({
    kind: "ready", url, buildId: "b1", deploymentId: "d1",
  });
  const building = (phase: string): WorkspacePreviewState => ({
    kind: "building", buildId: "b2", phase,
  });

  it("kind change is meaningful", () => {
    expect(isMeaningfulTransition(ready("u"), building("Queued"), false, false)).toBe(true);
  });

  it("building phase change is meaningful", () => {
    expect(isMeaningfulTransition(building("Queued"), building("Composing the site"), false, false)).toBe(true);
  });

  it("ready url change is meaningful (edit build's preview superseded the old one)", () => {
    expect(isMeaningfulTransition(ready("https://old"), ready("https://new"), false, false)).toBe(true);
  });

  it("hasOpenEdit flip is meaningful in both directions", () => {
    expect(isMeaningfulTransition(ready("u"), ready("u"), false, true)).toBe(true);
    expect(isMeaningfulTransition(ready("u"), ready("u"), true, false)).toBe(true);
  });

  it("identical state + flag is not meaningful", () => {
    expect(isMeaningfulTransition(ready("u"), ready("u"), false, false)).toBe(false);
    expect(isMeaningfulTransition(building("Queued"), building("Queued"), true, true)).toBe(false);
  });
});
```

Add `isMeaningfulTransition` to the import at the top:

```typescript
import { previewPaneStatusFor, isMeaningfulTransition } from "./workspace-preview-pane";
```

- [ ] **Step 2: Run to verify failures**

Run: `pnpm --filter @jab/web exec vitest run components/workspace-preview-pane.test.tsx`
Expected: FAIL — `isMeaningfulTransition` is not exported; the `ready+hasOpenEdit` poll test fails (`shouldPoll` is `false`).

- [ ] **Step 3: Implement the pure functions**

In `components/workspace-preview-pane.tsx`, replace `previewPaneStatusFor` (currently lines 46–59) with:

```typescript
/** Pure mapping from preview state -> PreviewFrame props. Unit-tested. */
export function previewPaneStatusFor(
  state: WorkspacePreviewState,
  hasOpenEdit = false,
): PaneStatus {
  switch (state.kind) {
    case "ready":
      // ready+open-edit covers the dispatch→result-build window: the edit's
      // build doesn't exist yet, so the derived state is still 'ready', but
      // we must keep polling to catch the flip to 'building'.
      return { status: "live", src: state.url, shouldPoll: hasOpenEdit };
    case "building":
      return { status: "deploying", shouldPoll: true };
    case "failed":
      return { status: "failed", shouldPoll: false };
    case "none":
    default:
      return { status: "idle", shouldPoll: false };
  }
}

/**
 * True when a polled result differs from the previous one in a way the
 * server-rendered surfaces care about (history chips, chat links). The pane
 * calls router.refresh() on these so the RSC re-renders — this is the
 * workspace's live-refresh mechanism (spec Track B3).
 */
export function isMeaningfulTransition(
  prev: WorkspacePreviewState,
  next: WorkspacePreviewState,
  prevHasOpenEdit: boolean,
  nextHasOpenEdit: boolean,
): boolean {
  if (prev.kind !== next.kind) return true;
  if (prev.kind === "building" && next.kind === "building" && prev.phase !== next.phase) return true;
  if (prev.kind === "ready" && next.kind === "ready" && prev.url !== next.url) return true;
  return prevHasOpenEdit !== nextHasOpenEdit;
}
```

- [ ] **Step 4: Run the test file to verify all pass**

Run: `pnpm --filter @jab/web exec vitest run components/workspace-preview-pane.test.tsx`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/workspace-preview-pane.tsx apps/web/components/workspace-preview-pane.test.tsx
git commit -m "feat(workspace): pane polls on ready+open-edit; pure isMeaningfulTransition"
```

---

### Task 4: wire the pane — poll loop, `router.refresh()`, prop threading

**Files:**
- Modify: `components/workspace-preview-pane.tsx` (component body)
- Modify: `app/ui-kit/workspace-jab/workspace-jab-demo.tsx` (`WorkspaceProject` type + real `PreviewPane` branch)
- Modify: `app/(app)/projects/[id]/workspace/page.tsx` (derive + pass `hasOpenEdit`)

No new unit tests in this task (the pure logic was tested in Task 3; the component glue is exercised live in Task 13). `tsc` is the gate.

- [ ] **Step 1: Rework the `WorkspacePreviewPane` component**

In `components/workspace-preview-pane.tsx`:

Add to imports:

```typescript
import { useRouter } from "next/navigation";
```

Add to `WorkspacePreviewPaneProps` (after `initialProtected`):

```typescript
  /** Server-rendered "an edit is queued/running" flag — drives ready-state polling. */
  initialHasOpenEdit?: boolean;
```

Replace the component's state + poll section (currently: the `useState` pair, `inFlight` ref, and the `poll` callback) with:

```typescript
export function WorkspacePreviewPane({
  projectId,
  initialState,
  initialProtected = false,
  initialHasOpenEdit = false,
  displayDomain,
}: WorkspacePreviewPaneProps) {
  const router = useRouter();
  const [state, setState] = useState<WorkspacePreviewState>(initialState);
  const [isProtected, setIsProtected] = useState(initialProtected);
  const [hasOpenEdit, setHasOpenEdit] = useState(initialHasOpenEdit);
  const inFlight = useRef(false);
  // Refs mirror the latest polled values so the poll callback can diff
  // without depending on state (which would re-create the interval).
  const stateRef = useRef(initialState);
  const openEditRef = useRef(initialHasOpenEdit);

  // Prop sync is OR-only: a revalidated RSC render that says "an edit is
  // open" must wake a non-polling pane (the post-submit case). It must NOT
  // force false — a concurrent revalidate computed from a slightly older
  // read could stop an active poll loop with no refresh pending to restart
  // it. Polls drive the flag back to false.
  useEffect(() => {
    if (initialHasOpenEdit) {
      setHasOpenEdit(true);
      openEditRef.current = true;
    }
  }, [initialHasOpenEdit]);

  const poll = useCallback(async () => {
    if (inFlight.current) return; // guard overlapping calls
    inFlight.current = true;
    try {
      const result: LoadWorkspacePreviewStateResult =
        await loadWorkspacePreviewStateAction(projectId);
      if (result.ok) {
        const transitioned = isMeaningfulTransition(
          stateRef.current,
          result.state,
          openEditRef.current,
          result.hasOpenEdit,
        );
        stateRef.current = result.state;
        openEditRef.current = result.hasOpenEdit;
        setState(result.state);
        setIsProtected(result.protected);
        setHasOpenEdit(result.hasOpenEdit);
        // Refresh the RSC so the edits history, chips, and chat transcript
        // re-render from fresh data (Track B3 — workspace live-refresh).
        if (transitioned) router.refresh();
      } else {
        // Project gone (not_found) — stop polling by going terminal. This drops
        // shouldPoll to false, so the effect cleanup clears the interval.
        stateRef.current = { kind: "none" };
        openEditRef.current = false;
        setState({ kind: "none" });
        setHasOpenEdit(false);
      }
    } catch {
      // Swallow transient poll errors — the next tick retries. Never blank
      // the pane on a single failed poll.
    } finally {
      inFlight.current = false;
    }
  }, [projectId, router]);

  const mapped = previewPaneStatusFor(state, hasOpenEdit);
```

The rest of the component (the `useEffect` interval keyed on `mapped.shouldPoll`, `caption`, and the JSX) stays unchanged.

- [ ] **Step 2: Thread the prop through the shell**

In `app/ui-kit/workspace-jab/workspace-jab-demo.tsx`:

(a) Find the exported `WorkspaceProject` interface (search `export interface WorkspaceProject` — it carries `previewState` and `previewProtected`) and add after `previewProtected`:

```typescript
  /** True when a workspace edit is queued/running at render time. */
  hasOpenEdit?: boolean;
```

(b) In the real-project branch of `PreviewPane` (search `<WorkspacePreviewPane` — around line 1400), add the prop:

```tsx
        <WorkspacePreviewPane
          projectId={project.id}
          initialState={project.previewState ?? { kind: "none" }}
          initialProtected={project.previewProtected ?? false}
          initialHasOpenEdit={project.hasOpenEdit ?? false}
          displayDomain={project.displayDomain}
        />
```

- [ ] **Step 3: Derive the flag in the page**

In `app/(app)/projects/[id]/workspace/page.tsx`:

Add the import (with the other `@/lib/jab/` imports):

```typescript
import { OPEN_EDIT_STATUSES } from "@/lib/jab/open-edits";
```

After `const editHistory = await loadWorkspaceEditHistory(project.id, 10);` add:

```typescript
  // An open edit at render time wakes the preview pane's poll loop even
  // though the derived preview state is still 'ready' (the edit's result
  // build doesn't exist yet). Derived from the already-loaded history —
  // no extra query.
  const hasOpenEdit = editHistory.some((e) =>
    (OPEN_EDIT_STATUSES as readonly string[]).includes(e.status),
  );
```

And in the `workspaceProject` literal, add after `previewProtected,`:

```typescript
    hasOpenEdit,
```

- [ ] **Step 4: Typecheck + run the adjacent suites**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean.

Run: `pnpm --filter @jab/web exec vitest run components/workspace-preview-pane.test.tsx lib/actions/workspace-preview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/workspace-preview-pane.tsx apps/web/app/ui-kit/workspace-jab/workspace-jab-demo.tsx "apps/web/app/(app)/projects/[id]/workspace/page.tsx"
git commit -m "feat(workspace): pane polls during open edits + router.refresh on transitions"
```

---

### Task 5: `revalidatePath` after manual edit dispatch

**Files:**
- Modify: `lib/actions/workspace-edit.ts`

The chat path (`workspace-chat.ts:201,214`) and discard (`discard-edit.ts:109`) already revalidate; the manual form path doesn't — so a submitted edit produces zero visible change. No new unit test: `workspace-edit.test.ts` deliberately covers only the pure `validateEditInput` (the action itself has no mock harness), and the chat tests already mock `next/cache`. The behavior is asserted live in Task 13 (history row appears without reload).

- [ ] **Step 1: Implement**

In `lib/actions/workspace-edit.ts`:

Add the import (top of file, after the `"use server";` directive's import block begins):

```typescript
import { revalidatePath } from "next/cache";
```

At the end of `requestWorkspaceEditAction`, immediately before `return { editId: inserted.id };`, add:

```typescript
  // The manual form path had no revalidate (chat + discard already do this) —
  // without it the new history row and the pane's open-edit flag are invisible
  // until a manual reload.
  revalidatePath(`/projects/${input.projectId}/workspace`);
```

- [ ] **Step 2: Typecheck + run the chat suite (it calls this action under mocks)**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean.

Run: `pnpm --filter @jab/web exec vitest run lib/actions/workspace-chat.test.ts lib/actions/workspace-edit.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/actions/workspace-edit.ts
git commit -m "fix(workspace): revalidate workspace after manual edit dispatch"
```

---

### Task 6: `mergeChatMessages` + ChatPanel transcript re-sync

**Files:**
- Create: `lib/jab/chat-message-merge.ts`
- Test: `lib/jab/chat-message-merge.test.ts`
- Modify: `app/(app)/projects/[id]/workspace/ChatPanel.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/jab/chat-message-merge.test.ts
import { describe, it, expect } from "vitest";
import { mergeChatMessages } from "./chat-message-merge";
import type { ChatMessageView } from "@/lib/actions/workspace-chat";

function msg(over: Partial<ChatMessageView>): ChatMessageView {
  return {
    id: "m1",
    role: "user",
    content: "hello",
    needsClarification: false,
    editId: null,
    buildId: null,
    createdAt: "2026-06-10T12:00:00.000Z",
    ...over,
  };
}

describe("mergeChatMessages", () => {
  it("server rows win over local copies with the same id (worker backfilled buildId)", () => {
    const local = [msg({ id: "a1", role: "assistant", content: "On it.", buildId: null })];
    const server = [msg({ id: "a1", role: "assistant", content: "On it.", editId: "e1", buildId: "b1" })];
    const merged = mergeChatMessages(server, local);
    expect(merged).toHaveLength(1);
    expect(merged[0].buildId).toBe("b1");
  });

  it("keeps an optimistic user message the server hasn't persisted yet", () => {
    const local = [msg({ id: "optimistic-1", content: "make it teal", createdAt: "2026-06-10T12:00:02.000Z" })];
    const server = [msg({ id: "u0", content: "earlier turn", createdAt: "2026-06-10T12:00:00.000Z" })];
    const merged = mergeChatMessages(server, local);
    expect(merged.map((m) => m.id)).toEqual(["u0", "optimistic-1"]);
  });

  it("drops an optimistic user message once a server row with the same content exists", () => {
    const local = [msg({ id: "optimistic-1", content: "make it teal" })];
    const server = [msg({ id: "u1", content: "make it teal" })];
    const merged = mergeChatMessages(server, local);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("u1");
  });

  it("keeps local err- notices (they exist only client-side)", () => {
    const local = [
      msg({ id: "err-1", role: "assistant", content: "Something went wrong sending that. Please try again.", needsClarification: true, createdAt: "2026-06-10T12:00:05.000Z" }),
    ];
    const server = [msg({ id: "u1", createdAt: "2026-06-10T12:00:00.000Z" })];
    const merged = mergeChatMessages(server, local);
    expect(merged.map((m) => m.id)).toEqual(["u1", "err-1"]);
  });

  it("orders the result by createdAt ascending", () => {
    const server = [
      msg({ id: "u2", createdAt: "2026-06-10T12:00:10.000Z" }),
      msg({ id: "u1", createdAt: "2026-06-10T12:00:00.000Z" }),
    ];
    const merged = mergeChatMessages(server, []);
    expect(merged.map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  it("is idempotent — merging the same inputs twice yields the same result", () => {
    const local = [msg({ id: "optimistic-1", content: "x", createdAt: "2026-06-10T12:00:02.000Z" })];
    const server = [msg({ id: "u1", content: "y", createdAt: "2026-06-10T12:00:00.000Z" })];
    const once = mergeChatMessages(server, local);
    const twice = mergeChatMessages(server, once);
    expect(twice).toEqual(once);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/chat-message-merge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/web/lib/jab/chat-message-merge.ts
import type { ChatMessageView } from "@/lib/actions/workspace-chat";

/**
 * chat-message-merge — pure reconciliation between the server transcript
 * (fresh initialMessages after a router.refresh) and ChatPanel's client
 * state (which may hold optimistic/in-flight entries).
 *
 * Rules:
 *  - Server rows are authoritative: a local copy of a server id is dropped
 *    in favor of the server version (which may carry a backfilled buildId
 *    or error-patched content).
 *  - `optimistic-*` user rows survive until a server row with the same
 *    role+content exists (the persisted twin), then yield to it.
 *  - `err-*` assistant notices are client-only; they always survive.
 *  - Output sorted by createdAt ascending (ties keep server-first order).
 */
const LOCAL_ID_PREFIXES = ["optimistic-", "err-"] as const;

function isLocalOnlyId(id: string): boolean {
  return LOCAL_ID_PREFIXES.some((p) => id.startsWith(p));
}

export function mergeChatMessages(
  server: ChatMessageView[],
  local: ChatMessageView[],
): ChatMessageView[] {
  const keptLocal = local.filter((m) => {
    if (!isLocalOnlyId(m.id)) return false; // server version wins
    if (m.id.startsWith("optimistic-")) {
      return !server.some((s) => s.role === "user" && s.content === m.content);
    }
    return true; // err- notice
  });
  return [...server, ...keptLocal].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/chat-message-merge.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire it into ChatPanel**

In `app/(app)/projects/[id]/workspace/ChatPanel.tsx`:

Add the import:

```typescript
import { mergeChatMessages } from "@/lib/jab/chat-message-merge";
```

After the `const [messages, setMessages] = useState<ChatMessageView[]>(initialMessages);` line, add:

```typescript
  // Re-sync when the server transcript changes (router.refresh from the
  // preview pane's poll, or a revalidate). useState ignores prop updates —
  // without this the backfilled buildId (progress/review links) never
  // appears without a manual reload.
  useEffect(() => {
    setMessages((prev) => mergeChatMessages(initialMessages, prev));
  }, [initialMessages]);
```

(`useEffect` is already imported in this file.)

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean.

```bash
git add apps/web/lib/jab/chat-message-merge.ts apps/web/lib/jab/chat-message-merge.test.ts "apps/web/app/(app)/projects/[id]/workspace/ChatPanel.tsx"
git commit -m "feat(workspace): chat transcript re-syncs on refresh via pure mergeChatMessages"
```

---

### Task 7: ChatPanel fills `LeftColumn` (un-clip the composer)

**Files:**
- Modify: `app/(app)/projects/[id]/workspace/ChatPanel.tsx`

ChatPanel self-sizes at `w-[380px]` but is mounted inside the shell's `LeftColumn` (`w-[322px]`, `overflow-hidden`) — the right ~58 px, including part of the Send button, is clipped. `LeftColumn` owns width + border; the panel should fill it. ChatPanel's sole consumer is the workspace page slot (verified), so this is safe.

- [ ] **Step 1: Implement**

In `ChatPanel.tsx`, change the root `<section>` className from:

```tsx
    <section className="flex w-[380px] shrink-0 flex-col border-r border-bord bg-bg motion-reduce:transition-none">
```

to:

```tsx
    <section className="flex h-full w-full flex-col bg-bg motion-reduce:transition-none">
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean.

```bash
git add "apps/web/app/(app)/projects/[id]/workspace/ChatPanel.tsx"
git commit -m "fix(workspace): ChatPanel fills LeftColumn (was clipped at 322px)"
```

---

### Task 8: real projects never see the mock — `ChatDisabledNotice`

**Files:**
- Modify: `app/ui-kit/workspace-jab/workspace-jab-demo.tsx`

- [ ] **Step 1: Implement the branch**

In `workspace-jab-demo.tsx`, find the chat-mode slot render (search `surface === "chat"` — currently):

```tsx
            {surface === "chat" &&
              (chatSurface ? (
                <LeftColumn>{chatSurface}</LeftColumn>
              ) : (
                <AIPanel
                  isStreaming={isStreaming}
                  setIsStreaming={setIsStreaming}
                />
              ))}
```

Replace with:

```tsx
            {surface === "chat" &&
              (chatSurface ? (
                <LeftColumn>{chatSurface}</LeftColumn>
              ) : project ? (
                // Real project, chat flag off: never show the demo theater
                // on a real workspace (it swallows input and fakes streaming).
                <LeftColumn>
                  <ChatDisabledNotice />
                </LeftColumn>
              ) : (
                <AIPanel
                  isStreaming={isStreaming}
                  setIsStreaming={setIsStreaming}
                />
              ))}
```

(`project` is already in scope in `WorkspaceJabDemo`.)

- [ ] **Step 2: Add the notice component**

Next to the `LeftColumn` helper (search `function LeftColumn`), add:

```tsx
/**
 * Rendered in the chat slot for REAL projects when JAB_CHAT_EDIT is off.
 * The mock AIPanel is demo-route-only — on a real workspace it reads as a
 * working chat and silently swallows input.
 */
function ChatDisabledNotice() {
  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="border-b border-bord px-4 py-3 text-sm font-bold text-wht">
        Chat
      </div>
      <div className="flex flex-1 items-center justify-center px-6">
        <p className="text-center text-[13px] leading-relaxed text-gry">
          Chat is disabled on this deployment. Set{" "}
          <code className="rounded bg-elev px-1 py-0.5 font-mono text-[11px] text-teal">
            JAB_CHAT_EDIT=1
          </code>{" "}
          and restart to enable AI edits.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean.

```bash
git add apps/web/app/ui-kit/workspace-jab/workspace-jab-demo.tsx
git commit -m "feat(workspace): chat-disabled notice replaces mock AIPanel on real projects"
```

---

### Task 9: render `error_text` on failed history rows

**Files:**
- Modify: `app/(app)/projects/[id]/workspace/page.tsx`

`loadWorkspaceEditHistory` already returns `errorText`; the row UI never shows it — a failed edit is a bare red chip.

- [ ] **Step 1: Implement**

In `page.tsx`'s `WorkspaceEditsPanel`, inside the history `<li>`, directly after the prompt line:

```tsx
                  <span className="truncate text-gry">{edit.prompt}</span>
```

add:

```tsx
                  {ui.label === "Failed" && edit.errorText && (
                    <span
                      className="truncate font-mono text-[11px] text-red/80"
                      title={edit.errorText}
                    >
                      {edit.errorText}
                    </span>
                  )}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean.

```bash
git add "apps/web/app/(app)/projects/[id]/workspace/page.tsx"
git commit -m "feat(workspace): failed edit rows show error_text"
```

---

### Task 10: `autoFailStaleOpenEdits` sweep

**Files:**
- Create: `lib/db/auto-fail-stale-open-edits.ts`
- Test: `lib/db/auto-fail-stale-open-edits.test.ts`

Mirrors `lib/db/auto-fail-stale-build.ts` (read → filter stale → CAS update each). Thresholds: `queued` > 10 min (dispatch pickup is sub-second when healthy — today's stranded edit sat at queued after the worker invoke died pre-step), `running` > 45 min (same ceiling as builds; clone+regen is minutes).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/db/auto-fail-stale-open-edits.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

import {
  autoFailStaleOpenEdits,
  isStaleOpenEdit,
  STALE_QUEUED_EDIT_MINUTES,
  STALE_RUNNING_EDIT_MINUTES,
} from "./auto-fail-stale-open-edits";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isStaleOpenEdit", () => {
  it("queued: stale after 10 minutes, fresh before", () => {
    expect(isStaleOpenEdit("queued", ago(11), Date.now())).toBe(true);
    expect(isStaleOpenEdit("queued", ago(9), Date.now())).toBe(false);
  });

  it("running: stale after 45 minutes, fresh at 20 (between the two thresholds)", () => {
    expect(isStaleOpenEdit("running", ago(46), Date.now())).toBe(true);
    expect(isStaleOpenEdit("running", ago(20), Date.now())).toBe(false);
  });

  it("non-open statuses and unparseable timestamps are never stale", () => {
    expect(isStaleOpenEdit("completed", ago(120), Date.now())).toBe(false);
    expect(isStaleOpenEdit("failed", ago(120), Date.now())).toBe(false);
    expect(isStaleOpenEdit("queued", "not-a-date", Date.now())).toBe(false);
    expect(isStaleOpenEdit("queued", null, Date.now())).toBe(false);
  });
});

// Read chain:   from("workspace_edits").select(...).eq(...).in(...)
// Update chain: from("workspace_edits").update(...).eq(id).eq(status).select("id")
function wireRead(rows: Array<Record<string, unknown>>) {
  const inFn = vi.fn().mockResolvedValue({ data: rows, error: null });
  const eqForRead = vi.fn(() => ({ in: inFn }));
  const selectForRead = vi.fn(() => ({ eq: eqForRead }));
  return { selectForRead, inFn };
}

describe("autoFailStaleOpenEdits", () => {
  it("returns false and never updates when nothing is open", async () => {
    const { selectForRead } = wireRead([]);
    const updateFn = vi.fn();
    mockFrom.mockReturnValue({ select: selectForRead, update: updateFn });
    await expect(autoFailStaleOpenEdits("proj-1")).resolves.toBe(false);
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("fails a stale queued edit with CAS filters and an explanatory error_text", async () => {
    const { selectForRead } = wireRead([
      { id: "edit-stale", status: "queued", created_at: ago(STALE_QUEUED_EDIT_MINUTES * 2) },
    ]);
    const selectAfterUpdate = vi.fn().mockResolvedValue({ data: [{ id: "edit-stale" }], error: null });
    const eqStatus = vi.fn(() => ({ select: selectAfterUpdate }));
    const eqId = vi.fn(() => ({ eq: eqStatus }));
    const updateFn = vi.fn(() => ({ eq: eqId }));
    mockFrom.mockReturnValue({ select: selectForRead, update: updateFn });

    await expect(autoFailStaleOpenEdits("proj-2")).resolves.toBe(true);
    expect(eqId).toHaveBeenCalledWith("id", "edit-stale");
    expect(eqStatus).toHaveBeenCalledWith("status", "queued");
    const payload = (updateFn.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(payload.status).toBe("failed");
    expect(String(payload.error_text)).toContain(`${STALE_QUEUED_EDIT_MINUTES} minutes`);
    expect(typeof payload.finished_at).toBe("string");
  });

  it("leaves a 20-minute running edit alone (under the running threshold)", async () => {
    const { selectForRead } = wireRead([
      { id: "edit-running", status: "running", created_at: ago(20) },
    ]);
    const updateFn = vi.fn();
    mockFrom.mockReturnValue({ select: selectForRead, update: updateFn });
    await expect(autoFailStaleOpenEdits("proj-3")).resolves.toBe(false);
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("returns false when the CAS update matches 0 rows (edit progressed mid-sweep)", async () => {
    const { selectForRead } = wireRead([
      { id: "edit-race", status: "queued", created_at: ago(STALE_QUEUED_EDIT_MINUTES * 2) },
    ]);
    const selectAfterUpdate = vi.fn().mockResolvedValue({ data: [], error: null });
    const eqStatus = vi.fn(() => ({ select: selectAfterUpdate }));
    const eqId = vi.fn(() => ({ eq: eqStatus }));
    const updateFn = vi.fn(() => ({ eq: eqId }));
    mockFrom.mockReturnValue({ select: selectForRead, update: updateFn });
    await expect(autoFailStaleOpenEdits("proj-4")).resolves.toBe(false);
  });

  it("uses STALE_RUNNING_EDIT_MINUTES in the error_text for stale running edits", async () => {
    const { selectForRead } = wireRead([
      { id: "edit-run-stale", status: "running", created_at: ago(STALE_RUNNING_EDIT_MINUTES * 2) },
    ]);
    const selectAfterUpdate = vi.fn().mockResolvedValue({ data: [{ id: "edit-run-stale" }], error: null });
    const eqStatus = vi.fn(() => ({ select: selectAfterUpdate }));
    const eqId = vi.fn(() => ({ eq: eqStatus }));
    const updateFn = vi.fn(() => ({ eq: eqId }));
    mockFrom.mockReturnValue({ select: selectForRead, update: updateFn });

    await expect(autoFailStaleOpenEdits("proj-5")).resolves.toBe(true);
    const payload = (updateFn.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(String(payload.error_text)).toContain(`${STALE_RUNNING_EDIT_MINUTES} minutes`);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/db/auto-fail-stale-open-edits.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/web/lib/db/auto-fail-stale-open-edits.ts
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { OPEN_EDIT_STATUSES, type OpenEditStatus } from "@/lib/jab/open-edits";

/**
 * Sweeps stranded workspace_edits rows — the edit analogue of
 * autoFailStaleActiveBuild (lib/db/auto-fail-stale-build.ts).
 *
 * Why this exists: edit-site runs with retries:0. A transport-level failure
 * on the worker invoke (e.g. the Next dev server answering mid-HMR-recompile
 * with an HTML error page — the 2026-06-10 stranded edit) kills the run
 * before ANY step executes, so the worker's own failure handling never
 * writes status='failed'. The row wedges at 'queued' ("Submitting…")
 * forever and nothing in the UI explains why.
 *
 * Thresholds: a healthy dispatch is picked up in well under a second, so
 * 10 minutes at 'queued' is conclusive. 'running' gets the same 45-minute
 * ceiling as builds (clone + regen takes minutes, not tens of minutes).
 */
export const STALE_QUEUED_EDIT_MINUTES = 10;
export const STALE_RUNNING_EDIT_MINUTES = 45;

const STALE_MS: Record<OpenEditStatus, number> = {
  queued: STALE_QUEUED_EDIT_MINUTES * 60 * 1000,
  running: STALE_RUNNING_EDIT_MINUTES * 60 * 1000,
};

export function isStaleOpenEdit(
  status: string | null | undefined,
  createdAt: string | null | undefined,
  nowMs: number,
): boolean {
  if (!status || !(OPEN_EDIT_STATUSES as readonly string[]).includes(status) || !createdAt) {
    return false;
  }
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return false;
  return nowMs - created > STALE_MS[status as OpenEditStatus];
}

export async function autoFailStaleOpenEdits(projectId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error: readErr } = await admin
    .from("workspace_edits")
    .select("id, status, created_at")
    .eq("project_id", projectId)
    .in("status", [...OPEN_EDIT_STATUSES]);
  if (readErr) {
    console.error(`[auto-fail-stale-edits] read failed for project ${projectId}: ${readErr.message}`);
    return false;
  }
  const now = Date.now();
  const stale = (data ?? []).filter((e) =>
    isStaleOpenEdit(
      (e as { status: string }).status,
      (e as { created_at: string }).created_at,
      now,
    ),
  ) as Array<{ id: string; status: OpenEditStatus; created_at: string }>;
  if (stale.length === 0) return false;

  let healed = 0;
  for (const e of stale) {
    const minutes =
      e.status === "queued" ? STALE_QUEUED_EDIT_MINUTES : STALE_RUNNING_EDIT_MINUTES;
    const { data: updated, error } = await admin
      .from("workspace_edits")
      .update({
        status: "failed",
        error_text: `auto-failed: '${e.status}' for over ${minutes} minutes (worker lost, crashed, or the dispatch died before any step ran)`,
        finished_at: new Date().toISOString(),
      })
      .eq("id", e.id)
      .eq("status", e.status) // compare-and-set: never clobber a row that just progressed
      .select("id");
    if (error) {
      console.error(`[auto-fail-stale-edits] update failed for ${e.id}: ${error.message}`);
    } else if ((updated ?? []).length > 0) {
      healed++;
    }
  }
  return healed > 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/db/auto-fail-stale-open-edits.test.ts`
Expected: PASS (8 tests).

Note: `lib/jab/open-edits.ts` carries `import "server-only"` — the existing vitest config already handles that for `auto-fail-stale-build.ts`; no config change expected.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/db/auto-fail-stale-open-edits.ts apps/web/lib/db/auto-fail-stale-open-edits.test.ts
git commit -m "feat(workspace): autoFailStaleOpenEdits sweep (queued>10m, running>45m, CAS)"
```

---

### Task 11: sweep call sites — entry guard + page load

**Files:**
- Modify: `lib/actions/workspace-edit.ts`
- Modify: `app/(app)/projects/[id]/workspace/page.tsx`

- [ ] **Step 1: Entry-guard call**

In `lib/actions/workspace-edit.ts`:

Add the import (next to the `auto-fail-stale-build` import):

```typescript
import { autoFailStaleOpenEdits } from "@/lib/db/auto-fail-stale-open-edits";
```

Directly after the existing line:

```typescript
  // Self-heal a wedged active build before the guard refuses on it.
  await autoFailStaleActiveBuild(input.projectId);
```

add:

```typescript
  // Same for stranded edits — a wedged 'queued'/'running' edit must flip to
  // a visible Failed before the new request evaluates concurrency.
  await autoFailStaleOpenEdits(input.projectId);
```

- [ ] **Step 2: Page-load call**

In `app/(app)/projects/[id]/workspace/page.tsx`:

Add the import:

```typescript
import { autoFailStaleOpenEdits } from "@/lib/db/auto-fail-stale-open-edits";
```

Directly before `const editHistory = await loadWorkspaceEditHistory(project.id, 10);` add:

```typescript
  // Flip stranded edits to a visible Failed chip before loading history —
  // authorization was proven by the RLS project SELECT above (the sweep
  // itself uses the admin client).
  await autoFailStaleOpenEdits(project.id);
```

- [ ] **Step 3: Typecheck + adjacent suites**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean.

Run: `pnpm --filter @jab/web exec vitest run lib/actions/workspace-chat.test.ts lib/db/auto-fail-stale-open-edits.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/actions/workspace-edit.ts "apps/web/app/(app)/projects/[id]/workspace/page.tsx"
git commit -m "feat(workspace): stale-edit sweep runs at edit entry + workspace page load"
```

---

### Task 12: full suite + typecheck gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full web suite**

Run: `pnpm --filter @jab/web test`
Expected: ALL PASS (879+ pre-campaign tests plus ~21 new ones). If anything fails, fix forward in the task that introduced it before proceeding.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit (only if fixes were needed)**

```bash
git add -A apps/web
git commit -m "test(workspace): full-suite green for chat completion campaign"
```

---

### Task 13: live e2e validation (operator task — run from the controlling session, NOT a subagent)

**Files:**
- Modify: `apps/web/.env.local` (NOT committed — gitignored)

- [ ] **Step 1: Enable the flag + restart dev servers**

Add to `apps/web/.env.local`:

```
JAB_CHAT_EDIT=1
```

Stop the running Next dev server and Inngest dev server, then restart both (the Next server must restart to pick up the env var; the long-running one also predates this campaign's code):

```powershell
# Terminal 1
npx inngest-cli@latest dev
# Terminal 2
pnpm --filter @jab/web dev
```

- [ ] **Step 2: Visual sanity (flag off → notice; flag on → real chat)**

Briefly start the dev server WITHOUT the flag once (or trust the code review) to confirm the workspace chat slot shows the "Chat is disabled" notice, not the mock. With the flag on, confirm the chat slot renders the real ChatPanel filling the full 322px column with no clipped composer, and `/ui-kit/workspace-jab` still shows the mock `AIPanel`.

- [ ] **Step 3: Runbook scenarios against Two Roads**

Project `075e33fd-8984-4e48-b58e-a9eab54d1828`, workspace at `http://localhost:3000/projects/075e33fd-8984-4e48-b58e-a9eab54d1828/workspace`. Follow `docs/superpowers/specs/2026-06-04-saas-e2e-loop-manual-smoke-runbook.md` scenarios 1–4, additionally asserting the NEW behavior:

1. Chat: `make the hero bolder` → actionable reply; **without reloading**: preview pane flips to "deploying" within ~10 s (two poll ticks), edit history row appears, phase caption advances, and when ready the chat bubble grows "View progress → / Review →" links.
2. Review → approve changed pages → publish (existing flow).
3. Chat: `add a phone number to the header` → shell edit; Header.tsx byte-diff per runbook.
4. Chat: `make it nicer` → clarifying reply, no build, pane stays "live".
5. Manual Targeted-edits form submit → history row appears without reload (Task 5's revalidate) and the pane starts polling (open-edit flag).

**Hard rule:** do not edit any source file while an edit build is in flight (HMR mid-recompile killed edit `854127ba` — that's the class Task 10 sweeps, but don't recreate it deliberately).

- [ ] **Step 4: Smoke script**

```powershell
$env:JAB_CHAT_EDIT = "1"
pnpm --filter @jab/web exec tsx lib/inngest/functions/edit-site.smoke.ts 075e33fd-8984-4e48-b58e-a9eab54d1828
```

Expected: SMOKE PASS (actionable component edit → ready; shell edit changes Header.tsx; vague prompt clarifies with no build).

- [ ] **Step 5: Record results**

Update the campaign section in `CLAUDE.md` / memory with the validated state (what ran, build ids, residuals).

---

## Self-review notes

- **Spec coverage:** A1→T13.1, A2→T8, A3→T7, B1→T5, B2→T1+T2+T3+T4, B3→T3+T4, B4→T6, B5→T9, C1→T10, C2→T11, C3→no-op by design (documented in spec), D→T13. No gaps.
- **Type consistency:** `OPEN_EDIT_STATUSES`/`OpenEditStatus` (T1) consumed in T4, T10, T11; `hasOpenEdit` flows action (T2) → pure fn (T3) → component+page (T4); `mergeChatMessages(server, local)` signature consistent between T6 test and implementation; `isMeaningfulTransition(prev, next, prevOpen, nextOpen)` consistent between T3 test and T4 usage.
- **Known parallel-session caution:** another session may be active in this clone. Each task commits immediately; if `git status` shows unexpected foreign changes at task start, commit only your own files (explicit paths above) and continue.
