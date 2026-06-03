import { describe, it, expect, afterEach } from "vitest";
import { Buffer } from "node:buffer";
import { fetchSiteManifest } from "./site.js";

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
  theme: { slug: "twentytwentyfour", name: "Twenty Twenty-Four", version: "1.0" },
};

describe("fetchSiteManifest", () => {
  const orig = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = orig;
  });

  it("GETs /wp-json/jab/v1/site with Basic auth and returns the manifest", async () => {
    let url = "";
    let auth = "";
    globalThis.fetch = (async (u: string, init?: RequestInit) => {
      url = String(u);
      auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    }) as typeof fetch;
    const site = await fetchSiteManifest({ wpUrl: "https://x/", user: "u", password: "p" });
    expect(site?.front_page.static_front.slug).toBe("home");
    expect(url).toBe("https://x/wp-json/jab/v1/site");
    expect(auth).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  it("returns null on 404 (old plugin) and on network error", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    expect(await fetchSiteManifest({ wpUrl: "https://x", user: "u", password: "p" })).toBeNull();
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as typeof fetch;
    expect(await fetchSiteManifest({ wpUrl: "https://x", user: "u", password: "p" })).toBeNull();
  });

  it("returns null when the body fails the structural guard", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ nope: true }), { status: 200 })) as typeof fetch;
    expect(await fetchSiteManifest({ wpUrl: "https://x", user: "u", password: "p" })).toBeNull();
  });
});
