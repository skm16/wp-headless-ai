import { describe, it, expect } from "vitest";
import { emitSdk } from "./sdk.js";
import type { Manifest } from "./types/manifest.js";

const minimalManifest: Manifest = {
  source: "http://example.com",
  fetchedAt: "2026-01-01T00:00:00Z",
  schemaVersion: 1,
  server: {
    namespace: "jab/v1",
    route: "/wp-json/jab/v1/mcp",
  },
  abilities: [],
};

describe("emitSdk — types.ts contains BlockNode interface", () => {
  it("emits export interface BlockNode", async () => {
    const files = await emitSdk(minimalManifest);
    const types = files.get("types.ts");
    expect(types).toBeDefined();
    expect(types).toContain("export interface BlockNode");
  });

  it("emits innerBlocks?: BlockNode[]", async () => {
    const files = await emitSdk(minimalManifest);
    const types = files.get("types.ts")!;
    expect(types).toContain("innerBlocks?: BlockNode[]");
  });

  it("emits innerContent?: Array<string | null>", async () => {
    const files = await emitSdk(minimalManifest);
    const types = files.get("types.ts")!;
    expect(types).toContain("innerContent?: Array<string | null>");
  });
});
