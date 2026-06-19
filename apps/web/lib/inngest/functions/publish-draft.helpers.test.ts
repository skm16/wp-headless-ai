import { describe, it, expect } from "vitest";
import { unitKeyToStoragePath, buildPublishDraftConfig } from "./publish-draft.helpers";
import { draftComponentName } from "@/lib/draft/bundle";
import { buildShellStoragePath } from "@/lib/ai/persist-shell-generation";

describe("unitKeyToStoragePath", () => {
  it("maps shell keys to the project shell path", () => {
    expect(unitKeyToStoragePath("shell:header", "B")).toBe(buildShellStoragePath("B", "header"));
    expect(unitKeyToStoragePath("shell:footer", "B")).toBe(buildShellStoragePath("B", "footer"));
  });
  it("maps a block name to the component path", () => {
    expect(unitKeyToStoragePath("core/cover", "B")).toBe(
      `builds/B/components/${draftComponentName("core/cover")}.tsx`,
    );
  });
});

describe("buildPublishDraftConfig", () => {
  it("carries source config + union slugs + tokens", () => {
    const cfg = buildPublishDraftConfig({
      draftId: "d",
      baseBuildId: "b",
      sourceConfig: { front_page_slug: "home", show_on_front: "page", locale: "de_DE" },
      changedSlugs: ["home", "about"],
      tokens: { colorPalette: [{ slug: "primary", color: "#c00" }] },
    });
    expect(cfg.mode).toBe("publish_draft");
    expect(cfg.source_build_id).toBe("b");
    expect(cfg.changed_slugs).toEqual(["home", "about"]);
    expect(cfg.front_page_slug).toBe("home");
    expect(cfg.show_on_front).toBe("page");
    expect(cfg.locale).toBe("de_DE");
    expect(cfg.tokens?.colorPalette).toEqual([{ slug: "primary", color: "#c00" }]);
  });
  it("omits tokens when null", () => {
    const cfg = buildPublishDraftConfig({
      draftId: "d",
      baseBuildId: "b",
      sourceConfig: {},
      changedSlugs: [],
      tokens: null,
    });
    expect(cfg.tokens).toBeUndefined();
  });
});
