import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildComponentStoragePath, persistGeneration } from "./persist-generation";
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

  it("writes failure_kind=null when no failureKind is passed (default path)", async () => {
    await persistGeneration({ buildId: "b1", projectId: "p1", component: baseComponent });
    expect(captured.updates[0].failure_kind).toBeNull();
  });

  it("threads an explicit failureKind through to failure_kind", async () => {
    await persistGeneration({
      buildId: "b1",
      projectId: "p1",
      component: { ...baseComponent, compileStatus: "failed" },
      failureKind: "rate_limit",
    });
    expect(captured.updates[0].failure_kind).toBe("rate_limit");
  });
});
