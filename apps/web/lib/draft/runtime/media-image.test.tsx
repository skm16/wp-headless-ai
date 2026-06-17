import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaImage } from "./media-image";

describe("draft MediaImage shim (deployed-parity image constraint)", () => {
  // buildDraftCss only scans component + shell sources (artifacts.ts:85,152),
  // NOT the runtime shims (bundle.ts resolves them, but the CSS JIT never sees
  // their TSX). So `h-auto`/`max-w-full` on the shim's <img> were never emitted —
  // the draft core/image rendered unconstrained. Constrain inline instead, like
  // the deployed MediaImage (style={{maxWidth:"100%",height:"auto"}}).
  it("constrains the structured-attrs <img> with an inline style, not a Tailwind class", () => {
    const html = renderToStaticMarkup(
      <MediaImage block={{ blockName: "core/image", attrs: { url: "https://wp.example/x.jpg", alt: "x" } }} />,
    );
    expect(html).toMatch(/max-width:\s*100%/);
    expect(html).toMatch(/height:\s*auto/);
    expect(html).not.toContain("max-w-full");
    expect(html).not.toContain("h-auto");
  });

  it("constrains the innerHTML-parsed <img> with the same inline style", () => {
    const html = renderToStaticMarkup(
      <MediaImage
        block={{ blockName: "core/image", attrs: {}, innerHTML: `<figure><img src="https://wp.example/y.png" alt="y"></figure>` }}
      />,
    );
    expect(html).toMatch(/max-width:\s*100%/);
    expect(html).toMatch(/height:\s*auto/);
    expect(html).not.toContain("max-w-full");
  });
});
