import { describe, it, expect, vi } from "vitest";
import {
  loadProjectBuildState,
  loadDashboardBuildStates,
} from "./load-project-builds";
import type { SupabaseClient } from "@supabase/supabase-js";

// Use a recent timestamp so active builds are NOT stale (current time − 1 min).
const FRESH_ACTIVE_CREATED_AT = new Date(Date.now() - 60 * 1000).toISOString();

/**
 * Two narrow mock builders — supabase's chainable query builder is the
 * pain point. Each builds a `from()` that returns a chain whose terminal
 * method (`limit` for site_builds, `in` + .order for the dashboard
 * batched query) resolves with the mock rows.
 *
 * makeChain: the site_builds builder is filter-aware — it records every
 * .eq(col, val) call and, at resolution time, filters the resolver's rows
 * by any `status` equality recorded. This pins that the third Promise.all
 * query (latestReadyBuild) really applies .eq("status","ready") and that
 * a wrong/missing filter would return different rows and fail the assertion.
 * All other tables use the plain pass-through behaviour (no status column
 * to filter on at the mock layer).
 */
function makeChain(resolver: (table: string) => unknown) {
  return {
    from: vi.fn((table: string) => {
      // Accumulated eq filters for this chain instance.
      const eqFilters: Array<[string, unknown]> = [];

      function resolveWithFilters() {
        let rows = resolver(table) as Array<Record<string, unknown>>;
        if (table === "site_builds") {
          for (const [col, val] of eqFilters) {
            if (col === "status") {
              rows = rows.filter((r) => r.status === val);
            }
          }
        }
        return { data: rows, error: null };
      }

      const builder: Record<string, unknown> = {};
      builder.select = vi.fn().mockReturnValue(builder);
      builder.eq = vi.fn((col: string, val: unknown) => {
        eqFilters.push([col, val]);
        return builder;
      });
      builder.in = vi.fn().mockReturnValue(builder);
      builder.order = vi.fn().mockReturnValue(builder);
      // limit is the awaited terminal for the loadProjectBuildState path.
      builder.limit = vi.fn().mockImplementation(() =>
        Promise.resolve(resolveWithFilters()),
      );
      // .then needs to be the implicit terminal for the dashboard path
      // where there's no .limit() — i.e. await on the builder itself.
      builder.then = (resolve: (value: ReturnType<typeof resolveWithFilters>) => unknown) =>
        Promise.resolve(resolveWithFilters()).then(resolve);
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

  it("flags hasActiveBuild=true when latest build is in-flight and not stale", async () => {
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
            created_at: FRESH_ACTIVE_CREATED_AT,
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

  it("surfaces latestReadyBuild/latestReadyPreview from an older build when the latest build is failed", async () => {
    // b1 (older, ready) — has a ready preview deployment d1
    // b2 (newer, failed) — has a failed deployment d2
    // latestBuild  → b2 (no status filter applied)
    // latestReadyBuild → b1 (status=ready filter applied; b2 excluded)
    // latestReadyPreview → d1 (matched by b1 id + environment=preview + status=ready)
    const supabase = makeChain((table) => {
      if (table === "site_builds") {
        // Resolver returns BOTH rows; the filter-aware builder trims by status.
        return [
          {
            id: "b2",
            status: "failed",
            failed_phase: "components",
            preview_url: null,
            page_count: null,
            block_type_count: null,
            component_count: null,
            fidelity_avg: null,
            created_at: "2026-06-09T01:00:00Z",
            finished_at: "2026-06-09T01:05:00Z",
          },
          {
            id: "b1",
            status: "ready",
            failed_phase: null,
            preview_url: "https://b1-preview.vercel.app",
            page_count: 8,
            block_type_count: 4,
            component_count: 4,
            fidelity_avg: "0.910",
            created_at: "2026-06-09T00:00:00Z",
            finished_at: "2026-06-09T00:10:00Z",
          },
        ];
      }
      if (table === "deployments") {
        return [
          // Failed deploy for b2
          {
            id: "d2",
            site_build_id: "b2",
            environment: "preview",
            status: "failed",
            url: null,
            provider_deployment_id: "dpl_d2",
            ready_at: null,
            created_at: "2026-06-09T01:05:00Z",
          },
          // Ready preview deploy for b1
          {
            id: "d1",
            site_build_id: "b1",
            environment: "preview",
            status: "ready",
            url: "https://b1-preview.vercel.app",
            provider_deployment_id: "dpl_d1",
            ready_at: "2026-06-09T00:10:00Z",
            created_at: "2026-06-09T00:09:00Z",
          },
        ];
      }
      return [];
    });

    const state = await loadProjectBuildState(supabase, "proj_1");

    // Latest build is b2 (failed — the unfiltered query returns the newest row)
    expect(state.latestBuild?.id).toBe("b2");
    expect(state.latestBuild?.status).toBe("failed");

    // latestReadyBuild is b1 (the status=ready filter excluded b2)
    expect(state.latestReadyBuild?.id).toBe("b1");

    // latestReadyPreview is d1 (matched to b1's id in the deployments history)
    expect(state.latestReadyPreview?.id).toBe("d1");
    expect(state.latestReadyPreview?.siteBuildId).toBe("b1");

    // No active build — b2 is failed, not in-flight
    expect(state.hasActiveBuild).toBe(false);
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
          { project_id: "p2", id: "b3", status: "discovering", preview_url: null, created_at: FRESH_ACTIVE_CREATED_AT },
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
