import { describe, it, expect } from "vitest";
import { planApprovalCarryForward, isBlockingFidelityRow } from "./approval-carry-forward";

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

describe("isBlockingFidelityRow", () => {
  it("is blocking when the canonical score is a hard 0 (string or number)", () => {
    expect(isBlockingFidelityRow({ score: 0, issues: [], viewportScores: {} })).toBe(true);
    expect(isBlockingFidelityRow({ score: "0", issues: [], viewportScores: {} })).toBe(true);
    expect(isBlockingFidelityRow({ score: "0.000", issues: [], viewportScores: {} })).toBe(true);
  });
  it("is blocking when any issue is high-severity", () => {
    expect(
      isBlockingFidelityRow({ score: "0.95", issues: [{ severity: "high" }], viewportScores: {} }),
    ).toBe(true);
  });
  it("is blocking when any viewport entry is flagged blocking (catastrophic-mobile shape: real non-zero score)", () => {
    expect(
      isBlockingFidelityRow({ score: "0.95", issues: [], viewportScores: { "375": { blocking: true } } }),
    ).toBe(true);
  });
  it("is NOT blocking for a healthy row (good score, only low issues, no viewport flag)", () => {
    expect(
      isBlockingFidelityRow({
        score: "0.96",
        issues: [{ severity: "low" }],
        viewportScores: { "375": { blocking: false }, "1280": { blocking: false } },
      }),
    ).toBe(false);
  });
  it("is NOT blocking for a skipped row (null score, no issues)", () => {
    expect(isBlockingFidelityRow({ score: null, issues: [], viewportScores: {} })).toBe(false);
  });
  it("tolerates missing/null fields", () => {
    expect(isBlockingFidelityRow({ score: null })).toBe(false);
    expect(isBlockingFidelityRow({ score: "0.9", issues: null, viewportScores: null })).toBe(false);
  });
});

describe("planApprovalCarryForward — fail-closed on a blocking result row", () => {
  it("resets an UNCHANGED, source-approved page to pending when its new result row is blocking", () => {
    const plan = planApprovalCarryForward({
      sourceFidelityRows: [{ slug: "home", approvalStatus: "approved" }],
      resultPages: [{ slug: "home", pageInventoryId: "r-home" }],
      changedSlugs: [], // content unchanged → would normally inherit "approved"
      resultBlockingSlugs: ["home"], // but the new fidelity row is blocking
    });
    expect(plan.carry).toEqual([{ pageInventoryId: "r-home", status: "pending" }]);
    expect(plan.resetToPending).toEqual(["home"]);
  });
  it("also resets an unchanged approved_with_issues page when newly blocking", () => {
    const plan = planApprovalCarryForward({
      sourceFidelityRows: [{ slug: "about", approvalStatus: "approved_with_issues" }],
      resultPages: [{ slug: "about", pageInventoryId: "r-about" }],
      changedSlugs: [],
      resultBlockingSlugs: ["about"],
    });
    expect(plan.carry).toEqual([{ pageInventoryId: "r-about", status: "pending" }]);
  });
  it("still inherits when the page is unchanged AND not blocking", () => {
    const plan = planApprovalCarryForward({
      sourceFidelityRows: [{ slug: "home", approvalStatus: "approved" }],
      resultPages: [{ slug: "home", pageInventoryId: "r-home" }],
      changedSlugs: [],
      resultBlockingSlugs: [],
    });
    expect(plan.carry).toEqual([{ pageInventoryId: "r-home", status: "approved" }]);
  });
  it("defaults to no blocking slugs when the field is omitted (back-compat)", () => {
    const plan = planApprovalCarryForward({
      sourceFidelityRows: [{ slug: "home", approvalStatus: "approved" }],
      resultPages: [{ slug: "home", pageInventoryId: "r-home" }],
      changedSlugs: [],
    });
    expect(plan.carry).toEqual([{ pageInventoryId: "r-home", status: "approved" }]);
  });
});
