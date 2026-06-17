import { describe, it, expect, vi } from "vitest";
import {
  baseDraftArtifactPath,
  dispatcherRowsFromInventory,
  ensureBaseDraftArtifacts,
  draftArtifactPath,
  buildVersionedDraftArtifacts,
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
    expect(d.upload).toHaveBeenCalledWith("drafts/base/b1/bundle.js", "//bundle", "text/plain");
    expect(d.upload).toHaveBeenCalledWith("drafts/base/b1/draft.css", "/*css*/", "text/plain");
    expect(out).toEqual({ bundlePath: "drafts/base/b1/bundle.js", cssPath: "drafts/base/b1/draft.css" });
  });

  it("skips building when both artifacts already exist", async () => {
    const d = deps({ artifactExists: vi.fn(async () => true) });
    await ensureBaseDraftArtifacts({ buildId: "b1" }, d);
    expect(d.bundle).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });

  it("admits the Classic block (__null__, tier classic, ok) as an editable unit", async () => {
    const loadComponentSources = vi.fn(async () => ({
      AcfHero: "export function AcfHero(){return null;}",
      ClassicContent: "export function ClassicContent(){return null;}",
    }));
    const d = deps({
      loadInventory: vi.fn(async () => [
        { block_name: "acf/hero", tier: "visual", compile_status: "ok" },
        { block_name: "__null__", tier: "classic", compile_status: "ok" },
      ]),
      loadComponentSources,
    });
    await ensureBaseDraftArtifacts({ buildId: "b1" }, d);
    // The Classic row resolves to ClassicContent and is requested + bundled.
    const requestedNames = (loadComponentSources as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(requestedNames).toContain("ClassicContent");
    const bundleInput = (d.bundle as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(bundleInput.componentSources.ClassicContent).toContain("ClassicContent");
  });
});

describe("draftArtifactPath", () => {
  it("keys versioned artifacts by draft + version", () => {
    expect(draftArtifactPath("d1", 4, "bundle.js")).toBe("drafts/d1/v4/bundle.js");
    expect(draftArtifactPath("d1", 4, "draft.css")).toBe("drafts/d1/v4/draft.css");
  });
});

describe("buildVersionedDraftArtifacts", () => {
  it("applies unit overrides over base sources (component + shell) before bundling", async () => {
    const d = {
      artifactExists: vi.fn(async () => false),
      loadInventory: vi.fn(async () => [
        { block_name: "acf/hero", tier: "visual", compile_status: "ok" },
      ]),
      loadComponentSources: vi.fn(async () => ({ AcfHero: "export function AcfHero(){return <p>base</p>;}" })),
      loadShellSource: vi.fn(async (_b: string, kind: string) =>
        kind === "header" ? "export function Header(){return <header>base</header>;}" : null,
      ),
      loadProjectMeta: vi.fn(async () => ({ wpUrl: "https://x.com", tokens: null, themeCss: null })),
      bundle: vi.fn(async () => ({ js: "//bundle" })),
      buildCss: vi.fn(async () => "/*css*/"),
      upload: vi.fn(async () => {}),
    };
    const out = await buildVersionedDraftArtifacts(
      {
        draftId: "d1",
        nextVersion: 4,
        baseBuildId: "b1",
        overrides: new Map([
          ["acf/hero", "export function AcfHero(){return <p>edited</p>;}"],
          ["shell:header", "export function Header(){return <header>edited</header>;}"],
        ]),
      },
      d,
    );
    const bundleInput = (d.bundle as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(bundleInput.componentSources.AcfHero).toContain("edited");
    expect(bundleInput.headerSource).toContain("edited");
    expect(bundleInput.footerSource).toBeNull(); // no override + null base → null (spec §req 4 fallback)
    expect(d.upload).toHaveBeenCalledWith("drafts/d1/v4/bundle.js", "//bundle", "text/plain");
    expect(d.upload).toHaveBeenCalledWith("drafts/d1/v4/draft.css", "/*css*/", "text/plain");
    expect(out).toEqual({ bundlePath: "drafts/d1/v4/bundle.js", cssPath: "drafts/d1/v4/draft.css" });
  });

  it("admits + applies an override for the Classic block (ClassicContent)", async () => {
    const loadComponentSources = vi.fn(async () => ({
      ClassicContent: "export function ClassicContent(){return <div className=\"base\" />;}",
    }));
    const d = {
      artifactExists: vi.fn(async () => false),
      loadInventory: vi.fn(async () => [
        { block_name: "__null__", tier: "classic", compile_status: "ok" },
      ]),
      loadComponentSources,
      loadShellSource: vi.fn(async () => null),
      loadProjectMeta: vi.fn(async () => ({ wpUrl: "https://x.com", tokens: null, themeCss: null })),
      bundle: vi.fn(async () => ({ js: "//bundle" })),
      buildCss: vi.fn(async () => "/*css*/"),
      upload: vi.fn(async () => {}),
    };
    await buildVersionedDraftArtifacts(
      {
        draftId: "d2",
        nextVersion: 2,
        baseBuildId: "b1",
        overrides: new Map([["__null__", "export function ClassicContent(){return <div className=\"edited\" />;}"]]),
      },
      d,
    );
    // The Classic component is requested under its ClassicContent name...
    const requestedNames = (loadComponentSources as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(requestedNames).toContain("ClassicContent");
    // ...and the __null__ override keys to ClassicContent in the bundle input.
    const bundleInput = (d.bundle as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(bundleInput.componentSources.ClassicContent).toContain("edited");
  });
});
