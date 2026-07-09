import { describe, it, expect } from "vitest";
import { resolveRevertTarget, type RevertEditRow } from "./resolve-revert-target";

const edits: RevertEditRow[] = [
  { id: "e1", createdAt: "2026-07-09T00:00:01Z" },
  { id: "e2", createdAt: "2026-07-09T00:00:02Z" },
  { id: "e3", createdAt: "2026-07-09T00:00:03Z" },
];

describe("resolveRevertTarget", () => {
  it("maps 1-based version N to the Nth edit ascending", () => {
    expect(resolveRevertTarget(edits, 2)).toEqual({ ok: true, editId: "e2" });
  });
  it("maps version 1 to the first edit", () => {
    expect(resolveRevertTarget(edits, 1)).toEqual({ ok: true, editId: "e1" });
  });
  it("returns out_of_range for N greater than the edit count", () => {
    expect(resolveRevertTarget(edits, 9)).toEqual({ ok: false, reason: "out_of_range" });
  });
  it("returns out_of_range for N < 1", () => {
    expect(resolveRevertTarget(edits, 0)).toEqual({ ok: false, reason: "out_of_range" });
  });
  it("returns out_of_range for an empty edit list", () => {
    expect(resolveRevertTarget([], 1)).toEqual({ ok: false, reason: "out_of_range" });
  });
});
