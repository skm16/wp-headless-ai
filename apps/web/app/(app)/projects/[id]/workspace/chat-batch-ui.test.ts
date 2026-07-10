import { describe, it, expect } from "vitest";
import { batchChipModel, isProposeSuperseded } from "./chat-batch-ui";
import type { ChatMessageView } from "@/lib/actions/workspace-chat";

const base: ChatMessageView = {
  id: "m", role: "assistant", content: "", needsClarification: false,
  editId: null, buildId: null, createdAt: "", editStatus: null, editError: null,
  batchRemaining: [],
};

describe("batchChipModel", () => {
  it("shows apply-all chips on a batch propose (clarify)", () => {
    const m = batchChipModel({ ...base, needsClarification: true, batchRemaining: ["a", "b", "c"] });
    expect(m).not.toBeNull();
    expect(m!.showApplyAll).toBe(true);
    expect(m!.count).toBe(3);
    expect(m!.applyAllMessage).toMatch(/all of them/i);
  });
  it("shows a progress hint on a batch apply (edit linked)", () => {
    const m = batchChipModel({ ...base, editId: "e1", batchRemaining: ["b", "c"] });
    expect(m!.showApplyAll).toBe(false);
    expect(m!.progressLabel).toBe("2 sections left in this change");
  });
  it("returns null when there is no batch", () => {
    expect(batchChipModel(base)).toBeNull();
    expect(batchChipModel({ ...base, needsClarification: true })).toBeNull();
  });
});

describe("batchChipModel — chip only on a live, unanswered propose (findings A+D)", () => {
  const propose: ChatMessageView = {
    id: "p", role: "assistant", content: "apply to all?", needsClarification: true,
    editId: null, buildId: null, createdAt: "", editStatus: null, editError: null,
    batchRemaining: ["a", "b", "c"],
  };
  it("shows the chip on a fresh propose (no linked edit, not superseded)", () => {
    expect(batchChipModel(propose)!.showApplyAll).toBe(true);
  });
  it("hides the chip when the bubble has a linked edit (an apply/error, not a propose)", () => {
    expect(batchChipModel({ ...propose, editId: "e1" })).toEqual(
      expect.objectContaining({ showApplyAll: false }),
    );
  });
  it("hides the chip when the linked edit failed", () => {
    const m = batchChipModel({ ...propose, editId: "e1", editStatus: "failed" });
    expect(m?.showApplyAll ?? false).toBe(false);
  });
  it("hides the chip when a later batch turn supersedes this propose", () => {
    expect(batchChipModel(propose, { superseded: true })?.showApplyAll ?? false).toBe(false);
  });
});

describe("isProposeSuperseded", () => {
  const mk = (over: Partial<ChatMessageView>): ChatMessageView => ({
    id: "x", role: "assistant", content: "", needsClarification: false,
    editId: null, buildId: null, createdAt: "", editStatus: null, editError: null,
    batchRemaining: [], ...over,
  });
  it("is true when a later message also carries a batch", () => {
    const msgs = [mk({ batchRemaining: ["a", "b"] }), mk({ editId: "e1", batchRemaining: ["b"] })];
    expect(isProposeSuperseded(msgs, 0)).toBe(true);
  });
  it("is false when this is the newest batch turn", () => {
    const msgs = [mk({ batchRemaining: ["a", "b"] }), mk({ content: "unrelated" })];
    expect(isProposeSuperseded(msgs, 0)).toBe(false);
  });
});
