import { describe, it, expect, vi, beforeEach } from "vitest";

// Chainable Supabase mock ─────────────────────────────────────────────────────
//
// markBuildFailed chains like:
//   admin.from("site_builds").update(...).eq(id).eq(project_id).neq(status, "cancelled")
//
// We build a fresh set of vi.fn() stubs per test (via beforeEach) so call
// history is isolated between cases.

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

import { markBuildFailed, formatErrorText } from "./shared-failure";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// markBuildFailed — cancel guard
// ─────────────────────────────────────────────────────────────────────────────
describe("markBuildFailed — cancel guard", () => {
  it("(a) issues update filtered by eq(id), eq(project_id), neq(status,'cancelled') with status:failed + phase + error_text + finished_at", async () => {
    // Update chain: .update().eq("id",...).eq("project_id",...).neq("status","cancelled") → resolves (return value is ignored)
    const neqFn = vi.fn().mockResolvedValue({ data: null, error: null });
    const eqProjectId = vi.fn(() => ({ neq: neqFn }));
    const eqId = vi.fn(() => ({ eq: eqProjectId }));
    const updateFn = vi.fn(() => ({ eq: eqId }));

    mockFrom.mockReturnValue({ update: updateFn });

    await markBuildFailed({
      buildId: "build-abc",
      projectId: "proj-xyz",
      phase: "composing",
      error: new Error("something broke"),
    });

    // Verify .eq("id", ...) and .eq("project_id", ...)
    expect(eqId).toHaveBeenCalledWith("id", "build-abc");
    expect(eqProjectId).toHaveBeenCalledWith("project_id", "proj-xyz");

    // Verify .neq("status", "cancelled") — the cancel guard
    expect(neqFn).toHaveBeenCalledWith("status", "cancelled");

    // Verify the update payload
    const updatePayload = (updateFn.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(updatePayload.status).toBe("failed");
    expect(updatePayload.failed_phase).toBe("composing");
    expect(updatePayload.error_text).toBe("something broke");
    expect(typeof updatePayload.finished_at).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatErrorText — existing cases stay untouched
// ─────────────────────────────────────────────────────────────────────────────
describe("formatErrorText", () => {
  it("returns the message of an Error", () => {
    expect(formatErrorText(new Error("boom"))).toBe("boom");
  });

  it("returns strings as-is", () => {
    expect(formatErrorText("plain string")).toBe("plain string");
  });

  it("JSON-stringifies plain objects", () => {
    expect(formatErrorText({ code: 500, msg: "x" })).toBe('{"code":500,"msg":"x"}');
  });

  it("falls back to String(err) on circular structures", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(formatErrorText(obj)).toMatch(/object/i);
  });
});
