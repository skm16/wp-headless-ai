import { describe, it, expect } from "vitest";
import { renderDraftShellHtml } from "./html-shell";

describe("renderDraftShellHtml", () => {
  const html = renderDraftShellHtml({
    projectId: "p1",
    token: "t.abc",
    initialPath: "/visit-us",
    fontLinkHrefs: ["https://fonts.googleapis.com/css2?family=Syne&display=swap"],
    version: "base-b1",
  });

  it("sets the #jab-app id and .jab-theme scope the CSS expects", () => {
    expect(html).toContain('<html id="jab-app"');
    expect(html).toContain('class="jab-theme"');
  });

  it("links css + module bundle through the token-gated asset route with a version cache-buster", () => {
    expect(html).toContain("/api/draft/p1/asset/draft.css?token=t.abc&v=base-b1");
    expect(html).toContain("/api/draft/p1/asset/bundle.js?token=t.abc&v=base-b1");
    expect(html).toContain('type="module"');
  });

  it("embeds the boot config with the initial path", () => {
    expect(html).toContain('"initialPath":"/visit-us"');
    expect(html).toContain('"apiBase":"/api/draft/p1"');
  });

  it("includes the font links", () => {
    expect(html).toContain("fonts.googleapis.com/css2?family=Syne");
  });
});
