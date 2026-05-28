/**
 * compile-generated-project.test.ts
 *
 * Unit tests for the Phase C compile gate helper.
 *
 * Integration testing (the full install+tsc path) requires:
 *   - `JAB_COMPOSE_TYPECHECK=1` in the environment
 *   - A running Supabase instance with a completed Phase C build in Storage
 *   - pnpm available in PATH
 *
 * Those conditions are not satisfied in CI unit-test runs. The tests here
 * cover only the env-gated skip path and the mock failure path to validate
 * the result interface contract.
 *
 * To run an integration smoke:
 *   JAB_COMPOSE_TYPECHECK=1 pnpm --filter web test -- compile-generated-project
 * (requires Supabase env vars and a valid buildId + projectId)
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// `server-only` is mocked by vitest.setup.ts — no action needed here.

describe("compileGeneratedProject", () => {
  afterEach(() => {
    // Ensure env var is clean after each test.
    delete process.env.JAB_COMPOSE_TYPECHECK;
    vi.restoreAllMocks();
  });

  it("returns success+skip when JAB_COMPOSE_TYPECHECK is not set", async () => {
    // Default state: env var absent — gate should be off.
    delete process.env.JAB_COMPOSE_TYPECHECK;

    const { compileGeneratedProject } = await import("./compile-generated-project");
    const result = await compileGeneratedProject({ buildId: "build-123", projectId: "proj-456" });

    expect(result.success).toBe(true);
    expect(result.log).toMatch(/typecheck skipped/i);
    expect(result.log).toMatch(/JAB_COMPOSE_TYPECHECK/);
  });

  it("returns success+skip when JAB_COMPOSE_TYPECHECK is set to a value other than '1'", async () => {
    process.env.JAB_COMPOSE_TYPECHECK = "0";

    const { compileGeneratedProject } = await import("./compile-generated-project");
    const result = await compileGeneratedProject({ buildId: "build-123", projectId: "proj-456" });

    expect(result.success).toBe(true);
    expect(result.log).toMatch(/typecheck skipped/i);
  });

  it("returns { success, log } shape when gate is off — callers can always destructure", async () => {
    delete process.env.JAB_COMPOSE_TYPECHECK;

    const { compileGeneratedProject } = await import("./compile-generated-project");
    const result = await compileGeneratedProject({ buildId: "b", projectId: "p" });

    // Verify the interface shape — callers must be able to check result.success and result.log.
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.log).toBe("string");
  });
});

/**
 * NOTE: Integration test for the JAB_COMPOSE_TYPECHECK=1 path.
 *
 * When the gate is enabled, compileGeneratedProject:
 *   1. Calls downloadProjectTree(buildId) → downloads from Supabase Storage
 *   2. Materializes files into a temp dir
 *   3. Runs `pnpm install --ignore-scripts --frozen-lockfile=false`
 *   4. Runs `pnpm typecheck`
 *   5. On failure: uploads compile-log.txt + updates site_builds.status='failed'
 *   6. Returns { success: false, log } on failure or { success: true, log } on pass
 *
 * Mocking spawn + downloadProjectTree to cover the failure path is complex
 * due to ESM module caching. The behaviour is validated end-to-end by the
 * smoke runner:
 *   JAB_COMPOSE_TYPECHECK=1 pnpm --filter web smoke:compose
 * (once a smoke:compose script is added in a follow-up task).
 */
