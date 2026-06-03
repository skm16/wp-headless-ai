import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@jab/core", async (orig) => {
  const actual = await orig<typeof import("@jab/core")>();
  return { ...actual, fetchManifest: vi.fn() };
});
import { fetchManifest } from "@jab/core";
import { probeWordPress, RECOMMENDED_PLUGIN_VERSION } from "./probe";

const baseManifest = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  source: "https://x",
  fetchedAt: "2026-06-03T00:00:00Z",
  server: { namespace: "mcp", route: "mcp-adapter-default-server" },
  abilities: [{ name: "jab/get-menus", label: "", description: "", inputSchema: {} }],
  ...over,
});

describe("probeWordPress version awareness", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns pluginVersion and no warnings when >= recommended", async () => {
    (fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue(baseManifest({ pluginVersion: "0.7.1" }));
    const r = await probeWordPress({ wpUrl: "https://x", username: "u", appPassword: "p" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pluginVersion).toBe("0.7.1");
      expect(r.warnings).toEqual([]);
    }
  });

  it("succeeds but warns when below recommended", async () => {
    (fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue(baseManifest({ pluginVersion: "0.6.0" }));
    const r = await probeWordPress({ wpUrl: "https://x", username: "u", appPassword: "p" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pluginVersion).toBe("0.6.0");
      expect(r.warnings.join(" ")).toContain(RECOMMENDED_PLUGIN_VERSION);
    }
  });

  it("succeeds with null version + a warning when the plugin reports none", async () => {
    (fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue(baseManifest({ pluginVersion: null }));
    const r = await probeWordPress({ wpUrl: "https://x", username: "u", appPassword: "p" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pluginVersion).toBeNull();
      expect(r.warnings.length).toBeGreaterThan(0);
    }
  });

  it("still hard-fails when the v0.6.0 ability floor is unmet", async () => {
    (fetchManifest as ReturnType<typeof vi.fn>).mockResolvedValue(baseManifest({ abilities: [] }));
    const r = await probeWordPress({ wpUrl: "https://x", username: "u", appPassword: "p" });
    expect(r.ok).toBe(false);
  });
});
