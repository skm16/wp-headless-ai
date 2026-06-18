import { describe, it, expect } from "vitest";
import {
  validateEditInput,
  WorkspaceEditError,
  MAX_PROMPT_CHARS,
} from "./workspace-edit-validation";

describe("validateEditInput — prompt length cap", () => {
  const base = { scope: "component" as const, target: "core/cover" };

  it("accepts a prompt at the cap", () => {
    expect(() =>
      validateEditInput({ ...base, prompt: "x".repeat(MAX_PROMPT_CHARS) }),
    ).not.toThrow();
  });

  it("rejects a prompt over the cap with prompt_too_long", () => {
    try {
      validateEditInput({ ...base, prompt: "x".repeat(MAX_PROMPT_CHARS + 1) });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceEditError);
      expect((err as WorkspaceEditError).code).toBe("prompt_too_long");
    }
  });
});

describe("validateEditInput — tokens scope", () => {
  it("accepts scope=tokens without a block target", () => {
    expect(() =>
      validateEditInput({ scope: "tokens", target: "color:primary", prompt: "make it red" }),
    ).not.toThrow();
  });
  it("does not require a non-empty target for tokens", () => {
    expect(() =>
      validateEditInput({ scope: "tokens", target: "", prompt: "make it red" }),
    ).not.toThrow();
  });
  it("still enforces the prompt-length floor for tokens", () => {
    try {
      validateEditInput({ scope: "tokens", target: "color:primary", prompt: "red" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceEditError);
      expect((err as WorkspaceEditError).code).toBe("prompt_too_short");
    }
  });
});
