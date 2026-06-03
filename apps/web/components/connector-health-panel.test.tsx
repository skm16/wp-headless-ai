import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectorHealthPanel } from "./connector-health-panel";
import type { DiagnosticsReport } from "@/lib/jab/diagnostics";

const report: DiagnosticsReport = {
  plugin_version: "0.7.1",
  generated_at: "2026-06-03T00:00:00Z",
  summary: { pass: 5, warn: 1, fail: 0 },
  facts: [],
  checks: [
    { id: "abilities_api", label: "Abilities API loaded", severity: "pass", message: "OK" },
    { id: "acf_no_schema_skips", label: "No ACF schema skips", severity: "warn", message: "2 groups skipped" },
  ],
};

describe("ConnectorHealthPanel", () => {
  it("renders each check label + severity + version summary", () => {
    const html = renderToStaticMarkup(<ConnectorHealthPanel report={report} />);
    expect(html).toContain("Abilities API loaded");
    expect(html).toContain("No ACF schema skips");
    expect(html).toContain("0.7.1");
    expect(html).toContain("2 groups skipped");
  });
});
