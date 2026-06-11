import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildShellStoragePath,
  shouldReuseShell,
  shellArtifactExists,
  persistShellGeneration,
} from "./persist-shell-generation";
import type { GeneratedShell } from "./generate-shell";

const captured = vi.hoisted(() => ({
  upserts: [] as Array<Record<string, unknown>>,
  download: undefined as
    | (() => Promise<{ data: unknown; error: { message: string } | null }>)
    | undefined,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        download: () =>
          captured.download
            ? captured.download()
            : Promise.resolve({ data: null, error: { message: "no download stub" } }),
      }),
    },
    from: () => ({
      upsert: (payload: Record<string, unknown>) => {
        captured.upserts.push(payload);
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));

beforeEach(() => {
  captured.upserts.length = 0;
  captured.download = undefined;
});

describe("buildShellStoragePath", () => {
  it("returns builds/<id>/project/components/site/Header.tsx for header", () => {
    expect(buildShellStoragePath("abc-123", "header")).toBe(
      "builds/abc-123/project/components/site/Header.tsx",
    );
  });

  it("returns Footer.tsx for footer", () => {
    expect(buildShellStoragePath("xyz-456", "footer")).toBe(
      "builds/xyz-456/project/components/site/Footer.tsx",
    );
  });
});

describe("shouldReuseShell — reuse decision (JAB_SKIP_SHELL_REGEN + edit-build default)", () => {
  // ── Full builds: JAB_SKIP_SHELL_REGEN semantics unchanged ──
  it("FULL build: reuses when skip enabled, no edit guidance, artifact exists", () => {
    expect(
      shouldReuseShell({ skipEnabled: true, isEditBuild: false, hasEditGuidance: false, artifactExists: true }),
    ).toBe(true);
  });

  it("FULL build: flag off → regenerates (production default unchanged — byte-identical path)", () => {
    expect(
      shouldReuseShell({ skipEnabled: false, isEditBuild: false, hasEditGuidance: false, artifactExists: true }),
    ).toBe(false);
  });

  it("FULL build: no prior artifact → regenerates (first compose of the build)", () => {
    expect(
      shouldReuseShell({ skipEnabled: true, isEditBuild: false, hasEditGuidance: false, artifactExists: false }),
    ).toBe(false);
  });

  // ── Edit builds: reuse is the DEFAULT (no env flag) ──
  it("EDIT build (component scope): reuses the shell with no flag set — both kinds present this shape", () => {
    expect(
      shouldReuseShell({ skipEnabled: false, isEditBuild: true, hasEditGuidance: false, artifactExists: true }),
    ).toBe(true);
  });

  it("EDIT build (shell scope): the TARGETED shell regenerates — guidance wins over everything", () => {
    expect(
      shouldReuseShell({ skipEnabled: false, isEditBuild: true, hasEditGuidance: true, artifactExists: true }),
    ).toBe(false);
    // Guidance wins even with the operator flag on (carve-out preserved).
    expect(
      shouldReuseShell({ skipEnabled: true, isEditBuild: true, hasEditGuidance: true, artifactExists: true }),
    ).toBe(false);
  });

  it("EDIT build (shell scope): the SIBLING shell (no guidance for its kind) reuses", () => {
    expect(
      shouldReuseShell({ skipEnabled: false, isEditBuild: true, hasEditGuidance: false, artifactExists: true }),
    ).toBe(true);
  });

  it("EDIT build: missing cloned artifact → regenerates (source build predates the Task-5 clone)", () => {
    expect(
      shouldReuseShell({ skipEnabled: false, isEditBuild: true, hasEditGuidance: false, artifactExists: false }),
    ).toBe(false);
  });
});

describe("shellArtifactExists — fail-soft Storage probe", () => {
  it("returns true when the download resolves with data", async () => {
    captured.download = async () => ({ data: new Blob(["export function Header() {}"]), error: null });
    await expect(shellArtifactExists("b1", "header")).resolves.toBe(true);
  });

  it("returns false when the download rejects (fail-soft — regenerate rather than throw)", async () => {
    captured.download = () => Promise.reject(new Error("storage unreachable"));
    await expect(shellArtifactExists("b1", "footer")).resolves.toBe(false);
  });
});

describe("persistShellGeneration — cache-aware telemetry math (Phase 1 fix)", () => {
  const baseShell: GeneratedShell = {
    shellKind: "header",
    tsx: "export function Header() { return null; }",
    compileStatus: "ok",
    compileAttemptCount: 1,
    modelUsed: "claude-sonnet-4-6",
    providerUsed: "anthropic",
    inputTokens: 700,
    outputTokens: 300,
    cacheReadTokens: 4000,
    cacheCreationTokens: 800,
    failureKind: null,
  };

  it("persists input_tokens AS-IS plus the cache-creation column, failure_kind null by default", async () => {
    await persistShellGeneration({ buildId: "b1", projectId: "p1", shell: baseShell });
    expect(captured.upserts).toHaveLength(1);
    const row = captured.upserts[0];
    // THE FIX: previously 700 - 4000 = -3300.
    expect(row.input_tokens_uncached).toBe(700);
    expect(row.input_tokens_cached).toBe(4000);
    expect(row.input_tokens_cache_creation).toBe(800);
    expect(row.output_tokens).toBe(300);
    expect(row.failure_kind).toBeNull();
  });

  it("threads the shell's failureKind through to failure_kind", async () => {
    // Phase 2: failureKind lives ON the shell result (the loop sets it) —
    // the separate PersistShellGenerationInput.failureKind arg is gone.
    await persistShellGeneration({
      buildId: "b1",
      projectId: "p1",
      shell: { ...baseShell, compileStatus: "failed", failureKind: "overloaded" },
    });
    expect(captured.upserts[0].failure_kind).toBe("overloaded");
  });
});

describe("persistShellGeneration — failure_kind + ground-truth model (Phase 2)", () => {
  function shell(over: Partial<GeneratedShell> = {}): GeneratedShell {
    return {
      shellKind: "header",
      tsx: "export function Header() { return null; }",
      compileStatus: "failed",
      compileAttemptCount: 2,
      modelUsed: null,
      providerUsed: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      failureKind: "rate_limit",
      ...over,
    };
  }

  it("persists failure_kind and a NULL model when zero API responses arrived", async () => {
    await persistShellGeneration({ buildId: "b1", projectId: "p1", shell: shell() });
    expect(captured.upserts).toHaveLength(1);
    expect(captured.upserts[0]).toMatchObject({
      failure_kind: "rate_limit",
      model_used: null,
      provider_used: null,
      compile_status: "failed",
    });
  });

  it("persists failure_kind null + the answering model on success", async () => {
    await persistShellGeneration({
      buildId: "b1",
      projectId: "p1",
      shell: shell({ compileStatus: "ok", failureKind: null, modelUsed: "claude-sonnet-4-6", providerUsed: "anthropic" }),
    });
    expect(captured.upserts[0]).toMatchObject({
      failure_kind: null,
      model_used: "claude-sonnet-4-6",
    });
  });
});
