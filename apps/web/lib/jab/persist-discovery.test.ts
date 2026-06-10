// apps/web/lib/jab/persist-discovery.test.ts
import { describe, it, expect, vi } from "vitest";

// Mock the admin client at the boundary. We assert on the chained call
// shape: from("block_inventory").upsert(...).select(...).
const fromMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: fromMock }),
}));

import { persistInventory, persistPages, toPageInventoryRow } from "./persist-discovery";
import type { InventoryEntry } from "./inventory";
import type { PageDiscoveryResult } from "./discovery-types";
import type { Paradigm } from "./paradigm-detection";

describe("toPageInventoryRow", () => {
  it("maps source_modified_gmt onto the upsert row, defaulting null", () => {
    const base = {
      slug: "home",
      post_type: "page",
      title: "Home",
      route_path: "/home",
      block_count: 3,
      paradigms: [] as Paradigm[],
      discovery: {
        slug: "home",
        post_type: "page",
        screenshotPaths: {},
        blockCapturesByViewport: {},
      } as unknown as PageDiscoveryResult,
    };
    expect(toPageInventoryRow({ ...base, sourceModifiedGmt: "2026-06-01T00:00:00Z" }, "b1", "p1").source_modified_gmt)
      .toBe("2026-06-01T00:00:00Z");
    expect(toPageInventoryRow(base, "b1", "p1").source_modified_gmt).toBeNull();
  });

  it("writes block_tree when present and null when absent (migration 0027)", () => {
    const base = {
      slug: "about",
      post_type: "page",
      title: "About",
      route_path: "/about",
      block_count: 3,
      paradigms: [] as Paradigm[],
      discovery: {
        slug: "about",
        post_type: "page",
        screenshotPaths: {},
        blockCapturesByViewport: {},
      } as unknown as PageDiscoveryResult,
    };
    const tree = [{ blockName: "core/heading", attrs: {}, innerBlocks: [], innerHTML: "", innerContent: [] }];
    expect(toPageInventoryRow({ ...base, blockTree: tree }, "b1", "p1").block_tree).toEqual(tree);
    expect(toPageInventoryRow(base, "b1", "p1").block_tree).toBeNull();
  });

  it("persists link when provided and null when absent (migration 0033)", () => {
    const base = {
      slug: "contact",
      post_type: "page",
      title: "Contact",
      route_path: "/contact",
      block_count: 2,
      paradigms: [] as Paradigm[],
      discovery: {
        slug: "contact",
        post_type: "page",
        screenshotPaths: {},
        blockCapturesByViewport: {},
      } as unknown as PageDiscoveryResult,
    };
    expect(toPageInventoryRow({ ...base, link: "https://example.com/contact/" }, "b1", "p1").link)
      .toBe("https://example.com/contact/");
    expect(toPageInventoryRow({ ...base, link: null }, "b1", "p1").link).toBeNull();
    expect(toPageInventoryRow(base, "b1", "p1").link).toBeNull();
  });
});

describe("persistInventory", () => {
  it("upserts each inventory row with project_id + site_build_id but no tenant_id column", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });

    const entries: InventoryEntry[] = [
      {
        blockName: "core/heading",
        occurrenceCount: 5,
        pageSlugs: ["home", "about"],
        attrSamples: [{ level: 1 }, { level: 2 }],
        tier: "trivial",
      },
    ];
    await persistInventory({
      buildId: "b1",
      projectId: "p1",
      entries,
      computedStylesByBlockName: { "core/heading": { median: { fontSize: "32px" } } },
    });

    expect(fromMock).toHaveBeenCalledWith("block_inventory");
    expect(upsert).toHaveBeenCalledOnce();
    const upsertedRow = upsert.mock.calls[0][0][0];
    expect(upsertedRow.project_id).toBe("p1");
    expect(upsertedRow.site_build_id).toBe("b1");
    expect(upsertedRow).not.toHaveProperty("tenant_id");
    expect(upsertedRow.block_name).toBe("core/heading");
    expect(upsertedRow.occurrence_count).toBe(5);
    expect(upsertedRow.tier).toBe("trivial");
    expect(upsertedRow.computed_styles).toEqual({ median: { fontSize: "32px" } });
  });

  it("skips persistence when entries is empty", async () => {
    fromMock.mockClear();
    await persistInventory({
      buildId: "b1",
      projectId: "p1",
      entries: [],
      computedStylesByBlockName: {},
    });
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe("persistPages", () => {
  it("upserts page_inventory rows with route_path + screenshot paths", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });

    const pages: Array<{
      slug: string;
      post_type: string;
      title: string;
      route_path: string;
      block_count: number;
      paradigms: Paradigm[];
      discovery: PageDiscoveryResult;
    }> = [
      {
        slug: "home",
        post_type: "page",
        title: "Home",
        route_path: "/",
        block_count: 7,
        paradigms: ["gutenberg"],
        discovery: {
          slug: "home",
          post_type: "page",
          screenshotPaths: { "375": "p.png", "768": "p.png", "1280": "p.png" },
          blockCapturesByViewport: { "375": [], "768": [], "1280": [] },
        },
      },
    ];

    await persistPages({ buildId: "b1", projectId: "p1", pages });
    const row = upsert.mock.calls[0][0][0];
    expect(row).not.toHaveProperty("tenant_id");
    expect(row.project_id).toBe("p1");
    expect(row.route_path).toBe("/");
    expect(row.source_screenshot_paths).toEqual({
      source: { "375": "p.png", "768": "p.png", "1280": "p.png" },
    });
    expect(row.block_count).toBe(7);
    expect(row.paradigms).toEqual(["gutenberg"]);
  });

  it("writes multi-paradigm page rows preserving render order", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });

    const pages: Array<{
      slug: string;
      post_type: string;
      title: string;
      route_path: string;
      block_count: number;
      paradigms: Paradigm[];
      discovery: PageDiscoveryResult;
    }> = [
      {
        slug: "about",
        post_type: "page",
        title: "About",
        route_path: "/about",
        block_count: 12,
        paradigms: ["acf_flex", "acf_template", "gutenberg"],
        discovery: {
          slug: "about",
          post_type: "page",
          screenshotPaths: { "375": "a.png", "768": "a.png", "1280": "a.png" },
          blockCapturesByViewport: { "375": [], "768": [], "1280": [] },
        },
      },
    ];

    await persistPages({ buildId: "b2", projectId: "p2", pages });
    const row = upsert.mock.calls[0][0][0];
    expect(row.paradigms).toEqual(["acf_flex", "acf_template", "gutenberg"]);
    expect(row.slug).toBe("about");
    expect(row.block_count).toBe(12);
  });
});
