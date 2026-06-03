import { describe, it, expect } from "vitest";
import { joinUrl } from "./playwright-verify";

describe("joinUrl", () => {
  it("appends a leading-slash route to a trailing-slash-free base", () => {
    expect(joinUrl("https://x.vercel.app", "/about")).toBe(
      "https://x.vercel.app/about",
    );
  });

  it("strips trailing slashes from the base", () => {
    expect(joinUrl("https://x.vercel.app/", "/about")).toBe(
      "https://x.vercel.app/about",
    );
    expect(joinUrl("https://x.vercel.app///", "/about")).toBe(
      "https://x.vercel.app/about",
    );
  });

  it("prepends a slash when the path lacks one", () => {
    expect(joinUrl("https://x.vercel.app", "about")).toBe(
      "https://x.vercel.app/about",
    );
  });

  it("returns base unchanged when path is empty", () => {
    expect(joinUrl("https://x.vercel.app", "")).toBe("https://x.vercel.app");
  });

  it("handles nested paths", () => {
    expect(joinUrl("https://x.vercel.app", "/blog/post-1")).toBe(
      "https://x.vercel.app/blog/post-1",
    );
  });

  it("preserves a `/` route_path verbatim", () => {
    expect(joinUrl("https://x.vercel.app", "/")).toBe("https://x.vercel.app/");
  });
});
