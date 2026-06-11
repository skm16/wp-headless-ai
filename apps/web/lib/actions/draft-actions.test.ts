// apps/web/lib/actions/draft-actions.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mocks — declared before any SUT import ──────────────────────────────────
// vi.hoisted lifts these into the module-mock factory scope so closures close
// over the same references the test bodies assert against.

const {
  mockCreateClient,
  mockProjectSingle,
  mockFindLiveDraft,
  mockLoadDraftVersions,
  mockLoadDraftSteps,
  mockBumpDraftVersion,
  mockBuildVersionedDraftArtifacts,
  mockDefaultArtifactDeps,
  mockAdminFrom,
  mockAdminClient,
} = vi.hoisted(() => {
  // ── RLS client (createClient) ─────────────────────────────────────────────
  // Default: project found. Individual tests override mockProjectSingle.
  const mockProjectSingle = vi.fn().mockResolvedValue({
    data: { id: "proj_1" },
    error: null,
  });
  const mockCreateClient = vi.fn(async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: mockProjectSingle }) }),
    }),
  }));

  // ── Admin client (createAdminClient) ─────────────────────────────────────
  // We expose `mockAdminFrom` so tests can wire per-call responses.
  const mockAdminFrom = vi.fn();
  const mockAdminClient = {
    from: mockAdminFrom,
  };
  const mockCreateAdminClient = vi.fn(() => mockAdminClient);

  // ── db/drafts helpers ────────────────────────────────────────────────────
  const mockFindLiveDraft = vi.fn();
  const mockLoadDraftVersions = vi.fn().mockResolvedValue([]);
  const mockLoadDraftSteps = vi.fn().mockResolvedValue([]);
  const mockBumpDraftVersion = vi.fn().mockResolvedValue(1);

  // ── draft/artifacts helpers ──────────────────────────────────────────────
  const mockBuildVersionedDraftArtifacts = vi.fn().mockResolvedValue({
    bundlePath: "drafts/d1/v1/bundle.js",
    cssPath: "drafts/d1/v1/draft.css",
  });
  const mockDefaultArtifactDeps = vi.fn().mockReturnValue({});

  return {
    mockCreateClient,
    mockProjectSingle,
    mockFindLiveDraft,
    mockLoadDraftVersions,
    mockLoadDraftSteps,
    mockBumpDraftVersion,
    mockBuildVersionedDraftArtifacts,
    mockDefaultArtifactDeps,
    mockAdminFrom,
    mockAdminClient,
    mockCreateAdminClient,
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: mockCreateClient,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => mockAdminClient),
}));

vi.mock("@/lib/db/drafts", () => ({
  findLiveDraft: mockFindLiveDraft,
  loadDraftVersions: mockLoadDraftVersions,
  loadDraftSteps: mockLoadDraftSteps,
  bumpDraftVersion: mockBumpDraftVersion,
}));

vi.mock("@/lib/draft/state", () => ({
  effectiveUnitVersions: vi.fn().mockReturnValue(new Map()),
}));

vi.mock("@/lib/draft/artifacts", () => ({
  buildVersionedDraftArtifacts: mockBuildVersionedDraftArtifacts,
  defaultArtifactDeps: mockDefaultArtifactDeps,
}));

// ── SUT import (after all mocks) ─────────────────────────────────────────────
import {
  undoLastEditAction,
  discardDraftAction,
  revertToVersionAction,
} from "./draft-actions";

// ── helpers ───────────────────────────────────────────────────────────────────

const DRAFT: import("@/lib/db/drafts").DraftRow = {
  id: "draft_1",
  base_build_id: "build_1",
  version: 2,
  status: "active",
};

/** Build a chainable admin query that resolves to `result` at the end. */
function chainResolving(result: unknown) {
  const terminal = () => ({
    maybeSingle: vi.fn().mockResolvedValue(result),
    single: vi.fn().mockResolvedValue(result),
  });
  const afterLimit = terminal();
  const afterOrder = { ...terminal(), limit: () => afterLimit };
  const afterIn = { ...terminal(), update: () => ({ in: vi.fn().mockResolvedValue(result) }) };
  const afterEq3 = { ...terminal(), order: () => afterOrder, in: () => afterIn };
  const afterEq2 = { ...terminal(), order: () => afterOrder, eq: () => afterEq3 };
  const afterIs = { ...terminal(), order: () => afterOrder };
  const afterEq1 = { ...terminal(), eq: () => afterEq2, is: () => afterIs, order: () => afterOrder };
  return { eq: () => afterEq1, is: () => afterIs, in: () => afterIn, update: () => ({ eq: () => ({ eq: () => Promise.resolve(result) }) }) };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Restore defaults
  mockProjectSingle.mockResolvedValue({ data: { id: "proj_1" }, error: null });
  mockFindLiveDraft.mockResolvedValue(DRAFT);
  mockLoadDraftVersions.mockResolvedValue([]);
  mockLoadDraftSteps.mockResolvedValue([]);
  mockBumpDraftVersion.mockResolvedValue(DRAFT.version + 1);
  mockBuildVersionedDraftArtifacts.mockResolvedValue({
    bundlePath: "drafts/d1/v1/bundle.js",
    cssPath: "drafts/d1/v1/draft.css",
  });
  mockDefaultArtifactDeps.mockReturnValue({});

  // Default admin.from() returns a benign stub
  mockAdminFrom.mockReturnValue(chainResolving({ data: null, error: null }));
});

// ── undoLastEditAction ────────────────────────────────────────────────────────

describe("undoLastEditAction", () => {
  it("marks the most recent completed edit as undone and rebuilds artifacts", async () => {
    // Arrange: one completed, non-undone edit exists
    const editRow = { id: "edit_1", created_at: "2026-06-11T10:00:00Z" };
    let callCount = 0;

    mockAdminFrom.mockImplementation((table: string) => {
      if (table === "workspace_edits") {
        callCount += 1;
        if (callCount === 1) {
          // First call: load most recent completed non-undone edit
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  is: () => ({
                    order: () => ({
                      limit: () => Promise.resolve({ data: [editRow], error: null }),
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        // Second call: CAS mark-undone
        return {
          update: () => ({
            eq: () => ({
              is: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        };
      }
      return chainResolving({ data: null, error: null });
    });

    const result = await undoLastEditAction("proj_1");

    expect(result).toEqual({ ok: true, newVersion: DRAFT.version + 1 });
    expect(mockBuildVersionedDraftArtifacts).toHaveBeenCalledOnce();
    expect(mockBumpDraftVersion).toHaveBeenCalledWith(DRAFT.id, DRAFT.version);
  });

  it("returns nothing_to_undo when no completed edits exist", async () => {
    mockAdminFrom.mockImplementation((table: string) => {
      if (table === "workspace_edits") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                is: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({ data: [], error: null }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return chainResolving({ data: null, error: null });
    });

    const result = await undoLastEditAction("proj_1");

    expect(result).toEqual({ ok: false, error: "nothing_to_undo" });
    expect(mockBuildVersionedDraftArtifacts).not.toHaveBeenCalled();
  });

  it("returns no_draft when no live draft exists", async () => {
    mockFindLiveDraft.mockResolvedValue(null);

    const result = await undoLastEditAction("proj_1");

    expect(result).toEqual({ ok: false, error: "no_draft" });
    expect(mockBuildVersionedDraftArtifacts).not.toHaveBeenCalled();
  });

  it("returns not_found when the project is not accessible (PGRST116)", async () => {
    mockProjectSingle.mockResolvedValue({
      data: null,
      error: { code: "PGRST116", message: "not found" },
    });

    await expect(undoLastEditAction("proj_x")).rejects.toThrow("not_found");
    expect(mockFindLiveDraft).not.toHaveBeenCalled();
  });
});

// ── discardDraftAction ────────────────────────────────────────────────────────

describe("discardDraftAction", () => {
  it("sets draft status to discarded", async () => {
    const updateEqSpy = vi.fn().mockResolvedValue({ data: null, error: null });
    mockAdminFrom.mockImplementation((table: string) => {
      if (table === "drafts") {
        return {
          update: () => ({
            eq: () => ({
              eq: updateEqSpy,
            }),
          }),
        };
      }
      return chainResolving({ data: null, error: null });
    });

    const result = await discardDraftAction("proj_1");

    expect(result).toEqual({ ok: true });
    expect(updateEqSpy).toHaveBeenCalledWith("status", "active");
  });

  it("returns no_draft when no live draft exists", async () => {
    mockFindLiveDraft.mockResolvedValue(null);

    const result = await discardDraftAction("proj_1");

    expect(result).toEqual({ ok: false, error: "no_draft" });
  });

  it("does not call buildVersionedDraftArtifacts (no rebuild needed on discard)", async () => {
    mockAdminFrom.mockImplementation((table: string) => {
      if (table === "drafts") {
        return {
          update: () => ({
            eq: () => ({
              eq: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        };
      }
      return chainResolving({ data: null, error: null });
    });

    await discardDraftAction("proj_1");

    expect(mockBuildVersionedDraftArtifacts).not.toHaveBeenCalled();
  });
});

// ── revertToVersionAction ─────────────────────────────────────────────────────

describe("revertToVersionAction", () => {
  it("marks later edits undone and rebuilds artifacts", async () => {
    const targetEdit = { id: "edit_1", created_at: "2026-06-11T09:00:00Z", undone_at: null };
    const laterEdit = { id: "edit_2", created_at: "2026-06-11T10:00:00Z", undone_at: null };
    let callCount = 0;

    const inSpy = vi.fn().mockResolvedValue({ data: null, error: null });

    mockAdminFrom.mockImplementation((table: string) => {
      if (table === "workspace_edits") {
        callCount += 1;
        if (callCount === 1) {
          // Load target edit (maybeSingle)
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: vi.fn().mockResolvedValue({ data: targetEdit, error: null }),
                }),
              }),
            }),
          };
        }
        if (callCount === 2) {
          // Load all completed edits (ordered)
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => Promise.resolve({ data: [targetEdit, laterEdit], error: null }),
                }),
              }),
            }),
          };
        }
        // Mark later edits undone via .in()
        return {
          update: () => ({
            in: inSpy,
          }),
        };
      }
      return chainResolving({ data: null, error: null });
    });

    const result = await revertToVersionAction("proj_1", "edit_1");

    expect(result).toEqual({ ok: true, newVersion: DRAFT.version + 1 });
    // .in("id", afterIds) — first arg is the column name
    expect(inSpy).toHaveBeenCalledWith("id", ["edit_2"]);
    expect(mockBuildVersionedDraftArtifacts).toHaveBeenCalledOnce();
  });

  it("un-undoes the target and all earlier undone edits (contiguous prefix restore)", async () => {
    const targetEdit = { id: "edit_1", created_at: "2026-06-11T09:00:00Z", undone_at: "2026-06-11T10:30:00Z" };
    let callCount = 0;
    // restoreSpy is called with .in("id", [array]) — new bulk-restore path.
    const restoreSpy = vi.fn().mockResolvedValue({ data: null, error: null });

    mockAdminFrom.mockImplementation((table: string) => {
      if (table === "workspace_edits") {
        callCount += 1;
        if (callCount === 1) {
          // Load target edit — already undone
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: vi.fn().mockResolvedValue({ data: targetEdit, error: null }),
                }),
              }),
            }),
          };
        }
        if (callCount === 2) {
          // Load all completed edits — only the target (no later edits to mark undone)
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => Promise.resolve({ data: [targetEdit], error: null }),
                }),
              }),
            }),
          };
        }
        // Un-undo: update({ undone_at: null }).in("id", restoreIds)
        return {
          update: () => ({
            in: restoreSpy,
          }),
        };
      }
      return chainResolving({ data: null, error: null });
    });

    const result = await revertToVersionAction("proj_1", "edit_1");

    expect(result).toEqual({ ok: true, newVersion: DRAFT.version + 1 });
    // restoreIds = all edits up-to-and-including target that had undone_at set.
    expect(restoreSpy).toHaveBeenCalledWith("id", ["edit_1"]);
    expect(mockBuildVersionedDraftArtifacts).toHaveBeenCalledOnce();
  });

  it("returns edit_not_found when the target edit does not belong to this draft", async () => {
    mockAdminFrom.mockImplementation((table: string) => {
      if (table === "workspace_edits") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          }),
        };
      }
      return chainResolving({ data: null, error: null });
    });

    const result = await revertToVersionAction("proj_1", "nonexistent_edit");

    expect(result).toEqual({ ok: false, error: "edit_not_found" });
    expect(mockBuildVersionedDraftArtifacts).not.toHaveBeenCalled();
  });

  it("returns no_draft when no live draft exists", async () => {
    mockFindLiveDraft.mockResolvedValue(null);

    const result = await revertToVersionAction("proj_1", "edit_1");

    expect(result).toEqual({ ok: false, error: "no_draft" });
    expect(mockBuildVersionedDraftArtifacts).not.toHaveBeenCalled();
  });
});
