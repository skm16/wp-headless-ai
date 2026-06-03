import { describe, it, expect } from "vitest";
import {
  validateEditInput,
  WorkspaceEditError,
} from "@/lib/jab/workspace-edit-validation";

describe("validateEditInput", () => {
  it("accepts a valid component edit", () => {
    expect(() =>
      validateEditInput({
        scope: "component",
        target: "core/heading",
        prompt: "Make the heading larger",
      }),
    ).not.toThrow();
  });

  it("accepts a valid shell edit (header/footer)", () => {
    expect(() =>
      validateEditInput({
        scope: "shell",
        target: "header",
        prompt: "Tighten the spacing around the logo",
      }),
    ).not.toThrow();
    expect(() =>
      validateEditInput({
        scope: "shell",
        target: "footer",
        prompt: "Move the social icons to the right",
      }),
    ).not.toThrow();
  });

  it("rejects scope='page' with a clear message in v1", () => {
    try {
      validateEditInput({
        scope: "component" as "component",
        rawScope: "page",
        target: "homepage",
        prompt: "Some change",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceEditError);
      expect((err as WorkspaceEditError).code).toBe("page_scope_unsupported");
    }
  });

  it("rejects an unknown scope value", () => {
    try {
      validateEditInput({
        scope: "component" as "component",
        rawScope: "wholesite",
        target: "anything",
        prompt: "Some change",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceEditError);
      expect((err as WorkspaceEditError).code).toBe("invalid_scope");
    }
  });

  it("rejects shell target other than header/footer", () => {
    try {
      validateEditInput({
        scope: "shell",
        target: "navbar",
        prompt: "Slim down the nav",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceEditError);
      expect((err as WorkspaceEditError).code).toBe("invalid_target");
    }
  });

  it("rejects an empty component target", () => {
    try {
      validateEditInput({
        scope: "component",
        target: "   ",
        prompt: "A change",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as WorkspaceEditError).code).toBe("invalid_target");
    }
  });

  it("rejects a prompt under 5 characters", () => {
    try {
      validateEditInput({
        scope: "shell",
        target: "header",
        prompt: "tiny",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as WorkspaceEditError).code).toBe("prompt_too_short");
    }
  });
});
