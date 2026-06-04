import { describe, it, expect } from "vitest";
import { buildCarryForwardUpdates } from "./edit-site.helpers";

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
});
