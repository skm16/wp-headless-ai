import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// vitest runs with cwd = apps/web (vitest.config.ts lives there).
function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("smoke zero-spend wiring (scripts run main() on import — pin by source)", () => {
  it("smoke-generate-components verifies block_inventory token columns in mock mode", () => {
    const s = src("scripts/smoke-generate-components.ts");
    expect(s).toContain("findNonZeroSpend");
    expect(s).toContain("input_tokens_cache_creation");
  });

  it("smoke-build verifies block_inventory AND shell_generations token columns in mock mode", () => {
    const s = src("scripts/smoke-build.ts");
    expect(s).toContain("findNonZeroSpend");
    expect(s).toContain("shell_generations");
    expect(s).toContain("input_tokens_cache_creation");
  });
});

describe("smoke banner / continuation wiring", () => {
  it("smoke-compose-site prints the spend-mode banner and mentions JAB_SKIP_SHELL_REGEN", () => {
    const s = src("scripts/smoke-compose-site.ts");
    expect(s).toContain("spendModeBanner");
    expect(s).toContain("JAB_SKIP_SHELL_REGEN");
    expect(s).toContain("pipelineContinuesNote");
  });

  it("smoke-generate-components prints the pipeline-continues note", () => {
    expect(src("scripts/smoke-generate-components.ts")).toContain("pipelineContinuesNote");
  });
});
