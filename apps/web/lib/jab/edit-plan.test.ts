import { describe, it, expect } from "vitest";
import {
  validateEditPlan,
  EDIT_PLAN_TOOL_SCHEMA,
  type EditPlan,
} from "./edit-plan";
import type { SiteMap } from "./site-map";

const siteMap: SiteMap = {
  blockTypes: [
    { blockName: "core/cover", label: "Cover", tier: "visual", occurrenceCount: 4, pageCount: 2, pageCountIsFloor: false },
    { blockName: "core/heading", label: "Heading", tier: "trivial", occurrenceCount: 9, pageCount: 2, pageCountIsFloor: false },
  ],
  pageSlugs: ["home", "about"],
  shell: { header: true, footer: false },
  tokens: { colors: [], fonts: [], sizes: [] },
};

function actionable(over: Partial<EditPlan> = {}): EditPlan {
  return {
    needsClarification: false,
    scope: "component",
    target: "core/cover",
    action: "Regenerated the Cover block on 2 page(s)",
    regenerationPrompt: "Make the hero bolder",
    clarifyingQuestion: null,
    ...over,
  } as EditPlan;
}

describe("validateEditPlan", () => {
  it("accepts an actionable component plan whose target exists", () => {
    expect(validateEditPlan(actionable(), siteMap).ok).toBe(true);
  });

  it("accepts a clarifying plan regardless of target", () => {
    const plan = actionable({ needsClarification: true, target: "", clarifyingQuestion: "Which block?" });
    expect(validateEditPlan(plan, siteMap).ok).toBe(true);
  });

  it("rejects a component plan whose target is not in the catalog (hallucinated)", () => {
    const r = validateEditPlan(actionable({ target: "core/made-up" }), siteMap);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown_target");
  });

  it("rejects scope=shell with a non-header/footer target", () => {
    const r = validateEditPlan(actionable({ scope: "shell", target: "core/cover" }), siteMap);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_shell_target");
  });

  it("rejects scope=shell targeting a shell kind that is absent (footer here)", () => {
    const r = validateEditPlan(actionable({ scope: "shell", target: "footer" }), siteMap);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("shell_absent");
  });

  it("accepts scope=shell targeting the present header", () => {
    expect(validateEditPlan(actionable({ scope: "shell", target: "header" }), siteMap).ok).toBe(true);
  });

  it("rejects an actionable plan with an empty regenerationPrompt", () => {
    const r = validateEditPlan(actionable({ regenerationPrompt: "  " }), siteMap);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("empty_guidance");
  });

  it("accepts a component edit targeting the Classic block", () => {
    const classicSiteMap: SiteMap = {
      blockTypes: [
        { blockName: "__null__", label: "Classic content", tier: "classic", occurrenceCount: 4, pageCount: 2, pageCountIsFloor: false },
      ],
      pageSlugs: ["about"],
      shell: { header: false, footer: false },
      tokens: { colors: [], fonts: [], sizes: [] },
    };
    const res = validateEditPlan(
      actionable({ target: "__null__", action: "Restyle the Classic body", regenerationPrompt: "Constrain to a max-width container" }),
      classicSiteMap,
    );
    expect(res.ok).toBe(true);
  });
});

// A SiteMap without `tokens` is fine for THIS task — validateEditPlan(tokens)
// does not read siteMap.tokens (the token summary lands in Task 3).
const baseSiteMap = { blockTypes: [], pageSlugs: [], shell: { header: true, footer: true } } as unknown as SiteMap;

describe("validateEditPlan — tokens scope", () => {
  it("accepts a valid token delta", () => {
    const plan = {
      needsClarification: false, scope: "tokens" as const, target: "color:primary",
      action: "Set primary to #c00", regenerationPrompt: "n/a", clarifyingQuestion: null,
      tokenDelta: { colors: [{ slug: "primary", color: "#c00" }] },
    } as unknown as EditPlan;
    expect(validateEditPlan(plan, baseSiteMap)).toEqual({ ok: true });
  });
  it("rejects a missing/empty token delta", () => {
    const plan = {
      needsClarification: false, scope: "tokens" as const, target: "",
      action: "x", regenerationPrompt: "n/a", clarifyingQuestion: null, tokenDelta: null,
    } as unknown as EditPlan;
    const r = validateEditPlan(plan, baseSiteMap);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_token_delta");
  });
  it("rejects an unsafe color", () => {
    const plan = {
      needsClarification: false, scope: "tokens" as const, target: "color:primary",
      action: "x", regenerationPrompt: "n/a", clarifyingQuestion: null,
      tokenDelta: { colors: [{ slug: "primary", color: "red;}" }] },
    } as unknown as EditPlan;
    expect(validateEditPlan(plan, baseSiteMap).ok).toBe(false);
  });
  it("does NOT require regenerationPrompt for tokens (deterministic apply)", () => {
    const plan = {
      needsClarification: false, scope: "tokens" as const, target: "color:primary",
      action: "Set primary", regenerationPrompt: "", clarifyingQuestion: null,
      tokenDelta: { colors: [{ slug: "primary", color: "#c00" }] },
    } as unknown as EditPlan;
    expect(validateEditPlan(plan, baseSiteMap)).toEqual({ ok: true });
  });
});

describe("EDIT_PLAN_TOOL_SCHEMA", () => {
  it("constrains scope to exactly component|shell|tokens (no deferred scopes)", () => {
    const scope = EDIT_PLAN_TOOL_SCHEMA.input_schema.properties.scope as { enum: readonly string[] };
    expect(scope.enum).toEqual(["component", "shell", "tokens"]);
  });

  it("declares strict tool use", () => {
    expect((EDIT_PLAN_TOOL_SCHEMA as { strict?: boolean }).strict).toBe(true);
  });

  it("meets the structured-outputs grammar constraints", () => {
    const schema = EDIT_PLAN_TOOL_SCHEMA.input_schema as {
      additionalProperties: boolean;
      required: readonly string[];
      properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    // strict grammar: every property key present in required
    // (clarifyingQuestion stays nullable via anyOf).
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    // no unsupported constraints anywhere in the schema
    const json = JSON.stringify(schema);
    expect(json).not.toMatch(/"minimum"|"maximum"|"minLength"|"maxLength"/);
    // no type-array unions — nullable is expressed via anyOf
    const cq = schema.properties.clarifyingQuestion as { type?: unknown; anyOf?: unknown[] };
    expect(Array.isArray(cq.type)).toBe(false);
    expect(Array.isArray(cq.anyOf)).toBe(true);
  });
});
