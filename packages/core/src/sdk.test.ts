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

describe("emitSdk — plugin version stamp", () => {
  it("stamps the plugin version into the types.ts header when present", async () => {
    const files = await emitSdk({ ...minimalManifest, pluginVersion: "0.7.1" });
    expect(files.get("types.ts")!).toContain("Plugin v:");
    expect(files.get("types.ts")!).toContain("0.7.1");
  });

  it("stamps 'unknown' into the header when the manifest carries no plugin version", async () => {
    const files = await emitSdk(minimalManifest);
    expect(files.get("types.ts")!).toContain("Plugin v:");
    expect(files.get("types.ts")!).toContain("unknown");
  });

  it("stamps the plugin version into the generated CLAUDE.md when present", async () => {
    const files = await emitSdk({ ...minimalManifest, pluginVersion: "0.7.1" });
    expect(files.get("CLAUDE.md")!).toContain("Plugin v0.7.1");
  });
});

describe("emitSdk — v0.7.0 row fields flow into types", () => {
  it("emits modified / modified_gmt when the list ability's outputSchema carries them", async () => {
    const manifest = {
      ...minimalManifest,
      pluginVersion: "0.7.0",
      abilities: [
        {
          name: "jab/get-posts",
          label: "Get Posts",
          description: "List posts.",
          inputSchema: { type: "object", properties: {} },
          outputSchema: {
            type: "object",
            required: ["posts"],
            properties: {
              posts: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "slug", "modified", "modified_gmt"],
                  properties: {
                    id: { type: "integer" },
                    slug: { type: "string" },
                    modified: { type: "string" },
                    modified_gmt: { type: "string" },
                  },
                },
              },
            },
          },
        },
      ],
    };
    const types = (await emitSdk(manifest)).get("types.ts")!;
    expect(types).toContain("modified_gmt");
    expect(types).toContain("modified");
  });
});
