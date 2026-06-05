import { describe, it, expect } from "vitest";
import {
  cptListMetaFromManifest,
  detectDynamicList,
  dynamicListSpecsFromInventory,
} from "./dynamic-list-detect";
import type { Manifest } from "@jab/core";

const manifest = (abilities: Manifest["abilities"]): Manifest => ({
  schemaVersion: 1,
  source: "x",
  fetchedAt: "x",
  server: { namespace: "jab", route: "/wp-json/jab/v1" },
  abilities,
});

describe("cptListMetaFromManifest", () => {
  it("derives postType/listAbility/wrapperKey/dateField for a CPT with a start-date ACF field", () => {
    const m = manifest([
      {
        name: "jab/get-event",
        label: "",
        description: "",
        inputSchema: {},
        outputSchema: {
          type: "object",
          properties: {
            event: {
              type: "object",
              properties: {
                acf: {
                  type: "object",
                  properties: {
                    address: { type: "string" },
                    start_date__time: { type: "string" },
                    end_date__time: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    ]);
    expect(cptListMetaFromManifest(m)).toEqual([
      { postType: "event", listAbility: "jab/get-event", wrapperKey: "event", dateField: "start_date__time" },
    ]);
  });

  it("ignores by-slug + term abilities and CPTs with no date field get dateField null", () => {
    const m = manifest([
      { name: "jab/get-event-by-slug", label: "", description: "", inputSchema: {}, outputSchema: {} },
      { name: "jab/get-team-member-category-terms", label: "", description: "", inputSchema: {}, outputSchema: {} },
      {
        name: "jab/get-team-member",
        label: "",
        description: "",
        inputSchema: {},
        outputSchema: {
          type: "object",
          properties: {
            "team-member": {
              type: "object",
              properties: { acf: { type: "object", properties: { bio: { type: "string" } } } },
            },
          },
        },
      },
    ]);
    expect(cptListMetaFromManifest(m)).toEqual([
      { postType: "team-member", listAbility: "jab/get-team-member", wrapperKey: "team-member", dateField: null },
    ]);
  });
});

const EVENT_META = {
  postType: "event",
  listAbility: "jab/get-event",
  wrapperKey: "event",
  dateField: "start_date__time",
};

describe("detectDynamicList", () => {
  it("flags a config-only events layout that links to the CPT archive", () => {
    const spec = detectDynamicList({
      blockName: "acf_flex/page/page_builder/upcoming_events",
      attrSample: {
        acf_fc_layout: "upcoming_events",
        section_headline: "Upcoming Events",
        view_all_link: { url: "https://x.com/events/" },
      },
      cpts: [EVENT_META],
    });
    expect(spec).toEqual({
      blockName: "acf_flex/page/page_builder/upcoming_events",
      listAbility: "jab/get-event",
      wrapperKey: "event",
      postType: "event",
      dateField: "start_date__time",
      order: "asc",
      upcomingOnly: true,
      limit: 12,
    });
  });

  it("matches by layout-name token when there is no archive link", () => {
    const spec = detectDynamicList({
      blockName: "acf_flex/page/page_builder/events",
      attrSample: { acf_fc_layout: "events", section_headline: "Upcoming Two Roads Events" },
      cpts: [EVENT_META],
    });
    expect(spec?.listAbility).toBe("jab/get-event");
  });

  it("returns null when the layout already carries an inline item array (static, not a placeholder)", () => {
    expect(
      detectDynamicList({
        blockName: "acf_flex/page/page_builder/featured_beers",
        attrSample: { acf_fc_layout: "featured_beers", beers: [{ ID: 1, post_title: "IPA", post_name: "ipa" }] },
        cpts: [{ postType: "beer", listAbility: "jab/get-beer", wrapperKey: "beer", dateField: null }],
      }),
    ).toBeNull();
  });

  it("returns null when no CPT matches the layout name or link", () => {
    expect(
      detectDynamicList({
        blockName: "acf_flex/page/page_builder/newsletter",
        attrSample: { acf_fc_layout: "newsletter", heading: "Sign up" },
        cpts: [EVENT_META],
      }),
    ).toBeNull();
  });

  it("sets upcomingOnly false / order desc when the matched CPT has no date field (recent-list fallback)", () => {
    const spec = detectDynamicList({
      blockName: "acf_flex/page/page_builder/team",
      attrSample: { acf_fc_layout: "team", view_all_link: { url: "/team-member/" } },
      cpts: [{ postType: "team-member", listAbility: "jab/get-team-member", wrapperKey: "team-member", dateField: null }],
    });
    expect(spec).toMatchObject({
      listAbility: "jab/get-team-member",
      dateField: null,
      upcomingOnly: false,
      order: "desc",
    });
  });
});

describe("dynamicListSpecsFromInventory", () => {
  it("flags acf_flex rows that map to a CPT list", () => {
    const m = manifest([
      {
        name: "jab/get-event",
        label: "",
        description: "",
        inputSchema: {},
        outputSchema: {
          type: "object",
          properties: {
            event: {
              type: "object",
              properties: {
                acf: { type: "object", properties: { start_date__time: { type: "string" } } },
              },
            },
          },
        },
      },
    ]);
    const rows = [
      {
        block_name: "acf_flex/page/page_builder/upcoming_events",
        kind: "acf_flex",
        spec: { acf_fc_layout: "upcoming_events", view_all_link: { url: "/events/" } },
      },
      { block_name: "acf_flex/page/page_builder/newsletter", kind: "acf_flex", spec: { acf_fc_layout: "newsletter" } },
      { block_name: "core/paragraph", kind: "block", spec: null },
    ];
    const specs = dynamicListSpecsFromInventory(rows, m);
    expect(specs.map((s) => s.blockName)).toEqual(["acf_flex/page/page_builder/upcoming_events"]);
  });
});
