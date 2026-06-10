import { describe, it, expect, vi } from "vitest";
import {
  regenerateComponentUnit,
  regenerateShellUnit,
  RegenCompileError,
  type RegenComponentDeps,
} from "./regenerate-unit";
import type { GeneratedComponent } from "@/lib/ai/component-generator";

function okComponent(over: Partial<GeneratedComponent> = {}): GeneratedComponent {
  return {
    blockName: "core/cover",
    tsx: "export function CoreCover() { return <div/>; }",
    compileStatus: "ok",
    compileAttemptCount: 1,
    modelUsed: "claude-sonnet-4-6",
    providerUsed: "anthropic",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    failureKind: null,
    ...over,
  };
}

function deps(over: Partial<RegenComponentDeps> = {}): RegenComponentDeps {
  return {
    loadTargetRow: vi.fn(async () => ({
      block_name: "core/cover",
      tier: "visual",
      kind: "block",
      spec: null,
      attr_samples: [{}],
      page_slugs: ["home"],
      occurrence_count: 4,
      source_dom_sample: "<div/>",
      computed_styles: null,
    })),
    loadTokens: vi.fn(async () => null),
    loadScreenshot: vi.fn(async () => "BASE64"),
    generate: vi.fn(async () => okComponent()),
    persist: vi.fn(async () => ({ storagePath: "p" })),
    ...over,
  };
}

describe("regenerateComponentUnit", () => {
  it("loads the row, generates with guidance, persists, returns ok telemetry", async () => {
    const d = deps();
    const r = await regenerateComponentUnit(
      { buildId: "b2", projectId: "p1", target: "core/cover", guidance: "bolder", screenshotSlug: "home" },
      d,
    );
    expect(r.compileStatus).toBe("ok");
    expect(d.generate).toHaveBeenCalledWith(
      expect.objectContaining({ guidance: "bolder", screenshotBase64: "BASE64" }),
    );
    expect(d.persist).toHaveBeenCalled();
    expect(r.cost.inputTokens).toBe(100);
  });

  it("throws when the target row is missing in the cloned inventory (no-op guard)", async () => {
    const d = deps({ loadTargetRow: vi.fn(async () => null) });
    await expect(
      regenerateComponentUnit(
        { buildId: "b2", projectId: "p1", target: "core/ghost", guidance: "x", screenshotSlug: "home" },
        d,
      ),
    ).rejects.toThrow(/core\/ghost/);
  });

  it("throws RegenCompileError when generation compile-fails", async () => {
    const d = deps({ generate: vi.fn(async () => okComponent({ compileStatus: "failed", tsx: null })) });
    await expect(
      regenerateComponentUnit(
        { buildId: "b2", projectId: "p1", target: "core/cover", guidance: "x", screenshotSlug: "home" },
        d,
      ),
    ).rejects.toBeInstanceOf(RegenCompileError);
    expect(d.persist).toHaveBeenCalled();
  });

  it("threads sourceHosts to the generate call when provided", async () => {
    const d = deps();
    await regenerateComponentUnit(
      {
        buildId: "b2",
        projectId: "p1",
        target: "core/cover",
        guidance: "bolder",
        screenshotSlug: "home",
        sourceHosts: ["tworoadsbrewing.com", "www.tworoadsbrewing.com"],
      },
      d,
    );
    expect(d.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceHosts: ["tworoadsbrewing.com", "www.tworoadsbrewing.com"],
      }),
    );
  });

  it("omits sourceHosts from the generate call when not provided (no rewrite)", async () => {
    const d = deps();
    await regenerateComponentUnit(
      { buildId: "b2", projectId: "p1", target: "core/cover", guidance: "x", screenshotSlug: "home" },
      d,
    );
    // sourceHosts is undefined → generateComponent skips origin-rewrite (safe default).
    expect(d.generate).toHaveBeenCalledWith(
      expect.objectContaining({ sourceHosts: undefined }),
    );
  });

  it("skips screenshot download for a non-visual tier", async () => {
    const d = deps({
      loadTargetRow: vi.fn(async () => ({
        block_name: "core/heading",
        tier: "trivial",
        kind: "block",
        spec: null,
        attr_samples: [{}],
        page_slugs: ["home"],
        occurrence_count: 9,
        source_dom_sample: null,
        computed_styles: null,
      })),
      generate: vi.fn(async () => okComponent({ blockName: "core/heading" })),
    });
    await regenerateComponentUnit(
      { buildId: "b2", projectId: "p1", target: "core/heading", guidance: "x", screenshotSlug: "home" },
      d,
    );
    expect(d.loadScreenshot).not.toHaveBeenCalled();
  });
});

describe("regenerateShellUnit", () => {
  it("returns deferredToCompose for header", () => {
    expect(regenerateShellUnit("header")).toEqual({ deferredToCompose: true });
  });

  it("returns deferredToCompose for footer", () => {
    expect(regenerateShellUnit("footer")).toEqual({ deferredToCompose: true });
  });

  it("throws for an invalid shell kind", () => {
    expect(() => regenerateShellUnit("sidebar")).toThrow(/header.*footer|footer.*header|sidebar/i);
  });
});
