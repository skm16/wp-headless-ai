// apps/web/lib/actions/build-review.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mocks — declared before any SUT import ──────────────────────────────────
// vi.hoisted lifts these into the module-mock factory scope so closures close
// over the same references the test bodies assert against.

const {
  mockUserFrom,
  mockUserClient,
  mockCreateClient,
  mockAdminFrom,
  mockAdminClient,
  mockRedeployToProduction,
  mockPollDeployment,
  mockRecordDeployment,
  mockSupersede,
} = vi.hoisted(() => {
  const mockUserFrom = vi.fn();
  const mockUserClient = { from: mockUserFrom };
  const mockCreateClient = vi.fn(async () => mockUserClient);

  const mockAdminFrom = vi.fn();
  const mockAdminClient = { from: mockAdminFrom };

  const mockRedeployToProduction = vi
    .fn()
    .mockResolvedValue({ id: "dpl_prod_1" });
  const mockPollDeployment = vi.fn().mockResolvedValue({
    outcome: "READY",
    deployment: { url: "clone-prod.vercel.app" },
  });
  const mockRecordDeployment = vi.fn().mockResolvedValue({ id: "deploy_row_1" });
  const mockSupersede = vi.fn().mockResolvedValue({ supersededCount: 0 });

  return {
    mockUserFrom,
    mockUserClient,
    mockCreateClient,
    mockAdminFrom,
    mockAdminClient,
    mockRedeployToProduction,
    mockPollDeployment,
    mockRecordDeployment,
    mockSupersede,
  };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: mockCreateClient }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => mockAdminClient),
}));
vi.mock("@/lib/vercel/load-client", () => ({
  loadVercelClient: vi.fn(() => ({
    redeployToProduction: mockRedeployToProduction,
  })),
}));
vi.mock("@/lib/vercel/poll-deployment", () => ({
  pollDeployment: mockPollDeployment,
}));
vi.mock("@/lib/jab/deployments-recorder", () => ({
  recordDeployment: mockRecordDeployment,
  supersedePreviousProductionDeployments: mockSupersede,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { publishBuildAction } from "./build-review";

// ── shared fixtures / routers ───────────────────────────────────────────────

const PREVIEW_ROW = {
  id: "preview_1",
  provider_deployment_id: "dpl_preview_1",
  url: "preview.vercel.app",
};
const PROJECT_VERCEL = {
  id: "proj_1",
  vercel_project_id: "vp_1",
  vercel_project_name: "jab-proj-1",
};

/** The RLS user client: site_builds single-load + fidelity_reports list. */
function userRouter(build: {
  id: string;
  project_id: string;
  status: string;
  config: unknown;
}) {
  return (table: string) => {
    if (table === "site_builds") {
      return {
        select: () => ({
          eq: () => ({ single: async () => ({ data: build, error: null }) }),
        }),
      };
    }
    if (table === "fidelity_reports") {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ approval_status: "approved" }],
            error: null,
          }),
        }),
      };
    }
    throw new Error(`unexpected user table: ${table}`);
  };
}

/**
 * The admin (service-role) client. Routes:
 *   - deployments: the preview-row maybeSingle read.
 *   - projects (select id, vercel_project_id, vercel_project_name).single() →
 *     the Vercel link, AND the publish_draft finalize select("design_tokens").single().
 *   - projects update(design_tokens) → captured into design_tokens_writes.
 *   - drafts update(status='published') → captured into draft_writes.
 *   - workspace_edits update → edit lineage (no-op for these tests).
 */
function adminRouter(opts: {
  existingDesignTokens?: unknown;
  designTokensWrites: Array<Record<string, unknown>>;
  draftWrites: Array<{ status: string }>;
  /** Whether the draft CAS (publishing→published) matches a row. Default true. */
  draftCasMatches?: boolean;
  /** Whether the C1 promote-claim CAS (ready + promoting_at NULL) matches. Default true. */
  claimMatches?: boolean;
  /** Captures promoting_at:null release-claim writes (C1 failure path). */
  claimReleases?: Array<true>;
  /** When true, the projects.design_tokens write throws (R4 brand-commit failure). */
  brandCommitThrows?: boolean;
  /** Draft status returned by the P2 post-claim re-check read. Default 'publishing'. */
  draftStatus?: string;
  /** The latest publish_draft build the P2 "current publish" query returns. Unset → none. */
  currentPublishBuild?: { id: string; draftId: string };
  /** When true, the P2 current-publish-build query errors (fail-closed). */
  publishBuildQueryError?: boolean;
}) {
  return (table: string) => {
    // C1: the promote-claim (update promoting_at).eq(id).eq(status).is(promoting_at,null).select
    // and the release (update promoting_at:null).eq(id).eq(status) both hit site_builds.
    if (table === "site_builds") {
      return {
        // P2 current-publish-build query: .select("id, config").eq().in().order()
        select: () => ({
          eq: () => ({
            in: () => ({
              order: async () => ({
                data: opts.currentPublishBuild
                  ? [
                      {
                        id: opts.currentPublishBuild.id,
                        config: { mode: "publish_draft", draft_id: opts.currentPublishBuild.draftId },
                      },
                    ]
                  : [],
                error: opts.publishBuildQueryError ? { message: "boom" } : null,
              }),
            }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          if (payload.promoting_at === null) {
            opts.claimReleases?.push(true);
            return { eq: () => ({ eq: async () => ({ error: null }) }) };
          }
          return {
            eq: () => ({
              eq: () => ({
                is: () => ({
                  select: async () => ({
                    data: (opts.claimMatches ?? true) ? [{ id: "claimed" }] : [],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        },
      };
    }
    if (table === "deployments") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({
                      data: PREVIEW_ROW,
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      };
    }
    if (table === "projects") {
      return {
        select: (cols: string) => {
          // publish_draft finalize: select("design_tokens").eq().single()
          if (cols === "design_tokens") {
            return {
              eq: () => ({
                single: async () => ({
                  data: { design_tokens: opts.existingDesignTokens ?? null },
                  error: null,
                }),
              }),
            };
          }
          // Vercel-link read: select("id, vercel_project_id, vercel_project_name").eq().single()
          return {
            eq: () => ({
              single: async () => ({ data: PROJECT_VERCEL, error: null }),
            }),
          };
        },
        update: (payload: Record<string, unknown>) => {
          opts.designTokensWrites.push(payload);
          return {
            eq: async () => {
              if (opts.brandCommitThrows) throw new Error("brand db down");
              return { error: null };
            },
          };
        },
      };
    }
    if (table === "drafts") {
      return {
        // P2 post-claim re-check: select("status").eq("id").maybeSingle().
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { status: opts.draftStatus ?? "publishing" },
              error: null,
            }),
          }),
        }),
        // Finalize CAS: update(status='published').eq(id).eq(status='publishing').select('id').
        // The brand-commit is gated on this matching a row (draftCasMatches).
        update: (payload: { status: string }) => {
          opts.draftWrites.push(payload);
          return {
            eq: () => ({
              eq: () => ({
                select: async () => ({
                  data: (opts.draftCasMatches ?? true) ? [{ id: "draft" }] : [],
                  error: null,
                }),
              }),
            }),
          };
        },
      };
    }
    if (table === "workspace_edits") {
      return { update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) };
    }
    throw new Error(`unexpected admin table: ${table}`);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedeployToProduction.mockResolvedValue({ id: "dpl_prod_1" });
  mockPollDeployment.mockResolvedValue({
    outcome: "READY",
    deployment: { url: "clone-prod.vercel.app" },
  });
  mockRecordDeployment.mockResolvedValue({ id: "deploy_row_1" });
  mockSupersede.mockResolvedValue({ supersededCount: 0 });
});

describe("publishBuildAction — publish_draft finalize", () => {
  it("commits config.tokens into projects.design_tokens.themeJson and flips the draft to published", async () => {
    const tokens = { colorPalette: [{ slug: "primary", color: "#c00" }] };
    const build = {
      id: "build_pd",
      project_id: "proj_1",
      status: "ready",
      config: {
        mode: "publish_draft",
        draft_id: "draft_1",
        base_build_id: "base_1",
        source_build_id: "base_1",
        changed_slugs: ["home"],
        front_page_slug: "home",
        tokens,
      },
    };
    const designTokensWrites: Array<Record<string, unknown>> = [];
    const draftWrites: Array<{ status: string }> = [];
    mockUserFrom.mockImplementation(userRouter(build));
    mockAdminFrom.mockImplementation(
      adminRouter({
        existingDesignTokens: { colors: { primary: "#000" } },
        designTokensWrites,
        draftWrites,
        currentPublishBuild: { id: "build_pd", draftId: "draft_1" },
      }),
    );

    const result = await publishBuildAction({ buildId: "build_pd" });
    expect(result.productionDeploymentId).toBe("deploy_row_1");

    // (a) projects.design_tokens written with themeJson = config.tokens,
    // preserving any existing non-themeJson keys.
    expect(designTokensWrites).toHaveLength(1);
    expect(designTokensWrites[0]).toEqual({
      design_tokens: { colors: { primary: "#000" }, themeJson: tokens },
    });

    // (b) the draft advanced to published.
    expect(draftWrites).toEqual([{ status: "published" }]);
  });

  it("advances the draft to published without writing design_tokens when the publish_draft build has no token edits", async () => {
    const build = {
      id: "build_pd2",
      project_id: "proj_1",
      status: "ready",
      config: {
        mode: "publish_draft",
        draft_id: "draft_2",
        base_build_id: "base_2",
        source_build_id: "base_2",
        changed_slugs: ["about"],
        front_page_slug: "home",
        // no tokens
      },
    };
    const designTokensWrites: Array<Record<string, unknown>> = [];
    const draftWrites: Array<{ status: string }> = [];
    mockUserFrom.mockImplementation(userRouter(build));
    mockAdminFrom.mockImplementation(
      adminRouter({
        designTokensWrites,
        draftWrites,
        currentPublishBuild: { id: "build_pd2", draftId: "draft_2" },
      }),
    );

    await publishBuildAction({ buildId: "build_pd2" });

    expect(designTokensWrites).toHaveLength(0); // no brand mutation
    expect(draftWrites).toEqual([{ status: "published" }]);
  });

  it("does NOT commit the brand when the draft CAS misses (concurrent cancel flipped it to active)", async () => {
    // Race-safety: if cancelPublishAction flipped the draft publishing→active
    // between the publish-gate check and finalize, the publishing→published CAS
    // matches 0 rows → the brand must NOT be committed onto the abandoned draft.
    const tokens = { colorPalette: [{ slug: "primary", color: "#c00" }] };
    const build = {
      id: "build_pd_raced",
      project_id: "proj_1",
      status: "ready",
      config: {
        mode: "publish_draft",
        draft_id: "draft_raced",
        base_build_id: "base_3",
        source_build_id: "base_3",
        changed_slugs: ["home"],
        front_page_slug: "home",
        tokens,
      },
    };
    const designTokensWrites: Array<Record<string, unknown>> = [];
    const draftWrites: Array<{ status: string }> = [];
    mockUserFrom.mockImplementation(userRouter(build));
    mockAdminFrom.mockImplementation(
      adminRouter({
        existingDesignTokens: null,
        designTokensWrites,
        draftWrites,
        draftCasMatches: false,
        currentPublishBuild: { id: "build_pd_raced", draftId: "draft_raced" },
      }),
    );

    await publishBuildAction({ buildId: "build_pd_raced" });

    // The CAS was attempted (draftWrites records the update call) but matched 0
    // rows, so the brand-commit is skipped.
    expect(draftWrites).toEqual([{ status: "published" }]);
    expect(designTokensWrites).toHaveLength(0);
  });

  it("C1: refuses to publish (no redeploy) when the promote-claim CAS misses", async () => {
    // A concurrent cancel marked the build 'cancelled' (or a prior publish
    // already claimed it) between the gate check and the claim → the
    // ready+promoting_at-NULL CAS matches 0 rows → publish_superseded, and the
    // irreversible Vercel redeploy must NOT run.
    const build = {
      id: "build_claim_miss",
      project_id: "proj_1",
      status: "ready",
      config: { mode: "publish_draft", draft_id: "d", base_build_id: "b", source_build_id: "b", changed_slugs: [], front_page_slug: "home" },
    };
    mockUserFrom.mockImplementation(userRouter(build));
    mockAdminFrom.mockImplementation(
      adminRouter({ designTokensWrites: [], draftWrites: [], claimMatches: false }),
    );

    await expect(publishBuildAction({ buildId: "build_claim_miss" })).rejects.toThrow(
      /no longer ready to publish|publish_superseded/i,
    );
    expect(mockRedeployToProduction).not.toHaveBeenCalled();
    expect(mockRecordDeployment).not.toHaveBeenCalled();
  });

  it("C1: releases the claim (promoting_at→null) and rethrows when the redeploy never goes READY", async () => {
    const build = {
      id: "build_poll_fail",
      project_id: "proj_1",
      status: "ready",
      config: { mode: "full" },
    };
    const claimReleases: Array<true> = [];
    mockUserFrom.mockImplementation(userRouter(build));
    mockAdminFrom.mockImplementation(
      adminRouter({ designTokensWrites: [], draftWrites: [], claimReleases }),
    );
    mockPollDeployment.mockResolvedValueOnce({ outcome: "TIMEOUT", lastReadyState: "BUILDING" });

    await expect(publishBuildAction({ buildId: "build_poll_fail" })).rejects.toThrow(
      /did not become ready|promote_failed/i,
    );
    // The claim was released so a retry can re-claim; no production row written.
    expect(claimReleases).toHaveLength(1);
    expect(mockRecordDeployment).not.toHaveBeenCalled();
  });

  it("P2: refuses + releases the claim when the draft is no longer 'publishing' (cancel raced; build hidden behind a rebuild)", async () => {
    // The build is still 'ready' so the claim succeeds, but the draft was
    // unlocked (publishing→active) without THIS build being cancelled (a rebuild
    // hid it from cancelPublishAction). publishBuildAction must re-check the
    // draft, refuse, release the claim, and deploy NOTHING.
    const build = {
      id: "build_draft_gone",
      project_id: "proj_1",
      status: "ready",
      config: {
        mode: "publish_draft",
        draft_id: "draft_x",
        base_build_id: "b",
        source_build_id: "b",
        changed_slugs: [],
        front_page_slug: "home",
      },
    };
    const claimReleases: Array<true> = [];
    mockUserFrom.mockImplementation(userRouter(build));
    mockAdminFrom.mockImplementation(
      adminRouter({ designTokensWrites: [], draftWrites: [], claimReleases, draftStatus: "active" }),
    );

    await expect(publishBuildAction({ buildId: "build_draft_gone" })).rejects.toThrow(
      /no longer the current publish|publish_superseded/i,
    );
    expect(claimReleases).toHaveLength(1); // claim released → build recoverable
    expect(mockRedeployToProduction).not.toHaveBeenCalled(); // nothing deployed
  });

  it("P2: refuses + releases when a NEWER publish superseded this build (draft still publishing)", async () => {
    // The stale-build hole: this old 'ready' publish_draft build's review URL is
    // used AFTER the same draft started a NEW publish. The draft is 'publishing'
    // again, so a draft-status-only check would PASS and redeploy the stale
    // artifact. The "current publish build" check refuses it — a newer
    // publish_draft build is now current for this draft.
    const build = {
      id: "build_super_old",
      project_id: "proj_1",
      status: "ready",
      config: {
        mode: "publish_draft",
        draft_id: "draft_super",
        base_build_id: "b",
        source_build_id: "b",
        changed_slugs: [],
        front_page_slug: "home",
      },
    };
    const claimReleases: Array<true> = [];
    mockUserFrom.mockImplementation(userRouter(build));
    mockAdminFrom.mockImplementation(
      adminRouter({
        designTokensWrites: [],
        draftWrites: [],
        claimReleases,
        draftStatus: "publishing", // draft IS publishing — re-locked by the newer publish
        currentPublishBuild: { id: "build_super_NEW", draftId: "draft_super" }, // newer build is current
      }),
    );

    await expect(publishBuildAction({ buildId: "build_super_old" })).rejects.toThrow(
      /no longer the current publish|publish_superseded/i,
    );
    expect(claimReleases).toHaveLength(1); // claim released → old build recoverable/inert
    expect(mockRedeployToProduction).not.toHaveBeenCalled(); // stale artifact NOT deployed
  });

  it("R4: a brand-commit failure is NON-FATAL — publish succeeds, claim NOT released, draft stays published", async () => {
    // The draft-finalize CAS succeeds (draft→published), then the brand-commit
    // throws. It must NOT hit the outer catch / release the claim — that would
    // strand the brand unrecoverably (a retry can't re-finalize a published
    // draft). Production already renders the tokens (compose baked them); the
    // failure only leaves the canonical project brand stale, so the publish
    // succeeds and the failure is logged for manual repair.
    const tokens = { colorPalette: [{ slug: "primary", color: "#c00" }] };
    const build = {
      id: "build_brand_fail",
      project_id: "proj_1",
      status: "ready",
      config: {
        mode: "publish_draft",
        draft_id: "draft_brand",
        base_build_id: "b",
        source_build_id: "b",
        changed_slugs: ["home"],
        front_page_slug: "home",
        tokens,
      },
    };
    const designTokensWrites: Array<Record<string, unknown>> = [];
    const draftWrites: Array<{ status: string }> = [];
    const claimReleases: Array<true> = [];
    mockUserFrom.mockImplementation(userRouter(build));
    mockAdminFrom.mockImplementation(
      adminRouter({
        designTokensWrites,
        draftWrites,
        claimReleases,
        brandCommitThrows: true,
        currentPublishBuild: { id: "build_brand_fail", draftId: "draft_brand" },
      }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await publishBuildAction({ buildId: "build_brand_fail" });

    expect(result.productionDeploymentId).toBe("deploy_row_1"); // publish succeeded
    expect(draftWrites).toEqual([{ status: "published" }]); // draft finalized
    expect(claimReleases).toHaveLength(0); // claim NOT released — not a failure path
    // The stale-brand condition is logged with the operator manual-repair line —
    // the only signal there is, so guard it from silent removal.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("brand-commit failed"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Manual repair:"));
    errorSpy.mockRestore();
  });

  it("C1/R2: releases the claim when post-deploy bookkeeping fails (no permanent strand)", async () => {
    // The Vercel redeploy SUCCEEDS but recordDeployment throws. The claim must
    // still be released so the build stays recoverable (cancel / re-publish)
    // instead of stranding the draft at 'publishing' forever.
    const build = {
      id: "build_record_fail",
      project_id: "proj_1",
      status: "ready",
      config: { mode: "full" },
    };
    const claimReleases: Array<true> = [];
    mockUserFrom.mockImplementation(userRouter(build));
    mockAdminFrom.mockImplementation(
      adminRouter({ designTokensWrites: [], draftWrites: [], claimReleases }),
    );
    mockRecordDeployment.mockRejectedValueOnce(new Error("db down"));

    await expect(publishBuildAction({ buildId: "build_record_fail" })).rejects.toThrow(/db down/);
    expect(mockRedeployToProduction).toHaveBeenCalled(); // the deploy DID happen
    expect(claimReleases).toHaveLength(1); // …and the claim was released for recovery
  });

  it("does not touch design_tokens or drafts for a non-publish_draft build", async () => {
    const build = {
      id: "build_full",
      project_id: "proj_1",
      status: "ready",
      config: { mode: "full" },
    };
    const designTokensWrites: Array<Record<string, unknown>> = [];
    const draftWrites: Array<{ status: string }> = [];
    mockUserFrom.mockImplementation(userRouter(build));
    mockAdminFrom.mockImplementation(
      adminRouter({ designTokensWrites, draftWrites }),
    );

    await publishBuildAction({ buildId: "build_full" });

    expect(designTokensWrites).toHaveLength(0);
    expect(draftWrites).toHaveLength(0);
  });
});
