import { describe, it, expect } from "vitest";
import { buildDataShapeSection } from "./patch-data-shape";
import type { BlockDataSource } from "@/lib/jab/resolve-block-data-source";

const manifest = {
  abilities: [
    {
      name: "jab/get-beer-by-slug",
      outputSchema: {
        properties: {
          beer: {
            oneOf: [
              { type: "null" },
              {
                type: "object",
                properties: {
                  acf: {
                    properties: {
                      description: { type: "string" },
                      abv: { type: "number" },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  ],
} as unknown as import("@jab/core").Manifest;

describe("buildDataShapeSection — direct kinds", () => {
  it("lists a direct-cpt block's ACF fields", () => {
    const src: BlockDataSource = { kind: "direct-cpt", cptSlug: "beer" };
    const out = buildDataShapeSection(src, manifest);
    expect(out).toContain("description");
    expect(out).toContain("abv");
    expect(out.toLowerCase()).toContain("data shape");
  });

  it("lists a direct-acf block's own attr fields", () => {
    const src: BlockDataSource = { kind: "direct-acf", sample: { heading: "Our Beers", subtitle: "On tap" } };
    const out = buildDataShapeSection(src, manifest);
    expect(out).toContain("heading");
    expect(out).toContain("subtitle");
  });

  it("returns empty string for kind=none", () => {
    expect(buildDataShapeSection({ kind: "none" }, manifest)).toBe("");
  });

  it("fail-softs to empty string when the CPT schema is not in the manifest", () => {
    const src: BlockDataSource = { kind: "direct-cpt", cptSlug: "nonexistent" };
    expect(buildDataShapeSection(src, manifest)).toBe("");
  });

  it("fail-softs to empty string when manifest is null", () => {
    expect(buildDataShapeSection({ kind: "direct-cpt", cptSlug: "beer" }, null)).toBe("");
  });
});

describe("buildDataShapeSection — relation (3b)", () => {
  it("surfaces the TARGET CPT's fields for a relation source with the item.acf nesting", () => {
    const src = { kind: "relation", fieldName: "beers", postType: "beer" } as const;
    const out = buildDataShapeSection(src, manifest);
    expect(out).toContain("description");         // the target CPT's field, not just featured_image
    expect(out).toContain("abv");
    expect(out).toContain("beers");               // names the relation field
    expect(out).toContain("item.acf");            // states the correct nesting
    expect(out.toLowerCase()).toContain("hydrated at render");
  });

  it("fail-softs to empty when the target CPT is not in the manifest", () => {
    const src = { kind: "relation", fieldName: "widgets", postType: "widget" } as const;
    expect(buildDataShapeSection(src, manifest)).toBe("");
  });
});

describe("buildDataShapeSection — relation wrapper matches the render path", () => {
  it("derives the wrapper as snake(postType) like the render, not the manifest custom key", () => {
    // Manifest keys the beer record under a CUSTOM wrapper 'beer_item'; the render
    // path reads resp['beer'] (snake postType). The section MUST match the render:
    // since the acf lives under 'beer_item' but the render reads 'beer', the honest
    // output is "" (no false "these fields are available" claim).
    const customManifest = {
      abilities: [
        {
          name: "jab/get-beer-by-slug",
          outputSchema: {
            // `required: ["beer_item"]` is what makes resolveCptAbilityMeta PREFER
            // the custom wrapper key (abilityWrapperKeyFromSchema reads required[0],
            // NOT properties — ability-client.ts:720-729). Without it the fixture
            // falls back to the snake(postType) derivation and passes vacuously,
            // reproducing NOTHING. This line is load-bearing for the repro.
            required: ["beer_item"],
            properties: {
              beer_item: {
                oneOf: [
                  { type: "null" },
                  { type: "object", properties: { acf: { properties: { description: { type: "string" } } } } },
                ],
              },
            },
          },
        },
      ],
    } as unknown as import("@jab/core").Manifest;
    const out = buildDataShapeSection({ kind: "relation", fieldName: "beers", postType: "beer" }, customManifest);
    expect(out).toBe("");
  });

  it("still surfaces fields for the standard case where the wrapper IS snake(postType)", () => {
    // Uses the existing top-of-file `manifest` fixture keyed under 'beer'.
    const out = buildDataShapeSection({ kind: "relation", fieldName: "beers", postType: "beer" }, manifest);
    expect(out).toContain("description");
    expect(out).toContain("item.acf");
  });
});

describe("buildDataShapeSection — fail-soft on malformed manifest", () => {
  const cases = [
    ["empty object", {}],
    ["abilities null", { abilities: null }],
    ["abilities non-array", { abilities: 42 }],
    ["abilities string", { abilities: "nope" }],
  ] as const;
  for (const [label, m] of cases) {
    it(`returns "" (no throw) for a ${label} manifest — direct-cpt`, () => {
      expect(() => buildDataShapeSection({ kind: "direct-cpt", cptSlug: "beer" }, m as never)).not.toThrow();
      expect(buildDataShapeSection({ kind: "direct-cpt", cptSlug: "beer" }, m as never)).toBe("");
    });
    it(`returns "" (no throw) for a ${label} manifest — relation`, () => {
      expect(() => buildDataShapeSection({ kind: "relation", fieldName: "beers", postType: "beer" }, m as never)).not.toThrow();
      expect(buildDataShapeSection({ kind: "relation", fieldName: "beers", postType: "beer" }, m as never)).toBe("");
    });
  }
});
