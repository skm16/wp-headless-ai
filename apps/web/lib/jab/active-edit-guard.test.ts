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
