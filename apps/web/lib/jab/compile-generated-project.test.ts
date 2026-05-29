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

  it("does NOT skip when JAB_COMPOSE_TYPECHECK is unset (inverted default — gate is on)", async () => {
    // The whole point of inverting the default: an unset env var must mean
    // "run the gate," not "skip the gate." This test fences the regression.
    delete process.env.JAB_COMPOSE_TYPECHECK;

    const { compileGeneratedProject } = await import("./compile-generated-project");
    const result = await compileGeneratedProject({ buildId: "build-no-skip", projectId: "proj-no-skip" });

    // The gate attempts to run; the actual run will fail in unit-test env
    // (no Supabase, no project tree in Storage), so success may be false.
    // What MUST hold: the skip log marker is absent — we did not opt out.
    expect(result.log).not.toMatch(/typecheck skipped/i);
  });

  it("does NOT skip when JAB_COMPOSE_TYPECHECK=1 (back-compat — explicit on)", async () => {
    // Pre-invert, "1" was the only way to enable the gate. After invert,
    // "1" still enables it (anything other than "0" means run).
    process.env.JAB_COMPOSE_TYPECHECK = "1";

    const { compileGeneratedProject } = await import("./compile-generated-project");
    const result = await compileGeneratedProject({ buildId: "b1", projectId: "p1" });

    expect(result.log).not.toMatch(/typecheck skipped/i);
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
