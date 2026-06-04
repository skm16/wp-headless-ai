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
