import { describe, it, expect, afterEach } from "vitest";
import { getSiteManifest } from "./ability-client";

const SAMPLE = {
  plugin_version: "0.7.1",
  generated_at: "2026-06-03T00:00:00Z",
  site: {
    title: "T",
    tagline: "",
    home_url: "https://x",
    site_url: "https://x",
    timezone: "UTC",
    locale: "en_US",
    permalink_structure: "/%postname%/",
  },
  front_page: {
    show_on_front: "page",
    static_front: { id: 2, slug: "home", title: "Home" },
    posts_page: { id: null, slug: null, title: null },
  },
  branding: { site_icon_url: null, custom_logo_id: 9, custom_logo_url: "https://x/logo.png" },
  menus: [{ slug: "primary", label: "Primary" }],
  image_sizes: [{ name: "large", width: 1024, height: 0, crop: false }],
  theme: { slug: "tt4", name: "TT4", version: "1.0" },
};

describe("getSiteManifest", () => {
  const orig = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = orig;
  });

  it("returns the manifest on 200 and null on 404", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(SAMPLE), { status: 200 })) as typeof fetch;
    const site = await getSiteManifest({ wpUrl: "https://x", username: "u", appPassword: "p" });
    expect(site?.front_page.static_front.slug).toBe("home");
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    expect(await getSiteManifest({ wpUrl: "https://x", username: "u", appPassword: "p" })).toBeNull();
  });

  it("returns null on a 3xx redirect (SSRF posture)", async () => {
    globalThis.fetch = (async () => new Response("", { status: 302 })) as typeof fetch;
    expect(await getSiteManifest({ wpUrl: "https://x", username: "u", appPassword: "p" })).toBeNull();
  });

  it("returns null when the body fails the structural guard", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ nope: true }), { status: 200 })) as typeof fetch;
    expect(await getSiteManifest({ wpUrl: "https://x", username: "u", appPassword: "p" })).toBeNull();
  });
});
