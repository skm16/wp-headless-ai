import { describe, it, expect } from "vitest";
import { planApprovalCarryForward } from "./approval-carry-forward";

describe("planApprovalCarryForward", () => {
  const source = [
    { slug: "home", approvalStatus: "approved" },
    { slug: "about", approvalStatus: "approved_with_issues" },
    { slug: "menu", approvalStatus: "pending" },
  ];
  const resultPages = [
    { slug: "home", pageInventoryId: "r-home" },
    { slug: "about", pageInventoryId: "r-about" },
    { slug: "menu", pageInventoryId: "r-menu" },
    { slug: "new-page", pageInventoryId: "r-new" },
  ];

  it("inherits source status for untouched pages, resets changed pages to pending", () => {
    const plan = planApprovalCarryForward({
      sourceFidelityRows: source,
      resultPages,
      changedSlugs: ["home"],
    });
    // home changed → pending; about untouched → inherits; menu untouched but source-pending stays pending.
    const byId = new Map(plan.carry.map((c) => [c.pageInventoryId, c.status]));
    expect(byId.get("r-home")).toBe("pending");
    expect(byId.get("r-about")).toBe("approved_with_issues");
    expect(byId.get("r-menu")).toBe("pending");
    // new-page has no source row → pending (result-only).
    expect(byId.get("r-new")).toBe("pending");
    expect(plan.resetToPending.sort()).toEqual(["home", "new-page"]);
  });

  it("never upgrades a source-pending page even when untouched", () => {
    const plan = planApprovalCarryForward({
      sourceFidelityRows: [{ slug: "menu", approvalStatus: "pending" }],
      resultPages: [{ slug: "menu", pageInventoryId: "r-menu" }],
      changedSlugs: [],
    });
    expect(plan.carry).toEqual([{ pageInventoryId: "r-menu", status: "pending" }]);
  });

  it("matches on slug, not page_inventory id (ids differ across builds)", () => {
    const plan = planApprovalCarryForward({
      sourceFidelityRows: [{ slug: "home", approvalStatus: "approved" }],
      resultPages: [{ slug: "home", pageInventoryId: "DIFFERENT-id" }],
      changedSlugs: [],
    });
    expect(plan.carry).toEqual([{ pageInventoryId: "DIFFERENT-id", status: "approved" }]);
  });

  it("treats a result-only changed page as pending (in resetToPending)", () => {
    const plan = planApprovalCarryForward({
      sourceFidelityRows: [],
      resultPages: [{ slug: "x", pageInventoryId: "r-x" }],
      changedSlugs: ["x"],
    });
    expect(plan.carry).toEqual([{ pageInventoryId: "r-x", status: "pending" }]);
    expect(plan.resetToPending).toEqual(["x"]);
  });
});
