import { describe, it, expect } from "vitest";
import {
  validateTsx,
  cptTemplatePrompt,
  generateComponent,
  summarizeAcfFields,
  acfFlexPrompt,
  findPostRelationFieldsInSample,
  visualPrompt,
  standardPrompt,
  trivialPrompt,
} from "./component-generator";
import type { EnrichedInventoryEntry } from "@/lib/jab/inventory";

describe("validateTsx", () => {
  it("accepts a valid TSX component", () => {
    const code = `
import React from "react";
export function Heading({ level = 1, content }: { level?: number; content: string }) {
  return <h1>{content}</h1>;
}
`;
    const errors = validateTsx(code, "Heading.tsx");
    expect(errors).toHaveLength(0);
  });

  it("rejects malformed JSX (unclosed tag)", () => {
    const code = `export function Bad() { return <div>unclosed; }`;
    const errors = validateTsx(code, "Bad.tsx");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects malformed JSX (mismatched tags)", () => {
    const code = `export function Bad() { return <div><span></div>; }`;
    const errors = validateTsx(code, "Bad.tsx");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts a component with TS type annotations", () => {
    const code = `
interface Props { text: string; }
export function Para({ text }: Props) { return <p>{text}</p>; }
`;
    const errors = validateTsx(code, "Para.tsx");
    expect(errors).toHaveLength(0);
  });
});

describe("generateComponent passthrough fallback", () => {
  it("emits self-contained HTML passthrough without DOM sanitizer imports", async () => {
    const result = await generateComponent({
      entry: {
        blockName: "core/html",
        occurrenceCount: 1,
        pageSlugs: ["home"],
        attrSamples: [],
        tier: "passthrough",
        kind: "block",
        sourceDomSample: null,
        computedStyles: null,
      },
      tokens: null,
    });

    expect(result.compileStatus).toBe("skipped");
    expect(result.tsx).toMatch(/dangerouslySetInnerHTML/);
    expect(result.tsx).not.toMatch(/RichTextContent/);
    expect(result.tsx).not.toMatch(/isomorphic-dompurify|DOMPurify/);
  });
});

describe("cptTemplatePrompt — children prop contract", () => {
  // The dispatcher (emitDispatcherTsx in compose-site-emit.ts) renders every
  // generated block as `<Component block={block} />` — no children passed.
  // If the CPT prompt asks for `children: React.ReactNode` (required), every
  // CPT template entry will fail tsc when the dispatcher imports it.
  // Therefore the prompt must declare children as OPTIONAL.
  function makeCptEntry(): EnrichedInventoryEntry {
    return {
      blockName: "cpt_template/beer",
      occurrenceCount: 1,
      pageSlugs: ["beer/example"],
      attrSamples: [{}],
      tier: "standard",
      kind: "cpt_template",
      spec: { blockNames: ["core/paragraph"], acfSchema: null },
    };
  }

  it("declares children as optional (children?:) in the rendered prompt", () => {
    const prompt = cptTemplatePrompt(makeCptEntry(), null);
    // Must contain the optional form, never a bare required `children:`.
    expect(prompt).toMatch(/children\?:\s*React\.ReactNode/);
    // Defensive: no required form (children: not preceded by `?`).
    expect(prompt).not.toMatch(/[^?]children:\s*React\.ReactNode/);
  });

  it("still asks for a layout component named {Cpt}Layout (export-name contract intact)", () => {
    const prompt = cptTemplatePrompt(makeCptEntry(), null);
    expect(prompt).toMatch(/BeerLayout/);
  });

  it("the shared system prompt carries the image binding contract that bans literal placeholder boxes", () => {
    const prompt = cptTemplatePrompt(makeCptEntry(), null);
    expect(prompt).toMatch(/Image binding contract/);
    expect(prompt).toMatch(/do NOT emit a literal placeholder/);
    expect(prompt).toMatch(/Two Roads FeaturedBeer/);
    expect(prompt).toMatch(/post_object\b|relationship/);
  });
});

describe("summarizeAcfFields — image & post-relation annotation", () => {
  it("expands an image-shaped object field with its binding paths", () => {
    const schema = {
      properties: {
        hero_image: {
          type: "object",
          "x-acf-media": { kind: "image", return_format: "array" },
          properties: {
            url: { type: "string" },
            alt: { type: "string" },
            sizes: { type: "object" },
          },
        },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).toMatch(/hero_image: image object/);
    expect(out).toMatch(/hero_image\.url/);
    expect(out).toMatch(/hero_image\.alt/);
    expect(out).toMatch(/hero_image\.sizes/);
  });

  it("detects image shape via structural url+alt siblings even when x-acf-media is absent", () => {
    const schema = {
      properties: {
        logo: {
          type: "object",
          properties: {
            url: { type: "string" },
            alt: { type: "string" },
          },
        },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).toMatch(/logo: image object/);
  });

  it("annotates url-return-format image fields (plain string with vendor extension)", () => {
    const schema = {
      properties: {
        thumbnail: {
          type: "string",
          "x-acf-media": { kind: "image", return_format: "url" },
        },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).toMatch(/thumbnail: image URL/);
  });

  it("annotates a gallery (array of image objects) with the same .url/.alt/.sizes hint", () => {
    const schema = {
      properties: {
        screenshots: {
          type: "array",
          items: {
            type: "object",
            "x-acf-media": { kind: "image", return_format: "array" },
            properties: {
              url: { type: "string" },
              alt: { type: "string" },
              sizes: { type: "object" },
            },
          },
        },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).toMatch(/screenshots: gallery \(array of image objects\)/);
    expect(out).toMatch(/\.url/);
    expect(out).toMatch(/\.sizes/);
  });

  it("annotates a post_object / relationship array as bare-WP_Post-records (the FeaturedBeer smoking gun)", () => {
    // Mirror the Two Roads "beers" field shape from the diagnosis report.
    const schema = {
      properties: {
        beers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ID: { type: "integer" },
              post_title: { type: "string" },
              post_name: { type: "string" },
              post_type: { type: "string" },
              post_date: { type: "string" },
              post_status: { type: "string" },
            },
          },
        },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).toMatch(/beers: array of post records/);
    expect(out).toMatch(/NO featured_image/);
    expect(out).toMatch(/do NOT render a literal placeholder box/);
    // Lists the actual fields so the LLM can type the interface correctly.
    expect(out).toMatch(/post_title/);
  });

  it("leaves unrelated array-of-object fields as plain 'array' (only post-record shape triggers the bare-record annotation)", () => {
    const schema = {
      properties: {
        coordinates: {
          type: "array",
          items: {
            type: "object",
            properties: { lat: { type: "number" }, lng: { type: "number" } },
          },
        },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).toMatch(/coordinates: array/);
    expect(out).not.toMatch(/post records/);
  });

  it("still skips acf_fc_layout discriminators and flexible_content (oneOf) arrays", () => {
    const schema = {
      properties: {
        acf_fc_layout: { type: "string" },
        page_builder: {
          type: "array",
          items: { oneOf: [{ properties: { acf_fc_layout: { const: "hero" } } }] },
        },
        keep_me: { type: "string" },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).not.toMatch(/acf_fc_layout/);
    expect(out).not.toMatch(/page_builder/);
    expect(out).toMatch(/keep_me/);
  });

  it("branches the media object message on kind=file vs kind=image (file_schema has no .sizes)", () => {
    const schema = {
      properties: {
        brochure: {
          type: "object",
          "x-acf-media": { kind: "file", return_format: "array" },
          properties: {
            url: { type: "string" },
            title: { type: "string" },
            filename: { type: "string" },
          },
        },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).toMatch(/brochure: file attachment/);
    // Defense-in-depth: the file branch must NOT carry image-binding
    // directives. The most-distinctive image-branch phrase is "for srcset",
    // which is only meaningful for image_schema (which exposes .sizes).
    // file_schema (Schema.php:641-661) emits no sizes; including srcset
    // guidance for files would mislead the LLM.
    expect(out).not.toMatch(/for srcset/);
    expect(out).not.toMatch(/image object/);
    expect(out).toMatch(/brochure\.filename/);
    // The file branch IS expected to call out the .sizes absence explicitly.
    expect(out).toMatch(/no `\.sizes`/);
  });

  it("requires uppercase ID alongside post_title + post_name before annotating a post-relation array — guards against custom repeaters that reuse post_title/post_name", () => {
    // Hand-authored repeater that happens to use post_title and post_name as
    // content labels but isn't a post relation. Lacking uppercase `ID` (which
    // post_ref_schema always emits) is the disambiguator.
    const schema = {
      properties: {
        testimonials: {
          type: "array",
          items: {
            type: "object",
            properties: {
              post_title: { type: "string" },
              post_name: { type: "string" },
              quote: { type: "string" },
            },
          },
        },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).toMatch(/testimonials: array/);
    expect(out).not.toMatch(/bare WP_Post|NO featured_image/);
  });
});

describe("findPostRelationFieldsInSample — runtime data shape detection (for acf_flex)", () => {
  it("flags top-level array fields whose items look like bare WP_Post records", () => {
    // Mirror the Two Roads FeaturedBeer runtime sample shape.
    const sample = {
      section_headline: "Featured Offerings",
      beers: [
        { ID: 123, post_title: "Workers Comp", post_name: "workers-comp", post_type: "beer" },
        { ID: 124, post_title: "Lil' Heaven", post_name: "lil-heaven", post_type: "beer" },
      ],
      cta_link: { url: "https://example.com", title: "All Beers" },
    };
    expect(findPostRelationFieldsInSample(sample)).toEqual(["beers"]);
  });

  it("returns multiple field names when several post-relation arrays are present", () => {
    const sample = {
      beers: [{ ID: 1, post_title: "x", post_name: "x", post_type: "beer" }],
      events: [{ ID: 2, post_title: "y", post_name: "y", post_type: "event" }],
      headline: "Things",
    };
    expect(findPostRelationFieldsInSample(sample).sort()).toEqual(["beers", "events"]);
  });

  it("returns empty for non-array fields and for arrays of non-post-shaped items", () => {
    expect(
      findPostRelationFieldsInSample({
        title: "x",
        coordinates: [{ lat: 1, lng: 2 }],
        nested: { beers: [{ ID: 1, post_title: "x", post_name: "x" }] }, // only top-level walked
      }),
    ).toEqual([]);
  });

  it("returns empty for empty arrays — no item to inspect", () => {
    expect(findPostRelationFieldsInSample({ beers: [] })).toEqual([]);
  });

  it("returns empty for non-object inputs without throwing", () => {
    expect(findPostRelationFieldsInSample(null)).toEqual([]);
    expect(findPostRelationFieldsInSample(undefined)).toEqual([]);
    expect(findPostRelationFieldsInSample("not an object")).toEqual([]);
    expect(findPostRelationFieldsInSample([1, 2, 3])).toEqual([]);
  });
});

describe("acfFlexPrompt — post-relation warning section", () => {
  function makeAcfFlexEntry(spec: unknown): EnrichedInventoryEntry {
    return {
      blockName: "acf_flex/page/page_builder/featured-beer",
      occurrenceCount: 3,
      pageSlugs: ["home"],
      attrSamples: [],
      tier: "visual",
      kind: "acf_flex",
      sourceDomSample: null,
      computedStyles: null,
      spec,
    } as unknown as EnrichedInventoryEntry;
  }

  it("emits the post-relation warning section when the sample data contains bare WP_Post arrays", () => {
    const sample = {
      section_headline: "Featured Offerings",
      beers: [
        { ID: 123, post_title: "Workers Comp", post_name: "workers-comp", post_type: "beer" },
      ],
    };
    const prompt = acfFlexPrompt(makeAcfFlexEntry(sample), null);
    expect(prompt).toMatch(/Post-relation fields detected in sample/);
    expect(prompt).toMatch(/`beers`/);
    expect(prompt).toMatch(/NO featured_image/);
    expect(prompt).toMatch(/do NOT render literal placeholder boxes/);
  });

  it("omits the post-relation warning section when no post arrays are present", () => {
    const sample = {
      section_headline: "Visit Us",
      address: "123 Main St",
      hours: "9-5",
    };
    const prompt = acfFlexPrompt(makeAcfFlexEntry(sample), null);
    expect(prompt).not.toMatch(/Post-relation fields detected/);
  });
});

describe("component generator — edit guidance placement (R7 cache-leak guard)", () => {
  const GUIDANCE = "Make the hero headline 2x bolder and use the brand yellow.";
  const MARKER = "\n\nUSER:\n";

  function visualEntry(): EnrichedInventoryEntry {
    return {
      blockName: "core/cover",
      occurrenceCount: 4,
      pageSlugs: ["home", "about"],
      attrSamples: [{ url: "x" }],
      tier: "visual",
      kind: "block",
      sourceDomSample: "<div class='wp-block-cover'>hi</div>",
      computedStyles: null,
    };
  }
  function standardEntry(): EnrichedInventoryEntry {
    return { ...visualEntry(), tier: "standard" };
  }
  function trivialEntry(): EnrichedInventoryEntry {
    return { ...visualEntry(), blockName: "core/heading", tier: "trivial" };
  }
  function cptEntry(): EnrichedInventoryEntry {
    return {
      blockName: "cpt_template/beer",
      occurrenceCount: 1,
      pageSlugs: ["beer/x"],
      attrSamples: [{}],
      tier: "standard",
      kind: "cpt_template",
      spec: { blockNames: ["core/paragraph"], acfSchema: null },
    };
  }
  function flexEntry(): EnrichedInventoryEntry {
    return {
      blockName: "acf_flex/page/builder/hero",
      occurrenceCount: 2,
      pageSlugs: ["home"],
      attrSamples: [{ heading: "Hi" }],
      tier: "visual",
      kind: "acf_flex",
      spec: { heading: "Hi" },
    } as unknown as EnrichedInventoryEntry;
  }

  // Each entry of the table is [builderName, builderFn, entryFn].
  const cases: Array<[string, (e: EnrichedInventoryEntry, t: null, g?: string) => string, () => EnrichedInventoryEntry]> = [
    ["visual", visualPrompt, visualEntry],
    ["standard", standardPrompt, standardEntry],
    ["trivial", trivialPrompt, trivialEntry],
    ["cptTemplate", cptTemplatePrompt, cptEntry],
    ["acfFlex", acfFlexPrompt, flexEntry],
  ];

  for (const [name, fn, mk] of cases) {
    it(`${name}: guidance lands strictly AFTER the USER: marker`, () => {
      const withGuidance = fn(mk(), null, GUIDANCE);
      expect(withGuidance).toContain(GUIDANCE);
      const markerIdx = withGuidance.indexOf(MARKER);
      expect(markerIdx).toBeGreaterThan(-1);
      // Guidance must appear only after the marker — never in the system half.
      expect(withGuidance.indexOf(GUIDANCE)).toBeGreaterThan(markerIdx + MARKER.length);
      expect(withGuidance.slice(0, markerIdx)).not.toContain(GUIDANCE);
    });

    it(`${name}: omitting guidance is byte-identical to today`, () => {
      expect(fn(mk(), null)).toBe(fn(mk(), null, undefined));
    });
  }
});
