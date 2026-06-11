import { describe, it, expect } from "vitest";
import { deriveEditUiState, isEditAwaitingReview } from "./workspace-edit-state";

describe("deriveEditUiState (§3.4 table)", () => {
  it("Applied when completed + no build (Live Draft path — edit applied to draft)", () => {
    const s = deriveEditUiState({ editStatus: "completed", buildStatus: null, promoted: false });
    expect(s.label).toBe("Applied");
    expect(s.awaitingReview).toBe(false);
  });
  it("Submitting… when queued/running with no build", () => {
    expect(deriveEditUiState({ editStatus: "queued", buildStatus: null, promoted: false }).label).toBe("Submitting…");
    expect(deriveEditUiState({ editStatus: "running", buildStatus: null, promoted: false }).label).toBe("Submitting…");
  });
  it("Building… when completed + linked build active", () => {
    expect(deriveEditUiState({ editStatus: "completed", buildStatus: "composing", promoted: false }).label).toBe("Building…");
    expect(deriveEditUiState({ editStatus: "completed", buildStatus: "verifying", promoted: false }).label).toBe("Building…");
  });
  it("Review ready when completed + build ready + not promoted", () => {
    const s = deriveEditUiState({ editStatus: "completed", buildStatus: "ready", promoted: false });
    expect(s.label).toBe("Review ready");
    expect(s.awaitingReview).toBe(true);
  });
  it("Live when completed + build ready + promoted", () => {
    const s = deriveEditUiState({ editStatus: "completed", buildStatus: "ready", promoted: true });
    expect(s.label).toBe("Live");
    expect(s.awaitingReview).toBe(false);
  });
  it("Discarded when build cancelled or edit discarded", () => {
    expect(deriveEditUiState({ editStatus: "completed", buildStatus: "cancelled", promoted: false }).label).toBe("Discarded");
    expect(deriveEditUiState({ editStatus: "discarded", buildStatus: "cancelled", promoted: false }).label).toBe("Discarded");
  });
  it("Discarded when edit status is discarded", () => {
    expect(deriveEditUiState({ editStatus: "discarded", buildStatus: null, promoted: false }).label).toBe("Discarded");
  });
  it("Failed when edit or build failed", () => {
    expect(deriveEditUiState({ editStatus: "failed", buildStatus: null, promoted: false }).label).toBe("Failed");
    expect(deriveEditUiState({ editStatus: "completed", buildStatus: "failed", promoted: false }).label).toBe("Failed");
  });
});

describe("isEditAwaitingReview", () => {
  it("true only for completed + ready + not promoted + not cancelled", () => {
    expect(isEditAwaitingReview({ editStatus: "completed", buildStatus: "ready", promoted: false })).toBe(true);
    expect(isEditAwaitingReview({ editStatus: "completed", buildStatus: "ready", promoted: true })).toBe(false);
    expect(isEditAwaitingReview({ editStatus: "discarded", buildStatus: "cancelled", promoted: false })).toBe(false);
    expect(isEditAwaitingReview({ editStatus: "completed", buildStatus: "composing", promoted: false })).toBe(false);
  });
  it("false for Applied (Live Draft path — no build linked)", () => {
    expect(isEditAwaitingReview({ editStatus: "completed", buildStatus: null, promoted: false })).toBe(false);
  });
});
