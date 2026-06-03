import { describe, it, expect, afterEach } from "vitest";
import { Buffer } from "node:buffer";
import { parsePluginVersion, fetchPluginVersion } from "./manifest.js";

describe("parsePluginVersion", () => {
  it("extracts plugin_version from the REST manifest envelope", () => {
    expect(parsePluginVersion({ plugin_version: "0.7.1", abilities: [] })).toBe("0.7.1");
  });
  it("returns null for a missing or non-string plugin_version", () => {
    expect(parsePluginVersion({ abilities: [] })).toBeNull();
    expect(parsePluginVersion({ plugin_version: null })).toBeNull();
    expect(parsePluginVersion({ plugin_version: 7 })).toBeNull();
  });
  it("returns null for non-object bodies", () => {
    expect(parsePluginVersion(null)).toBeNull();
    expect(parsePluginVersion("0.7.1")).toBeNull();
    expect(parsePluginVersion(undefined)).toBeNull();
  });
  it("trims and rejects empty strings", () => {
    expect(parsePluginVersion({ plugin_version: "  0.7.1  " })).toBe("0.7.1");
    expect(parsePluginVersion({ plugin_version: "   " })).toBeNull();
  });
});

describe("fetchPluginVersion", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("GETs /wp-json/jab/v1/manifest with Basic auth and returns plugin_version", async () => {
    let seenUrl = "";
    let seenAuth = "";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      return new Response(JSON.stringify({ plugin_version: "0.7.1", abilities: [] }), { status: 200 });
    }) as typeof fetch;
    const v = await fetchPluginVersion({ wpUrl: "https://x/", user: "u", password: "p" });
    expect(v).toBe("0.7.1");
    expect(seenUrl).toBe("https://x/wp-json/jab/v1/manifest");
    expect(seenAuth).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  it("returns null on non-200 (old plugin then 404) without throwing", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    expect(await fetchPluginVersion({ wpUrl: "https://x", user: "u", password: "p" })).toBeNull();
  });

  it("returns null on network error without throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await fetchPluginVersion({ wpUrl: "https://x", user: "u", password: "p" })).toBeNull();
  });
});
