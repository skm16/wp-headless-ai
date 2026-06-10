import { describe, it, expect } from "vitest";
import { ensureValue } from "./credentials.js";

describe("ensureValue", () => {
  it("returns the trimmed value when provided", async () => {
    await expect(ensureValue("  secret  ", "password")).resolves.toBe("secret");
  });

  it("returns an already-clean value untouched", async () => {
    await expect(ensureValue("abc", "user")).resolves.toBe("abc");
  });
});
