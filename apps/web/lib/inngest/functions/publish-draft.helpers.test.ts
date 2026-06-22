import { describe, it, expect, vi } from "vitest";
import {
  unitKeyToStoragePath,
  buildPublishDraftConfig,
  cloneStorageObjectsFailClosed,
} from "./publish-draft.helpers";
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

describe("cloneStorageObjectsFailClosed (C3)", () => {
  const paths = [
    "builds/base_1/components/Hero.tsx",
    "builds/base_1/source/home/1280.png",
  ];

  it("copies every object, rewriting base→new build path, and returns the count", async () => {
    const copy = vi.fn().mockResolvedValue({ error: null });
    const copied = await cloneStorageObjectsFailClosed(paths, "base_1", "new_1", copy);

    expect(copied).toBe(2);
    expect(copy).toHaveBeenCalledWith(
      "builds/base_1/components/Hero.tsx",
      "builds/new_1/components/Hero.tsx",
    );
    expect(copy).toHaveBeenCalledWith(
      "builds/base_1/source/home/1280.png",
      "builds/new_1/source/home/1280.png",
    );
  });

  it("THROWS when any copy fails (fail-closed) and names the failing object", async () => {
    const copy = vi.fn(async (from: string) =>
      from.endsWith("1280.png") ? { error: { message: "object not found" } } : { error: null },
    );
    await expect(
      cloneStorageObjectsFailClosed(paths, "base_1", "new_1", copy),
    ).rejects.toThrow(/source\/home\/1280\.png.*object not found/s);
    // It attempts ALL copies before throwing (so the error lists every failure).
    expect(copy).toHaveBeenCalledTimes(2);
  });

  it("is a no-op (returns 0) for an empty object list — a prefix with nothing to clone", async () => {
    const copy = vi.fn();
    expect(await cloneStorageObjectsFailClosed([], "base_1", "new_1", copy)).toBe(0);
    expect(copy).not.toHaveBeenCalled();
  });
});
