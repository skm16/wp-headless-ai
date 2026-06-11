import { describe, it, expect, vi, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  planEdit,
  parsePlannerToolUse,
  stableHeadSlice,
  AnthropicPlannerClient,
  type PlannerClient,
  type PlannerMessage,
} from "./edit-planner";
import type { SiteMap } from "@/lib/jab/site-map";
import { PLANNER_MAX_TURNS } from "@/lib/ai/edit-cost-guard";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Minimal Messages-API response; override per test. */
function fullResponse(over: Record<string, unknown> = {}) {
  return {
    content: [
      {
        type: "tool_use",
        id: "tu_1",
        name: "emit_edit_plan",
        input: {
          needsClarification: true,
          scope: "component",
          target: "",
          action: "",
          regenerationPrompt: "",
          clarifyingQuestion: "Which?",
        },
      },
    ],
    stop_reason: "tool_use",
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    ...over,
  };
}

/** Fake SDK whose messages.create resolves the given responses in order. */
function fakeSdk(responses: Array<Record<string, unknown>>) {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(fullResponse(r));
  return { sdk: { messages: { create } } as unknown as Anthropic, create };
}

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

  it("trims messages to the last PLANNER_MAX_TURNS turns", async () => {
    const messages = Array.from({ length: PLANNER_MAX_TURNS + 8 }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i}`,
    }));
    let received: PlannerMessage[] = [];
    const client: PlannerClient = {
      async createPlan({ messages: m }) {
        received = m;
        return {
          toolInput: { needsClarification: true, clarifyingQuestion: "?" },
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        };
      },
    };
    await planEdit({ messages, siteMap, client });
    expect(received).toHaveLength(PLANNER_MAX_TURNS);
    expect(received[0].content).toBe(`msg ${8}`); // first kept = total(20) - 12
  });
});

describe("stableHeadSlice", () => {
  it("returns the array unchanged at or under max", () => {
    const msgs = [1, 2, 3];
    expect(stableHeadSlice(msgs, 12, 4)).toEqual([1, 2, 3]);
    expect(stableHeadSlice(Array.from({ length: 12 }, (_, i) => i), 12, 4)).toHaveLength(12);
  });

  it("only shifts the window start every `chunk` turns (cache-prefix stability)", () => {
    // max=12, chunk=4: lengths 13..16 all drop exactly 4 → same head element.
    for (const len of [13, 14, 15, 16]) {
      const msgs = Array.from({ length: len }, (_, i) => i);
      expect(stableHeadSlice(msgs, 12, 4)[0]).toBe(4);
    }
    // lengths 17..20 all drop exactly 8.
    for (const len of [17, 18, 19, 20]) {
      const msgs = Array.from({ length: len }, (_, i) => i);
      expect(stableHeadSlice(msgs, 12, 4)[0]).toBe(8);
    }
  });

  it("never returns more than max", () => {
    for (let len = 0; len <= 30; len++) {
      const msgs = Array.from({ length: len }, (_, i) => i);
      expect(stableHeadSlice(msgs, 12, 4).length).toBeLessThanOrEqual(12);
    }
  });
});

describe("planEdit message-role invariant", () => {
  it("drops leading assistant turns so messages[0] is user-role", async () => {
    // The budget-notice path persists assistant-only rows, so a conversation
    // can legitimately START with an assistant turn.
    const messages: PlannerMessage[] = [
      { role: "assistant", content: "You're sending messages too quickly. Please slow down." },
      { role: "user", content: "make the hero bolder" },
    ];
    let received: PlannerMessage[] = [];
    const client: PlannerClient = {
      async createPlan({ messages: m }) {
        received = m;
        return {
          toolInput: { needsClarification: true, clarifyingQuestion: "?" },
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        };
      },
    };
    await planEdit({ messages, siteMap, client });
    expect(received).toHaveLength(1);
    expect(received[0].role).toBe("user");
  });
});

describe("planEdit cost cap", () => {
  it("throws EditBudgetError(planner_cost_cap) BEFORE calling the client when the estimate exceeds the cap", async () => {
    // 4 turns x 50,000 chars = 200,000 chars ≈ 50,000 tokens > 30,000 cap.
    // (The per-message 4000-char cap lives in the ACTION, not here — planEdit
    // must defend itself.)
    const big = "x".repeat(50_000);
    const messages: PlannerMessage[] = Array.from({ length: 4 }, () => ({
      role: "user" as const,
      content: big,
    }));
    const createPlan = vi.fn();
    await expect(
      planEdit({ messages, siteMap, client: { createPlan } as unknown as PlannerClient }),
    ).rejects.toMatchObject({ name: "EditBudgetError", code: "planner_cost_cap" });
    expect(createPlan).not.toHaveBeenCalled();
  });
});

describe("AnthropicPlannerClient prompt caching", () => {
  it("places cache_control on the system block and on the LAST message's last content block only", async () => {
    const { sdk, create } = fakeSdk([{}]);
    const client = new AnthropicPlannerClient({ sdk });
    await client.createPlan({
      system: "sys",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
    });
    const body = create.mock.calls[0][0];
    // system is a block array with the breakpoint (caches tools+system,
    // render order tools → system → messages).
    expect(body.system).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    // earlier messages stay plain strings (no breakpoints wasted — max 4/request)
    expect(body.messages[0]).toEqual({ role: "user", content: "first" });
    expect(body.messages[1]).toEqual({ role: "assistant", content: "second" });
    // last message converted to block-array form carrying the breakpoint —
    // the multi-turn pattern: tools+system+history become the cached prefix.
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "third", cache_control: { type: "ephemeral" } }],
    });
  });
});

describe("AnthropicPlannerClient model + sdk plumbing", () => {
  it("resolves the model via getModelFor('planner') — default sonnet", async () => {
    const { sdk, create } = fakeSdk([{}]);
    const client = new AnthropicPlannerClient({ sdk });
    await client.createPlan({ system: "sys", messages: [{ role: "user", content: "hi" }] });
    expect(create.mock.calls[0][0].model).toBe("claude-sonnet-4-6");
  });

  it("honors the JAB_AI_MODEL_PLANNER env override (resolved per call)", async () => {
    vi.stubEnv("JAB_AI_MODEL_PLANNER", "claude-haiku-4-5-20251001");
    const { sdk, create } = fakeSdk([{}]);
    const client = new AnthropicPlannerClient({ sdk });
    await client.createPlan({ system: "sys", messages: [{ role: "user", content: "hi" }] });
    expect(create.mock.calls[0][0].model).toBe("claude-haiku-4-5-20251001");
  });

  it("uses the injected sdk instead of constructing its own", async () => {
    const { sdk, create } = fakeSdk([{}]);
    const client = new AnthropicPlannerClient({ sdk });
    await client.createPlan({ system: "sys", messages: [{ role: "user", content: "hi" }] });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
