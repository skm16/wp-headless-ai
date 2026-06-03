// apps/web/lib/jab/seed-pages.test.ts
import { describe, it, expect } from "vitest";
import { selectSeedPages, hoistFrontPage, type CptListPair } from "./seed-pages";
import type { PostTypeRow, CptAbilityMeta, PostListRow } from "./ability-client";

function pair(slug: string, rowSlugs: string[]): CptListPair {
  const cpt: PostTypeRow = {
    slug,
    rest_base: slug,
    plural_label: slug,
    singular_label: slug,
    is_builtin: false,
    hierarchical: false,
    count: 0,
  };
  const meta: CptAbilityMeta = {
    listAbilityName: `jab/get-${slug}`,
    listWrapperKey: slug,
    bySlugAbilityName: `jab/get-${slug}-by-slug`,
    bySlugWrapperKey: slug,
  };
  const rows: PostListRow[] = rowSlugs.map((s, i) => ({
    id: i + 1,
    title: `${slug}-${s}`,
    slug: s,
    link: `https://example.test/${slug}/${s}`,
    date: "",
    excerpt: "",
  } as unknown as PostListRow));
  return { cpt, meta, rows };
}

describe("selectSeedPages", () => {
  it("keeps every row for post_type=page", () => {
    const input: CptListPair[] = [
      pair("page", ["home", "about", "contact", "team", "history"]),
    ];
    const out = selectSeedPages(input);
    expect(out[0].rows.map((r) => r.slug)).toEqual(["home", "about", "contact", "team", "history"]);
  });

  it("keeps only the first row for non-page CPTs", () => {
    const input: CptListPair[] = [
      pair("beer", Array.from({ length: 88 }, (_, i) => `beer-${i}`)),
      pair("event", Array.from({ length: 100 }, (_, i) => `event-${i}`)),
    ];
    const out = selectSeedPages(input);
    expect(out[0].rows.map((r) => r.slug)).toEqual(["beer-0"]);
    expect(out[1].rows.map((r) => r.slug)).toEqual(["event-0"]);
  });

  it("respects samplesPerNonPageCpt override", () => {
    const input: CptListPair[] = [
      pair("beer", ["a", "b", "c", "d", "e"]),
    ];
    const out = selectSeedPages(input, { samplesPerNonPageCpt: 3 });
    expect(out[0].rows.map((r) => r.slug)).toEqual(["a", "b", "c"]);
  });

  it("clamps samplesPerNonPageCpt to a minimum of 1", () => {
    const input: CptListPair[] = [pair("beer", ["a", "b", "c"])];
    const zero = selectSeedPages(input, { samplesPerNonPageCpt: 0 });
    const negative = selectSeedPages(input, { samplesPerNonPageCpt: -5 });
    expect(zero[0].rows.map((r) => r.slug)).toEqual(["a"]);
    expect(negative[0].rows.map((r) => r.slug)).toEqual(["a"]);
  });

  it("treats additional slugs in keepAllSlugs like page", () => {
    const input: CptListPair[] = [
      pair("page", ["home", "about"]),
      pair("landing", ["promo-spring", "promo-fall", "promo-winter"]),
      pair("beer", ["a", "b", "c"]),
    ];
    const out = selectSeedPages(input, { keepAllSlugs: ["page", "landing"] });
    expect(out[0].rows.map((r) => r.slug)).toEqual(["home", "about"]);
    expect(out[1].rows.map((r) => r.slug)).toEqual(["promo-spring", "promo-fall", "promo-winter"]);
    expect(out[2].rows.map((r) => r.slug)).toEqual(["a"]);
  });

  it("preserves CPT order and CPT-level metadata identity", () => {
    const input: CptListPair[] = [
      pair("post", ["latest", "older"]),
      pair("page", ["home"]),
      pair("beer", ["ipa", "stout"]),
    ];
    const out = selectSeedPages(input);
    expect(out.map((p) => p.cpt.slug)).toEqual(["post", "page", "beer"]);
    expect(out[0].meta.listAbilityName).toBe("jab/get-post");
    expect(out[2].meta.bySlugAbilityName).toBe("jab/get-beer-by-slug");
  });

  it("handles empty row lists gracefully", () => {
    const input: CptListPair[] = [
      pair("page", []),
      pair("beer", []),
    ];
    const out = selectSeedPages(input);
    expect(out[0].rows).toEqual([]);
    expect(out[1].rows).toEqual([]);
  });

  it("does not mutate the input arrays", () => {
    const input: CptListPair[] = [pair("beer", ["a", "b", "c"])];
    const inputRowsRef = input[0].rows;
    const inputLength = input[0].rows.length;
    selectSeedPages(input);
    expect(input[0].rows).toBe(inputRowsRef);
    expect(input[0].rows.length).toBe(inputLength);
  });
});

// ── hoistFrontPage helpers ────────────────────────────────────────────────────

const makeCpt = (slug: string): PostTypeRow => ({
  slug,
  rest_base: slug,
  plural_label: slug,
  singular_label: slug,
  is_builtin: slug === "page" || slug === "post",
  hierarchical: slug === "page",
  count: 100,
});

const makeMeta = (slug: string): CptAbilityMeta => ({
  listAbilityName: `jab/get-${slug}`,
  listWrapperKey: slug,
  bySlugAbilityName: `jab/get-${slug}-by-slug`,
  bySlugWrapperKey: slug,
});

const makeRow = (slug: string, title = slug): PostListRow => ({
  id: 1,
  slug,
  title,
  link: `https://example.test/${slug}`,
  date: "2026-01-01T00:00:00Z",
  excerpt: "",
  modified: "2026-01-01T00:00:00Z",
  modified_gmt: "2026-01-01T00:00:00Z",
});

const makePair = (cptSlug: string, rowSlugs: string[]): CptListPair => ({
  cpt: makeCpt(cptSlug),
  meta: makeMeta(cptSlug),
  rows: rowSlugs.map((s) => makeRow(s)),
});

describe("hoistFrontPage", () => {
  it("returns input unchanged when frontPageSlug is null", () => {
    const seeds = [makePair("page", ["about", "contact"])];
    expect(hoistFrontPage(seeds, seeds, null)).toEqual(seeds);
  });

  it("hoists row to position 0 within its CPT when already in seeds", () => {
    const seeds = [
      makePair("beer", ["ipa"]),
      makePair("page", ["about", "home", "contact"]),
    ];
    const result = hoistFrontPage(seeds, seeds, "home");
    // "home" should now be at position 0 within page CPT,
    // and page CPT should be at position 0 of the seed lists.
    expect(result[0].cpt.slug).toBe("page");
    expect(result[0].rows.map((r) => r.slug)).toEqual(["home", "about", "contact"]);
    expect(result[1].cpt.slug).toBe("beer");
  });

  it("returns input unchanged when front page already at position 0,0", () => {
    const seeds = [
      makePair("page", ["home", "about"]),
      makePair("beer", ["ipa"]),
    ];
    const result = hoistFrontPage(seeds, seeds, "home");
    expect(result).toEqual(seeds);
  });

  it("injects row from perCptLists when not in seeds (sampled out)", () => {
    // beer CPT got sampled to just ["ipa"] in seeds, but perCptLists has the homepage candidate "specialty-beer-home"
    const perCptLists: CptListPair[] = [
      makePair("page", ["about"]),
      makePair("beer", ["ipa", "specialty-beer-home", "stout"]),
    ];
    const seeds: CptListPair[] = [
      { ...perCptLists[0] },
      { ...perCptLists[1], rows: [perCptLists[1].rows[0]] }, // sampled to just "ipa"
    ];
    const result = hoistFrontPage(seeds, perCptLists, "specialty-beer-home");
    // beer CPT hoisted to position 0, and "specialty-beer-home" injected at row position 0
    expect(result[0].cpt.slug).toBe("beer");
    expect(result[0].rows[0].slug).toBe("specialty-beer-home");
  });

  it("injects a new CPT entry when the front-page CPT isn't in seedCptLists at all", () => {
    // Edge case: perCptLists has a CPT entry that's missing from seedCptLists
    // (would only happen if selectSeedPages were called with custom filtering).
    // Verify the front-page row prepends a new seed entry.
    const perCptLists: CptListPair[] = [
      makePair("page", ["about"]),
      makePair("landing", ["welcome"]),
    ];
    const seedsWithoutLanding: CptListPair[] = [makePair("page", ["about"])];
    const result = hoistFrontPage(seedsWithoutLanding, perCptLists, "welcome");
    expect(result).toHaveLength(2);
    expect(result[0].cpt.slug).toBe("landing");
    expect(result[0].rows.map((r) => r.slug)).toEqual(["welcome"]);
    expect(result[1].cpt.slug).toBe("page");
  });

  it("returns input unchanged when front page slug not found anywhere", () => {
    const seeds = [makePair("page", ["about", "contact"])];
    const perCptLists = [makePair("page", ["about", "contact"])];
    const result = hoistFrontPage(seeds, perCptLists, "ghost-page");
    expect(result).toEqual(seeds);
  });

  it("does not mutate inputs", () => {
    const seeds = [makePair("page", ["about", "home"])];
    const seedsBeforeStr = JSON.stringify(seeds);
    hoistFrontPage(seeds, seeds, "home");
    expect(JSON.stringify(seeds)).toBe(seedsBeforeStr);
  });
});
