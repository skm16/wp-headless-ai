import { describe, it, expect } from "vitest";
import { planEdit, parsePlannerToolUse, type PlannerClient } from "./edit-planner";
import type { SiteMap } from "@/lib/jab/site-map";

const siteMap: SiteMap = {
  blockTypes: [{ blockName: "core/cover", label: "Cover", tier: "visual", occurrenceCount: 4 }],
  pageSlugs: ["home"],
  shell: { header: true, footer: false },
};

function mockClient(toolInput: Record<string, unknown>): PlannerClient {
  return {
    async createPlan() {
      return {
        toolInput,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
    },
  };
}

describe("parsePlannerToolUse", () => {
  it("coerces a well-formed actionable tool input to an EditPlan", () => {
    const plan = parsePlannerToolUse({
      needsClarification: false,
      scope: "component",
      target: "core/cover",
      action: "Regenerate Cover — affects 1 page",
      regenerationPrompt: "Make it bolder",
      clarifyingQuestion: null,
    });
    expect(plan).toEqual({
      needsClarification: false,
      scope: "component",
      target: "core/cover",
      action: "Regenerate Cover — affects 1 page",
      regenerationPrompt: "Make it bolder",
      clarifyingQuestion: null,
    });
  });

  it("defaults a missing/garbage scope to component and missing strings to empty", () => {
    const plan = parsePlannerToolUse({ needsClarification: true, clarifyingQuestion: "Which one?" });
    expect(plan.scope).toBe("component");
    expect(plan.needsClarification).toBe(true);
    expect(plan.target).toBe("");
    expect(plan.regenerationPrompt).toBe("");
    expect(plan.clarifyingQuestion).toBe("Which one?");
  });

  it("clamps a deferred scope (page) down to component (never representable)", () => {
    const plan = parsePlannerToolUse({ needsClarification: false, scope: "page", target: "home" });
    expect(plan.scope).toBe("component");
  });
});

describe("planEdit", () => {
  it("returns an actionable plan + usage from the client", async () => {
    const { plan, usage } = await planEdit({
      messages: [{ role: "user", content: "make the hero bolder" }],
      siteMap,
      client: mockClient({
        needsClarification: false,
        scope: "component",
        target: "core/cover",
        action: "Regenerate Cover — affects 1 page",
        regenerationPrompt: "Make the hero bolder",
        clarifyingQuestion: null,
      }),
    });
    expect(plan.scope).toBe("component");
    expect(plan.target).toBe("core/cover");
    expect(usage.inputTokens).toBe(100);
  });

  it("returns a clarifying plan for a vague request", async () => {
    const { plan } = await planEdit({
      messages: [{ role: "user", content: "make it nicer" }],
      siteMap,
      client: mockClient({ needsClarification: true, clarifyingQuestion: "Which section did you mean?" }),
    });
    expect(plan.needsClarification).toBe(true);
    expect(plan.clarifyingQuestion).toMatch(/which/i);
  });

  it("passes a hallucinated target straight through (caller validates)", async () => {
    const { plan } = await planEdit({
      messages: [{ role: "user", content: "change the testimonials" }],
      siteMap,
      client: mockClient({
        needsClarification: false,
        scope: "component",
        target: "core/testimonials",
        action: "Regenerate Testimonials",
        regenerationPrompt: "x",
        clarifyingQuestion: null,
      }),
    });
    expect(plan.target).toBe("core/testimonials"); // unknown to siteMap; caller rejects.
  });
});
