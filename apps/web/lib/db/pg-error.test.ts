import { describe, it, expect } from "vitest";
import { isUniqueViolation, UNIQUE_VIOLATION } from "@/lib/db/pg-error";

describe("UNIQUE_VIOLATION", () => {
  it("is the Postgres unique-violation SQLSTATE", () => {
    expect(UNIQUE_VIOLATION).toBe("23505");
  });
});

describe("isUniqueViolation", () => {
  it("returns true for a PostgrestError with code 23505", () => {
    expect(isUniqueViolation({ code: "23505", message: "duplicate key" })).toBe(true);
  });

  it("returns false for a different Postgres code (PGRST116 not-found)", () => {
    expect(isUniqueViolation({ code: "PGRST116", message: "no rows" })).toBe(false);
  });

  it("returns false for a foreign-key violation (23503)", () => {
    expect(isUniqueViolation({ code: "23503", message: "fk violation" })).toBe(false);
  });

  it("returns false for null / undefined", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it("returns false for an error without a code field", () => {
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation({ message: "no code here" })).toBe(false);
  });

  it("returns false for a non-object", () => {
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation(23505)).toBe(false);
  });
});
