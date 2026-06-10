import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildShellStoragePath,
  shouldReuseShell,
  persistShellGeneration,
} from "./persist-shell-generation";
import type { GeneratedShell } from "./generate-shell";

const captured = vi.hoisted(() => ({
  upserts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
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

describe("shouldReuseShell — JAB_SKIP_SHELL_REGEN decision", () => {
  it("reuses when skip enabled, no edit guidance, and the artifact exists", () => {
    expect(shouldReuseShell({ skipEnabled: true, hasEditGuidance: false, artifactExists: true })).toBe(true);
  });

  it("does NOT reuse when the skip flag is off (default production behaviour)", () => {
    expect(shouldReuseShell({ skipEnabled: false, hasEditGuidance: false, artifactExists: true })).toBe(false);
  });

  it("does NOT reuse when no prior artifact exists (first compose of the build)", () => {
    expect(shouldReuseShell({ skipEnabled: true, hasEditGuidance: false, artifactExists: false })).toBe(false);
  });

  it("does NOT reuse when this is a shell-scope edit targeting the kind — the edit MUST regenerate", () => {
    expect(shouldReuseShell({ skipEnabled: true, hasEditGuidance: true, artifactExists: true })).toBe(false);
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
