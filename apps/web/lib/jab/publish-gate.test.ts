import { describe, it, expect } from "vitest";
import { evaluatePublishGate } from "./publish-gate";

describe("evaluatePublishGate", () => {
  it("returns ok=true when build is ready and every fidelity row is approved", () => {
    const result = evaluatePublishGate({
      buildStatus: "ready",
      fidelityReports: [
        { approval_status: "approved" },
        { approval_status: "approved_with_issues" },
        { approval_status: "approved" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects when build status is not 'ready'", () => {
    const result = evaluatePublishGate({
      buildStatus: "verifying",
      fidelityReports: [{ approval_status: "approved" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("build_not_ready");
    }
  });

  it("rejects when fidelityReports is empty", () => {
    const result = evaluatePublishGate({
      buildStatus: "ready",
      fidelityReports: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("no_fidelity_rows");
    }
  });

  it("rejects when any page is rejected (rejected_pages beats unapproved_pages)", () => {
    const result = evaluatePublishGate({
      buildStatus: "ready",
      fidelityReports: [
        { approval_status: "approved" },
        { approval_status: "rejected" },
        { approval_status: "pending" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rejected_pages");
      expect(result.rejectedCount).toBe(1);
    }
  });

  it("rejects when pages are still pending (no rejections)", () => {
    const result = evaluatePublishGate({
      buildStatus: "ready",
      fidelityReports: [
        { approval_status: "approved" },
        { approval_status: "pending" },
        { approval_status: "pending" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unapproved_pages");
      expect(result.unapprovedCount).toBe(2);
    }
  });

  it("treats approved_with_issues as accepting", () => {
    const result = evaluatePublishGate({
      buildStatus: "ready",
      fidelityReports: [
        { approval_status: "approved_with_issues" },
        { approval_status: "approved_with_issues" },
      ],
    });
    expect(result.ok).toBe(true);
  });
});
