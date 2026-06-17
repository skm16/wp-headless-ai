// apps/web/lib/actions/workspace-preview.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- mocks (declared before importing the SUT) ---
// vi.hoisted ensures these are available when vi.mock factory runs (hoisted above imports).
const { mockSingle, mockCreateClient, mockLoadProjectBuildState, mockAssertReachable, mockHasOpenEdit, mockFindLiveDraft } =
  vi.hoisted(() => {
    const mockSingle = vi.fn();
    const mockCreateClient = vi.fn(async () => ({
      from: () => ({
        select: () => ({ eq: () => ({ single: mockSingle }) }),
      }),
    }));
    const mockLoadProjectBuildState = vi.fn();
    const mockAssertReachable = vi.fn();
    const mockHasOpenEdit = vi.fn();
    const mockFindLiveDraft = vi.fn();
    return { mockSingle, mockCreateClient, mockLoadProjectBuildState, mockAssertReachable, mockHasOpenEdit, mockFindLiveDraft };
  });

vi.mock("@/lib/supabase/server", () => ({
  createClient: mockCreateClient,
}));

vi.mock("@/lib/jab/load-project-builds", () => ({
  loadProjectBuildState: mockLoadProjectBuildState,
}));

vi.mock("@/lib/vercel/preview-protection", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/vercel/preview-protection")
  >("@/lib/vercel/preview-protection");
  return { ...actual, assertPreviewReachable: mockAssertReachable };
});

vi.mock("@/lib/jab/open-edits", () => ({
  hasOpenWorkspaceEdit: mockHasOpenEdit,
}));

vi.mock("@/lib/db/drafts", () => ({
  findLiveDraft: mockFindLiveDraft,
}));

// mintDraftToken is tested separately in lib/draft/token.test.ts.
// Mock it here so the action test isn't sensitive to HMAC internals.
vi.mock("@/lib/draft/token", () => ({
  mintDraftToken: vi.fn(() => "test-token-stub"),
}));

import { loadWorkspacePreviewStateAction, loadDraftPreviewInfo } from "./workspace-preview";
import { PreviewProtectedError } from "@/lib/vercel/preview-protection";

function readyBuildState() {
  return {
    latestBuild: {
      id: "build_1",
      status: "ready",
      failedPhase: null,
      previewUrl: "https://x.vercel.app",
      pageCount: null,
      blockTypeCount: null,
      componentCount: null,
      fidelityAvg: null,
      createdAt: "2026-06-03T00:00:00Z",
      finishedAt: null,
    },
    latestPreview: {
      id: "dpl_1",
      siteBuildId: "build_1",
      environment: "preview" as const,
      status: "ready" as const,
      url: "https://x.vercel.app",
      providerDeploymentId: "v1",
      readyAt: null,
      createdAt: "2026-06-03T00:00:00Z",
    },
    latestReadyBuild: null,
    latestReadyPreview: null,
    productionDeployment: null,
    deployHistory: [],
    hasActiveBuild: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertReachable.mockResolvedValue(undefined);
  mockHasOpenEdit.mockResolvedValue(false);
});

describe("loadWorkspacePreviewStateAction", () => {
  it("returns { ok: false, reason: 'not_found' } on PGRST116", async () => {
    mockSingle.mockResolvedValue({ data: null, error: { code: "PGRST116" } });
    const result = await loadWorkspacePreviewStateAction("proj_x");
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(mockLoadProjectBuildState).not.toHaveBeenCalled();
  });

  it("returns the derived preview state with protected=false when reachable", async () => {
    mockSingle.mockResolvedValue({ data: { id: "proj_1" }, error: null });
    mockLoadProjectBuildState.mockResolvedValue(readyBuildState());
    const result = await loadWorkspacePreviewStateAction("proj_1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.kind).toBe("ready");
      expect(result.protected).toBe(false);
    }
  });

  it("sets protected=true (does NOT throw) when assertPreviewReachable throws PreviewProtectedError", async () => {
    mockSingle.mockResolvedValue({ data: { id: "proj_1" }, error: null });
    mockLoadProjectBuildState.mockResolvedValue(readyBuildState());
    mockAssertReachable.mockRejectedValue(
      new PreviewProtectedError("https://x.vercel.app", 401),
    );
    const result = await loadWorkspacePreviewStateAction("proj_1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.protected).toBe(true);
      expect(result.state.kind).toBe("ready");
    }
  });

  it("does not call assertPreviewReachable when the state is not 'ready'", async () => {
    mockSingle.mockResolvedValue({ data: { id: "proj_1" }, error: null });
    const buildingState = {
      ...readyBuildState(),
      latestBuild: { ...readyBuildState().latestBuild, status: "components" },
      latestPreview: null,
      hasActiveBuild: true,
    };
    mockLoadProjectBuildState.mockResolvedValue(buildingState);
    const result = await loadWorkspacePreviewStateAction("proj_1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.kind).toBe("building");
      expect(result.protected).toBe(false);
    }
    expect(mockAssertReachable).not.toHaveBeenCalled();
  });

  it("returns hasOpenEdit=false by default", async () => {
    mockSingle.mockResolvedValue({ data: { id: "proj_1" }, error: null });
    mockLoadProjectBuildState.mockResolvedValue(readyBuildState());
    const result = await loadWorkspacePreviewStateAction("proj_1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hasOpenEdit).toBe(false);
  });

  it("returns hasOpenEdit=true when an open workspace edit exists", async () => {
    mockSingle.mockResolvedValue({ data: { id: "proj_1" }, error: null });
    mockLoadProjectBuildState.mockResolvedValue(readyBuildState());
    mockHasOpenEdit.mockResolvedValue(true);
    const result = await loadWorkspacePreviewStateAction("proj_1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hasOpenEdit).toBe(true);
  });
});

describe("loadDraftPreviewInfo", () => {
  beforeEach(() => {
    mockFindLiveDraft.mockResolvedValue(null);
  });

  it("returns null when project not found (PGRST116)", async () => {
    mockSingle.mockResolvedValue({ data: null, error: { code: "PGRST116" } });
    const result = await loadDraftPreviewInfo("proj_x");
    expect(result).toBeNull();
    expect(mockFindLiveDraft).not.toHaveBeenCalled();
  });

  it("returns null when no live draft exists", async () => {
    mockSingle.mockResolvedValue({ data: { id: "proj_1" }, error: null });
    mockFindLiveDraft.mockResolvedValue(null);
    const result = await loadDraftPreviewInfo("proj_1");
    expect(result).toBeNull();
  });

  it("returns DraftPreviewInfo with tokenUrl when a live draft exists", async () => {
    mockSingle.mockResolvedValue({ data: { id: "proj_1" }, error: null });
    mockFindLiveDraft.mockResolvedValue({ id: "draft_1", version: 3, base_build_id: "b1", status: "active" });
    const result = await loadDraftPreviewInfo("proj_1");
    expect(result).not.toBeNull();
    expect(result?.draftId).toBe("draft_1");
    expect(result?.version).toBe(3);
    expect(result?.tokenUrl).toBe("/draft/proj_1/?token=test-token-stub&v=3");
  });

  it("version=0 draft (no committed artifacts yet) returns null", async () => {
    mockSingle.mockResolvedValue({ data: { id: "proj_1" }, error: null });
    mockFindLiveDraft.mockResolvedValue({ id: "draft_0", version: 0, base_build_id: "b1", status: "active" });
    const result = await loadDraftPreviewInfo("proj_1");
    // version=0 means no edit has committed a bundle yet — iframe would 404.
    expect(result).toBeNull();
  });
});
