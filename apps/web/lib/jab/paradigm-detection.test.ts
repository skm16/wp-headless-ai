import { describe, it, expect } from "vitest";
import { findFlexibleContentFieldNames, extractCptAcfSchema } from "./paradigm-detection";
import type { Manifest } from "@jab/core";

describe("findFlexibleContentFieldNames", () => {
  it("returns empty array for null schema", () => {
    expect(findFlexibleContentFieldNames(null)).toEqual([]);
  });

  it("returns empty array for schema with no properties", () => {
    expect(findFlexibleContentFieldNames({ type: "object" })).toEqual([]);
  });

  it("returns empty array when no field looks like flexible_content", () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
        count: { type: "number" },
      },
    };
    expect(findFlexibleContentFieldNames(schema)).toEqual([]);
  });

  it("detects single-layout flex (items is the variant directly)", () => {
    const schema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: {
            type: "object",
            required: ["acf_fc_layout"],
            properties: {
              acf_fc_layout: { type: "string", enum: ["hero"] },
              heading: { type: "string" },
            },
          },
        },
      },
    };
    expect(findFlexibleContentFieldNames(schema)).toEqual(["sections"]);
  });

  it("detects multi-layout flex (items.oneOf)", () => {
    const schema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: {
            oneOf: [
              {
                type: "object",
                required: ["acf_fc_layout"],
                properties: { acf_fc_layout: { type: "string", enum: ["hero"] } },
              },
              {
                type: "object",
                required: ["acf_fc_layout"],
                properties: { acf_fc_layout: { type: "string", enum: ["cta"] } },
              },
            ],
          },
        },
      },
    };
    expect(findFlexibleContentFieldNames(schema)).toEqual(["sections"]);
  });

  it("detects multiple flex fields on the same CPT", () => {
    const schema = {
      type: "object",
      properties: {
        sidebar: {
          type: "array",
          items: { type: "object", properties: { acf_fc_layout: { enum: ["link_list"] } } },
        },
        sections: {
          type: "array",
          items: { type: "object", properties: { acf_fc_layout: { enum: ["hero"] } } },
        },
      },
    };
    expect(findFlexibleContentFieldNames(schema).sort()).toEqual(["sections", "sidebar"]);
  });

  it("ignores arrays that aren't flexible_content", () => {
    const schema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        related: { type: "array", items: { type: "object", properties: { id: { type: "integer" } } } },
      },
    };
    expect(findFlexibleContentFieldNames(schema)).toEqual([]);
  });
});

const makeManifestAbility = (
  name: string,
  wrapperKey: string,
  itemProperties: Record<string, unknown>,
): Manifest["abilities"][number] => ({
  name,
  label: name,
  description: "",
  inputSchema: {},
  outputSchema: {
    type: "object",
    required: [wrapperKey],
    properties: {
      [wrapperKey]: {
        oneOf: [
          { type: "object", properties: itemProperties },
          { type: "null" },
        ],
      },
    },
  },
});

const makeManifest = (abilities: Manifest["abilities"]): Manifest => ({
  schemaVersion: 1,
  source: "https://example.test",
  fetchedAt: new Date().toISOString(),
  server: { namespace: "jab", route: "/wp-json/jab/v1" },
  abilities,
});

describe("extractCptAcfSchema", () => {
  it("returns null when manifest is null", () => {
    expect(extractCptAcfSchema(null, { bySlugAbilityName: "jab/get-beer-by-slug", bySlugWrapperKey: "beer" })).toBeNull();
  });

  it("returns null when ability is not in manifest", () => {
    const manifest = makeManifest([makeManifestAbility("jab/get-beer-by-slug", "beer", { id: { type: "integer" } })]);
    expect(
      extractCptAcfSchema(manifest, { bySlugAbilityName: "jab/get-event-by-slug", bySlugWrapperKey: "event" }),
    ).toBeNull();
  });

  it("returns null when item properties lack an acf key", () => {
    const manifest = makeManifest([makeManifestAbility("jab/get-beer-by-slug", "beer", { id: { type: "integer" } })]);
    expect(extractCptAcfSchema(manifest, { bySlugAbilityName: "jab/get-beer-by-slug", bySlugWrapperKey: "beer" })).toBeNull();
  });

  it("extracts the acf schema from a properly-shaped ability", () => {
    const acfSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        abv: { type: "number" },
        ibu: { type: "number" },
      },
    };
    const manifest = makeManifest([
      makeManifestAbility("jab/get-beer-by-slug", "beer", { id: { type: "integer" }, acf: acfSchema }),
    ]);
    expect(
      extractCptAcfSchema(manifest, { bySlugAbilityName: "jab/get-beer-by-slug", bySlugWrapperKey: "beer" }),
    ).toEqual(acfSchema);
  });

  it("returns null when oneOf has no non-null variant", () => {
    const manifest: Manifest = {
      schemaVersion: 1,
      source: "https://example.test",
      fetchedAt: new Date().toISOString(),
      server: { namespace: "jab", route: "/wp-json/jab/v1" },
      abilities: [
        {
          name: "jab/get-beer-by-slug",
          label: "",
          description: "",
          inputSchema: {},
          outputSchema: {
            type: "object",
            required: ["beer"],
            properties: { beer: { oneOf: [{ type: "null" }] } },
          },
        },
      ],
    };
    expect(extractCptAcfSchema(manifest, { bySlugAbilityName: "jab/get-beer-by-slug", bySlugWrapperKey: "beer" })).toBeNull();
  });

  it("returns null when ability has no outputSchema", () => {
    const manifest: Manifest = {
      schemaVersion: 1,
      source: "https://example.test",
      fetchedAt: new Date().toISOString(),
      server: { namespace: "jab", route: "/wp-json/jab/v1" },
      abilities: [{ name: "jab/get-beer-by-slug", label: "", description: "", inputSchema: {} }],
    };
    expect(
      extractCptAcfSchema(manifest, { bySlugAbilityName: "jab/get-beer-by-slug", bySlugWrapperKey: "beer" }),
    ).toBeNull();
  });

  it("returns null when wrapper key is missing from outputSchema.properties", () => {
    const manifest = makeManifest([makeManifestAbility("jab/get-beer-by-slug", "beer", { id: { type: "integer" } })]);
    expect(
      extractCptAcfSchema(manifest, { bySlugAbilityName: "jab/get-beer-by-slug", bySlugWrapperKey: "wrong_key" }),
    ).toBeNull();
  });

  it("returns null when wrapper exists but has no oneOf", () => {
    const manifest: Manifest = {
      schemaVersion: 1,
      source: "https://example.test",
      fetchedAt: new Date().toISOString(),
      server: { namespace: "jab", route: "/wp-json/jab/v1" },
      abilities: [{
        name: "jab/get-beer-by-slug",
        label: "",
        description: "",
        inputSchema: {},
        outputSchema: { type: "object", properties: { beer: { type: "object" } } },
      }],
    };
    expect(
      extractCptAcfSchema(manifest, { bySlugAbilityName: "jab/get-beer-by-slug", bySlugWrapperKey: "beer" }),
    ).toBeNull();
  });
});

import { detectParadigms } from "./paradigm-detection";

const makePost = (overrides: Partial<{
  blocks: Array<{ blockName: string | null; attrs: Record<string, unknown>; innerBlocks: unknown[]; innerHTML: string; innerContent: (string | null)[] }>;
  acf: Record<string, unknown> | undefined;
}> = {}) => ({
  id: 1,
  title: "X",
  slug: "x",
  link: "https://example.test/x",
  date: "2026-05-27T00:00:00Z",
  excerpt: "",
  blocks: overrides.blocks,
  acf: overrides.acf,
}) as Parameters<typeof detectParadigms>[0];

describe("detectParadigms", () => {
  it("returns ['unknown'] when no signal fires", () => {
    expect(detectParadigms(makePost({ blocks: [], acf: undefined }), null)).toEqual(["unknown"]);
  });

  it("returns ['gutenberg'] for a post with typed blocks", () => {
    expect(
      detectParadigms(
        makePost({
          blocks: [
            { blockName: "core/heading", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] },
          ],
        }),
        null,
      ),
    ).toEqual(["gutenberg"]);
  });

  it("returns ['classic'] for a single __null__ block with HTML", () => {
    expect(
      detectParadigms(
        makePost({
          blocks: [
            { blockName: null, attrs: {}, innerBlocks: [], innerHTML: "<p>hi</p>", innerContent: ["<p>hi</p>"] },
          ],
        }),
        null,
      ),
    ).toEqual(["classic"]);
  });

  it("returns ['gutenberg'] when typed blocks coexist with __null__ (classic suppressed)", () => {
    expect(
      detectParadigms(
        makePost({
          blocks: [
            { blockName: "core/heading", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] },
            { blockName: null, attrs: {}, innerBlocks: [], innerHTML: "<p>...</p>", innerContent: [] },
          ],
        }),
        null,
      ),
    ).toEqual(["gutenberg"]);
  });

  it("returns ['unknown'] when blocks is a single empty __null__ (no innerHTML)", () => {
    expect(
      detectParadigms(
        makePost({
          blocks: [
            { blockName: null, attrs: {}, innerBlocks: [], innerHTML: "   ", innerContent: [] },
          ],
        }),
        null,
      ),
    ).toEqual(["unknown"]);
  });

  it("returns ['acf_template'] for ACF data with no flex fields and no blocks", () => {
    const cptSchema = {
      type: "object",
      properties: { abv: { type: "number" }, name: { type: "string" } },
    };
    expect(
      detectParadigms(
        makePost({ blocks: [], acf: { abv: 5.5, name: "IPA" } }),
        cptSchema,
      ),
    ).toEqual(["acf_template"]);
  });

  it("returns ['acf_flex'] when ACF flex field has entries", () => {
    const cptSchema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: { type: "object", properties: { acf_fc_layout: { enum: ["hero"] } } },
        },
      },
    };
    expect(
      detectParadigms(
        makePost({ blocks: [], acf: { sections: [{ acf_fc_layout: "hero", heading: "Hi" }] } }),
        cptSchema,
      ),
    ).toEqual(["acf_flex"]);
  });

  it("returns ['acf_flex', 'acf_template'] for hybrid ACF (flex + non-flex fields)", () => {
    const cptSchema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: { type: "object", properties: { acf_fc_layout: { enum: ["hero"] } } },
        },
        footer_text: { type: "string" },
      },
    };
    expect(
      detectParadigms(
        makePost({ blocks: [], acf: { sections: [{ acf_fc_layout: "hero" }], footer_text: "© 2026" } }),
        cptSchema,
      ),
    ).toEqual(["acf_flex", "acf_template"]);
  });

  it("ACF paradigms come before gutenberg in the array", () => {
    const cptSchema = {
      type: "object",
      properties: { hero_text: { type: "string" } },
    };
    expect(
      detectParadigms(
        makePost({
          blocks: [
            { blockName: "core/paragraph", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] },
          ],
          acf: { hero_text: "Welcome" },
        }),
        cptSchema,
      ),
    ).toEqual(["acf_template", "gutenberg"]);
  });

  it("does NOT classify ACF when all values are null/empty", () => {
    const cptSchema = {
      type: "object",
      properties: { hero_text: { type: "string" }, sections: { type: "array" } },
    };
    expect(
      detectParadigms(
        makePost({ blocks: [], acf: { hero_text: "", sections: [] } }),
        cptSchema,
      ),
    ).toEqual(["unknown"]);
  });

  it("does NOT classify acf_flex when the flex array is empty", () => {
    const cptSchema = {
      type: "object",
      properties: {
        sections: {
          type: "array",
          items: { type: "object", properties: { acf_fc_layout: { enum: ["hero"] } } },
        },
      },
    };
    expect(
      detectParadigms(
        makePost({ blocks: [], acf: { sections: [] } }),
        cptSchema,
      ),
    ).toEqual(["unknown"]);
  });

  it("CPT with no ACF schema in manifest can still classify gutenberg", () => {
    expect(
      detectParadigms(
        makePost({
          blocks: [
            { blockName: "core/heading", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] },
          ],
          acf: undefined,
        }),
        null,
      ),
    ).toEqual(["gutenberg"]);
  });
});
