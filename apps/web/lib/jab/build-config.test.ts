import { describe, it, expect } from "vitest";
import {
  isEditConfig,
  isPublishDraftConfig,
  configCarryForwardSource,
  carryForwardSourceConfig,
  buildFrontPageConfigPatch,
  buildLocaleConfigPatch,
  type BuildConfig,
} from "@/lib/jab/build-config";

describe("isEditConfig", () => {
  const editConfig: BuildConfig = {
    mode: "edit",
    source_build_id: "src-build-1",
    scope: "component",
    target: "core/heading",
    prompt: "make the hero bolder",
    regeneration_prompt: "Increase the hero heading weight to 800 and size up.",
    action: "Regenerated the Hero block",
    edit_id: "edit-1",
    message_id: "msg-1",
    changed_slugs: ["/", "/about"],
    change_reason: "component_pages",
    front_page_slug: "home",
  };

  it("returns true for an edit config", () => {
    expect(isEditConfig(editConfig)).toBe(true);
  });

  it("returns false for a full config", () => {
    const full: BuildConfig = { mode: "full" };
    expect(isEditConfig(full)).toBe(false);
  });

  it("narrows the type so edit-only fields are accessible", () => {
    // The guard must narrow so source_build_id is reachable without a cast.
    const cfg: BuildConfig = editConfig;
    if (isEditConfig(cfg)) {
      expect(cfg.source_build_id).toBe("src-build-1");
      expect(cfg.scope).toBe("component");
      expect(cfg.changed_slugs).toEqual(["/", "/about"]);
    } else {
      throw new Error("expected edit config to narrow");
    }
  });

  it("returns false for null / undefined / non-object input", () => {
    expect(isEditConfig(null)).toBe(false);
    expect(isEditConfig(undefined)).toBe(false);
    expect(isEditConfig("edit")).toBe(false);
    expect(isEditConfig(42)).toBe(false);
    expect(isEditConfig({})).toBe(false);
    expect(isEditConfig({ mode: "other" })).toBe(false);
  });

  it("accepts message_id: null and change_reason: null (manual-form path)", () => {
    const manual: BuildConfig = {
      mode: "edit",
      source_build_id: "src-build-2",
      scope: "shell",
      target: "footer",
      prompt: "tighten the footer",
      regeneration_prompt: "tighten the footer",
      action: "Regenerated the footer",
      edit_id: "edit-2",
      message_id: null,
      changed_slugs: ["/", "/about", "/contact"],
      change_reason: "shell_all",
      front_page_slug: null,
    };
    expect(isEditConfig(manual)).toBe(true);
  });
});

describe("carryForwardSourceConfig", () => {
  it("extracts front_page_slug from a full build's legacy untyped config", () => {
    expect(carryForwardSourceConfig({ mode: "full", front_page_slug: "home" })).toStrictEqual({
      front_page_slug: "home",
    });
  });

  it("extracts front_page_slug from an edit config (edit-on-edit chains keep it)", () => {
    expect(
      carryForwardSourceConfig({ mode: "edit", source_build_id: "b1", front_page_slug: "home" }),
    ).toStrictEqual({ front_page_slug: "home" });
  });

  it("carries last_sync_watermark when present (incremental window survives edits)", () => {
    expect(
      carryForwardSourceConfig({ mode: "full", front_page_slug: "home", last_sync_watermark: "2026-06-01T00:00:00Z" }),
    ).toStrictEqual({ front_page_slug: "home", last_sync_watermark: "2026-06-01T00:00:00Z" });
  });

  it("returns null front_page_slug for null / non-object / missing / empty-string configs", () => {
    expect(carryForwardSourceConfig(null)).toStrictEqual({ front_page_slug: null });
    expect(carryForwardSourceConfig("garbage")).toStrictEqual({ front_page_slug: null });
    expect(carryForwardSourceConfig({ mode: "full" })).toStrictEqual({ front_page_slug: null });
    expect(carryForwardSourceConfig({ mode: "full", front_page_slug: "" })).toStrictEqual({ front_page_slug: null });
  });

  it("ignores non-string values for both keys", () => {
    expect(
      carryForwardSourceConfig({ mode: "full", front_page_slug: 42, last_sync_watermark: 42 }),
    ).toStrictEqual({ front_page_slug: null });
  });

  it("drops an empty-string watermark (normalized in the helper, not at call sites)", () => {
    expect(
      carryForwardSourceConfig({ mode: "full", front_page_slug: "home", last_sync_watermark: "" }),
    ).toStrictEqual({ front_page_slug: "home" });
  });

  it("carries show_on_front when valid", () => {
    expect(
      carryForwardSourceConfig({ mode: "full", front_page_slug: "home", show_on_front: "page" }),
    ).toStrictEqual({ front_page_slug: "home", show_on_front: "page" });
    expect(
      carryForwardSourceConfig({ mode: "full", show_on_front: "posts" }),
    ).toStrictEqual({ front_page_slug: null, show_on_front: "posts" });
  });

  it("omits show_on_front when absent or invalid", () => {
    expect(carryForwardSourceConfig({ mode: "full", show_on_front: "garbage" })).toStrictEqual({
      front_page_slug: null,
    });
    expect(carryForwardSourceConfig({ mode: "full", front_page_slug: "home" })).toStrictEqual({
      front_page_slug: "home",
    });
  });
});

describe("buildFrontPageConfigPatch", () => {
  it("persists show_on_front='posts' even with no static slug", () => {
    expect(buildFrontPageConfigPatch("posts", null)).toStrictEqual({ show_on_front: "posts" });
  });
  it("persists both for a static front page", () => {
    expect(buildFrontPageConfigPatch("page", "home")).toStrictEqual({
      show_on_front: "page",
      front_page_slug: "home",
    });
  });
  it("persists only the slug when mode is unknown (pre-v0.7.0 plugin)", () => {
    expect(buildFrontPageConfigPatch(null, "home")).toStrictEqual({ front_page_slug: "home" });
  });
  it("returns an empty patch when nothing is known", () => {
    expect(buildFrontPageConfigPatch(null, null)).toStrictEqual({});
    expect(buildFrontPageConfigPatch(undefined, "")).toStrictEqual({});
  });
});

describe("buildLocaleConfigPatch", () => {
  it("returns { locale } for a non-empty locale", () => {
    expect(buildLocaleConfigPatch("en_US")).toEqual({ locale: "en_US" });
    expect(buildLocaleConfigPatch("ar")).toEqual({ locale: "ar" });
  });
  it("returns {} for null/undefined/empty (no key written)", () => {
    expect(buildLocaleConfigPatch(null)).toEqual({});
    expect(buildLocaleConfigPatch(undefined)).toEqual({});
    expect(buildLocaleConfigPatch("")).toEqual({});
    expect(buildLocaleConfigPatch("   ")).toEqual({});
  });
});

describe("publish_draft config", () => {
  const cfg: BuildConfig = {
    mode: "publish_draft",
    draft_id: "d",
    base_build_id: "b",
    source_build_id: "b",
    changed_slugs: ["home", "about"],
    front_page_slug: "home",
  };
  it("isPublishDraftConfig narrows correctly", () => {
    expect(isPublishDraftConfig(cfg)).toBe(true);
    expect(isPublishDraftConfig({ mode: "full" })).toBe(false);
    expect(isPublishDraftConfig({ mode: "edit" })).toBe(false);
  });
  it("configCarryForwardSource returns source+changed for publish_draft and edit, null for full", () => {
    expect(configCarryForwardSource(cfg)).toEqual({ sourceBuildId: "b", changedSlugs: ["home", "about"] });
    expect(
      configCarryForwardSource({
        mode: "edit",
        source_build_id: "s",
        changed_slugs: ["x"],
      } as BuildConfig),
    ).toEqual({ sourceBuildId: "s", changedSlugs: ["x"] });
    expect(configCarryForwardSource({ mode: "full" })).toBeNull();
  });
});

describe("carryForwardSourceConfig — locale", () => {
  it("carries a string locale", () => {
    expect(carryForwardSourceConfig({ front_page_slug: "home", locale: "de_DE" }).locale).toBe("de_DE");
  });
  it("omits locale when absent or non-string", () => {
    expect(carryForwardSourceConfig({ front_page_slug: "home" }).locale).toBeUndefined();
    expect(carryForwardSourceConfig({ front_page_slug: "home", locale: 5 }).locale).toBeUndefined();
  });
});
