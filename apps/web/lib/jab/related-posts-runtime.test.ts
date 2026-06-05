import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isPostRef,
  collectRefsByType,
  resolveRelationshipRefs,
  createWpMediaResolver,
  type RBlock,
} from "./related-posts-runtime";

const beerRef = (id: number, slug: string) => ({
  ID: id, post_title: `Beer ${id}`, post_name: slug, post_type: "beer",
});

describe("isPostRef", () => {
  it("accepts a thin post-ref object", () => {
    expect(isPostRef(beerRef(12, "road-2-ruin"))).toBe(true);
  });
  it("rejects non-refs (missing ID / post_type / post_name)", () => {
    expect(isPostRef({ post_title: "x" })).toBe(false);
    expect(isPostRef({ ID: 1, post_type: "beer" })).toBe(false);
    expect(isPostRef(null)).toBe(false);
    expect(isPostRef("road-2-ruin")).toBe(false);
  });
});

describe("collectRefsByType", () => {
  it("walks blocks + innerBlocks and groups unique refs by post_type", () => {
    const blocks: RBlock[] = [
      { blockName: "acf_flex/page/pb/featured", _key: "a",
        attrs: { featured_beers: [beerRef(1, "a"), beerRef(2, "b")], heading: "Featured" } },
      { blockName: "acf_flex/page/pb/more", _key: "b",
        attrs: { picks: [beerRef(2, "b")] },           // dup id 2 collapses
        innerBlocks: [
          { blockName: "x", _key: "c", attrs: { events: [{ ID: 9, post_title: "E", post_name: "e", post_type: "event" }] } },
        ] },
    ];
    const map = collectRefsByType(blocks);
    expect([...(map.get("beer") ?? [])].sort()).toEqual([1, 2]);
    expect([...(map.get("event") ?? [])]).toEqual([9]);
  });
  it("ignores arrays that are not all post-refs", () => {
    const blocks: RBlock[] = [
      { blockName: "x", _key: "a", attrs: { tags: ["ipa", "lager"], mixed: [beerRef(1, "a"), { foo: 1 }] } },
    ];
    expect(collectRefsByType(blocks).size).toBe(0);
  });
});

describe("resolveRelationshipRefs", () => {
  it("fetches each unique ref by-slug and merges featured_image in place", async () => {
    const blocks: RBlock[] = [
      { blockName: "f", _key: "a", attrs: { featured_beers: [beerRef(1, "road-2-ruin"), beerRef(2, "cruise")] } },
    ];
    const callAbility = vi.fn(async (name: string, input: any) => {
      expect(name).toBe("jab/get-beer-by-slug");
      const map: Record<string, unknown> = {
        "road-2-ruin": { ID: 1, post_title: "Road 2 Ruin", featured_image: { url: "https://wp/r2r.png", alt: "R2R" } },
        "cruise": { ID: 2, post_title: "Cruise Control", featured_image: { url: "https://wp/cc.png", alt: "CC" } },
      };
      return { beer: map[input.slug] };  // wrapper key = snake(post_type)
    });

    const out = await resolveRelationshipRefs(blocks, callAbility);

    const refs = out[0].attrs.featured_beers as any[];
    expect(refs[0].featured_image.url).toBe("https://wp/r2r.png");
    expect(refs[1].featured_image.url).toBe("https://wp/cc.png");
    // one call per unique slug
    expect(callAbility).toHaveBeenCalledTimes(2);
  });

  it("dedupes repeated refs across blocks into a single fetch", async () => {
    const blocks: RBlock[] = [
      { blockName: "f", _key: "a", attrs: { picks: [beerRef(1, "road-2-ruin")] } },
      { blockName: "g", _key: "b", attrs: { more: [beerRef(1, "road-2-ruin")] } },
    ];
    const callAbility = vi.fn(async () => ({ beer: { ID: 1, featured_image: { url: "u", alt: "" } } }));
    await resolveRelationshipRefs(blocks, callAbility);
    expect(callAbility).toHaveBeenCalledTimes(1);
  });

  it("is fail-soft: a fetch error leaves the ref unenriched, others still resolve", async () => {
    const blocks: RBlock[] = [
      { blockName: "f", _key: "a", attrs: { b: [beerRef(1, "ok"), beerRef(2, "boom")] } },
    ];
    const callAbility = vi.fn(async (_n: string, input: any) => {
      if (input.slug === "boom") throw new Error("WP 500");
      return { beer: { ID: 1, featured_image: { url: "u", alt: "" } } };
    });
    const out = await resolveRelationshipRefs(blocks, callAbility);
    const refs = out[0].attrs.b as any[];
    expect(refs[0].featured_image.url).toBe("u");
    expect(refs[1].featured_image).toBeUndefined();   // unenriched, no throw
  });

  it("no post-refs → no calls, returns the same blocks", async () => {
    const blocks: RBlock[] = [{ blockName: "p", _key: "a", attrs: { content: "hi" } }];
    const callAbility = vi.fn();
    const out = await resolveRelationshipRefs(blocks, callAbility);
    expect(callAbility).not.toHaveBeenCalled();
    expect(out).toBe(blocks);
  });
});

describe("resolveRelationshipRefs — image sourcing from ACF (Two Roads beers)", () => {
  const ref = (id: number, slug: string) => ({ ID: id, post_title: `Beer ${id}`, post_name: slug, post_type: "beer" });

  it("sources featured_image from acf.feature_image (resolved object) when no top-level featured_image", async () => {
    const blocks: RBlock[] = [{ blockName: "f", _key: "a", attrs: { beers: [ref(1, "r2r")] } }];
    // mirrors the live jab/get-beer-by-slug shape: no top-level featured_image, image lives in acf.feature_image.
    const callAbility = vi.fn(async () => ({
      beer: { id: 1, title: "Road 2 Ruin", acf: { feature_image: { url: "https://wp/can.png", alt: "Can" }, gallery: [{ url: "https://wp/wrap.png", alt: "Wrap" }] } },
    }));
    const out = await resolveRelationshipRefs(blocks, callAbility);
    const beers = out[0].attrs.beers as any[];
    expect(beers[0].featured_image.url).toBe("https://wp/can.png");
    expect(beers[0].featured_image.alt).toBe("Can");
  });

  it("prefers a named ACF image field (feature_image) over the gallery array", async () => {
    const blocks: RBlock[] = [{ blockName: "f", _key: "a", attrs: { beers: [ref(1, "r2r")] } }];
    const callAbility = vi.fn(async () => ({
      beer: { acf: { gallery: [{ url: "https://wp/wrap.png" }], feature_image: { url: "https://wp/can.png" } } },
    }));
    const out = await resolveRelationshipRefs(blocks, callAbility);
    expect((out[0].attrs.beers as any[])[0].featured_image.url).toBe("https://wp/can.png");
  });

  it("falls back to acf.gallery[0] when there is no named image field", async () => {
    const blocks: RBlock[] = [{ blockName: "f", _key: "a", attrs: { beers: [ref(1, "r2r")] } }];
    const callAbility = vi.fn(async () => ({ beer: { acf: { gallery: [{ url: "https://wp/g0.png", alt: "G0" }] } } }));
    const out = await resolveRelationshipRefs(blocks, callAbility);
    expect((out[0].attrs.beers as any[])[0].featured_image.url).toBe("https://wp/g0.png");
  });

  it("resolves a bare attachment ID via the injected resolveMedia", async () => {
    const blocks: RBlock[] = [{ blockName: "f", _key: "a", attrs: { beers: [ref(1, "r2r")] } }];
    const callAbility = vi.fn(async () => ({ beer: { acf: { feature_image: 4884 } } }));
    const resolveMedia = vi.fn(async (id: number) => ({ url: `https://wp/media-${id}.png`, alt: "Resolved" }));
    const out = await resolveRelationshipRefs(blocks, callAbility, resolveMedia);
    expect(resolveMedia).toHaveBeenCalledWith(4884);
    expect((out[0].attrs.beers as any[])[0].featured_image.url).toBe("https://wp/media-4884.png");
  });

  it("still uses a top-level featured_image when present (e.g. a CPT with a WP thumbnail)", async () => {
    const blocks: RBlock[] = [{ blockName: "f", _key: "a", attrs: { posts: [{ ID: 9, post_title: "N", post_name: "n", post_type: "post" }] } }];
    const callAbility = vi.fn(async () => ({ post: { featured_image: { url: "https://wp/thumb.png", alt: "T" }, acf: {} } }));
    const out = await resolveRelationshipRefs(blocks, callAbility);
    expect((out[0].attrs.posts as any[])[0].featured_image.url).toBe("https://wp/thumb.png");
  });

  it("leaves the ref unenriched when the record carries no image at all", async () => {
    const blocks: RBlock[] = [{ blockName: "f", _key: "a", attrs: { beers: [ref(1, "r2r")] } }];
    const callAbility = vi.fn(async () => ({ beer: { acf: { abv: "8", description: "hoppy" } } }));
    const out = await resolveRelationshipRefs(blocks, callAbility);
    expect((out[0].attrs.beers as any[])[0].featured_image).toBeUndefined();
  });

  it("does not resolve IDs when no resolveMedia is injected (object/string forms still work)", async () => {
    const blocks: RBlock[] = [{ blockName: "f", _key: "a", attrs: { beers: [ref(1, "r2r")] } }];
    const callAbility = vi.fn(async () => ({ beer: { acf: { feature_image: 4884 } } }));
    const out = await resolveRelationshipRefs(blocks, callAbility);
    expect((out[0].attrs.beers as any[])[0].featured_image).toBeUndefined();
  });

  it("the WP thumbnail OUTRANKS a competing ACF image (a deliberate featured image wins)", async () => {
    // The generalizability case: a conventional post with a real WP thumbnail
    // AND an incidental ACF image field must render the THUMBNAIL, not the ACF graphic.
    const blocks: RBlock[] = [{ blockName: "f", _key: "a", attrs: { posts: [{ ID: 9, post_title: "N", post_name: "n", post_type: "post" }] } }];
    const callAbility = vi.fn(async () => ({
      post: { featured_image: { url: "https://wp/thumb.png", alt: "Thumb" }, acf: { cover_image: { url: "https://wp/acf-graphic.png" }, feature_image: { url: "https://wp/acf2.png" } } },
    }));
    const out = await resolveRelationshipRefs(blocks, callAbility);
    expect((out[0].attrs.posts as any[])[0].featured_image.url).toBe("https://wp/thumb.png");
  });

  it("ignores a generic acf.image field (not in the named allow-list) — prefers no image over a wrong one", async () => {
    const blocks: RBlock[] = [{ blockName: "f", _key: "a", attrs: { beers: [ref(1, "r2r")] } }];
    const callAbility = vi.fn(async () => ({ beer: { acf: { image: { url: "https://wp/incidental.png" } } } }));
    const out = await resolveRelationshipRefs(blocks, callAbility);
    expect((out[0].attrs.beers as any[])[0].featured_image).toBeUndefined();
  });

  it("ignores an unnamed image array (logos/badges) — only conventionally-named galleries are used", async () => {
    const blocks: RBlock[] = [{ blockName: "f", _key: "a", attrs: { beers: [ref(1, "r2r")] } }];
    const callAbility = vi.fn(async () => ({ beer: { acf: { partner_logos: [{ url: "https://wp/logo.png" }] } } }));
    const out = await resolveRelationshipRefs(blocks, callAbility);
    expect((out[0].attrs.beers as any[])[0].featured_image).toBeUndefined();
  });

  it("normalizes the ACF 'Image URL' return_format (a bare string URL)", async () => {
    const blocks: RBlock[] = [{ blockName: "f", _key: "a", attrs: { beers: [ref(1, "r2r")] } }];
    const callAbility = vi.fn(async () => ({ beer: { acf: { feature_image: "https://wp/url-format.png" } } }));
    const out = await resolveRelationshipRefs(blocks, callAbility);
    expect((out[0].attrs.beers as any[])[0].featured_image.url).toBe("https://wp/url-format.png");
    expect((out[0].attrs.beers as any[])[0].featured_image.alt).toBeUndefined();
  });

  it("treats an ACF 'no image' (0) as no image — never fetches /media/0", async () => {
    const blocks: RBlock[] = [{ blockName: "f", _key: "a", attrs: { beers: [ref(1, "r2r")] } }];
    const callAbility = vi.fn(async () => ({ beer: { acf: { feature_image: 0 } } }));
    const resolveMedia = vi.fn(async (id: number) => ({ url: `https://wp/media-${id}.png` }));
    const out = await resolveRelationshipRefs(blocks, callAbility, resolveMedia);
    expect(resolveMedia).not.toHaveBeenCalled();
    expect((out[0].attrs.beers as any[])[0].featured_image).toBeUndefined();
  });

  it("merges the fetched record's non-image ACF fields onto the ref (components bind acf.abv etc.)", async () => {
    const blocks: RBlock[] = [{ blockName: "f", _key: "a", attrs: { beers: [ref(1, "r2r")] } }];
    const callAbility = vi.fn(async () => ({ beer: { acf: { feature_image: { url: "https://wp/can.png" }, abv: "8.2%" } } }));
    const out = await resolveRelationshipRefs(blocks, callAbility);
    const beer = (out[0].attrs.beers as any[])[0];
    expect(beer.featured_image.url).toBe("https://wp/can.png");
    expect(beer.acf.abv).toBe("8.2%"); // pins the `...hit.record` spread
  });

  it("requests the lightweight payload (no blocks/content) on the by-slug fetch", async () => {
    const blocks: RBlock[] = [{ blockName: "f", _key: "a", attrs: { beers: [ref(1, "r2r")] } }];
    const callAbility = vi.fn(async () => ({ beer: { acf: {} } }));
    await resolveRelationshipRefs(blocks, callAbility);
    expect(callAbility).toHaveBeenCalledWith("jab/get-beer-by-slug", { slug: "r2r", include: { blocks: false, content: false } });
  });
});

describe("createWpMediaResolver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns a no-op resolver (never fetches) when WP env is absent", async () => {
    vi.stubEnv("WP_URL", "");
    vi.stubEnv("WP_USER", "");
    vi.stubEnv("WP_APP_PASSWORD", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const resolve = createWpMediaResolver();
    expect(await resolve(123)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches /wp/v2/media/{id} with Basic auth and maps source_url/alt_text → {url, alt}", async () => {
    vi.stubEnv("WP_URL", "https://wp.test/");
    vi.stubEnv("WP_USER", "admin");
    vi.stubEnv("WP_APP_PASSWORD", "pw pw pw");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ source_url: "https://wp.test/img.png", alt_text: "Alt" }) }));
    vi.stubGlobal("fetch", fetchMock);
    const resolve = createWpMediaResolver();
    const out = await resolve(138);
    expect(out).toEqual({ url: "https://wp.test/img.png", alt: "Alt" });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://wp.test/wp-json/wp/v2/media/138"); // trailing slash trimmed
    expect((opts as RequestInit).headers as Record<string, string>).toMatchObject({ Authorization: "Basic " + Buffer.from("admin:pw pw pw").toString("base64") });
  });

  it("is fail-soft: non-ok response → null", async () => {
    vi.stubEnv("WP_URL", "https://wp.test");
    vi.stubEnv("WP_USER", "admin");
    vi.stubEnv("WP_APP_PASSWORD", "pw");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await createWpMediaResolver()(404)).toBeNull();
  });

  it("is fail-soft: a thrown fetch → null (no throw)", async () => {
    vi.stubEnv("WP_URL", "https://wp.test");
    vi.stubEnv("WP_USER", "admin");
    vi.stubEnv("WP_APP_PASSWORD", "pw");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    expect(await createWpMediaResolver()(1)).toBeNull();
  });

  it("memoizes by id — two calls for the same id fetch once", async () => {
    vi.stubEnv("WP_URL", "https://wp.test");
    vi.stubEnv("WP_USER", "admin");
    vi.stubEnv("WP_APP_PASSWORD", "pw");
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ source_url: "https://wp.test/x.png" }) }));
    vi.stubGlobal("fetch", fetchMock);
    const resolve = createWpMediaResolver();
    await resolve(7);
    await resolve(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
