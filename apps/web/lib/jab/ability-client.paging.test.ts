import { describe, it, expect } from "vitest";
import { listAllPostType } from "./ability-client";
import type { McpClient } from "@jab/core";

function fakeClient(pages: Record<number, unknown[]>): McpClient {
  return {
    async callTool(_name: string, args: Record<string, unknown>) {
      const page = (args.page as number) ?? 1;
      return { isError: false, structuredContent: { posts: pages[page] ?? [] } };
    },
  } as unknown as McpClient;
}

const row = (id: number) => ({
  id,
  title: `t${id}`,
  slug: `s${id}`,
  link: "",
  date: "",
  excerpt: "",
  modified: "",
  modified_gmt: "",
});

describe("listAllPostType", () => {
  it("pages until a short page is returned and concatenates rows", async () => {
    const full = Array.from({ length: 100 }, (_, i) => row(i));
    const client = fakeClient({ 1: full, 2: full, 3: [row(999)] });
    const { rows, truncated } = await listAllPostType(client, {
      abilityName: "jab/get-posts",
      wrapperKey: "posts",
      numberposts: 100,
    });
    expect(rows.length).toBe(201);
    expect(truncated).toBe(false);
  });

  it("stops and flags truncated at maxPages", async () => {
    const full = Array.from({ length: 100 }, (_, i) => row(i));
    const client = fakeClient({ 1: full, 2: full, 3: full });
    const { rows, truncated } = await listAllPostType(client, {
      abilityName: "jab/get-posts",
      wrapperKey: "posts",
      numberposts: 100,
      maxPages: 2,
    });
    expect(rows.length).toBe(200);
    expect(truncated).toBe(true);
  });

  it("returns a single short page without extra calls", async () => {
    const client = fakeClient({ 1: [row(1), row(2)] });
    const { rows, truncated } = await listAllPostType(client, {
      abilityName: "jab/get-posts",
      wrapperKey: "posts",
      numberposts: 100,
    });
    expect(rows.length).toBe(2);
    expect(truncated).toBe(false);
  });
});
