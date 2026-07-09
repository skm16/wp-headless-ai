import { describe, it, expect } from "vitest";
import { chatBubbleFooterFor } from "./chat-bubble-status";

describe("chatBubbleFooterFor", () => {
  it("returns null when there is no linked edit", () => {
    expect(
      chatBubbleFooterFor({ editId: null, buildId: null, editStatus: null, editError: null, needsClarification: false }),
    ).toBeNull();
  });

  it("returns null for a needsClarification message even if editId is set", () => {
    expect(
      chatBubbleFooterFor({ editId: "e1", buildId: null, editStatus: "queued", editError: null, needsClarification: true }),
    ).toBeNull();
  });

  it("shows a pending state for status=queued", () => {
    const r = chatBubbleFooterFor({ editId: "e1", buildId: null, editStatus: "queued", editError: null, needsClarification: false });
    expect(r).toEqual({ text: "Applying to draft…", tone: "pending" });
  });

  it("shows a pending state for status=running", () => {
    const r = chatBubbleFooterFor({ editId: "e1", buildId: null, editStatus: "running", editError: null, needsClarification: false });
    expect(r).toEqual({ text: "Applying to draft…", tone: "pending" });
  });

  it("shows the completed checkmark for status=completed", () => {
    const r = chatBubbleFooterFor({ editId: "e1", buildId: null, editStatus: "completed", editError: null, needsClarification: false });
    expect(r).toEqual({ text: "Applied to draft ✓", tone: "neutral" });
  });

  it("shows the real error_text for status=failed, amber tone", () => {
    const r = chatBubbleFooterFor({
      editId: "e1", buildId: null, editStatus: "failed",
      editError: "The generator hit a problem: timeout", needsClarification: false,
    });
    expect(r).toEqual({ text: "The generator hit a problem: timeout", tone: "amber" });
  });

  it("falls back to a generic message for status=failed with no error_text", () => {
    const r = chatBubbleFooterFor({ editId: "e1", buildId: null, editStatus: "failed", editError: null, needsClarification: false });
    expect(r).toEqual({ text: "Something went wrong applying that edit.", tone: "amber" });
  });

  it("returns null for status=discarded", () => {
    expect(
      chatBubbleFooterFor({ editId: "e1", buildId: null, editStatus: "discarded", editError: null, needsClarification: false }),
    ).toBeNull();
  });

  it("returns null once a buildId is linked (full-build edit path, unaffected by this feature)", () => {
    expect(
      chatBubbleFooterFor({ editId: "e1", buildId: "build-1", editStatus: "completed", editError: null, needsClarification: false }),
    ).toBeNull();
  });
});
