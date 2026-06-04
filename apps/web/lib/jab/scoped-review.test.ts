import { describe, it, expect } from "vitest";
import { partitionScopedPages, type ScopedPageInput } from "./scoped-review";

const pages: ScopedPageInput[] = [
  { slug: "home", approvalStatus: "pending" },
  { slug: "about", approvalStatus: "approved" },
  { slug: "menu", approvalStatus: "approved_with_issues" },
];

describe("partitionScopedPages", () => {
  it("splits changed (actionable) vs carried-forward pages by slug", () => {
    const r = partitionScopedPages(pages, ["home"]);
    expect(r.changed.map((p) => p.slug)).toEqual(["home"]);
    expect(r.carried.map((p) => p.slug).sort()).toEqual(["about", "menu"]);
    expect(r.changedCount).toBe(1);
  });
  it("with a null changedSlugs (full re-review), everything is changed", () => {
    const r = partitionScopedPages(pages, null);
    expect(r.changed.length).toBe(3);
    expect(r.carried.length).toBe(0);
  });
  it("with an empty changedSlugs array, nothing is changed (all carried)", () => {
    const r = partitionScopedPages(pages, []);
    expect(r.changed.length).toBe(0);
    expect(r.carried.length).toBe(3);
  });
});
