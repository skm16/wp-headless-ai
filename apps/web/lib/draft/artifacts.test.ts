import { describe, it, expect, vi } from "vitest";
import {
  baseDraftArtifactPath,
  dispatcherRowsFromInventory,
  ensureBaseDraftArtifacts,
  type ArtifactDeps,
} from "./artifacts";

describe("baseDraftArtifactPath", () => {
  it("keys phase-1 artifacts by buildId", () => {
    expect(baseDraftArtifactPath("b1", "bundle.js")).toBe("drafts/base/b1/bundle.js");
    expect(baseDraftArtifactPath("b1", "draft.css")).toBe("drafts/base/b1/draft.css");
  });
});

describe("dispatcherRowsFromInventory", () => {
  it("passes through the dispatcher-relevant columns", () => {
    const rows = dispatcherRowsFromInventory([
      { block_name: "acf/hero", tier: "visual", compile_status: "ok" },
      { block_name: null, tier: "passthrough", compile_status: null },
    ]);
    expect(rows).toEqual([
      { blockName: "acf/hero", tier: "visual", compileStatus: "ok" },
      { blockName: null, tier: "passthrough", compileStatus: null },
    ]);
  });
});

describe("ensureBaseDraftArtifacts", () => {
  function deps(over: Partial<ArtifactDeps> = {}): ArtifactDeps {
    return {
      artifactExists: vi.fn(async () => false),
      loadInventory: vi.fn(async () => [
        { block_name: "acf/hero", tier: "visual", compile_status: "ok" },
      ]),
      loadComponentSources: vi.fn(async () => ({ AcfHero: "export function AcfHero(){return null;}" })),
      loadShellSource: vi.fn(async () => null),
      loadProjectMeta: vi.fn(async () => ({ wpUrl: "https://example.com", tokens: null, themeCss: null })),
      bundle: vi.fn(async () => ({ js: "//bundle" })),
      buildCss: vi.fn(async () => "/*css*/"),
      upload: vi.fn(async () => {}),
      ...over,
    };
  }

  it("builds and uploads bundle + css when artifacts are missing", async () => {
    const d = deps();
    const out = await ensureBaseDraftArtifacts({ buildId: "b1" }, d);
    expect(d.bundle).toHaveBeenCalled();
    expect(d.upload).toHaveBeenCalledWith("drafts/base/b1/bundle.js", "//bundle", "text/javascript");
    expect(d.upload).toHaveBeenCalledWith("drafts/base/b1/draft.css", "/*css*/", "text/css");
    expect(out).toEqual({ bundlePath: "drafts/base/b1/bundle.js", cssPath: "drafts/base/b1/draft.css" });
  });

  it("skips building when both artifacts already exist", async () => {
    const d = deps({ artifactExists: vi.fn(async () => true) });
    await ensureBaseDraftArtifacts({ buildId: "b1" }, d);
    expect(d.bundle).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });
});
