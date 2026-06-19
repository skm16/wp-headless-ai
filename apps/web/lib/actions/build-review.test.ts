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
}) {
  return (table: string) => {
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
          return { eq: async () => ({ error: null }) };
        },
      };
    }
    if (table === "drafts") {
      return {
        update: (payload: { status: string }) => {
          opts.draftWrites.push(payload);
          return { eq: () => ({ eq: async () => ({ error: null }) }) };
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
      adminRouter({ designTokensWrites, draftWrites }),
    );

    await publishBuildAction({ buildId: "build_pd2" });

    expect(designTokensWrites).toHaveLength(0); // no brand mutation
    expect(draftWrites).toEqual([{ status: "published" }]);
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
