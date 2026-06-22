// apps/web/lib/actions/publish-draft-action.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mocks — declared before any SUT import ──────────────────────────────────
// vi.hoisted lifts these into the module-mock factory scope so closures close
// over the same references the test bodies assert against.

const {
  mockInngestSend,
  mockProjectSingle,
  mockCreateClient,
  mockFindLiveDraft,
  mockLoadDraftSteps,
  mockAutoFailStaleActiveBuild,
  mockAdminFrom,
  mockAdminClient,
} = vi.hoisted(() => {
  const mockInngestSend = vi.fn().mockResolvedValue(undefined);

  // ── RLS client (createClient): projects select-single → { id, tenant_id }. ──
  const mockProjectSingle = vi.fn().mockResolvedValue({
    data: { id: "proj_1", tenant_id: "tenant_1" },
    error: null,
  });
  const mockCreateClient = vi.fn(async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: mockProjectSingle }) }),
    }),
  }));

  // ── Admin client (createAdminClient): per-table behavior wired by mockAdminFrom. ──
  const mockAdminFrom = vi.fn();
  const mockAdminClient = { from: mockAdminFrom };

  // ── db helpers ────────────────────────────────────────────────────────────
  const mockFindLiveDraft = vi.fn();
  const mockLoadDraftSteps = vi.fn().mockResolvedValue([]);
  const mockAutoFailStaleActiveBuild = vi.fn().mockResolvedValue(false);

  return {
    mockInngestSend,
    mockProjectSingle,
    mockCreateClient,
    mockFindLiveDraft,
    mockLoadDraftSteps,
    mockAutoFailStaleActiveBuild,
    mockAdminFrom,
    mockAdminClient,
  };
});

vi.mock("@/lib/inngest/client", () => ({ inngest: { send: mockInngestSend } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mockCreateClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => mockAdminClient) }));
vi.mock("@/lib/db/drafts", () => ({
  findLiveDraft: mockFindLiveDraft,
  loadDraftSteps: mockLoadDraftSteps,
}));
vi.mock("@/lib/db/auto-fail-stale-build", () => ({
  autoFailStaleActiveBuild: mockAutoFailStaleActiveBuild,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { publishDraftAction, cancelPublishAction } from "./publish-draft-action";
import { DRAFT_PUBLISH_REQUESTED_EVENT } from "@/lib/inngest/publish-draft-event";

// ── test fixtures ────────────────────────────────────────────────────────────

const ACTIVE_DRAFT = { id: "draft_1", base_build_id: "base_1", version: 3, status: "active" };

const ONE_ACTIVE_STEP = [
  { id: "e1", status: "completed", undone_at: null, changed_slugs: ["home"], created_at: "2026-06-18T00:00:00Z", scope: "component", target: "core/cover" },
];

/**
 * Build the admin-client `from(table)` router for the happy path:
 *   - site_builds: the latest-build concurrency read (returns [] = no active),
 *     and the insert → queued row with id 'pub_build_1'.
 *   - drafts: the CAS lock UPDATE drafts SET status='publishing' (1 row).
 */
function happyAdminRouter(opts?: {
  latestBuilds?: Array<{ id: string; status: string }>;
  lockRows?: Array<{ id: string }>;
  insertError?: { code?: string; message: string } | null;
}) {
  const latestBuilds = opts?.latestBuilds ?? [];
  const lockRows = opts?.lockRows ?? [{ id: "draft_1" }];
  const insertError = opts?.insertError ?? null;

  return (table: string) => {
    if (table === "site_builds") {
      return {
        // publishDraft concurrency read: .select().eq().order().limit()
        // cancel build-find: .select().eq().in().order()  (no limit)
        select: () => ({
          eq: () => ({
            order: () => ({ limit: async () => ({ data: latestBuilds, error: null }) }),
            in: () => ({ order: async () => ({ data: latestBuilds, error: null }) }),
          }),
        }),
        // insert: .insert().select().single()
        insert: () => ({
          select: () => ({
            single: async () =>
              insertError
                ? { data: null, error: insertError }
                : { data: { id: "pub_build_1" }, error: null },
          }),
        }),
        // dispatch-failure cleanup: .update().eq()
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    if (table === "drafts") {
      // CAS lock / unlock: .update().eq().eq().select()
      return {
        update: () => ({
          eq: () => ({ eq: () => ({ select: async () => ({ data: lockRows, error: null }) }) }),
        }),
      };
    }
    throw new Error(`unexpected admin table: ${table}`);
  };
}

/**
 * Router for cancelPublishAction's C1 path: the build-find read
 * (select→eq→in→order, returns ALL candidate builds — active + ready), the
 * CAS-cancel of each publish_draft build (update→eq(id)→eq(status)→is→select),
 * and the draft unlock (update→eq→eq→select). `buildCancelTargetIds` captures
 * the id each CAS-cancel targets so a test can assert it cancelled the
 * publish_draft build (not a newer non-publish build that hid it).
 */
function cancelAdminRouter(opts: {
  builds: Array<{ id: string; status: string; config: unknown }>;
  buildCancelRows: Array<{ id: string }>;
  draftUnlockRows: Array<{ id: string }>;
  buildCancelTargetIds?: string[];
  draftUpdateSpy?: (payload: Record<string, unknown>) => void;
  /** When true, the candidate-build lookup errors (cancel must fail closed). */
  buildsQueryError?: boolean;
}) {
  return (table: string) => {
    if (table === "site_builds") {
      return {
        select: () => ({
          eq: () => ({
            in: () => ({
              order: async () => ({
                data: opts.buildsQueryError ? null : opts.builds,
                error: opts.buildsQueryError ? { message: "boom" } : null,
              }),
            }),
          }),
        }),
        // CAS-cancel: .update().eq("id", pb.id).is("promoting_at", null).select("id")
        // (no status pin — see cancelPublishAction comment, Finding 1.)
        update: () => ({
          eq: (_col: string, id: string) => ({
            is: () => ({
              select: async () => {
                opts.buildCancelTargetIds?.push(id);
                return { data: opts.buildCancelRows, error: null };
              },
            }),
          }),
        }),
      };
    }
    if (table === "drafts") {
      return {
        update: (payload: Record<string, unknown>) => {
          opts.draftUpdateSpy?.(payload);
          return {
            eq: () => ({ eq: () => ({ select: async () => ({ data: opts.draftUnlockRows, error: null }) }) }),
          };
        },
      };
    }
    throw new Error(`unexpected admin table: ${table}`);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProjectSingle.mockResolvedValue({ data: { id: "proj_1", tenant_id: "tenant_1" }, error: null });
  mockFindLiveDraft.mockResolvedValue(ACTIVE_DRAFT);
  mockLoadDraftSteps.mockResolvedValue(ONE_ACTIVE_STEP);
  mockAutoFailStaleActiveBuild.mockResolvedValue(false);
  mockAdminFrom.mockImplementation(happyAdminRouter());
});

describe("publishDraftAction", () => {
  it("throws no_draft when the project has no live draft", async () => {
    mockFindLiveDraft.mockResolvedValueOnce(null);
    await expect(publishDraftAction("proj_1")).rejects.toThrow(/no_draft/);
  });

  it("throws nothing_to_publish when the draft has no active steps", async () => {
    mockLoadDraftSteps.mockResolvedValueOnce([]); // no completed, non-undone steps
    await expect(publishDraftAction("proj_1")).rejects.toThrow(/nothing_to_publish/);
  });

  it("throws nothing_to_publish when all steps are undone", async () => {
    mockLoadDraftSteps.mockResolvedValueOnce([
      { id: "e1", status: "completed", undone_at: "2026-06-18T01:00:00Z", changed_slugs: ["home"], created_at: "2026-06-18T00:00:00Z", scope: "component", target: "core/cover" },
    ]);
    await expect(publishDraftAction("proj_1")).rejects.toThrow(/nothing_to_publish/);
  });

  it("refuses when another build is active for the project", async () => {
    mockAdminFrom.mockImplementation(
      happyAdminRouter({ latestBuilds: [{ id: "b_active", status: "composing" }] }),
    );
    await expect(publishDraftAction("proj_1")).rejects.toThrow(/active_build|in flight/i);
  });

  it("happy path: inserts a queued publish_draft build, CAS-locks the draft, dispatches the event", async () => {
    const result = await publishDraftAction("proj_1");
    expect(result).toEqual({ buildId: "pub_build_1" });

    // stale-build self-heal ran before the concurrency check
    expect(mockAutoFailStaleActiveBuild).toHaveBeenCalledWith("proj_1");

    // dispatched draft/publish.requested with the new build id + draft + tenant
    expect(mockInngestSend).toHaveBeenCalledTimes(1);
    const sent = mockInngestSend.mock.calls[0][0] as {
      name: string;
      data: { projectId: string; tenantId: string; draftId: string; buildId: string };
    };
    expect(sent.name).toBe(DRAFT_PUBLISH_REQUESTED_EVENT);
    expect(sent.data).toEqual({
      projectId: "proj_1",
      tenantId: "tenant_1",
      draftId: "draft_1",
      buildId: "pub_build_1",
    });
  });

  it("throws when the CAS lock loses the race (0 rows updated)", async () => {
    mockAdminFrom.mockImplementation(happyAdminRouter({ lockRows: [] }));
    await expect(publishDraftAction("proj_1")).rejects.toThrow();
    // a lost lock must NOT dispatch the worker
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("throws not_found when the project is not the caller's", async () => {
    mockProjectSingle.mockResolvedValueOnce({ data: null, error: { code: "PGRST116" } });
    await expect(publishDraftAction("proj_1")).rejects.toThrow(/not_found/);
  });
});

describe("cancelPublishAction", () => {
  it("flips a publishing draft back to active and returns ok", async () => {
    mockFindLiveDraft.mockResolvedValueOnce({ ...ACTIVE_DRAFT, status: "publishing" });
    mockAdminFrom.mockImplementation(happyAdminRouter({ lockRows: [{ id: "draft_1" }] }));
    const result = await cancelPublishAction("proj_1");
    expect(result).toEqual({ ok: true });
  });

  it("returns an error when there is no live draft", async () => {
    mockFindLiveDraft.mockResolvedValueOnce(null);
    const result = await cancelPublishAction("proj_1");
    expect(result.ok).toBe(false);
  });

  it("returns not_publishing without touching builds when the draft is active (nothing to cancel)", async () => {
    mockFindLiveDraft.mockResolvedValueOnce({ ...ACTIVE_DRAFT, status: "active" });
    const fromSpy = vi.fn(() => {
      throw new Error("admin.from must not be called when the draft is not publishing");
    });
    mockAdminFrom.mockImplementation(fromSpy);

    const result = await cancelPublishAction("proj_1");

    expect(result).toEqual({ ok: false, error: "not_publishing" });
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("C1 residual: cancels the publish_draft build behind a newer non-publish build, then unlocks the draft", async () => {
    // A normal rebuild was started while the publish_draft build sat at 'ready'
    // review, so a newer 'full' build is the LATEST. cancel must still find +
    // cancel the publish_draft build (not just inspect the latest) before
    // unlocking the draft — otherwise the old 'ready' publish_draft build stays
    // claimable + promotable to production.
    mockFindLiveDraft.mockResolvedValueOnce({ ...ACTIVE_DRAFT, status: "publishing" });
    const cancelTargets: string[] = [];
    const draftUpdateSpy = vi.fn();
    mockAdminFrom.mockImplementation(
      cancelAdminRouter({
        builds: [
          { id: "newer_full", status: "composing", config: { mode: "full" } },
          { id: "pub_ready", status: "ready", config: { mode: "publish_draft", draft_id: "draft_1" } },
        ],
        buildCancelRows: [{ id: "pub_ready" }], // CAS hit: promoting_at NULL
        draftUnlockRows: [{ id: "draft_1" }],
        buildCancelTargetIds: cancelTargets,
        draftUpdateSpy,
      }),
    );

    const result = await cancelPublishAction("proj_1");

    expect(result).toEqual({ ok: true });
    // It cancelled the PUBLISH build, not the newer full build that hid it.
    expect(cancelTargets).toEqual(["pub_ready"]);
    expect(draftUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
  });

  it("C1: fails closed (refuses, does NOT unlock the draft) when the candidate-build lookup errors", async () => {
    // A fail-OPEN lookup would unlock the draft while leaving a still-'ready'
    // publish_draft build claimable — the exact precondition for the stale-build
    // promotion hole. Fail closed instead.
    mockFindLiveDraft.mockResolvedValueOnce({ ...ACTIVE_DRAFT, status: "publishing" });
    const draftUpdateSpy = vi.fn();
    mockAdminFrom.mockImplementation(
      cancelAdminRouter({
        builds: [],
        buildCancelRows: [],
        draftUnlockRows: [{ id: "draft_1" }],
        buildsQueryError: true,
        draftUpdateSpy,
      }),
    );

    const result = await cancelPublishAction("proj_1");

    expect(result.ok).toBe(false);
    expect(draftUpdateSpy).not.toHaveBeenCalled(); // draft NOT unlocked
  });

  it("C1: refuses (promote_in_progress) and does NOT unlock the draft when the publish_draft build is already promoting", async () => {
    // The publish_draft build has promoting_at set, so its CAS-cancel
    // (status + promoting_at IS NULL) matches 0 rows. cancel must refuse and
    // leave the draft 'publishing' — never free it out from under the live redeploy.
    mockFindLiveDraft.mockResolvedValueOnce({ ...ACTIVE_DRAFT, status: "publishing" });
    const draftUpdateSpy = vi.fn();
    mockAdminFrom.mockImplementation(
      cancelAdminRouter({
        builds: [
          { id: "pub_ready", status: "ready", config: { mode: "publish_draft", draft_id: "draft_1" } },
        ],
        buildCancelRows: [], // CAS missed: promoting_at was set
        draftUnlockRows: [{ id: "draft_1" }],
        draftUpdateSpy,
      }),
    );

    const result = await cancelPublishAction("proj_1");

    expect(result).toEqual({ ok: false, error: "promote_in_progress" });
    expect(draftUpdateSpy).not.toHaveBeenCalled();
  });
});
