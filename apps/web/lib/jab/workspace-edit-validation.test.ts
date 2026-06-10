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
