import { describe, it, expect } from "vitest";
import { blockInventory, shellGenerations, projects } from "./schema";

/**
 * Pins the drizzle mirror of migration 0034_ai_cost_telemetry.sql.
 * If a column rename drifts between the .sql DDL and schema.ts, telemetry
 * writes silently miss — these assertions catch the drift class.
 */
describe("migration 0034 — AI cost telemetry columns", () => {
  it("block_inventory carries cache-creation, failure-kind, and carry-forward columns", () => {
    expect(blockInventory.inputTokensCacheCreation.name).toBe("input_tokens_cache_creation");
    expect(blockInventory.failureKind.name).toBe("failure_kind");
    expect(blockInventory.promptInputsHash.name).toBe("prompt_inputs_hash");
    expect(blockInventory.reusedFromBuildId.name).toBe("reused_from_build_id");
  });

  it("shell_generations carries cache-creation and failure-kind columns", () => {
    expect(shellGenerations.inputTokensCacheCreation.name).toBe("input_tokens_cache_creation");
    expect(shellGenerations.failureKind.name).toBe("failure_kind");
  });

  it("projects carries design_scrape_usage", () => {
    expect(projects.designScrapeUsage.name).toBe("design_scrape_usage");
  });
});
