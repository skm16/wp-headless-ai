import { describe, it, expect, vi, afterEach } from "vitest";
import { McpClient } from "@jab/core";
import { getMenus, JabAbilityError } from "./ability-client";

function mockClient(impl: Partial<McpClient>): McpClient {
  return impl as unknown as McpClient;
}

describe("getMenus", () => {
  it("returns typed menus on the happy path", async () => {
    const client = mockClient({
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "ok" }],
        structuredContent: {
          menus: [
            {
              id: 7,
              slug: "main-menu",
              name: "Main Menu",
              locations: ["primary"],
              items: [
                {
                  id: 12,
                  title: "Home",
                  url: "/",
                  target: "",
                  object_type: "page",
                  object_id: 4,
                  parent_id: 0,
                  order: 1,
                },
              ],
            },
          ],
        },
      }),
    });

    const menus = await getMenus(client);
    expect(menus).toHaveLength(1);
    expect(menus[0].locations).toContain("primary");
    expect(menus[0].items[0].url).toBe("/");
  });

  it("throws JabAbilityError when isError=true", async () => {
    const client = mockClient({
      callTool: vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: "text", text: "permission denied" }],
      }),
    });
    await expect(getMenus(client)).rejects.toMatchObject({
      name: "JabAbilityError",
      code: "ability_call_failed",
    });
  });

  it("throws ability_call_failed when callTool throws", async () => {
    const client = mockClient({
      callTool: vi.fn().mockRejectedValue(new Error("network down")),
    });
    await expect(getMenus(client)).rejects.toMatchObject({
      code: "ability_call_failed",
    });
  });

  it("throws ability_response_invalid for malformed structuredContent", async () => {
    const client = mockClient({
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "ok" }],
        structuredContent: { menus: "not an array" },
      }),
    });
    await expect(getMenus(client)).rejects.toMatchObject({
      code: "ability_response_invalid",
    });
  });
});

import {
  getGlobalStyles,
  getPostBySlug,
  listPostType,
  listPostTypes,
} from "./ability-client";

// We'll set process.env values + mock fetch for REST-backed helpers.
const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

describe("listPostTypes", () => {
  it("fetches /wp-json/jab/v1/content-types and returns typed rows", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          post_types: [
            {
              slug: "page",
              rest_base: "pages",
              plural_label: "Pages",
              singular_label: "Page",
              is_builtin: true,
              hierarchical: true,
              count: 12,
            },
            {
              slug: "beer",
              rest_base: "beers",
              plural_label: "Beers",
              singular_label: "Beer",
              is_builtin: false,
              hierarchical: false,
              count: 47,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const types = await listPostTypes({
      wpUrl: "https://wp.example.com",
      username: "u",
      appPassword: "p",
    });
    expect(types).toHaveLength(2);
    expect(types[0].slug).toBe("page");
    expect(types[1].count).toBe(47);
  });

  it("throws ability_call_failed on non-200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("forbidden", { status: 403 }),
    );
    await expect(
      listPostTypes({ wpUrl: "https://wp.example.com", username: "u", appPassword: "p" }),
    ).rejects.toMatchObject({ code: "ability_call_failed" });
  });

  it("throws ability_response_invalid on malformed body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(
      listPostTypes({ wpUrl: "https://wp.example.com", username: "u", appPassword: "p" }),
    ).rejects.toMatchObject({ code: "ability_response_invalid" });
  });
});

describe("listPostType", () => {
  it("returns the wrapped array for an auto-discovered ability", async () => {
    const client = mockClient({
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "ok" }],
        structuredContent: {
          pages: [
            { id: 1, title: "Home", slug: "home", link: "/", excerpt: "", date: "2025-01-01T00:00:00Z" },
            { id: 2, title: "About", slug: "about", link: "/about", excerpt: "", date: "2025-01-02T00:00:00Z" },
          ],
        },
      }),
    });
    const rows = await listPostType(client, {
      abilityName: "jab/get-pages",
      wrapperKey: "pages",
      numberposts: 100,
    });
    expect(rows).toHaveLength(2);
    expect(rows[1].slug).toBe("about");
  });

  it("throws ability_response_invalid when wrapper key missing", async () => {
    const client = mockClient({
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "ok" }],
        structuredContent: { somethingElse: [] },
      }),
    });
    await expect(
      listPostType(client, {
        abilityName: "jab/get-pages",
        wrapperKey: "pages",
        numberposts: 100,
      }),
    ).rejects.toMatchObject({ code: "ability_response_invalid" });
  });
});

describe("getPostBySlug", () => {
  it("returns the typed record with blocks", async () => {
    const client = mockClient({
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "ok" }],
        structuredContent: {
          page: {
            id: 4,
            title: "Home",
            slug: "home",
            link: "/",
            excerpt: "",
            date: "2025-01-01T00:00:00Z",
            blocks: [
              {
                blockName: "core/heading",
                attrs: { level: 1 },
                innerBlocks: [],
                innerHTML: "<h1>hi</h1>",
                innerContent: ["<h1>hi</h1>"],
              },
            ],
          },
        },
      }),
    });
    const record = await getPostBySlug(client, {
      abilityName: "jab/get-page-by-slug",
      wrapperKey: "page",
      slug: "home",
      includeBlocks: true,
    });
    expect(record).not.toBeNull();
    expect(record!.blocks).toHaveLength(1);
    expect(record!.blocks![0].blockName).toBe("core/heading");
  });

  it("returns null when wrapper value is null (post not found)", async () => {
    const client = mockClient({
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "ok" }],
        structuredContent: { page: null },
      }),
    });
    const r = await getPostBySlug(client, {
      abilityName: "jab/get-page-by-slug",
      wrapperKey: "page",
      slug: "ghost",
      includeBlocks: true,
    });
    expect(r).toBeNull();
  });
});

describe("getGlobalStyles", () => {
  it("returns the parsed settings + styles payload", async () => {
    const mockFetch = vi.fn();
    // First call: /wp/v2/themes?status=active → returns active theme
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify([{ stylesheet: "twentytwentyfour", status: "active" }]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    // Second call: /wp/v2/global-styles/themes/twentytwentyfour → returns settings+styles
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          settings: { color: { palette: [{ slug: "primary", color: "#1a4d2e" }] } },
          styles: { typography: { fontFamily: "Inter" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = mockFetch;
    const styles = await getGlobalStyles({
      wpUrl: "https://wp.example.com",
      username: "u",
      appPassword: "p",
    });
    expect(styles).not.toBeNull();
    expect(styles!.settings).toBeDefined();
  });

  it("returns null on 404 (classic theme, no theme.json)", async () => {
    const mockFetch = vi.fn();
    // themes call succeeds with an active theme
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify([{ stylesheet: "twentytwentyfour", status: "active" }]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    // global-styles call → 404 (classic theme, no theme.json)
    mockFetch.mockResolvedValueOnce(
      new Response("not found", { status: 404 }),
    );
    globalThis.fetch = mockFetch;
    const styles = await getGlobalStyles({
      wpUrl: "https://wp.example.com",
      username: "u",
      appPassword: "p",
    });
    expect(styles).toBeNull();
  });
});

import { resolveCptAbilityMeta } from "./ability-client";
import type { Manifest } from "@jab/core";

describe("resolveCptAbilityMeta", () => {
  const manifest = {
    plugin_version: "0.6.0",
    generated_at: "2026-01-01T00:00:00Z",
    abilities: [
      {
        name: "jab/get-pages",
        category: "jab-content",
        label: "Get Pages",
        description: "",
        input_schema: {},
        output_schema: {
          type: "object",
          required: ["pages"],
          properties: { pages: { type: "array" } },
        },
        meta: {},
      },
      {
        name: "jab/get-page-by-slug",
        category: "jab-content",
        label: "Get Page By Slug",
        description: "",
        input_schema: {},
        output_schema: {
          type: "object",
          required: ["page"],
          properties: { page: {} },
        },
        meta: {},
      },
    ],
  } as unknown as Manifest;

  it("resolves the list + by-slug ability pair from rest_base", () => {
    const meta = resolveCptAbilityMeta(manifest, { slug: "page", rest_base: "pages" });
    expect(meta.listAbilityName).toBe("jab/get-pages");
    expect(meta.listWrapperKey).toBe("pages");
    expect(meta.bySlugAbilityName).toBe("jab/get-page-by-slug");
    expect(meta.bySlugWrapperKey).toBe("page");
  });

  it("falls back to slug-based naming when manifest lookup misses", () => {
    const meta = resolveCptAbilityMeta(null, { slug: "beer", rest_base: "beers" });
    expect(meta.listAbilityName).toBe("jab/get-beers");
    expect(meta.listWrapperKey).toBe("beers");
    expect(meta.bySlugAbilityName).toBe("jab/get-beer-by-slug");
    expect(meta.bySlugWrapperKey).toBe("beer");
  });
});
