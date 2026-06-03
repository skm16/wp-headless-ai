import { describe, it, expect } from "vitest";
import { formatErrorText } from "./shared-failure";

describe("formatErrorText", () => {
  it("returns the message of an Error", () => {
    expect(formatErrorText(new Error("boom"))).toBe("boom");
  });

  it("returns strings as-is", () => {
    expect(formatErrorText("plain string")).toBe("plain string");
  });

  it("JSON-stringifies plain objects", () => {
    expect(formatErrorText({ code: 500, msg: "x" })).toBe('{"code":500,"msg":"x"}');
  });

  it("falls back to String(err) on circular structures", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(formatErrorText(obj)).toMatch(/object/i);
  });
});
