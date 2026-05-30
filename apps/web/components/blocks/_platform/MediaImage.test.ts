import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isWpHostedImage, parseImgFromInnerHTML, MediaImage } from "./MediaImage";
import { createElement } from "react";

/**
 * MediaImage is an RSC that pulls process.env.WP_URL at render time, so
 * we exercise the same-origin classifier directly here. The render
 * itself is integration-tested by the Phase D Vercel deploy gate.
 */
describe("isWpHostedImage — same-origin classifier for next/image vs plain <img>", () => {
  it("returns true when the src hostname matches the WP_URL hostname", () => {
    expect(
      isWpHostedImage("https://tworoadsbrewing.com/wp-content/uploads/can.png", "https://tworoadsbrewing.com"),
    ).toBe(true);
  });

  it("ignores path/scheme differences — only hostname matters", () => {
    expect(
      isWpHostedImage("https://tworoadsbrewing.com/uploads/foo.png", "https://tworoadsbrewing.com/wp-json/"),
    ).toBe(true);
  });

  it("returns false for cross-origin sources (ShortPixel / Jetpack / other CDNs)", () => {
    expect(
      isWpHostedImage(
        "https://sp-ao.shortpixel.ai/client/foo.png",
        "https://tworoadsbrewing.com",
      ),
    ).toBe(false);
    expect(
      isWpHostedImage("https://i0.wp.com/example.com/foo.png", "https://example.com"),
    ).toBe(false);
  });

  it("returns false when WP_URL is undefined / empty (dev/test fallback path)", () => {
    expect(isWpHostedImage("https://example.com/a.png", undefined)).toBe(false);
    expect(isWpHostedImage("https://example.com/a.png", "")).toBe(false);
  });

  it("returns false when either URL is malformed (defensive — never throws)", () => {
    expect(isWpHostedImage("not a url", "https://example.com")).toBe(false);
    expect(isWpHostedImage("https://example.com/a.png", "not a url")).toBe(false);
    expect(isWpHostedImage("", "https://example.com")).toBe(false);
  });
});

/**
 * Stage 2 fallback: WordPress core/image typically stores
 * `{id, sizeSlug, linkDestination}` in attrs and the actual <img>
 * markup in innerHTML — sourced attributes per the plugin's
 * BlockTypeSchema.php. Pre-Fix-K the shim returned null for this
 * shape and every core/image rendered nothing.
 */
describe("parseImgFromInnerHTML — sourced-attr fallback (WP core/image)", () => {
  it("extracts src / alt / width / height from a typical core/image innerHTML", () => {
    const html = `<figure class="wp-block-image"><img src="https://example.com/uploads/a.jpg" alt="A cat" width="800" height="600" /></figure>`;
    expect(parseImgFromInnerHTML(html)).toEqual({
      src: "https://example.com/uploads/a.jpg",
      alt: "A cat",
      width: 800,
      height: 600,
    });
  });

  it("returns null when innerHTML contains no <img> tag (defensive)", () => {
    expect(parseImgFromInnerHTML("<p>no image here</p>")).toBeNull();
    expect(parseImgFromInnerHTML("")).toBeNull();
  });

  it("returns null when the <img> tag has no src (degenerate output)", () => {
    expect(parseImgFromInnerHTML(`<img alt="orphan">`)).toBeNull();
  });

  it("returns just src + alt when width/height attrs aren't present", () => {
    expect(parseImgFromInnerHTML(`<img src="https://x.test/a.jpg" alt="x">`))
      .toEqual({ src: "https://x.test/a.jpg", alt: "x", width: undefined, height: undefined });
  });

  it("handles single-quoted attributes", () => {
    const html = `<img src='https://x.test/a.jpg' alt='x' width='100' height='50'>`;
    expect(parseImgFromInnerHTML(html)).toEqual({
      src: "https://x.test/a.jpg",
      alt: "x",
      width: 100,
      height: 50,
    });
  });

  it("rejects non-integer width / height values without breaking src extraction", () => {
    const html = `<img src="https://x.test/a.jpg" width="auto" height="100%">`;
    expect(parseImgFromInnerHTML(html)).toEqual({
      src: "https://x.test/a.jpg",
      alt: undefined,
      width: undefined,
      height: undefined,
    });
  });

  it("returns null on null / non-string inputs (defensive against block.innerHTML being absent)", () => {
    expect(parseImgFromInnerHTML(null as unknown as string)).toBeNull();
    expect(parseImgFromInnerHTML(undefined as unknown as string)).toBeNull();
  });
});

/**
 * Stage-priority render tests using react-dom/server. Lightweight enough
 * to lock in the three-stage invariant without a full test renderer.
 * `MediaImage` is an RSC but renders synchronously when its async deps
 * aren't reached — none of the three stages awaits anything.
 */
describe("MediaImage — stage-priority lock-in", () => {
  function render(block: { attrs: Record<string, unknown>; innerHTML?: string }): string {
    return renderToStaticMarkup(
      createElement(MediaImage, { block: block as Parameters<typeof MediaImage>[0]["block"] }),
    );
  }

  it("Stage 1 wins when attrs.url is set, even if innerHTML also carries a different <img> src", () => {
    // Regression guard for the `if (!src && html)` Stage-2 condition:
    // a future refactor removing `!src` would clobber the attrs-resolved
    // src with whatever innerHTML carries. This test fails loudly in
    // that case.
    process.env.WP_URL = "https://attrs-origin.test";
    const out = render({
      attrs: { url: "https://attrs-origin.test/from-attrs.jpg", alt: "from attrs" },
      innerHTML: '<img src="https://other.test/from-html.jpg" alt="from html">',
    });
    expect(out).toMatch(/from-attrs\.jpg/);
    expect(out).not.toMatch(/from-html\.jpg/);
  });

  it("Stage 2 fires when attrs has no url/src but innerHTML carries an <img> tag (the regression Fix K closes)", () => {
    process.env.WP_URL = "https://example.com";
    const out = render({
      attrs: { id: 123, sizeSlug: "large" },
      innerHTML:
        '<figure class="wp-block-image"><img src="https://example.com/uploads/a.jpg" alt="A cat" width="800" height="600" /></figure>',
    });
    // The extracted src renders into the output — not nothing.
    expect(out).toMatch(/a\.jpg/);
    expect(out).toMatch(/A cat/);
  });

  it("Stage 3 raw-innerHTML passthrough fires when neither attrs nor parser yield a src but innerHTML has content", () => {
    process.env.WP_URL = "https://example.com";
    const out = render({
      attrs: { id: 123 },
      innerHTML: "<p>only text, no img tag at all</p>",
    });
    // The passthrough figure wrapper preserves the original markup.
    expect(out).toMatch(/wp-block-image--passthrough/);
    expect(out).toMatch(/only text, no img tag at all/);
  });

  it("returns null only when attrs has no src AND innerHTML is empty / whitespace-only", () => {
    expect(render({ attrs: { id: 999 }, innerHTML: "" })).toBe("");
    expect(render({ attrs: { id: 999 }, innerHTML: "   \n  " })).toBe("");
  });
});
