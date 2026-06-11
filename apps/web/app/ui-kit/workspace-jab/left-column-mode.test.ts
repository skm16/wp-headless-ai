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
