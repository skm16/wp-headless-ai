import { describe, it, expect } from "vitest";
import { buildCarryForwardUpdates, PAGE_INVENTORY_CLONE_COLUMNS } from "./edit-site.helpers";

describe("buildCarryForwardUpdates", () => {
  it("emits an inherited approver/timestamp for untouched pages and nulls for reset pages", () => {
    const updates = buildCarryForwardUpdates({
      carry: [
        { pageInventoryId: "r-home", status: "pending" },
        { pageInventoryId: "r-about", status: "approved" },
      ],
      resetToPending: ["home"],
      resultIdToSlug: new Map([
        ["r-home", "home"],
        ["r-about", "about"],
      ]),
      sourceSlugMeta: new Map([
        ["about", { approvedByUserId: "u1", approvedAt: "2026-06-01T00:00:00Z" }],
        ["home", { approvedByUserId: "u9", approvedAt: "2026-05-30T00:00:00Z" }],
      ]),
    });
    const byId = new Map(updates.map((u) => [u.pageInventoryId, u]));
    // reset page → pending + null approver/timestamp.
    expect(byId.get("r-home")).toEqual({
      pageInventoryId: "r-home",
      approvalStatus: "pending",
      approvedByUserId: null,
      approvedAt: null,
    });
    // untouched inherited page → carries the source approver + timestamp.
    expect(byId.get("r-about")).toEqual({
      pageInventoryId: "r-about",
      approvalStatus: "approved",
      approvedByUserId: "u1",
      approvedAt: "2026-06-01T00:00:00Z",
    });
  });

  it("yields null provenance for an inherited page with no sourceSlugMeta entry", () => {
    const updates = buildCarryForwardUpdates({
      carry: [{ pageInventoryId: "r-contact", status: "approved_with_issues" }],
      resetToPending: [],
      resultIdToSlug: new Map([["r-contact", "contact"]]),
      sourceSlugMeta: new Map(), // no entry for "contact"
    });
    expect(updates[0]).toEqual({
      pageInventoryId: "r-contact",
      approvalStatus: "approved_with_issues",
      approvedByUserId: null,
      approvedAt: null,
    });
  });

  it("yields null provenance for a carry item whose pageInventoryId has no slug mapping", () => {
    const updates = buildCarryForwardUpdates({
      carry: [{ pageInventoryId: "r-orphan", status: "approved" }],
      resetToPending: [],
      resultIdToSlug: new Map(), // no mapping for "r-orphan"
      sourceSlugMeta: new Map([["anything", { approvedByUserId: "u1", approvedAt: "2026-06-01T00:00:00Z" }]]),
    });
    expect(updates[0]).toEqual({
      pageInventoryId: "r-orphan",
      approvalStatus: "approved",
      approvedByUserId: null,
      approvedAt: null,
    });
  });
});

describe("PAGE_INVENTORY_CLONE_COLUMNS", () => {
  const cols = PAGE_INVENTORY_CLONE_COLUMNS.split(",").map((c) => c.trim());

  it("carries block_tree — without it the NEXT edit fail-closes to all-pages re-review", () => {
    expect(cols).toContain("block_tree");
  });

  it("carries source_modified_gmt — without it JAB_INCREMENTAL_SKIP degrades to full sync", () => {
    expect(cols).toContain("source_modified_gmt");
  });

  it("carries every column loadSourcePagesForImpact reads (slug, block_tree)", () => {
    expect(cols).toEqual(expect.arrayContaining(["slug", "block_tree"]));
  });
});
