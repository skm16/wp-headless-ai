import { describe, it, expect, vi } from "vitest";
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
