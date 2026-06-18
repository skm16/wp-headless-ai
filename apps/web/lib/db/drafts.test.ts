import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

import { ensureActiveDraft, bumpDraftVersion, loadActiveTokenDeltas } from "./drafts";

beforeEach(() => vi.clearAllMocks());

function selectChain(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const limit = vi.fn(() => ({ maybeSingle }));
  const order = vi.fn(() => ({ limit }));
  const in_ = vi.fn(() => ({ order, limit, maybeSingle }));
  const eq2 = vi.fn(() => ({ in: in_, order, limit, maybeSingle, eq: vi.fn(() => ({ order, limit, maybeSingle })) }));
  const select = vi.fn(() => ({ eq: eq2 }));
  return { select, eq2, in_ };
}

describe("ensureActiveDraft", () => {
  it("returns the existing live draft without inserting", async () => {
    const existing = { id: "d1", base_build_id: "b1", version: 3, status: "active" };
    const { select } = selectChain({ data: existing, error: null });
    const insert = vi.fn();
    mockFrom.mockReturnValue({ select, insert });
    await expect(ensureActiveDraft("p1", "t1")).resolves.toEqual(existing);
    expect(insert).not.toHaveBeenCalled();
  });

  it("creates a draft forked from the latest ready build when none is live", async () => {
    // 1st call: drafts select -> none; 2nd: site_builds select -> ready build; 3rd: drafts insert
    const noDraft = selectChain({ data: null, error: null });
    const readyBuild = selectChain({ data: { id: "b9" }, error: null });
    const inserted = { id: "d2", base_build_id: "b9", version: 0, status: "active" };
    const insertSingle = vi.fn().mockResolvedValue({ data: inserted, error: null });
    const insertSelect = vi.fn(() => ({ single: insertSingle }));
    const insert = vi.fn(() => ({ select: insertSelect }));
    mockFrom
      .mockReturnValueOnce({ select: noDraft.select })
      .mockReturnValueOnce({ select: readyBuild.select })
      .mockReturnValueOnce({ insert });
    await expect(ensureActiveDraft("p1", "t1")).resolves.toEqual(inserted);
    const payload = (insert.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(payload).toMatchObject({ project_id: "p1", tenant_id: "t1", base_build_id: "b9", status: "active" });
  });

  it("throws loudly when no ready build exists to fork from", async () => {
    const noDraft = selectChain({ data: null, error: null });
    const noBuild = selectChain({ data: null, error: null });
    mockFrom
      .mockReturnValueOnce({ select: noDraft.select })
      .mockReturnValueOnce({ select: noBuild.select });
    await expect(ensureActiveDraft("p1", "t1")).rejects.toThrow(/ready build/i);
  });
});

describe("bumpDraftVersion", () => {
  it("CAS-updates version and returns the new version", async () => {
    const updated = vi.fn().mockResolvedValue({ data: [{ id: "d1", version: 4 }], error: null });
    const selectAfter = vi.fn(() => updated());
    const eqVersion = vi.fn(() => ({ select: selectAfter }));
    const eqId = vi.fn(() => ({ eq: eqVersion }));
    const update = vi.fn(() => ({ eq: eqId }));
    mockFrom.mockReturnValue({ update });
    await expect(bumpDraftVersion("d1", 3)).resolves.toBe(4);
    expect(eqId).toHaveBeenCalledWith("id", "d1");
    expect(eqVersion).toHaveBeenCalledWith("version", 3);
  });

  it("throws when the CAS matches 0 rows (concurrent writer)", async () => {
    const selectAfter = vi.fn().mockResolvedValue({ data: [], error: null });
    const eqVersion = vi.fn(() => ({ select: selectAfter }));
    const eqId = vi.fn(() => ({ eq: eqVersion }));
    const update = vi.fn(() => ({ eq: eqId }));
    mockFrom.mockReturnValue({ update });
    await expect(bumpDraftVersion("d1", 3)).rejects.toThrow(/concurrent/i);
  });
});

describe("loadActiveTokenDeltas", () => {
  // The query is .select().eq(draft_id).eq(scope).eq(status).is(undone_at).not(token_delta).order(created_at)
  function tokenChain(result: { data: unknown; error: unknown }) {
    const order = vi.fn().mockResolvedValue(result);
    const not = vi.fn(() => ({ order }));
    const is = vi.fn(() => ({ not }));
    const eqStatus = vi.fn(() => ({ is }));
    const eqScope = vi.fn(() => ({ eq: eqStatus }));
    const eqDraft = vi.fn(() => ({ eq: eqScope }));
    const select = vi.fn(() => ({ eq: eqDraft }));
    return { select, eqDraft, eqScope, eqStatus, is, not, order };
  }

  it("queries active token edits and returns their deltas in created_at order", async () => {
    const rows = [
      { token_delta: { colors: [{ slug: "primary", color: "#000" }] }, created_at: "2026-06-18T00:00:00Z" },
      { token_delta: { colors: [{ slug: "primary", color: "#c00" }] }, created_at: "2026-06-18T00:01:00Z" },
    ];
    const chain = tokenChain({ data: rows, error: null });
    mockFrom.mockReturnValue({ select: chain.select });
    await expect(loadActiveTokenDeltas("d1")).resolves.toEqual([
      { colors: [{ slug: "primary", color: "#000" }] },
      { colors: [{ slug: "primary", color: "#c00" }] },
    ]);
    expect(mockFrom).toHaveBeenCalledWith("workspace_edits");
    expect(chain.eqDraft).toHaveBeenCalledWith("draft_id", "d1");
    expect(chain.eqScope).toHaveBeenCalledWith("scope", "tokens");
    expect(chain.eqStatus).toHaveBeenCalledWith("status", "completed");
    expect(chain.is).toHaveBeenCalledWith("undone_at", null);
    expect(chain.not).toHaveBeenCalledWith("token_delta", "is", null);
    expect(chain.order).toHaveBeenCalledWith("created_at", { ascending: true });
  });

  it("returns an empty array when there are no active token edits", async () => {
    const chain = tokenChain({ data: [], error: null });
    mockFrom.mockReturnValue({ select: chain.select });
    await expect(loadActiveTokenDeltas("d1")).resolves.toEqual([]);
  });

  it("drops null deltas defensively", async () => {
    const chain = tokenChain({
      data: [{ token_delta: null, created_at: "x" }, { token_delta: { colors: [{ slug: "p", color: "#c00" }] }, created_at: "y" }],
      error: null,
    });
    mockFrom.mockReturnValue({ select: chain.select });
    await expect(loadActiveTokenDeltas("d1")).resolves.toEqual([{ colors: [{ slug: "p", color: "#c00" }] }]);
  });

  it("throws loudly on a query error", async () => {
    const chain = tokenChain({ data: null, error: { message: "boom" } });
    mockFrom.mockReturnValue({ select: chain.select });
    await expect(loadActiveTokenDeltas("d1")).rejects.toThrow(/loadActiveTokenDeltas failed: boom/);
  });
});
