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
