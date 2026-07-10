import { describe, it, expect } from "vitest";
import { decideChatTurnOutcome } from "./chat-turn-outcome";
import type { EditPlan } from "./edit-plan";
import type { SiteMap } from "./site-map";
import { parsePlannerToolUse } from "@/lib/ai/edit-planner";

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
    revertIntent: null,
    revertVersion: null,
    batch: null,
    ...over,
  };
}

describe("decideChatTurnOutcome — validation-failure clarify drops batch (re-adversarial residual 1)", () => {
  it("nulls batch on a validation-failure clarify so no spurious 'Apply to all' chip renders", () => {
    // An APPLY turn (needsClarification=false) whose target isn't a real block
    // fails validateEditPlan and is surfaced as a clarify. If it kept plan.batch,
    // the persisted bubble (needsClarification=true, editId=null, batchRemaining
    // populated) would be byte-identical to a genuine propose → batchChipModel
    // renders 'Apply to all N' on an ERROR bubble and clicking re-drives the
    // failure. The validation-failure clarify must carry NO batch.
    const p = plan({
      needsClarification: false,
      target: "acf/does-not-exist",
      batch: { remaining: ["acf/a", "acf/b"], guidance: "uniform links" },
    });
    const out = decideChatTurnOutcome(p, siteMap);
    expect(out.kind).toBe("clarify");
    if (out.kind === "clarify") {
      expect(out.batch).toBeNull();
    }
  });

  it("still carries batch on a GENUINE propose (needsClarification set by the planner)", () => {
    // A real propose must keep its batch so the confirm chip renders.
    const p = plan({
      needsClarification: true,
      clarifyingQuestion: "Apply to all 2?",
      batch: { remaining: ["acf/a", "acf/b"], guidance: "uniform links" },
    });
    const out = decideChatTurnOutcome(p, siteMap);
    expect(out.kind).toBe("clarify");
    if (out.kind === "clarify") {
      expect(out.batch).toEqual({ remaining: ["acf/a", "acf/b"], guidance: "uniform links" });
    }
  });
});

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
  it("returns a revert outcome when revertIntent is set", () => {
    const out = decideChatTurnOutcome(plan({ revertIntent: "undo_last", revertVersion: null }), siteMap);
    expect(out.kind).toBe("revert");
    if (out.kind === "revert") {
      expect(out.intent).toBe("undo_last");
      expect(out.version).toBeNull();
    }
  });
  it("carries the version for a to_version revert", () => {
    const out = decideChatTurnOutcome(plan({ revertIntent: "to_version", revertVersion: 10 }), siteMap);
    expect(out.kind).toBe("revert");
    if (out.kind === "revert") expect(out.version).toBe(10);
  });
  it("still clarifies first when needsClarification is set, even with a revertIntent", () => {
    const out = decideChatTurnOutcome(
      plan({ needsClarification: true, revertIntent: "undo_last", clarifyingQuestion: "Which change?" }),
      siteMap,
    );
    expect(out.kind).toBe("clarify");
  });
});

describe("decideChatTurnOutcome — batch passthrough", () => {
  const siteMap = {
    blockTypes: [{ blockName: "acf/featured-beer", label: "Featured Beer", pageCount: 2, pageCountIsFloor: false }],
    pageSlugs: [], shell: { header: true, footer: true },
    tokens: { colors: [], fonts: [], sizes: [] },
  } as unknown as import("@/lib/jab/site-map").SiteMap;

  it("carries batch through a propose (clarify) outcome", () => {
    const plan = parsePlannerToolUse({
      needsClarification: true, clarifyingQuestion: "Apply to all 2?",
      batch: { remaining: ["acf/featured-beer"], guidance: "uniform links" },
    });
    const out = decideChatTurnOutcome(plan, siteMap);
    expect(out.kind).toBe("clarify");
    if (out.kind === "clarify") {
      expect(out.batch).toEqual({ remaining: ["acf/featured-beer"], guidance: "uniform links" });
    }
  });

  it("carries batch through an apply (edit) outcome", () => {
    const plan = parsePlannerToolUse({
      needsClarification: false, scope: "component", target: "acf/featured-beer",
      action: "Restyled the link — remaining: none", regenerationPrompt: "uniform links",
      batch: { remaining: [], guidance: "uniform links" },
    });
    const out = decideChatTurnOutcome(plan, siteMap);
    expect(out.kind).toBe("edit");
    if (out.kind === "edit") {
      expect(out.batch).toEqual({ remaining: [], guidance: "uniform links" });
    }
  });

  it("batch is null for an ordinary single edit", () => {
    const plan = parsePlannerToolUse({
      needsClarification: false, scope: "component", target: "acf/featured-beer",
      action: "Made the beer block bolder", regenerationPrompt: "bolder",
    });
    const out = decideChatTurnOutcome(plan, siteMap);
    expect(out.kind).toBe("edit");
    if (out.kind === "edit") {
      expect(out.batch).toBeNull();
    }
  });
});
