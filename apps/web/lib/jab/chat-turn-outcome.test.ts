import { describe, it, expect } from "vitest";
import { decideChatTurnOutcome } from "./chat-turn-outcome";
import type { EditPlan } from "./edit-plan";
import type { SiteMap } from "./site-map";

const siteMap: SiteMap = {
  blockTypes: [{ blockName: "core/cover", label: "Cover", tier: "visual", occurrenceCount: 4, pageCount: 1, pageCountIsFloor: false }],
  pageSlugs: ["home"],
  shell: { header: true, footer: false },
  tokens: { colors: [], fonts: [], sizes: [] },
};
function plan(over: Partial<EditPlan>): EditPlan {
  return {
    needsClarification: false,
    scope: "component",
    target: "core/cover",
    action: "Regenerate Cover",
    regenerationPrompt: "bolder",
    clarifyingQuestion: null,
    tokenDelta: null,
    ...over,
  };
}

describe("decideChatTurnOutcome", () => {
  it("clarify when the plan asks for clarification", () => {
    const r = decideChatTurnOutcome(plan({ needsClarification: true, clarifyingQuestion: "Which one?" }), siteMap);
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify") expect(r.message).toBe("Which one?");
  });
  it("clarify (with a real-target list) when validation rejects a hallucinated target", () => {
    const r = decideChatTurnOutcome(plan({ target: "core/ghost" }), siteMap);
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify") expect(r.message).toMatch(/core\/cover/);
  });
  it("edit when the plan is actionable and valid", () => {
    const r = decideChatTurnOutcome(plan({}), siteMap);
    expect(r.kind).toBe("edit");
    if (r.kind === "edit") {
      expect(r.assistantText).toContain("Regenerate Cover");
      expect(r.plan.target).toBe("core/cover");
    }
  });
  it("falls back to a generic clarify message when the model gave no question", () => {
    const r = decideChatTurnOutcome(plan({ needsClarification: true, clarifyingQuestion: null }), siteMap);
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify") expect(r.message.length).toBeGreaterThan(0);
  });
});
