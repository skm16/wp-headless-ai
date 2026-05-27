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
