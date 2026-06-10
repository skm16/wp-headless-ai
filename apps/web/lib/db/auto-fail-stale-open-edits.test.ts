// apps/web/lib/db/auto-fail-stale-open-edits.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

import {
  autoFailStaleOpenEdits,
  isStaleOpenEdit,
  STALE_QUEUED_EDIT_MINUTES,
  STALE_RUNNING_EDIT_MINUTES,
} from "./auto-fail-stale-open-edits";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isStaleOpenEdit", () => {
  it("queued: stale after 10 minutes, fresh before", () => {
    expect(isStaleOpenEdit("queued", ago(11), Date.now())).toBe(true);
    expect(isStaleOpenEdit("queued", ago(9), Date.now())).toBe(false);
  });

  it("running: stale after 45 minutes, fresh at 20 (between the two thresholds)", () => {
    expect(isStaleOpenEdit("running", ago(46), Date.now())).toBe(true);
    expect(isStaleOpenEdit("running", ago(20), Date.now())).toBe(false);
  });

  it("non-open statuses and unparseable timestamps are never stale", () => {
    expect(isStaleOpenEdit("completed", ago(120), Date.now())).toBe(false);
    expect(isStaleOpenEdit("failed", ago(120), Date.now())).toBe(false);
    expect(isStaleOpenEdit("queued", "not-a-date", Date.now())).toBe(false);
    expect(isStaleOpenEdit("queued", null, Date.now())).toBe(false);
  });
});

// Read chain:   from("workspace_edits").select(...).eq(...).in(...)
// Update chain: from("workspace_edits").update(...).eq(id).eq(status).select("id")
function wireRead(rows: Array<Record<string, unknown>>) {
  const inFn = vi.fn().mockResolvedValue({ data: rows, error: null });
  const eqForRead = vi.fn(() => ({ in: inFn }));
  const selectForRead = vi.fn(() => ({ eq: eqForRead }));
  return { selectForRead, inFn };
}

describe("autoFailStaleOpenEdits", () => {
  it("returns false and never updates when nothing is open", async () => {
    const { selectForRead } = wireRead([]);
    const updateFn = vi.fn();
    mockFrom.mockReturnValue({ select: selectForRead, update: updateFn });
    await expect(autoFailStaleOpenEdits("proj-1")).resolves.toBe(false);
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("fails a stale queued edit with CAS filters and an explanatory error_text", async () => {
    const { selectForRead } = wireRead([
      { id: "edit-stale", status: "queued", created_at: ago(STALE_QUEUED_EDIT_MINUTES * 2) },
    ]);
    const selectAfterUpdate = vi.fn().mockResolvedValue({ data: [{ id: "edit-stale" }], error: null });
    const eqStatus = vi.fn(() => ({ select: selectAfterUpdate }));
    const eqId = vi.fn(() => ({ eq: eqStatus }));
    const updateFn = vi.fn(() => ({ eq: eqId }));
    mockFrom.mockReturnValue({ select: selectForRead, update: updateFn });

    await expect(autoFailStaleOpenEdits("proj-2")).resolves.toBe(true);
    expect(eqId).toHaveBeenCalledWith("id", "edit-stale");
    expect(eqStatus).toHaveBeenCalledWith("status", "queued");
    const payload = (updateFn.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(payload.status).toBe("failed");
    expect(String(payload.error_text)).toContain(`${STALE_QUEUED_EDIT_MINUTES} minutes`);
    expect(typeof payload.finished_at).toBe("string");
  });

  it("leaves a 20-minute running edit alone (under the running threshold)", async () => {
    const { selectForRead } = wireRead([
      { id: "edit-running", status: "running", created_at: ago(20) },
    ]);
    const updateFn = vi.fn();
    mockFrom.mockReturnValue({ select: selectForRead, update: updateFn });
    await expect(autoFailStaleOpenEdits("proj-3")).resolves.toBe(false);
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("returns false when the CAS update matches 0 rows (edit progressed mid-sweep)", async () => {
    const { selectForRead } = wireRead([
      { id: "edit-race", status: "queued", created_at: ago(STALE_QUEUED_EDIT_MINUTES * 2) },
    ]);
    const selectAfterUpdate = vi.fn().mockResolvedValue({ data: [], error: null });
    const eqStatus = vi.fn(() => ({ select: selectAfterUpdate }));
    const eqId = vi.fn(() => ({ eq: eqStatus }));
    const updateFn = vi.fn(() => ({ eq: eqId }));
    mockFrom.mockReturnValue({ select: selectForRead, update: updateFn });
    await expect(autoFailStaleOpenEdits("proj-4")).resolves.toBe(false);
  });

  it("uses STALE_RUNNING_EDIT_MINUTES in the error_text for stale running edits", async () => {
    const { selectForRead } = wireRead([
      { id: "edit-run-stale", status: "running", created_at: ago(STALE_RUNNING_EDIT_MINUTES * 2) },
    ]);
    const selectAfterUpdate = vi.fn().mockResolvedValue({ data: [{ id: "edit-run-stale" }], error: null });
    const eqStatus = vi.fn(() => ({ select: selectAfterUpdate }));
    const eqId = vi.fn(() => ({ eq: eqStatus }));
    const updateFn = vi.fn(() => ({ eq: eqId }));
    mockFrom.mockReturnValue({ select: selectForRead, update: updateFn });

    await expect(autoFailStaleOpenEdits("proj-5")).resolves.toBe(true);
    const payload = (updateFn.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(String(payload.error_text)).toContain(`${STALE_RUNNING_EDIT_MINUTES} minutes`);
  });
});
