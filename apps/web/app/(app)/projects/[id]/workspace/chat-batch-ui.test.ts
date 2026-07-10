import { describe, it, expect } from "vitest";
import { batchChipModel } from "./chat-batch-ui";
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
