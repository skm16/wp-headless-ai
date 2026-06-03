import { describe, it, expect, vi } from "vitest";
import {
  loadProjectBuildState,
  loadDashboardBuildStates,
} from "./load-project-builds";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Two narrow mock builders — supabase's chainable query builder is the
 * pain point. Each builds a `from()` that returns a chain whose terminal
 * method (`limit` for site_builds, `in` + .order for the dashboard
 * batched query) resolves with the mock rows.
 */
function makeChain(resolver: (table: string) => unknown) {
  return {
    from: vi.fn((table: string) => {
      const data = resolver(table);
      const terminal = { data, error: null };
      const builder: Record<string, unknown> = {};
      builder.select = vi.fn().mockReturnValue(builder);
      builder.eq = vi.fn().mockReturnValue(builder);
      builder.in = vi.fn().mockReturnValue(builder);
      builder.order = vi.fn().mockReturnValue(builder);
      // limit is the awaited terminal for the loadProjectBuildState path.
      builder.limit = vi.fn().mockResolvedValue(terminal);
      // .then needs to be the implicit terminal for the dashboard path
      // where there's no .limit() — i.e. await on the builder itself.
      builder.then = (resolve: (value: typeof terminal) => unknown) =>
        Promise.resolve(terminal).then(resolve);
      return builder;
    }),
  } as unknown as SupabaseClient;
}

describe("loadProjectBuildState", () => {
  it("returns nulls when the project has no builds and no deployments", async () => {
    const supabase = makeChain(() => []);
    const result = await loadProjectBuildState(supabase, "proj_1");
    expect(result.latestBuild).toBeNull();
    expect(result.latestPreview).toBeNull();
    expect(result.productionDeployment).toBeNull();
    expect(result.deployHistory).toEqual([]);
    expect(result.hasActiveBuild).toBe(false);
  });

  it("flags hasActiveBuild=true when latest build is in-flight", async () => {
    const supabase = makeChain((table) => {
      if (table === "site_builds") {
        return [
          {
            id: "build_1",
            status: "discovering",
            failed_phase: null,
            preview_url: null,
            page_count: null,
            block_type_count: null,
            component_count: null,
            fidelity_avg: null,
            created_at: "2026-06-03T00:00:00Z",
            finished_at: null,
          },
        ];
      }
      return [];
    });
    const result = await loadProjectBuildState(supabase, "proj_1");
    expect(result.hasActiveBuild).toBe(true);
    expect(result.latestBuild?.status).toBe("discovering");
  });

  it("surfaces production deployment when present", async () => {
    const supabase = makeChain((table) => {
      if (table === "site_builds") {
        return [
          {
            id: "build_1",
            status: "ready",
            failed_phase: null,
            preview_url: "https://prev.vercel.app",
            page_count: 5,
            block_type_count: 12,
            component_count: 12,
            fidelity_avg: "0.880",
            created_at: "2026-06-03T00:00:00Z",
            finished_at: "2026-06-03T00:10:00Z",
          },
        ];
      }
      if (table === "deployments") {
        return [
          {
            id: "dep_prod",
            site_build_id: "build_1",
            environment: "production",
            status: "ready",
            url: "https://prod.vercel.app",
            provider_deployment_id: "dpl_prod",
            ready_at: "2026-06-03T00:11:00Z",
            created_at: "2026-06-03T00:11:00Z",
          },
          {
            id: "dep_prev",
            site_build_id: "build_1",
            environment: "preview",
            status: "ready",
            url: "https://prev.vercel.app",
            provider_deployment_id: "dpl_prev",
            ready_at: "2026-06-03T00:09:00Z",
            created_at: "2026-06-03T00:09:00Z",
          },
        ];
      }
      return [];
    });
    const result = await loadProjectBuildState(supabase, "proj_1");
    expect(result.productionDeployment?.url).toBe("https://prod.vercel.app");
    expect(result.latestPreview?.url).toBe("https://prev.vercel.app");
    expect(result.deployHistory).toHaveLength(2);
    expect(result.hasActiveBuild).toBe(false);
  });

  it("returns latestPreview=null when the latest build has no preview row", async () => {
    const supabase = makeChain((table) => {
      if (table === "site_builds") {
        return [
          {
            id: "build_new",
            status: "ready",
            failed_phase: null,
            preview_url: null,
            page_count: 0,
            block_type_count: 0,
            component_count: 0,
            fidelity_avg: null,
            created_at: "2026-06-03T00:00:00Z",
            finished_at: "2026-06-03T00:01:00Z",
          },
        ];
      }
      if (table === "deployments") {
        // preview row belongs to an OLDER build
        return [
          {
            id: "dep_old",
            site_build_id: "build_old",
            environment: "preview",
            status: "ready",
            url: "https://old.vercel.app",
            provider_deployment_id: "dpl_old",
            ready_at: null,
            created_at: "2026-06-02T00:00:00Z",
          },
        ];
      }
      return [];
    });
    const result = await loadProjectBuildState(supabase, "proj_1");
    expect(result.latestPreview).toBeNull();
  });
});

describe("loadDashboardBuildStates", () => {
  it("returns an empty Map when no projectIds are passed", async () => {
    const supabase = makeChain(() => []);
    const result = await loadDashboardBuildStates(supabase, []);
    expect(result.size).toBe(0);
  });

  it("maps every projectId to its latest-build + production-deploy state", async () => {
    const supabase = makeChain((table) => {
      if (table === "site_builds") {
        return [
          { project_id: "p1", id: "b1", status: "ready", preview_url: "https://p1.vercel.app", created_at: "2026-06-03T00:00:00Z" },
          { project_id: "p1", id: "b0", status: "failed", preview_url: null, created_at: "2026-06-02T00:00:00Z" },
          { project_id: "p2", id: "b3", status: "discovering", preview_url: null, created_at: "2026-06-03T00:00:00Z" },
        ];
      }
      if (table === "deployments") {
        return [
          { project_id: "p1", environment: "production", status: "ready", url: "https://p1-prod.vercel.app", created_at: "2026-06-03T00:00:00Z" },
        ];
      }
      return [];
    });
    const result = await loadDashboardBuildStates(supabase, ["p1", "p2", "p3"]);
    expect(result.get("p1")).toEqual({
      hasActiveBuild: false,
      latestBuildStatus: "ready",
      productionUrl: "https://p1-prod.vercel.app",
      previewUrl: "https://p1.vercel.app",
    });
    expect(result.get("p2")).toEqual({
      hasActiveBuild: true,
      latestBuildStatus: "discovering",
      productionUrl: null,
      previewUrl: null,
    });
    // p3 has no builds — defaults to nulls + hasActiveBuild=false
    expect(result.get("p3")).toEqual({
      hasActiveBuild: false,
      latestBuildStatus: null,
      productionUrl: null,
      previewUrl: null,
    });
  });
});
