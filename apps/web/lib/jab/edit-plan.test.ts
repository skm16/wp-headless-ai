import { describe, it, expect } from "vitest";
import {
  validateEditPlan,
  EDIT_PLAN_TOOL_SCHEMA,
  type EditPlan,
} from "./edit-plan";
import type { SiteMap } from "./site-map";

const siteMap: SiteMap = {
  blockTypes: [
    { blockName: "core/cover", label: "Cover", tier: "visual", occurrenceCount: 4 },
    { blockName: "core/heading", label: "Heading", tier: "trivial", occurrenceCount: 9 },
  ],
  pageSlugs: ["home", "about"],
  shell: { header: true, footer: false },
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
});

describe("EDIT_PLAN_TOOL_SCHEMA", () => {
  it("constrains scope to exactly component|shell (no deferred scopes)", () => {
    const scope = EDIT_PLAN_TOOL_SCHEMA.input_schema.properties.scope as { enum: readonly string[] };
    expect(scope.enum).toEqual(["component", "shell"]);
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
