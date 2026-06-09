// apps/web/lib/db/auto-fail-stale-build.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Chainable Supabase mock ─────────────────────────────────────────────────────
//
// The helper under test chains like:
//   Read:   admin.from("site_builds").select(...).eq(...).in(...)
//   Update: admin.from("site_builds").update(...).eq(...).eq(...).select("id")
//
// We build a fresh set of vi.fn() stubs per test (via beforeEach) so call
// history is isolated between cases.

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

import { autoFailStaleActiveBuild } from "./auto-fail-stale-build";
import { STALE_ACTIVE_BUILD_MINUTES } from "@/lib/jab/build-status";

// A timestamp that is definitely stale (2× the ceiling).
const STALE_CREATED_AT = new Date(
  Date.now() - STALE_ACTIVE_BUILD_MINUTES * 2 * 60 * 1000,
).toISOString();

// A timestamp that is NOT stale (created 1 minute ago).
const FRESH_CREATED_AT = new Date(Date.now() - 60 * 1000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Case (a): no active rows ─ returns false, update never called
// ─────────────────────────────────────────────────────────────────────────────
describe("autoFailStaleActiveBuild — no active rows", () => {
  it("returns false and never calls update", async () => {
    // The read chain resolves with an empty array.
    const inFn = vi.fn().mockResolvedValue({ data: [], error: null });
    const eqForRead = vi.fn(() => ({ in: inFn }));
    const selectForRead = vi.fn(() => ({ eq: eqForRead }));
    const updateFn = vi.fn();
    mockFrom.mockReturnValue({ select: selectForRead, update: updateFn });

    const result = await autoFailStaleActiveBuild("proj-1");
    expect(result).toBe(false);
    expect(updateFn).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case (b): one stale active row ─ update called with CAS filters, returns true
// ─────────────────────────────────────────────────────────────────────────────
describe("autoFailStaleActiveBuild — one stale active row", () => {
  it("updates the row with compare-and-set filters and returns true", async () => {
    const staleRow = { id: "build-stale", status: "composing", created_at: STALE_CREATED_AT };

    // Read chain.
    const inFn = vi.fn().mockResolvedValue({ data: [staleRow], error: null });
    const eqForRead = vi.fn(() => ({ in: inFn }));
    const selectForRead = vi.fn(() => ({ eq: eqForRead }));

    // Update chain: .update().eq(id).eq(status).select("id") → { data: [{ id }] }
    const selectAfterUpdate = vi.fn().mockResolvedValue({ data: [{ id: "build-stale" }], error: null });
    const eqStatus = vi.fn(() => ({ select: selectAfterUpdate }));
    const eqId = vi.fn(() => ({ eq: eqStatus }));
    const updateFn = vi.fn(() => ({ eq: eqId }));

    mockFrom.mockReturnValue({ select: selectForRead, update: updateFn });

    const result = await autoFailStaleActiveBuild("proj-2");
    expect(result).toBe(true);

    // Verify compare-and-set: first eq is on id, second on current status.
    expect(eqId).toHaveBeenCalledWith("id", "build-stale");
    expect(eqStatus).toHaveBeenCalledWith("status", "composing");

    // Verify the update payload references the constant rather than a hard-coded string.
    const updatePayload = (updateFn.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(updatePayload.status).toBe("failed");
    expect(updatePayload.failed_phase).toBe("composing"); // composing is in FAILED_PHASES
    expect(String(updatePayload.error_text)).toContain(`${STALE_ACTIVE_BUILD_MINUTES} minutes`);
    expect(typeof updatePayload.finished_at).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case (c): fresh active row (not yet stale) ─ returns false
// ─────────────────────────────────────────────────────────────────────────────
describe("autoFailStaleActiveBuild — fresh active row", () => {
  it("returns false when the active row is within the staleness window", async () => {
    const freshRow = { id: "build-fresh", status: "discovering", created_at: FRESH_CREATED_AT };

    const inFn = vi.fn().mockResolvedValue({ data: [freshRow], error: null });
    const eqForRead = vi.fn(() => ({ in: inFn }));
    const selectForRead = vi.fn(() => ({ eq: eqForRead }));
    const updateFn = vi.fn();

    mockFrom.mockReturnValue({ select: selectForRead, update: updateFn });

    const result = await autoFailStaleActiveBuild("proj-3");
    expect(result).toBe(false);
    expect(updateFn).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case (d): update matches 0 rows (CAS lost — row just progressed) ─ returns false
// ─────────────────────────────────────────────────────────────────────────────
describe("autoFailStaleActiveBuild — CAS lost (row progressed between read and update)", () => {
  it("returns false when .select returns an empty array (0 rows updated)", async () => {
    const staleRow = { id: "build-race", status: "building", created_at: STALE_CREATED_AT };

    // Read chain returns the stale row.
    const inFn = vi.fn().mockResolvedValue({ data: [staleRow], error: null });
    const eqForRead = vi.fn(() => ({ in: inFn }));
    const selectForRead = vi.fn(() => ({ eq: eqForRead }));

    // Update chain: .select("id") returns empty data (CAS miss).
    const selectAfterUpdate = vi.fn().mockResolvedValue({ data: [], error: null });
    const eqStatus = vi.fn(() => ({ select: selectAfterUpdate }));
    const eqId = vi.fn(() => ({ eq: eqStatus }));
    const updateFn = vi.fn(() => ({ eq: eqId }));

    mockFrom.mockReturnValue({ select: selectForRead, update: updateFn });

    const result = await autoFailStaleActiveBuild("proj-4");
    expect(result).toBe(false);
  });
});
