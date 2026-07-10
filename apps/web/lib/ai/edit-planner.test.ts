import { describe, it, expect, vi, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  planEdit,
  parsePlannerToolUse,
  stableHeadSlice,
  buildSystemPromptForTest,
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
  blockTypes: [{ blockName: "core/cover", label: "Cover", tier: "visual", occurrenceCount: 4, pageCount: 1, pageCountIsFloor: false }],
  pageSlugs: ["home"],
  shell: { header: true, footer: false },
  tokens: { colors: [], fonts: [], sizes: [] },
};

function mockClient(toolInput: Record<string, unknown>): PlannerClient {
  return {
    async createPlan() {
      return {
        toolInput,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
        stopReason: "tool_use" as const,
        retriedForMaxTokens: false,
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
      tokenDelta: null,
      revertIntent: null,
      revertVersion: null,
      batch: null,
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

describe("parsePlannerToolUse — tokenDelta", () => {
  it("parses a tokens plan with a token delta", () => {
    const plan = parsePlannerToolUse({
      needsClarification: false, scope: "tokens", target: "color:primary",
      action: "Set primary to #c00", regenerationPrompt: "", clarifyingQuestion: null,
      tokenDelta: { colors: [{ slug: "primary", color: "#c00" }] },
    });
    expect(plan.scope).toBe("tokens");
    expect(plan.tokenDelta).toEqual({ colors: [{ slug: "primary", color: "#c00" }] });
  });
  it("defaults tokenDelta to null when absent", () => {
    const plan = parsePlannerToolUse({ needsClarification: true, clarifyingQuestion: "?" });
    expect(plan.tokenDelta).toBeNull();
  });
});

describe("parsePlannerToolUse — revert fields", () => {
  it("coerces revertIntent and revertVersion", () => {
    const plan = parsePlannerToolUse({
      needsClarification: false, scope: "component", target: "", action: "Undo the last change",
      regenerationPrompt: "", clarifyingQuestion: null, tokenDelta: null,
      revertIntent: "to_version", revertVersion: 10,
    });
    expect(plan.revertIntent).toBe("to_version");
    expect(plan.revertVersion).toBe(10);
  });

  it("defaults missing/invalid revert fields to null", () => {
    const plan = parsePlannerToolUse({
      needsClarification: false, scope: "component", target: "x", action: "y",
      regenerationPrompt: "z", clarifyingQuestion: null, tokenDelta: null,
    });
    expect(plan.revertIntent).toBeNull();
    expect(plan.revertVersion).toBeNull();
  });

  it("rejects a bogus revertIntent value", () => {
    const plan = parsePlannerToolUse({
      needsClarification: false, scope: "component", target: "x", action: "y",
      regenerationPrompt: "z", clarifyingQuestion: null, tokenDelta: null,
      revertIntent: "delete_everything", revertVersion: "not a number",
    });
    expect(plan.revertIntent).toBeNull();
    expect(plan.revertVersion).toBeNull();
  });
});

describe("parsePlannerToolUse — batch", () => {
  it("coerces a well-formed batch", () => {
    const plan = parsePlannerToolUse({
      needsClarification: true, clarifyingQuestion: "These 3 share it — apply to all?",
      batch: { remaining: ["acf/featured-beer", "acf/featured-news"], guidance: "uniform View More" },
    });
    expect(plan.batch).toEqual({
      remaining: ["acf/featured-beer", "acf/featured-news"],
      guidance: "uniform View More",
    });
  });
  it("defaults batch to null when absent", () => {
    const plan = parsePlannerToolUse({ needsClarification: true, clarifyingQuestion: "?" });
    expect(plan.batch).toBeNull();
  });
  it("nulls a malformed batch", () => {
    const plan = parsePlannerToolUse({
      needsClarification: false, scope: "component", target: "acf/x", action: "y",
      regenerationPrompt: "z", batch: { remaining: "not-an-array", guidance: "g" },
    });
    expect(plan.batch).toBeNull();
  });
});

describe("parsePlannerToolUse — strips leaked tool-call markup from user-facing text", () => {
  // A planner LLM can emit literal tool-call syntax as the VALUE of a string
  // field (a strict tool-use grammar guarantees "valid JSON string", not "safe
  // to render as chat"). Both clarifyingQuestion AND action reach the user
  // verbatim via chat-turn-outcome, so both must be scrubbed at the parse
  // boundary — not just `action` inside validateEditPlan (which short-circuits
  // on needsClarification and never sees clarifyingQuestion). Regression: the
  // observed leak was `</parameter>` + `<parameter name="tokenDelta">null` in a
  // clarifying question.
  const CLOSE_PARAM = "</" + "parameter>";
  const OPEN_PARAM = "<" + 'parameter name="tokenDelta">null';

  it("scrubs tool markup out of clarifyingQuestion (the reported leak)", () => {
    const leaked = `One component at a time is fine. Also what is ${CLOSE_PARAM}\n${OPEN_PARAM}`;
    const plan = parsePlannerToolUse({ needsClarification: true, clarifyingQuestion: leaked });
    expect(plan.clarifyingQuestion).not.toContain("parameter");
    expect(plan.clarifyingQuestion).not.toContain("<");
    // The human-readable prose survives.
    expect(plan.clarifyingQuestion).toContain("One component at a time");
  });

  it("scrubs tool markup out of action", () => {
    const leaked = `Restyle the header ${CLOSE_PARAM}`;
    const plan = parsePlannerToolUse({
      needsClarification: false, scope: "component", target: "header",
      action: leaked, regenerationPrompt: "z", clarifyingQuestion: null,
    });
    expect(plan.action).not.toContain("parameter");
    expect(plan.action).toContain("Restyle the header");
  });

  it("leaves clean text byte-identical", () => {
    const clean = "Which section did you mean — the header or the footer?";
    const plan = parsePlannerToolUse({ needsClarification: true, clarifyingQuestion: clean });
    expect(plan.clarifyingQuestion).toBe(clean);
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
          stopReason: "tool_use" as const,
          retriedForMaxTokens: false,
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
          stopReason: "tool_use" as const,
          retriedForMaxTokens: false,
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

describe("AnthropicPlannerClient stop_reason handling", () => {
  it("retries ONCE at max_tokens=2048 when the first attempt truncates, accumulating usage and keeping cache markers", async () => {
    const { sdk, create } = fakeSdk([
      { stop_reason: "max_tokens", content: [] },
      {}, // healthy tool_use response
    ]);
    const client = new AnthropicPlannerClient({ sdk });
    const result = await client.createPlan({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].max_tokens).toBe(1024);
    expect(create.mock.calls[1][0].max_tokens).toBe(2048);
    // cache marker present on the RETRY too (never drop it on retry)
    expect(create.mock.calls[1][0].system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(result.retriedForMaxTokens).toBe(true);
    expect(result.stopReason).toBe("tool_use");
    // usage accumulated across BOTH attempts (true spend, not just the winner)
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(40);
  });

  it("discards a parseable-but-TRUNCATED tool input when the retry also hits max_tokens", async () => {
    // The dangerous variant: a max_tokens response that still carries a
    // tool_use block whose input parses — e.g. a cut-off regenerationPrompt.
    // Trusting it would dispatch a real edit from half an instruction.
    const truncatedInput = {
      needsClarification: false,
      scope: "component",
      target: "core/cover",
      action: "Regenerate the Cover",
      regenerationPrompt: "make the he",
      clarifyingQuestion: null,
    };
    const truncated = {
      stop_reason: "max_tokens",
      content: [{ type: "tool_use", id: "tu_t", name: "emit_edit_plan", input: truncatedInput }],
    };
    const { sdk, create } = fakeSdk([truncated, truncated]);
    const client = new AnthropicPlannerClient({ sdk });
    const result = await client.createPlan({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(create).toHaveBeenCalledTimes(2); // exactly one retry, never more
    expect(result.stopReason).toBe("max_tokens");
    expect(result.retriedForMaxTokens).toBe(true);
    // the truncated input was NOT trusted
    expect(result.toolInput.needsClarification).toBe(true);
  });

  it("does not retry on a healthy tool_use stop_reason", async () => {
    const { sdk, create } = fakeSdk([{}]);
    const client = new AnthropicPlannerClient({ sdk });
    const result = await client.createPlan({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("tool_use");
    expect(result.retriedForMaxTokens).toBe(false);
  });
});

describe("planEdit plannerMeta threading", () => {
  it("returns plannerMeta from the client result", async () => {
    const client: PlannerClient = {
      async createPlan() {
        return {
          toolInput: { needsClarification: true, clarifyingQuestion: "?" },
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          stopReason: "max_tokens" as const,
          retriedForMaxTokens: true,
        };
      },
    };
    const { plannerMeta } = await planEdit({
      messages: [{ role: "user", content: "hi" }],
      siteMap,
      client,
    });
    expect(plannerMeta).toEqual({ stopReason: "max_tokens", retriedForMaxTokens: true });
  });
});

describe("buildSystemPrompt blast radius", () => {
  const MAP: SiteMap = {
    blockTypes: [{ blockName: "core/cover", label: "Cover", tier: "visual", occurrenceCount: 5, pageCount: 3, pageCountIsFloor: false }],
    pageSlugs: ["home", "about", "contact"],
    shell: { header: true, footer: true },
    tokens: { colors: [], fonts: [], sizes: [] },
  };

  it("states the distinct page count, never the raw instance count", () => {
    const prompt = buildSystemPromptForTest(MAP);
    expect(prompt).toMatch(/Cover.*3 page/s);
    expect(prompt).not.toMatch(/appears 5 times/);
  });

  it("says 'at least N' when the page count is a floor (capped inventory)", () => {
    const capped: SiteMap = {
      blockTypes: [{ blockName: "core/cover", label: "Cover", tier: "visual", occurrenceCount: 200, pageCount: 50, pageCountIsFloor: true }],
      pageSlugs: [],
      shell: { header: true, footer: true },
      tokens: { colors: [], fonts: [], sizes: [] },
    };
    expect(buildSystemPromptForTest(capped)).toMatch(/at least 50 pages/);
  });
});

describe("buildSystemPrompt design tokens", () => {
  it("lists editable design tokens and teaches scope=tokens", () => {
    const map = {
      blockTypes: [], pageSlugs: ["home"], shell: { header: true, footer: false },
      tokens: {
        colors: [{ slug: "primary", color: "#c00" }],
        fonts: [{ slug: "heading", fontFamily: "Anton" }],
        sizes: [{ slug: "xl", size: "2rem" }],
      },
    } as any;
    const p = buildSystemPromptForTest(map);
    expect(p).toContain("tokens");
    expect(p).toContain("primary");
    expect(p).toContain("#c00");
    expect(p).toContain("heading");
  });
});

describe("buildSystemPrompt revert", () => {
  it("instructs the planner to use revertIntent for undo/revert requests", () => {
    const siteMap = {
      blockTypes: [], pageSlugs: [], shell: { header: true, footer: false },
      tokens: { colors: [], fonts: [], sizes: [] },
    } as unknown as import("@/lib/jab/site-map").SiteMap;
    const prompt = buildSystemPromptForTest(siteMap);
    expect(prompt.toLowerCase()).toContain("revert");
    expect(prompt).toContain("revertIntent");
    expect(prompt).toContain("undo_last");
  });
});
