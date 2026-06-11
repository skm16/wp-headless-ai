import { describe, it, expect } from "vitest";
import { spendModeBanner, pipelineContinuesNote } from "./smoke-banners";

describe("spendModeBanner", () => {
  it("mock mode states $0 and the dual-process caveat", () => {
    const lines = spendModeBanner({ mockMode: true, skipShellRegen: false }).join("\n");
    expect(lines).toContain("DRY RUN");
    expect(lines).toContain("JAB_GENERATE_MOCK=1");
    expect(lines).toContain("restart `pnpm dev`");
    expect(lines).toContain("$0");
  });

  it("live mode states the cost and offers both zero-cost paths", () => {
    const lines = spendModeBanner({ mockMode: false, skipShellRegen: false }).join("\n");
    expect(lines).toContain("LIVE RUN");
    expect(lines).toContain("JAB_GENERATE_MOCK=1");
    expect(lines).toContain("JAB_SKIP_SHELL_REGEN");
  });

  it("live mode with JAB_SKIP_SHELL_REGEN active says the shell calls are skipped", () => {
    const lines = spendModeBanner({ mockMode: false, skipShellRegen: true }).join("\n");
    expect(lines).toContain("JAB_SKIP_SHELL_REGEN=1");
    expect(lines).toContain("skipped");
  });
});

describe("pipelineContinuesNote", () => {
  it("after components: names the shell calls + deploy that still run", () => {
    const note = pipelineContinuesNote("components");
    expect(note).toContain("pipeline continues (compose shells + deploy)");
    expect(note).toContain("AFTER this PASS");
  });

  it("after compose: names the deploy + verify that still run", () => {
    const note = pipelineContinuesNote("compose");
    expect(note).toContain("pipeline continues (deploy + verify)");
    expect(note).toContain("AFTER this PASS");
  });
});
