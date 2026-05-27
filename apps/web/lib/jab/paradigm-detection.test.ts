import { describe, it, expect } from "vitest";
import { findFlexibleContentFieldNames } from "./paradigm-detection";

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
