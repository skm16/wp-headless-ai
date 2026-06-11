// apps/web/lib/actions/workspace-preview.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- mocks (declared before importing the SUT) ---
// vi.hoisted ensures these are available when vi.mock factory runs (hoisted above imports).
const { mockSingle, mockCreateClient, mockLoadProjectBuildState, mockAssertReachable, mockHasOpenEdit } =
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
    return { mockSingle, mockCreateClient, mockLoadProjectBuildState, mockAssertReachable, mockHasOpenEdit };
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

import { loadWorkspacePreviewStateAction } from "./workspace-preview";
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
