# Workspace Left-Rail Mode Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the workspace "Targeted edits" surface out of the full-width banner into the left utility column, make the far-left icon rail a real mode switcher (AI chat | Targeted edits | collapsed), and default the bottom code panel hidden so the live preview fills the available height and (when the column is collapsed) full width.

**Architecture:** A small pure module (`left-column-mode.ts`) encodes the rail's click→mode transitions so they're unit-testable without rendering the timer-driven `"use client"` shell. The shell (`workspace-jab-demo.tsx`) holds a single `leftMode` state that the rail icons drive and the left-column slot reads; the slot renders one of two `ReactNode` props (`chatSurface` / `editsSurface`) or nothing. The server page (`page.tsx`) stops stacking banners and instead threads the edits + chat surfaces into the shell as props (server-children-through-a-client-component). `WorkspaceEditsPanel` is restyled from a wide banner into a vertical column stack.

**Tech Stack:** Next.js 15 App Router, React 19 (`"use client"` shell + server components), TypeScript, Tailwind, Vitest (`node` environment — tests target pure exported helpers, never rendered DOM, matching the existing `workspace-preview-pane.test.tsx` / `chat-card-model.test.ts` convention).

**Spec:** [`docs/superpowers/specs/2026-06-10-workspace-left-rail-mode-switcher-design.md`](../specs/2026-06-10-workspace-left-rail-mode-switcher-design.md)

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `apps/web/app/ui-kit/workspace-jab/left-column-mode.ts` | Pure model: `LeftColumnMode` type, `nextLeftColumnMode(current, clicked)` transition fn, `leftColumnSurface(mode)` selector. No React, no imports. | **Create** |
| `apps/web/app/ui-kit/workspace-jab/left-column-mode.test.ts` | Unit tests for the model (all 6 transitions + selector). | **Create** |
| `apps/web/app/ui-kit/workspace-jab/workspace-jab-demo.tsx` | Client shell: holds `leftMode`, wires `IconNav` as mode switcher, renders the left-column slot, accepts `editsSurface` / `chatSurface` props, defaults `codeOpen` closed. | **Modify** |
| `apps/web/app/(app)/projects/[id]/workspace/page.tsx` | Server page: stop rendering banners; pass `WorkspaceEditsPanel` + `ChatPanel` as surface props; restyle `WorkspaceEditsPanel` for the narrow column. | **Modify** |

No new dependencies. No DB/migration/server-action/loader changes.

---

### Task 1: Left-column mode model (pure)

**Files:**
- Create: `apps/web/app/ui-kit/workspace-jab/left-column-mode.ts`
- Test: `apps/web/app/ui-kit/workspace-jab/left-column-mode.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/ui-kit/workspace-jab/left-column-mode.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  nextLeftColumnMode,
  leftColumnSurface,
  type LeftColumnMode,
} from "./left-column-mode";

describe("nextLeftColumnMode", () => {
  it("collapses when clicking the already-active mode", () => {
    expect(nextLeftColumnMode("ai", "ai")).toBe("collapsed");
    expect(nextLeftColumnMode("edits", "edits")).toBe("collapsed");
  });

  it("opens into the clicked mode when collapsed", () => {
    expect(nextLeftColumnMode("collapsed", "ai")).toBe("ai");
    expect(nextLeftColumnMode("collapsed", "edits")).toBe("edits");
  });

  it("switches surface (stays open) when clicking the other mode", () => {
    expect(nextLeftColumnMode("ai", "edits")).toBe("edits");
    expect(nextLeftColumnMode("edits", "ai")).toBe("ai");
  });
});

describe("leftColumnSurface", () => {
  it("maps each mode to which surface the slot renders", () => {
    expect(leftColumnSurface("ai")).toBe("chat");
    expect(leftColumnSurface("edits")).toBe("edits");
    expect(leftColumnSurface("collapsed")).toBe("none");
  });

  it("is exhaustive over LeftColumnMode", () => {
    const modes: LeftColumnMode[] = ["ai", "edits", "collapsed"];
    for (const m of modes) {
      expect(["chat", "edits", "none"]).toContain(leftColumnSurface(m));
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @jab/web test left-column-mode`
Expected: FAIL — cannot find module `./left-column-mode` (file not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/app/ui-kit/workspace-jab/left-column-mode.ts`:

```ts
/**
 * Pure model for the workspace left-column mode switcher (spec
 * 2026-06-10-workspace-left-rail-mode-switcher). Kept React-free so the rail
 * interaction is unit-testable without rendering the timer-driven "use client"
 * shell — same convention as chat-card-model.ts / previewPaneStatusFor.
 */
export type LeftColumnMode = "ai" | "edits" | "collapsed";

/** Which rail mode-icon was clicked. "collapsed" is never clicked directly. */
export type LeftColumnModeIcon = "ai" | "edits";

/**
 * Rail click semantics: clicking the active mode's icon collapses the column;
 * clicking a different mode's icon switches to (and opens) that mode.
 */
export function nextLeftColumnMode(
  current: LeftColumnMode,
  clicked: LeftColumnModeIcon,
): LeftColumnMode {
  return current === clicked ? "collapsed" : clicked;
}

/** Which surface the left-column slot should render for a given mode. */
export function leftColumnSurface(
  mode: LeftColumnMode,
): "chat" | "edits" | "none" {
  switch (mode) {
    case "ai":
      return "chat";
    case "edits":
      return "edits";
    case "collapsed":
      return "none";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @jab/web test left-column-mode`
Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/ui-kit/workspace-jab/left-column-mode.ts" "apps/web/app/ui-kit/workspace-jab/left-column-mode.test.ts"
git commit -m "feat(workspace): pure left-column mode model (ai|edits|collapsed)"
```

---

### Task 2: Wire IconNav as the mode switcher

**Files:**
- Modify: `apps/web/app/ui-kit/workspace-jab/workspace-jab-demo.tsx` (the `IconNav` component, ~lines 156–232)

This task makes the rail's AI + Edits icons functional and driven by props. The shell state itself is added in Task 3; here `IconNav` just takes `mode` + `onSelectMode` and renders/active-highlights from them.

- [ ] **Step 1: Replace the `IconNav` component**

Find the existing `IconNav` function (starts `function IconNav() {`, around line 158) and replace the whole function with:

```tsx
function IconNav({
  mode,
  onSelectMode,
}: {
  mode: LeftColumnMode;
  onSelectMode: (icon: "ai" | "edits") => void;
}) {
  // Decorative icons (no onClick) stay inert per spec — only AI + Edits are
  // wired. `active` is now derived from `mode`, not hardcoded.
  type Item =
    | { kind: "decorative"; d: string; tip: string }
    | { kind: "mode"; icon: "ai" | "edits"; d: string; tip: string };
  const items: Item[] = [
    {
      kind: "decorative",
      d: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
      tip: "Dashboard",
    },
    { kind: "decorative", d: "circle", tip: "Sites" },
    { kind: "decorative", d: "M13 2L3 14h9l-1 8 10-12h-9z", tip: "Deploys" },
    {
      kind: "mode",
      icon: "ai",
      d: "M12 3l1.5 7.5L21 12l-7.5 1.5L12 21l-1.5-7.5L3 12l7.5-1.5z",
      tip: "AI assistant",
    },
    {
      // pencil / edit glyph
      kind: "mode",
      icon: "edits",
      d: "M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z",
      tip: "Targeted edits",
    },
  ];
  return (
    <nav className="z-50 flex w-12 shrink-0 flex-col items-center gap-1 border-r border-bord bg-bg px-0 pb-3 pt-2.5">
      <a
        href="#"
        className="mb-2.5 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[7px] border border-bord bg-elev no-underline"
      >
        <svg width="16" height="16" viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <text
            x="2"
            y="21"
            fontFamily="var(--font-display), sans-serif"
            fontWeight="800"
            fontSize="17"
            fill="rgb(0 201 167)"
          >
            J
          </text>
        </svg>
      </a>
      {items.map((ic, i) => {
        const active = ic.kind === "mode" && mode === ic.icon;
        const className = [
          "flex h-[34px] w-[34px] items-center justify-center rounded-[7px] border no-underline transition-colors",
          active
            ? "border-teal/15 bg-teal/[0.09] text-teal"
            : "border-transparent text-gry-d hover:text-gry",
        ].join(" ");
        const glyph = (
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {ic.d === "circle" ? (
              <>
                <circle cx="12" cy="12" r="10" />
                <path d="M12 2C8.5 7 8.5 17 12 22M12 2C15.5 7 15.5 17 12 22" />
                <path d="M2 12h20" />
              </>
            ) : (
              <path d={ic.d} />
            )}
          </svg>
        );
        if (ic.kind === "mode") {
          return (
            <button
              key={i}
              type="button"
              title={ic.tip}
              aria-pressed={active}
              onClick={() => onSelectMode(ic.icon)}
              className={className}
            >
              {glyph}
            </button>
          );
        }
        return (
          <a key={i} href="#" title={ic.tip} className={className}>
            {glyph}
          </a>
        );
      })}
      <div className="mt-auto">
        <div className="flex h-7 w-7 items-center justify-center rounded-md border border-bord bg-gradient-to-br from-[#1a4080] to-[#0f2040] font-display text-[11px] font-bold text-teal">
          SK
        </div>
      </div>
    </nav>
  );
}
```

- [ ] **Step 2: Add the model import at the top of the file**

At the top of `workspace-jab-demo.tsx`, below the existing imports (after the `WorkspacePreviewState` import line), add:

```tsx
import {
  nextLeftColumnMode,
  leftColumnSurface,
  type LeftColumnMode,
} from "./left-column-mode";
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @jab/web typecheck`
Expected: FAIL — `IconNav` is now called with no props in `WorkspaceJabDemo` (fixed in Task 3). This confirms the call site is the only remaining break. (If other errors appear, they are real and must be fixed now.)

> Note: do not commit yet — the file won't typecheck until Task 3 wires the call site. Tasks 2 + 3 form one commit.

---

### Task 3: Left-column slot + state + code-panel default in the shell

**Files:**
- Modify: `apps/web/app/ui-kit/workspace-jab/workspace-jab-demo.tsx` (the `WorkspaceJabDemo` function ~lines 1546–1585, and the `WorkspaceProject` interface ~lines 1530–1544)

- [ ] **Step 1: Extend the `WorkspaceProject` interface with surface props**

This change actually lives on `WorkspaceJabDemo`'s own props, not `WorkspaceProject` (the surfaces are page-level elements, not per-project data). Find the `WorkspaceJabDemo` function signature:

```tsx
export function WorkspaceJabDemo({
  project,
}: { project?: WorkspaceProject } = {}) {
```

Replace it with:

```tsx
export function WorkspaceJabDemo({
  project,
  editsSurface,
  chatSurface,
}: {
  project?: WorkspaceProject;
  /** Real Targeted-edits surface (server-rendered) for the "edits" mode. */
  editsSurface?: ReactNode;
  /** Real chat surface (server-rendered) for the "ai" mode. Falls back to the
   *  built-in demo AIPanel when omitted (e.g. /ui-kit route, or JAB_CHAT_EDIT off). */
  chatSurface?: ReactNode;
} = {}) {
```

- [ ] **Step 2: Replace the shell body (state + rail wiring + slot)**

Find the body of `WorkspaceJabDemo` from `const [isStreaming, setIsStreaming] = useState(false);` through the closing `</>`. Replace the whole body with:

```tsx
  const [isStreaming, setIsStreaming] = useState(false);
  // Code panel defaults CLOSED so the live preview fills the available height
  // on open. The TopBar "Code" toggle still opens it on demand (spec §2).
  const [codeOpen, setCodeOpen] = useState(false);
  const [wpOpen, setWpOpen] = useState(false);
  const [leftMode, setLeftMode] = useState<LeftColumnMode>("ai");

  const surface = leftColumnSurface(leftMode);

  return (
    <>
      <KeyframeStyles />
      <div className="flex h-screen overflow-hidden bg-bg">
        <IconNav
          mode={leftMode}
          onSelectMode={(icon) =>
            setLeftMode((m) => nextLeftColumnMode(m, icon))
          }
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            isStreaming={isStreaming}
            codeOpen={codeOpen}
            setCodeOpen={setCodeOpen}
            wpOpen={wpOpen}
            setWpOpen={setWpOpen}
            project={project}
          />
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {/* Left-column slot: one surface at a time, collapsible to nothing.
                When collapsed the PreviewPane (flex-1 min-w-0) takes full width. */}
            {surface === "chat" &&
              (chatSurface ? (
                <div className="flex w-[322px] shrink-0 flex-col overflow-hidden border-r border-bord bg-surf">
                  {chatSurface}
                </div>
              ) : (
                <AIPanel
                  isStreaming={isStreaming}
                  setIsStreaming={setIsStreaming}
                />
              ))}
            {surface === "edits" && (
              <div className="flex w-[322px] shrink-0 flex-col overflow-hidden border-r border-bord bg-surf">
                {editsSurface ?? <EditsSurfacePlaceholder />}
              </div>
            )}
            <PreviewPane
              isStreaming={isStreaming}
              codeOpen={codeOpen}
              project={project}
            />
            {wpOpen && <WPPanel onClose={() => setWpOpen(false)} />}
          </div>
        </div>
      </div>
    </>
  );
```

Notes for the implementer:
- The demo `AIPanel` already owns `w-[322px] … border-r border-bord bg-surf`, so it is rendered bare (no extra wrapper) to avoid a double border. The real `chatSurface` / `editsSurface` are wrapped because they fill the column rather than self-size.
- `hasBuild` is removed (it only fed the old `codeOpen` default). If a lint error reports `hasBuild` unused elsewhere, delete its declaration line.

- [ ] **Step 3: Add the demo placeholder for the edits mode**

Immediately above the `WorkspaceJabDemo` function, add:

```tsx
/**
 * Shown in the left column's "edits" mode on the /ui-kit demo route, where no
 * real project/build (and therefore no server-wired edits surface) exists.
 */
function EditsSurfacePlaceholder() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <p className="text-[13px] font-bold text-wht">Targeted edits</p>
      <p className="mt-2 font-body text-xs leading-[1.5] text-gry-d">
        Connect a project with a generated build to make scoped edits to the
        shell or individual components.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @jab/web typecheck`
Expected: PASS — `ReactNode` is already imported (line 8); `IconNav` call site now matches its props.

- [ ] **Step 5: Run the existing workspace tests + the new model test**

Run: `pnpm --filter @jab/web test workspace left-column-mode chat-card-model`
Expected: PASS — all existing workspace tests stay green (data path unchanged), new model test green.

- [ ] **Step 6: Commit (Tasks 2 + 3 together)**

```bash
git add "apps/web/app/ui-kit/workspace-jab/workspace-jab-demo.tsx"
git commit -m "feat(workspace): icon rail drives left-column mode; preview defaults full-height"
```

---

### Task 4: Thread surfaces into the shell + restyle the edits panel (server page)

**Files:**
- Modify: `apps/web/app/(app)/projects/[id]/workspace/page.tsx` (the `ProjectWorkspace` return ~lines 156–178, and the `WorkspaceEditsPanel` component ~lines 188–305)

- [ ] **Step 1: Replace the page's return JSX**

Find the `return (` block in `ProjectWorkspace` (starts ~line 156, the `<div className="flex flex-col">` wrapper). Replace the whole `return (…);` with:

```tsx
  return (
    <WorkspaceJabDemo
      project={workspaceProject}
      editsSurface={
        <WorkspaceEditsPanel
          projectId={project.id}
          sourceBuildId={sourceBuildId}
          history={editHistory}
          submitAction={submitEdit}
          discardAction={discardEditFormAction}
        />
      }
      chatSurface={
        chatEnabled ? (
          <ChatPanel
            projectId={project.id}
            initialMessages={conversation.messages}
            sourceBuildReady={sourceBuildId !== null}
          />
        ) : undefined
      }
    />
  );
```

This removes the `<div className="flex flex-col">` banner stack, the `chatEnabled && (<div className="flex border-b…">…<div className="flex-1" /></div>)` wrapper, and the standalone `<WorkspaceEditsPanel … />` banner — all three are replaced by the surface props above.

- [ ] **Step 2: Restyle `WorkspaceEditsPanel` for the narrow column**

Replace the entire `WorkspaceEditsPanel` function body's `return (…)` (the outer `<section className="border-b border-bord bg-bg px-8 py-5">`) with the vertical-stack version. Replace from `return (` (line ~195) through the matching `</section>);` (line ~304) with:

```tsx
  return (
    <section className="flex h-full flex-col overflow-hidden bg-surf">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-bord px-3.5">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgb(0 201 167)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
        </svg>
        <span className="text-[13px] font-bold text-wht">Targeted edits</span>
        {!sourceBuildId && (
          <span className="ml-auto font-mono text-[11px] text-amb">
            Requires a ready build
          </span>
        )}
      </div>

      <form action={submitAction} className="flex flex-col gap-2 px-3.5 py-3">
        <select
          name="scope"
          defaultValue="shell"
          disabled={!sourceBuildId}
          className="h-9 rounded-md border border-bord bg-elev px-2.5 text-[13px] text-wht outline-none focus:border-teal disabled:opacity-60"
        >
          <option value="shell">shell</option>
          <option value="component">component</option>
        </select>
        <input
          type="text"
          name="target"
          placeholder="header / footer / core/heading"
          disabled={!sourceBuildId}
          className="h-9 rounded-md border border-bord bg-elev px-2.5 text-[13px] text-wht outline-none focus:border-teal disabled:opacity-60"
        />
        <textarea
          name="prompt"
          placeholder="Describe the change you want"
          disabled={!sourceBuildId}
          maxLength={MAX_PROMPT_CHARS}
          rows={3}
          className="resize-none rounded-md border border-bord bg-elev px-2.5 py-2 text-[13px] leading-[1.5] text-wht outline-none focus:border-teal disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={!sourceBuildId}
          className="inline-flex h-9 items-center justify-center rounded-md bg-teal px-4 text-[13px] font-semibold text-bg transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Run edit →
        </button>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-3">
        {history.length > 0 && (
          <ul className="divide-y divide-bord overflow-hidden rounded-lg border border-bord bg-bg">
            {history.map((edit) => {
              // §3.4 state machine: workspace_edits.status='completed' means
              // "dispatched", not "done" — label + gates derive from the
              // LINKED build's status via deriveEditUiState.
              const ui = deriveEditUiState({
                editStatus: edit.status,
                buildStatus: edit.resultBuildStatus,
                promoted: edit.promoted,
              });
              const canReview = Boolean(edit.resultBuildId) && ui.awaitingReview;
              const canDiscard =
                ui.awaitingReview ||
                ui.label === "Building…" ||
                ui.label === "Submitting…";
              return (
                <li
                  key={edit.id}
                  className="flex flex-col gap-1.5 px-3 py-2.5 text-[13px]"
                >
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 rounded-sm border border-bord bg-elev px-1.5 py-0.5 font-mono text-[10px] text-gry">
                      {edit.scope}/{edit.target}
                    </span>
                    <EditStatusChip label={ui.label} />
                  </div>
                  <span className="min-w-0 truncate text-gry">{edit.prompt}</span>
                  <div className="flex items-center gap-3">
                    {edit.resultBuildId && !canReview && (
                      <Link
                        href={`/projects/${projectId}/builds/${edit.resultBuildId}/progress`}
                        className="shrink-0 font-mono text-[11px] text-teal hover:underline"
                      >
                        view build →
                      </Link>
                    )}
                    {canReview && edit.resultBuildId && (
                      <Link
                        href={`/projects/${projectId}/builds/${edit.resultBuildId}/review`}
                        className="shrink-0 font-mono text-[11px] text-teal hover:underline"
                      >
                        Review →
                      </Link>
                    )}
                    {canDiscard && (
                      <form action={discardAction}>
                        <input type="hidden" name="editId" value={edit.id} />
                        <button
                          type="submit"
                          className="shrink-0 font-mono text-[11px] text-red hover:underline"
                        >
                          Discard
                        </button>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
```

This preserves every field `name=`, both server actions, the `deriveEditUiState` history logic, the `EditStatusChip`, and all the build/review/discard links — only the layout changes (banner grid → vertical column stack; horizontal `<input name="prompt">` → `<textarea>` to fit the narrow width; per-row layout stacks the badge/chip/prompt/links vertically).

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @jab/web typecheck`
Expected: PASS. (`ChatPanel`, `WorkspaceEditsPanel`, `WorkspaceJabDemo`, `MAX_PROMPT_CHARS`, `deriveEditUiState`, `Link` are all already imported in `page.tsx`.)

- [ ] **Step 4: Run the full app test suite**

Run: `pnpm --filter @jab/web test`
Expected: PASS — full suite green (the data path is unchanged; the change is purely where surfaces mount + their styling).

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(app)/projects/[id]/workspace/page.tsx"
git commit -m "feat(workspace): edits + chat surfaces mount in left column; remove banners"
```

---

### Task 5: Manual verification

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server**

Run: `pnpm --filter @jab/web dev`
Then open `http://localhost:3000/ui-kit/workspace-jab` (the self-contained demo route — no real project needed).

- [ ] **Step 2: Verify the demo route**

Confirm:
- The far-left rail shows the **AI** (sparkle) and **Targeted edits** (pencil) icons; AI is highlighted on load.
- Clicking the **pencil** icon swaps the left column to the Targeted-edits placeholder; the AI sparkle de-highlights, pencil highlights.
- Clicking the **active** icon (the highlighted one) **collapses** the column — the preview expands to full width.
- Clicking a mode icon while collapsed **reopens** the column in that mode.
- The bottom **Code panel is closed on load**; clicking the TopBar **Code** button opens/closes it.

- [ ] **Step 3: Verify a real project (if a generated build is available)**

Open `http://localhost:3000/projects/<id>/workspace` for a project with a `ready` build. Confirm:
- Preview opens full-bleed (code panel closed, no banner above it).
- AI icon shows the real chat surface when `JAB_CHAT_EDIT=1`, else the demo AI mock.
- Pencil icon shows the real **Targeted edits** form; submitting an edit and the history list render inside the 322px column; "Requires a ready build" amber note appears when there's no ready build.

- [ ] **Step 4: Final full check**

Run: `pnpm --filter @jab/web typecheck && pnpm --filter @jab/web test`
Expected: both PASS.

---

## Self-Review Notes

- **Spec coverage:** §1 model → Task 1. §2 shell (codeOpen default, leftMode, IconNav wiring, slot, props, placeholder) → Tasks 2+3. §3 page banners removed + surfaces threaded + `WorkspaceEditsPanel` restyle → Task 4. Testing section → Task 1 (model) + Task 3/4 (existing suites stay green) + Task 5 (manual). All spec sections map to tasks.
- **Out-of-scope honored:** other rail icons stay decorative (Task 2 marks them `kind: "decorative"`, no onClick); no server action / DB / migration / preview-pane / WPPanel / gating changes; no persistence; no collapse animation.
- **Test environment fidelity:** vitest runs `environment: "node"` with no RTL — so tests target the pure `nextLeftColumnMode` / `leftColumnSurface` helpers, never a rendered tree, matching `workspace-preview-pane.test.tsx` / `chat-card-model.test.ts`. The spec's "shell render assertion" is intentionally realized as a pure-selector test (`leftColumnSurface`) here.
- **Type consistency:** `LeftColumnMode` / `nextLeftColumnMode` / `leftColumnSurface` names are identical across Tasks 1–3. `editsSurface` / `chatSurface` prop names match between the shell (Task 3) and the page (Task 4).
- **Filter name:** all commands use `pnpm --filter @jab/web` (the `apps/web` package name is `@jab/web` per CLAUDE.md). A bare `vitest`/`tsc` won't resolve from the repo root.

## Post-Implementation Record (2026-06-10)

Executed via subagent-driven development on branch `feat/saas-e2e-loop`. Commits:
`81fa8e9` (model) → `d558cb1` (shell wiring) → `0ce5526` (review fixes: hoist rail
items, aria-label, LeftColumn helper) → `c6385aa` (page surfaces + edits restyle) →
`b7dddd4` (drop dead `min-w-0`) → `aaa229a` (final-review fix, see below). Per-task
spec + quality review passed on every task; typecheck clean and full app suite green
(884 tests) at the end.

**Final holistic review found two seam issues the per-task reviews couldn't see:**

1. **Chat surface geometry (fixed — `aaa229a`).** The real `ChatPanel` root kept its
   own `w-[380px] shrink-0 border-r border-bord bg-bg`, so when wrapped in the new
   `LeftColumn` (322px, `overflow-hidden`, `border-r`) it was clipped to 322px with a
   doubled right border — only on the `JAB_CHAT_EDIT=1` path (off by default, so the
   demo-route manual pass didn't surface it). Fixed by giving `ChatPanel`'s root the
   same fill-the-wrapper contract the edits panel already uses:
   `flex h-full flex-col overflow-hidden motion-reduce:transition-none` (no self
   width/border/bg; `LeftColumn` owns column geometry, `bg-surf` inherited). Both real
   surfaces are now geometrically identical inside the wrapper, delivering the spec's
   "identical geometry" guarantee.

2. **Spec's "shell render assertion" (resolved by substitution + manual, not a new
   unit test).** The repo's vitest runs `environment: "node"` with no jsdom/RTL in the
   dependency tree (verified), so a real `WorkspaceJabDemo` render test isn't possible
   without adding test infrastructure the codebase deliberately avoids. The rail→surface
   wiring is instead covered by (a) the pure `leftColumnSurface` selector test and (b)
   the Task 5 manual Playwright pass, which drove every transition end-to-end:
   AI-default (sparkle `[pressed]`, code panel closed, preview full-height) → click
   pencil → edits surface swaps in (not stacked) → click active → column collapses,
   preview full-width → click from collapsed → reopens in that mode → TopBar Code toggle
   opens the panel on demand. Snapshots captured each state. Adding a no-RTL "render"
   test would assert nothing real, so it was deliberately not written.

**Manual-verification method note:** `/ui-kit/workspace-jab` is auth-gated by middleware
in dev, so verification used a throwaway public probe route (`app/probe-workspace/` +
a temporary `PUBLIC_ROUTES` entry) rendering `<WorkspaceJabDemo />` with no props. Both
were fully reverted after — the working tree is pristine (no `probe`/`middleware`
changes in git).
