// apps/web/lib/jab/seed-pages.test.ts
import { describe, it, expect } from "vitest";
import { selectSeedPages, type CptListPair } from "./seed-pages";
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
