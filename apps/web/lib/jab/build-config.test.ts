import { describe, it, expect } from "vitest";
import { isEditConfig, carryForwardSourceConfig, type BuildConfig } from "@/lib/jab/build-config";

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
    expect(carryForwardSourceConfig({ mode: "full", front_page_slug: "home" })).toEqual({
      front_page_slug: "home",
    });
  });

  it("extracts front_page_slug from an edit config (edit-on-edit chains keep it)", () => {
    expect(
      carryForwardSourceConfig({ mode: "edit", source_build_id: "b1", front_page_slug: "home" }),
    ).toEqual({ front_page_slug: "home" });
  });

  it("carries last_sync_watermark when present (incremental window survives edits)", () => {
    expect(
      carryForwardSourceConfig({ mode: "full", front_page_slug: "home", last_sync_watermark: "2026-06-01T00:00:00Z" }),
    ).toEqual({ front_page_slug: "home", last_sync_watermark: "2026-06-01T00:00:00Z" });
  });

  it("returns null front_page_slug for null / non-object / missing / empty-string configs", () => {
    expect(carryForwardSourceConfig(null)).toEqual({ front_page_slug: null });
    expect(carryForwardSourceConfig("garbage")).toEqual({ front_page_slug: null });
    expect(carryForwardSourceConfig({ mode: "full" })).toEqual({ front_page_slug: null });
    expect(carryForwardSourceConfig({ mode: "full", front_page_slug: "" })).toEqual({ front_page_slug: null });
  });
});
