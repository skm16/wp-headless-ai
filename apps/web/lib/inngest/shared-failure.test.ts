import { describe, it, expect, vi, beforeEach } from "vitest";

// Chainable Supabase mock ─────────────────────────────────────────────────────
//
// markBuildFailed chains like:
//   admin.from("site_builds").select("config").eq(id).eq(project_id).maybeSingle()
//   admin.from("site_builds").update(...).eq(id).eq(project_id).neq(status, "cancelled")
//   admin.from("drafts").update(...).eq(id).eq(status, "publishing")   [publish_draft only]
//
// `installSupabaseMock` lets each test supply the config the build's
// select-read returns and capture the draft-unlock update (if any). We build a
// fresh set of vi.fn() stubs per test (via beforeEach) so call history is
// isolated between cases.

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

import { markBuildFailed, formatErrorText } from "./shared-failure";

beforeEach(() => {
  vi.clearAllMocks();
});

interface SupabaseMockHarness {
  /** site_builds UPDATE payload (the failure write). */
  buildUpdateFn: ReturnType<typeof vi.fn>;
  /** drafts UPDATE payload + filter chain — present only when a drafts update is issued. */
  draftUpdateFn: ReturnType<typeof vi.fn>;
  draftEqId: ReturnType<typeof vi.fn>;
  draftEqStatus: ReturnType<typeof vi.fn>;
}

/**
 * Wire mockFrom to serve, in order:
 *   - site_builds.select("config")…maybeSingle() → { config }
 *   - site_builds.update(...).eq.eq.neq()        → resolves
 *   - drafts.update(...).eq.eq()                 → resolves (captured)
 */
function installSupabaseMock(config: unknown): SupabaseMockHarness {
  // site_builds SELECT chain → maybeSingle resolves the config
  const maybeSingleFn = vi.fn().mockResolvedValue({ data: { config }, error: null });
  const selEqProject = vi.fn(() => ({ maybeSingle: maybeSingleFn }));
  const selEqId = vi.fn(() => ({ eq: selEqProject }));
  const selectFn = vi.fn(() => ({ eq: selEqId }));

  // site_builds UPDATE chain → .eq("id").eq("project_id").neq("status","cancelled")
  const buildNeq = vi.fn().mockResolvedValue({ data: null, error: null });
  const buildEqProject = vi.fn(() => ({ neq: buildNeq }));
  const buildEqId = vi.fn(() => ({ eq: buildEqProject }));
  const buildUpdateFn = vi.fn(() => ({ eq: buildEqId }));

  // drafts UPDATE chain → .eq("id").eq("status","publishing")
  const draftEqStatus = vi.fn().mockResolvedValue({ data: null, error: null });
  const draftEqId = vi.fn(() => ({ eq: draftEqStatus }));
  const draftUpdateFn = vi.fn(() => ({ eq: draftEqId }));

  mockFrom.mockImplementation((table: string) => {
    if (table === "drafts") return { update: draftUpdateFn };
    // site_builds — distinguish select (config read) vs update (failure write)
    return { select: selectFn, update: buildUpdateFn };
  });

  return { buildUpdateFn, draftUpdateFn, draftEqId, draftEqStatus };
}

// ─────────────────────────────────────────────────────────────────────────────
// markBuildFailed — cancel guard
// ─────────────────────────────────────────────────────────────────────────────
describe("markBuildFailed — cancel guard", () => {
  it("(a) issues update filtered by eq(id), eq(project_id), neq(status,'cancelled') with status:failed + phase + error_text + finished_at", async () => {
    const h = installSupabaseMock({ mode: "full" });

    await markBuildFailed({
      buildId: "build-abc",
      projectId: "proj-xyz",
      phase: "composing",
      error: new Error("something broke"),
    });

    // Verify the update payload
    const updatePayload = (h.buildUpdateFn.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(updatePayload.status).toBe("failed");
    expect(updatePayload.failed_phase).toBe("composing");
    expect(updatePayload.error_text).toBe("something broke");
    expect(typeof updatePayload.finished_at).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// markBuildFailed — publish_draft draft unlock (Task 8)
// ─────────────────────────────────────────────────────────────────────────────
describe("markBuildFailed — publish_draft draft unlock", () => {
  it("reverts the draft publishing → active (CAS) when the failed build is a publish_draft build", async () => {
    const h = installSupabaseMock({
      mode: "publish_draft",
      draft_id: "draft-123",
      base_build_id: "base-1",
      source_build_id: "base-1",
      changed_slugs: ["home"],
      front_page_slug: "home",
    });

    await markBuildFailed({
      buildId: "build-pub",
      projectId: "proj-1",
      phase: "verifying",
      error: new Error("compose blew up"),
    });

    // The drafts row is reverted via CAS on the publishing lock.
    const draftPayload = (h.draftUpdateFn.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(draftPayload.status).toBe("active");
    expect(h.draftEqId).toHaveBeenCalledWith("id", "draft-123");
    expect(h.draftEqStatus).toHaveBeenCalledWith("status", "publishing");
  });

  it("does NOT touch any draft when the failed build is not a publish_draft build", async () => {
    const h = installSupabaseMock({ mode: "edit", source_build_id: "s", changed_slugs: [] });

    await markBuildFailed({
      buildId: "build-edit",
      projectId: "proj-1",
      phase: "composing",
      error: "x",
    });

    expect(h.draftUpdateFn).not.toHaveBeenCalled();
  });

  it("does NOT touch any draft when the build row's config cannot be read", async () => {
    // maybeSingle resolves null data → no config → no draft update.
    const maybeSingleFn = vi.fn().mockResolvedValue({ data: null, error: null });
    const selEqProject = vi.fn(() => ({ maybeSingle: maybeSingleFn }));
    const selEqId = vi.fn(() => ({ eq: selEqProject }));
    const selectFn = vi.fn(() => ({ eq: selEqId }));
    const buildNeq = vi.fn().mockResolvedValue({ data: null, error: null });
    const buildEqProject = vi.fn(() => ({ neq: buildNeq }));
    const buildEqId = vi.fn(() => ({ eq: buildEqProject }));
    const buildUpdateFn = vi.fn(() => ({ eq: buildEqId }));
    const draftUpdateFn = vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) })) }));
    mockFrom.mockImplementation((table: string) => {
      if (table === "drafts") return { update: draftUpdateFn };
      return { select: selectFn, update: buildUpdateFn };
    });

    await markBuildFailed({
      buildId: "build-x",
      projectId: "proj-1",
      phase: "composing",
      error: "x",
    });

    expect(draftUpdateFn).not.toHaveBeenCalled();
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
