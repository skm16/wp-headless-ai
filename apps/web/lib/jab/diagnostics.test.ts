import { describe, it, expect, afterEach } from "vitest";
import { isDiagnosticsReport, getDiagnostics } from "./diagnostics";

const SAMPLE = {
  plugin_version: "0.7.1",
  generated_at: "2026-06-03T00:00:00Z",
  summary: { pass: 5, warn: 1, fail: 0 },
  facts: [{ id: "plugin_version", label: "Plugin version", value: "0.7.1" }],
  checks: [{ id: "abilities_api", label: "Abilities API loaded", severity: "pass", message: "OK" }],
};

describe("isDiagnosticsReport", () => {
  it("accepts a well-formed report", () => {
    expect(isDiagnosticsReport(SAMPLE)).toBe(true);
  });
  it("rejects bodies missing checks/summary", () => {
    expect(isDiagnosticsReport({ plugin_version: "0.7.1" })).toBe(false);
    expect(isDiagnosticsReport(null)).toBe(false);
    expect(isDiagnosticsReport({ ...SAMPLE, checks: "no" })).toBe(false);
  });
});

describe("getDiagnostics", () => {
  const orig = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = orig;
  });

  it("returns the report on 200", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(SAMPLE), { status: 200 })) as typeof fetch;
    const r = await getDiagnostics({ wpUrl: "https://x", username: "u", appPassword: "p" });
    expect(r?.summary.pass).toBe(5);
  });

  it("returns null on 404 / 403 / redirect / network error", async () => {
    for (const status of [404, 403, 302]) {
      globalThis.fetch = (async () => new Response("", { status })) as typeof fetch;
      expect(await getDiagnostics({ wpUrl: "https://x", username: "u", appPassword: "p" })).toBeNull();
    }
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as typeof fetch;
    expect(await getDiagnostics({ wpUrl: "https://x", username: "u", appPassword: "p" })).toBeNull();
  });
});
