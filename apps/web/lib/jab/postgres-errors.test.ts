import { describe, it, expect } from "vitest";
import { isUniqueViolation } from "./postgres-errors";

describe("isUniqueViolation", () => {
  it("returns true for Postgres SQLSTATE 23505", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("returns false for other Postgres codes", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation({ code: "PGRST116" })).toBe(false);
  });

  it("returns false for null / non-object inputs", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
  });
});
