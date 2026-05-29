/**
 * compile-generated-project.test.ts
 *
 * Unit tests for the Phase C compile gate helper.
 *
 * Gate semantics (post-invert, 2026-05-28):
 *   - JAB_COMPOSE_TYPECHECK="0"  → SKIP (explicit opt-out for dev speed)
 *   - JAB_COMPOSE_TYPECHECK unset or any other value → RUN
 *
 * The RUN path requires Supabase + pnpm and is exercised by the smoke runner.
 * These unit tests cover the skip path and assert the inverted default
 * (unset = run, not skip).
 *
 * To run an integration smoke:
 *   pnpm --filter web smoke:compose
 * (requires Supabase env vars and a valid buildId + projectId)
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// `server-only` is mocked by vitest.setup.ts — no action needed here.

describe("compileGeneratedProject — gate semantics", () => {
  afterEach(() => {
    // Ensure env var is clean after each test.
    delete process.env.JAB_COMPOSE_TYPECHECK;
    vi.restoreAllMocks();
  });

  it("skips with success when JAB_COMPOSE_TYPECHECK=0 (explicit opt-out)", async () => {
    process.env.JAB_COMPOSE_TYPECHECK = "0";

    const { compileGeneratedProject } = await import("./compile-generated-project");
    const result = await compileGeneratedProject({ buildId: "build-123", projectId: "proj-456" });

    expect(result.success).toBe(true);
    expect(result.log).toMatch(/typecheck skipped/i);
    expect(result.log).toMatch(/JAB_COMPOSE_TYPECHECK/);
  });

  it("rejects (throws) when env is unset and the failure-DB-update can't complete", async () => {
    // Two fences in one test:
    //   1. Inverted default — unset env means RUN, not skip.
    //   2. Required DB contract — if updateBuildFailed throws, the function
    //      must throw too. Silent swallow leaves the build stuck in
    //      'composing' forever with no Inngest error to retry/alert on.
    // In the unit-test env there's no real Storage tree or matching
    // site_builds row, so the compile path enters the catch block and
    // updateBuildFailed rejects — which we now require to propagate.
    delete process.env.JAB_COMPOSE_TYPECHECK;

    const { compileGeneratedProject } = await import("./compile-generated-project");

    await expect(
      compileGeneratedProject({ buildId: "build-no-skip", projectId: "proj-no-skip" }),
    ).rejects.toThrow();
  });

  it("rejects when JAB_COMPOSE_TYPECHECK=1 (legacy on-value) and DB update fails", async () => {
    // Back-compat: "1" still enables the gate (any value other than "0" runs).
    // Same required-DB-update contract as the unset case.
    process.env.JAB_COMPOSE_TYPECHECK = "1";

    const { compileGeneratedProject } = await import("./compile-generated-project");

    await expect(
      compileGeneratedProject({ buildId: "b1", projectId: "p1" }),
    ).rejects.toThrow();
  });

  it("returns { success, log } shape when gate is opted out — callers can always destructure", async () => {
    process.env.JAB_COMPOSE_TYPECHECK = "0";

    const { compileGeneratedProject } = await import("./compile-generated-project");
    const result = await compileGeneratedProject({ buildId: "b", projectId: "p" });

    expect(typeof result.success).toBe("boolean");
    expect(typeof result.log).toBe("string");
  });
});

/**
 * NOTE: Integration test for the RUN path.
 *
 * When the gate runs (default), compileGeneratedProject:
 *   1. Calls downloadProjectTree(buildId) → downloads from Supabase Storage
 *   2. Materializes files into a temp dir
 *   3. Runs `pnpm install --ignore-scripts --frozen-lockfile=false`
 *   4. Runs `pnpm typecheck`
 *   5. On failure: uploads compile-log.txt + updates site_builds.status='failed'
 *   6. Returns { success: false, log } on failure or { success: true, log } on pass
 *
 * Mocking spawn + downloadProjectTree to cover the failure path is complex
 * due to ESM module caching. The behaviour is validated end-to-end by the
 * smoke runner.
 */
