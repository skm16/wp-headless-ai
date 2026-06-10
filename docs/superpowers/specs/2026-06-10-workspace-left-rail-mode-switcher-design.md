# Workspace left-rail mode switcher + full-height preview

> Spec — 2026-06-10. Moves the workspace's "Targeted edits" surface out of the
> full-width banner into the left utility column, makes the far-left icon rail a
> real mode switcher, collapses the left column on demand so the preview can go
> full-width, and defaults the bottom code panel hidden so the preview fills the
> available height.

## Problem

On `/projects/[id]/workspace`, the **Targeted edits** form is rendered as a
full-width `<section>` banner stacked *above* the `h-screen` workspace shell (see
[`page.tsx`](../../../apps/web/app/(app)/projects/[id]/workspace/page.tsx) — the
`WorkspaceEditsPanel` and the `chatEnabled` ChatPanel wrapper). Because the shell
is a fixed-height (`h-screen`) flex layout, these banners push the actual
preview/AI workspace below the fold — the user scrolls past a wall of edit-form
chrome before reaching the live site.

Two adjacent layout problems compound it:

- The bottom **Code panel** defaults to *open* whenever a build exists
  (`useState(hasBuild)` in `WorkspaceJabDemo`). It's a fixed `h-[320px]` block
  that steals vertical space, so the preview never fills the available height on
  a generated project.
- The left **AI Assistant column** (322px) is always mounted with no way to
  collapse it, so the preview can never take the full width.

## Goal

Make the far-left **icon rail** (`IconNav`) the single control for the left
column, and let that 322px column host *either* the AI chat *or* the Targeted
edits surface — one at a time, collapsible to nothing. Default the code panel
closed so the preview fills the height. Net effect: the workspace opens to a
full-bleed live preview, and the edits/chat surfaces are one rail-click away.

## Design

Three files change, all inside the workspace feature. No server action, DB
query, or data-loading path changes — only *where* surfaces mount and *which*
one is visible.

### 1. Left-column mode model (new, pure, tested)

A small pure module `left-column-mode.ts` co-located in the workspace shell's
directory (`app/ui-kit/workspace-jab/`) encodes the rail interaction so it can be
unit-tested without rendering the timer-driven shell.

```
export type LeftColumnMode = "ai" | "edits" | "collapsed";

// Clicking a rail mode-icon. Clicking the active mode collapses; clicking a
// different mode switches to it (and opens if currently collapsed).
export function nextLeftColumnMode(
  current: LeftColumnMode,
  clicked: "ai" | "edits",
): LeftColumnMode;
```

Rules:

- `nextLeftColumnMode("ai", "ai")` → `"collapsed"` (toggle off active mode).
- `nextLeftColumnMode("edits", "edits")` → `"collapsed"`.
- `nextLeftColumnMode("collapsed", "ai")` → `"ai"` (open into clicked mode).
- `nextLeftColumnMode("collapsed", "edits")` → `"edits"`.
- `nextLeftColumnMode("ai", "edits")` → `"edits"` (switch surface, stay open).
- `nextLeftColumnMode("edits", "ai")` → `"ai"`.

The rail's *active* highlight is `mode === clicked` for each icon; when
`collapsed`, neither mode icon is highlighted.

### 2. `workspace-jab-demo.tsx` (client shell)

- Replace `codeOpen`'s default: `useState(false)` (was `useState(hasBuild)`).
  The TopBar "Code" toggle is unchanged — the user can still open it; it just
  starts closed so the preview fills the height. `hasBuild` is no longer needed
  for this and its computation is removed if otherwise unused.
- Add `const [leftMode, setLeftMode] = useState<LeftColumnMode>("ai")`.
- **`IconNav`** gains a **Targeted-edits icon** (a pencil/edit glyph) and a real
  **AI icon** wired to the mode. The two become functional:
  - AI/sparkle icon → `setLeftMode(m => nextLeftColumnMode(m, "ai"))`,
    active when `leftMode === "ai"`.
  - Edits/pencil icon → `setLeftMode(m => nextLeftColumnMode(m, "edits"))`,
    active when `leftMode === "edits"`.
  - The existing decorative icons (Dashboard / Deploys, and the J logo / SK
    avatar) stay decorative — out of scope. The current always-active "Sites"
    circle icon loses its hardcoded `active: true`.
  - `IconNav` takes `leftMode` + `onSelectMode(mode)` props so the rail and the
    column stay in sync from one source of truth.
- **Left column becomes a slot.** Today the row is
  `<AIPanel/> <PreviewPane/> {wpOpen && <WPPanel/>}`. It becomes:
  - `leftMode === "ai"` → render `chatSurface` prop if provided, else the demo
    `<AIPanel/>` (the `/ui-kit` route has no real chat).
  - `leftMode === "edits"` → render `editsSurface` prop if provided, else a
    lightweight placeholder (demo route has no real project/build).
  - `leftMode === "collapsed"` → render nothing; `PreviewPane` (already
    `flex-1 min-w-0`) expands to full width automatically.
  - The slot wrapper keeps the column's fixed `w-[322px] shrink-0 border-r`
    sizing so AI and edits surfaces share identical geometry. (The demo
    `AIPanel` currently sets its own width internally; the real surfaces will be
    wrapped to match — see §3.)
- New optional props on `WorkspaceJabDemo` / `WorkspaceProject` boundary:
  `editsSurface?: ReactNode`, `chatSurface?: ReactNode`. The `/ui-kit`
  stakeholder route passes neither and keeps its self-contained mock (AI column
  shows the demo `AIPanel`; edits icon shows the placeholder). No real data
  reaches that route.

### 3. `page.tsx` (server) + `WorkspaceEditsPanel` restyle

- Stop rendering the two banners. Delete the `chatEnabled && (<div
  className="flex border-b…"><ChatPanel/>…</div>)` wrapper and the standalone
  `<WorkspaceEditsPanel … />` block above `<WorkspaceJabDemo/>`.
- Build the edits surface as an element and pass it in:
  `editsSurface={<WorkspaceEditsPanel … />}`. When `chatEnabled`, also pass
  `chatSurface={<ChatPanel … />}` (so the existing `JAB_CHAT_EDIT` gate still
  controls whether a real chat surface exists; when the flag is off, no
  `chatSurface` is passed and the AI mode shows the demo `AIPanel` mock, exactly
  as the `/ui-kit` route does — unchanged behavior for the gate-off path).
- The page no longer wraps the shell in `<div className="flex flex-col">` with
  banners; it returns the shell directly with the two surface props.
- **`WorkspaceEditsPanel` restyle** for the narrow column. Today it's a wide
  horizontal banner: `px-8`, a 4-column grid
  (`md:grid-cols-[120px_1fr_2fr_auto]`), inline title row. In a 322px column it
  becomes a **vertical stack**: single-column form (scope select, target input,
  prompt input, Run button stacked), tighter `px-4 py-4` padding, and the
  history list below scrolls within the column. Same fields, same `name=`
  attributes, same `submitAction` / `discardAction` server actions, same
  `deriveEditUiState` history rendering — a restyle, not a rewrite. The
  "Requires a ready build" amber note and disabled states are preserved. The
  surface fills the column height (`flex flex-col`, history area
  `flex-1 overflow-y-auto`) to match the AI panel's feel.

## Data flow

Unchanged. `editHistory`, `sourceBuildId`, `submitEdit`,
`discardEditFormAction`, `conversation` are still computed in the server
`page.tsx` and flow into `WorkspaceEditsPanel` / `ChatPanel`. The only change is
that those elements mount inside the client shell's left-column slot (passed as
`ReactNode` props — the server-children-through-a-client-component pattern)
instead of as banners above it. The client shell never imports server code.

## What is explicitly out of scope (YAGNI)

- Wiring the other rail icons (Dashboard, Deploys, J logo, SK avatar) — they
  stay decorative.
- Any change to server actions, DB queries, migrations, the preview pane,
  WPPanel, or the `JAB_CHAT_EDIT` gating semantics.
- Persisting the user's chosen `leftMode` / `codeOpen` across reloads — both
  reset to defaults (`"ai"`, closed) on each load. Persistence is a possible
  follow-up, not part of this change.
- Animating the column collapse. The column simply mounts/unmounts. A
  slide/width transition is a polish follow-up.

## Testing

- **`left-column-mode.test.ts`** — unit tests for `nextLeftColumnMode` covering
  all six transitions in §1. Pure function, Vitest, co-located, matching the
  `chat-card-model.test.ts` convention.
- **Shell render assertion** — a focused test that, given `editsSurface` and
  `chatSurface` props, the left column renders the chat surface in `"ai"` mode,
  the edits surface in `"edits"` mode, and neither when `"collapsed"` (preview
  occupies full width). Driven through the rail's `onSelectMode`.
- Existing `workspace-edit*` and `workspace-chat*` tests are unaffected (data
  path unchanged) and must stay green.
- Manual: on a generated project the workspace opens full-bleed preview, code
  panel closed; the rail's AI and Edits icons toggle/collapse the left column;
  the edits form submits and history renders inside the column.
