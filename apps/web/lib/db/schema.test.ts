import { describe, it, expect } from "vitest";
import { fidelityReports } from "./schema";

describe("fidelityReports schema", () => {
  it("has a viewport_scores jsonb column", () => {
    // Drizzle exposes columns on the table object keyed by JS property name.
    const col = (fidelityReports as unknown as { viewportScores?: { name: string } }).viewportScores;
    expect(col).toBeDefined();
    expect(col!.name).toBe("viewport_scores");
  });
});
