import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  blockInventoryTelemetryPayload,
  buildComponentStoragePath,
  persistGeneration,
} from "./persist-generation";
import type { GeneratedComponent } from "./component-generator";

// ---------------------------------------------------------------------------
// Mocked Supabase admin client — captures the block_inventory update payload.
// vi.mock factories are hoisted, so shared state must come from vi.hoisted.
// ---------------------------------------------------------------------------

const captured = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
      }),
    },
    from: () => ({
      update: (payload: Record<string, unknown>) => {
        captured.updates.push(payload);
        const chain = {
          eq: () => chain,
          // Awaiting the builder resolves to the supabase result shape.
          then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
        };
        return chain;
      },
    }),
  }),
}));

beforeEach(() => {
  captured.updates.length = 0;
});

const baseComponent: GeneratedComponent = {
  blockName: "core/heading",
  tsx: "export function CoreHeading() { return null; }",
  compileStatus: "ok",
  compileAttemptCount: 1,
  modelUsed: "claude-sonnet-4-6",
  providerUsed: "anthropic",
  // API semantics: input_tokens is ALREADY the uncached remainder.
  inputTokens: 900,
  outputTokens: 400,
  cacheReadTokens: 5000,
  cacheCreationTokens: 1250,
  failureKind: null,
};

describe("buildComponentStoragePath", () => {
  it("produces a valid storage path for a standard block name", () => {
    const path = buildComponentStoragePath("build-abc", "core/heading");
    expect(path).toBe("builds/build-abc/components/CoreHeading.tsx");
  });

  it("handles acf_flex block names", () => {
    const path = buildComponentStoragePath("build-xyz", "acf_flex/page/sections/hero_section");
    expect(path).toBe("builds/build-xyz/components/AcfFlexPageSectionsHeroSection.tsx");
  });

  it("handles null block name (passthrough)", () => {
    const path = buildComponentStoragePath("build-123", "__null__");
    expect(path).toBe("builds/build-123/components/Null.tsx");
  });
});

describe("persistGeneration — cache-aware telemetry math (Phase 1 fix)", () => {
  it("persists input_tokens AS-IS (no cache-read subtraction) plus the cache-creation column", async () => {
    await persistGeneration({ buildId: "b1", projectId: "p1", component: baseComponent });
    expect(captured.updates).toHaveLength(1);
    const row = captured.updates[0];
    // THE FIX: previously 900 - 5000 = -4100 (double-subtraction).
    expect(row.input_tokens_uncached).toBe(900);
    expect(row.input_tokens_cached).toBe(5000);
    expect(row.input_tokens_cache_creation).toBe(1250);
    expect(row.output_tokens).toBe(400);
    expect(row.model_used).toBe("claude-sonnet-4-6");
    expect(row.compile_status).toBe("ok");
  });

  it("writes failure_kind=null when the component carries no failureKind (default path)", async () => {
    await persistGeneration({ buildId: "b1", projectId: "p1", component: baseComponent });
    expect(captured.updates[0].failure_kind).toBeNull();
  });

  it("threads the component's failureKind through to failure_kind", async () => {
    await persistGeneration({
      buildId: "b1",
      projectId: "p1",
      component: { ...baseComponent, compileStatus: "failed", failureKind: "rate_limit" },
    });
    expect(captured.updates[0].failure_kind).toBe("rate_limit");
  });
});

// ---------------------------------------------------------------------------
// Phase 2: failureKind lives ON the component (the loop sets it) — the
// separate PersistGenerationInput.failureKind arg is gone. Uses the same
// captured-updates admin-client mock as the Phase 1 suite above (a second
// vi.mock of "@/lib/supabase/admin" in this file would override the first).
// ---------------------------------------------------------------------------

function component(over: Partial<GeneratedComponent> = {}): GeneratedComponent {
  return {
    blockName: "core/button",
    tsx: "export function CoreButton() { return null; }",
    compileStatus: "ok",
    compileAttemptCount: 1,
    modelUsed: "fake-model-id",
    providerUsed: "anthropic",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    failureKind: null,
    ...over,
  };
}

describe("persistGeneration — failure_kind persistence (Phase 2)", () => {
  it("writes the component's failureKind to block_inventory.failure_kind", async () => {
    await persistGeneration({
      buildId: "b1",
      projectId: "p1",
      component: component({ compileStatus: "failed", failureKind: "max_tokens" }),
    });
    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]).toMatchObject({
      failure_kind: "max_tokens",
      compile_status: "failed",
    });
  });

  it("writes failure_kind null on success", async () => {
    await persistGeneration({ buildId: "b1", projectId: "p1", component: component() });
    expect(captured.updates[0]).toMatchObject({ failure_kind: null });
  });
});

// ---------------------------------------------------------------------------
// Phase 4: blockInventoryTelemetryPayload — pure payload shaper for the
// block_inventory telemetry UPDATE. The two carry-forward columns default to
// NULL so the guidance-regen path (regenerate-unit.ts passes no opts)
// invalidates the cloned row's hash. Reuses the Phase 2 component() factory.
// ---------------------------------------------------------------------------

describe("blockInventoryTelemetryPayload", () => {
  it("writes prompt_inputs_hash and reused_from_build_id when provided", () => {
    const payload = blockInventoryTelemetryPayload(component(), {
      promptInputsHash: "h1",
      reusedFromBuildId: "build-prior",
    });
    expect(payload.prompt_inputs_hash).toBe("h1");
    expect(payload.reused_from_build_id).toBe("build-prior");
  });

  it("NULLs both columns when opts are omitted — the guidance-regen path must invalidate the cloned row's hash", () => {
    const payload = blockInventoryTelemetryPayload(component());
    expect(payload.prompt_inputs_hash).toBeNull();
    expect(payload.reused_from_build_id).toBeNull();
  });

  it("still carries the cost-telemetry columns (Phase 1 math: input_tokens_uncached = inputTokens as-is)", () => {
    const payload = blockInventoryTelemetryPayload(
      component({
        modelUsed: "claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
      }),
    );
    expect(payload.model_used).toBe("claude-sonnet-4-6");
    expect(payload.input_tokens_uncached).toBe(100);
    expect(payload.input_tokens_cached).toBe(10);
    expect(payload.input_tokens_cache_creation).toBe(5);
    expect(payload.output_tokens).toBe(50);
    expect(payload.compile_status).toBe("ok");
  });
});
