import { describe, it, expect, vi, afterEach } from "vitest";
import { envKeyFor, getModelFor } from "./model";

const ENV_KEYS = [
  "JAB_AI_MODEL",
  "JAB_AI_MODEL_DESIGN",
  "JAB_AI_MODEL_CODEGEN",
  "JAB_AI_MODEL_COMPONENT_VISUAL",
  "JAB_AI_MODEL_COMPONENT_STANDARD",
  "JAB_AI_MODEL_COMPONENT_TRIVIAL",
  "JAB_AI_MODEL_SHELL",
  "JAB_AI_MODEL_PLANNER",
  "JAB_AI_MODEL_FIDELITY_VISION",
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.restoreAllMocks();
});

describe("envKeyFor — hyphen-safe env key builder", () => {
  it("maps hyphenated tasks to underscore env keys", () => {
    expect(envKeyFor("component-visual")).toBe("JAB_AI_MODEL_COMPONENT_VISUAL");
    expect(envKeyFor("component-standard")).toBe("JAB_AI_MODEL_COMPONENT_STANDARD");
    expect(envKeyFor("component-trivial")).toBe("JAB_AI_MODEL_COMPONENT_TRIVIAL");
    expect(envKeyFor("fidelity-vision")).toBe("JAB_AI_MODEL_FIDELITY_VISION");
  });

  it("passes through single-word tasks", () => {
    expect(envKeyFor("design")).toBe("JAB_AI_MODEL_DESIGN");
    expect(envKeyFor("shell")).toBe("JAB_AI_MODEL_SHELL");
    expect(envKeyFor("planner")).toBe("JAB_AI_MODEL_PLANNER");
  });
});

describe("getModelFor — defaults per CONTRACTS", () => {
  it("resolves the documented default for every task", () => {
    expect(getModelFor("design")).toBe("claude-haiku-4-5-20251001");
    expect(getModelFor("codegen")).toBe("claude-sonnet-4-6");
    expect(getModelFor("component-visual")).toBe("claude-sonnet-4-6");
    expect(getModelFor("component-standard")).toBe("claude-sonnet-4-6");
    expect(getModelFor("component-trivial")).toBe("claude-haiku-4-5-20251001");
    expect(getModelFor("shell")).toBe("claude-sonnet-4-6");
    expect(getModelFor("planner")).toBe("claude-sonnet-4-6");
    expect(getModelFor("fidelity-vision")).toBe("claude-sonnet-4-6");
  });

  it("the dead 'content' task is gone from the union (compile-time pin)", () => {
    // @ts-expect-error — "content" was deleted from TASKS in Phase 1; if
    // this annotation stops erroring under `pnpm typecheck`, the dead task
    // came back.
    const removed = () => getModelFor("content");
    expect(typeof removed).toBe("function");
  });
});

describe("getModelFor — per-task override via hyphen-fixed key", () => {
  it("honors JAB_AI_MODEL_COMPONENT_VISUAL", () => {
    process.env.JAB_AI_MODEL_COMPONENT_VISUAL = "claude-haiku-4-5-20251001";
    expect(getModelFor("component-visual")).toBe("claude-haiku-4-5-20251001");
  });

  it("an empty-string per-task var throws (set-but-invalid, never falls through)", () => {
    process.env.JAB_AI_MODEL_SHELL = "";
    expect(() => getModelFor("shell")).toThrow(/JAB_AI_MODEL_SHELL/);
  });
});

describe("ALLOWED list refresh", () => {
  it("accepts claude-opus-4-8", () => {
    process.env.JAB_AI_MODEL_CODEGEN = "claude-opus-4-8";
    expect(getModelFor("codegen")).toBe("claude-opus-4-8");
  });

  it("rejects the retired claude-opus-4-7 pin", () => {
    process.env.JAB_AI_MODEL_CODEGEN = "claude-opus-4-7";
    expect(() => getModelFor("codegen")).toThrow(/not in the allowed list/);
  });
});

describe("legacy global JAB_AI_MODEL warn", () => {
  it("warns once per resolution when the global moves a task off its default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.JAB_AI_MODEL = "claude-sonnet-4-6"; // design default is haiku
    expect(getModelFor("design")).toBe("claude-sonnet-4-6");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("design");
    expect(line).toContain("claude-haiku-4-5-20251001"); // the default
    expect(line).toContain("claude-sonnet-4-6"); // the override
  });

  it("does not warn when the global matches the task default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.JAB_AI_MODEL = "claude-haiku-4-5-20251001";
    expect(getModelFor("design")).toBe("claude-haiku-4-5-20251001");
    expect(warn).not.toHaveBeenCalled();
  });

  it("per-task override beats the global, with no warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.JAB_AI_MODEL = "claude-sonnet-4-6";
    process.env.JAB_AI_MODEL_DESIGN = "claude-haiku-4-5-20251001";
    expect(getModelFor("design")).toBe("claude-haiku-4-5-20251001");
    expect(warn).not.toHaveBeenCalled();
  });
});
