import { describe, it, expect, vi } from "vitest";
import { patchUnitSource, buildPatchPrompt } from "./patch-component";
import type { ModelClient } from "./model-client";

const CURRENT = `export function AcfHero({ block }: { block: { attrs: Record<string, unknown> } }) {
  return <h1 className="text-6xl">{String(block.attrs.title ?? "")}</h1>;
}
`;

function fakeClient(responses: string[]): ModelClient {
  const generate = vi.fn();
  for (const r of responses) generate.mockResolvedValueOnce({ text: r, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 } });
  return { generate } as unknown as ModelClient;
}

describe("buildPatchPrompt", () => {
  it("contains the current source, the instruction, and the keep-contract rules", () => {
    const p = buildPatchPrompt({ currentTsx: CURRENT, guidance: "make the headline smaller", exportName: "AcfHero" });
    expect(p.user).toContain(CURRENT.trim());
    expect(p.user).toContain("make the headline smaller");
    expect(p.system).toContain("AcfHero");
    expect(p.system).toMatch(/minimal/i);
  });
});

describe("patchUnitSource", () => {
  it("returns the patched TSX when the model output validates", async () => {
    const patched = CURRENT.replace("text-6xl", "text-4xl");
    const result = await patchUnitSource({
      currentTsx: CURRENT,
      guidance: "make the headline smaller",
      exportName: "AcfHero",
      maxBytes: 10_000,
      client: fakeClient([patched]),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tsx).toContain("text-4xl");
  });

  it("retries once on invalid TSX, then succeeds", async () => {
    const patched = CURRENT.replace("text-6xl", "text-5xl");
    const result = await patchUnitSource({
      currentTsx: CURRENT,
      guidance: "smaller",
      exportName: "AcfHero",
      maxBytes: 10_000,
      client: fakeClient(["export function AcfHero({ <<<garbage", patched]),
    });
    expect(result.ok).toBe(true);
  });

  it("fails after two invalid attempts with the validation errors attached", async () => {
    const result = await patchUnitSource({
      currentTsx: CURRENT,
      guidance: "smaller",
      exportName: "AcfHero",
      maxBytes: 10_000,
      client: fakeClient(["<<<garbage", "<<<garbage again"]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });

  it("fails when the output exceeds maxBytes", async () => {
    const huge = CURRENT + "\n// " + "x".repeat(20_000);
    const result = await patchUnitSource({
      currentTsx: CURRENT,
      guidance: "smaller",
      exportName: "AcfHero",
      maxBytes: 10_000,
      client: fakeClient([huge, huge]),
    });
    expect(result.ok).toBe(false);
  });
});
