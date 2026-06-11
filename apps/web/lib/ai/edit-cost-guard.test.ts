import { describe, it, expect } from "vitest";
import {
  evaluateEditBudget,
  EDIT_RATE_WINDOW_MS,
  MAX_EDITS_PER_WINDOW,
  MAX_CHAT_MESSAGES_PER_WINDOW,
  PLANNER_MAX_TURNS,
  EditBudgetError,
  estimateTokens,
} from "./edit-cost-guard";

describe("evaluateEditBudget", () => {
  const now = Date.parse("2026-06-03T12:00:00Z");
  const recent = new Date(now - 1000).toISOString();
  const old = new Date(now - EDIT_RATE_WINDOW_MS - 1000).toISOString();

  it("ok under both limits", () => {
    expect(
      evaluateEditBudget({
        now,
        recentEditCreatedAts: [recent],
        recentMessageCreatedAts: [recent, recent],
      }),
    ).toEqual({ ok: true });
  });

  it("refuses when too many edits in the window", () => {
    const ats = Array.from({ length: MAX_EDITS_PER_WINDOW }, () => recent);
    const r = evaluateEditBudget({ now, recentEditCreatedAts: ats, recentMessageCreatedAts: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("rate_limited_edits");
  });

  it("refuses when too many chat messages in the window", () => {
    const ats = Array.from({ length: MAX_CHAT_MESSAGES_PER_WINDOW }, () => recent);
    const r = evaluateEditBudget({ now, recentEditCreatedAts: [], recentMessageCreatedAts: ats });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("rate_limited_messages");
  });

  it("ignores timestamps outside the window", () => {
    const ats = Array.from({ length: MAX_EDITS_PER_WINDOW + 5 }, () => old);
    expect(evaluateEditBudget({ now, recentEditCreatedAts: ats, recentMessageCreatedAts: [] }).ok).toBe(true);
  });

  it("exposes a planner-context turn cap", () => {
    expect(PLANNER_MAX_TURNS).toBeGreaterThanOrEqual(8);
  });

  it("EditBudgetError carries a code", () => {
    const e = new EditBudgetError("rate_limited_edits", "slow down");
    expect(e.code).toBe("rate_limited_edits");
    expect(e).toBeInstanceOf(Error);
  });
});

describe("estimateTokens", () => {
  it("estimates ceil(length / 4) tokens", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(4000))).toBe(1000);
  });
});

describe("EditBudgetError cost-cap codes", () => {
  it("accepts planner_cost_cap and edit_cost_cap", () => {
    expect(new EditBudgetError("planner_cost_cap", "m").code).toBe("planner_cost_cap");
    expect(new EditBudgetError("edit_cost_cap", "m").code).toBe("edit_cost_cap");
  });
});
