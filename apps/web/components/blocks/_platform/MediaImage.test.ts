import { describe, it, expect } from "vitest";
import { isWpHostedImage } from "./MediaImage";

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
