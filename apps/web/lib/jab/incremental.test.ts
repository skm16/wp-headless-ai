import { describe, it, expect } from "vitest";
import { resolveSyncWindow, selectChangedPages, maxModifiedGmt } from "./incremental";

describe("maxModifiedGmt", () => {
  it("returns the latest modified_gmt or null when empty", () => {
    expect(
      maxModifiedGmt([{ modified_gmt: "2026-06-01T00:00:00Z" }, { modified_gmt: "2026-06-03T00:00:00Z" }]),
    ).toBe("2026-06-03T00:00:00Z");
    expect(maxModifiedGmt([])).toBeNull();
    expect(maxModifiedGmt([{}])).toBeNull();
  });
});

describe("resolveSyncWindow", () => {
  it("yields modifiedAfter when a watermark exists, empty otherwise", () => {
    expect(resolveSyncWindow("2026-06-01T00:00:00Z")).toEqual({ modifiedAfter: "2026-06-01T00:00:00Z" });
    expect(resolveSyncWindow(null)).toEqual({});
  });
});

describe("selectChangedPages", () => {
  const prior = [
    { slug: "home", postType: "page", modifiedGmt: "2026-06-01T00:00:00Z" },
    { slug: "about", postType: "page", modifiedGmt: "2026-06-01T00:00:00Z" },
  ];
  const cur = (over: Partial<{ slug: string; modified_gmt: string }> = {}) => ({
    id: 1,
    title: "",
    slug: "home",
    link: "",
    date: "",
    excerpt: "",
    modified: "",
    modified_gmt: "2026-06-03T00:00:00Z",
    ...over,
  });

  it("flags full sync when there is no window", () => {
    const r = selectChangedPages(prior, [cur()], {});
    expect(r.isFullSync).toBe(true);
  });
  it("selects only pages newer than the window plus brand-new slugs", () => {
    const r = selectChangedPages(
      prior,
      [cur({ slug: "home" }), cur({ slug: "new", modified_gmt: "2026-06-03T00:00:00Z" })],
      { modifiedAfter: "2026-06-02T00:00:00Z" },
    );
    expect(r.isFullSync).toBe(false);
    expect(r.changedSlugs.has("home")).toBe(true);
    expect(r.changedSlugs.has("new")).toBe(true);
    expect(r.changedSlugs.has("about")).toBe(false);
  });
});
