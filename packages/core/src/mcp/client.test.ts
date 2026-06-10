import { describe, it, expect, vi, afterEach } from "vitest";
import { McpClient, McpClientError } from "./client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Build a minimal valid JSON-RPC success body for an MCP `initialize` response.
 */
function makeInitializeBody(id: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      serverInfo: { name: "test-server", version: "0.0.0" },
    },
  });
}

/**
 * Build a minimal valid JSON-RPC success body for a `tools/call` response.
 * The inner envelope mirrors what mcp-adapter-execute-ability returns.
 */
function makeToolsCallBody(id: number, data: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: true, data }),
        },
      ],
      isError: false,
    },
  });
}

/**
 * Build a Response-like object accepted by the global fetch stub.
 */
function makeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

// ---------------------------------------------------------------------------
// Happy-path session-expiry recovery
// ---------------------------------------------------------------------------

describe("McpClient — session-expiry recovery (404 → re-init → retry)", () => {
  it("recovers from a 404 on tools/call by re-initializing and retrying once", async () => {
    // Scripted response queue:
    // 1. initialize → 200 + session s1
    // 2. notifications/initialized → 202
    // 3. tools/call → 404 (session expired)
    // 4. initialize (retry) → 200 + session s2
    // 5. notifications/initialized → 202
    // 6. tools/call (retry) → 200 with result
    const responses: Response[] = [
      makeResponse(200, makeInitializeBody(1), { "mcp-session-id": "s1" }),
      makeResponse(202, ""),
      makeResponse(404, "Session not found"),
      makeResponse(200, makeInitializeBody(3), { "mcp-session-id": "s2" }),
      makeResponse(202, ""),
      makeResponse(200, makeToolsCallBody(4, { id: 42 })),
    ];

    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const resp = responses[callCount++];
      if (!resp) throw new Error(`Unexpected fetch call #${callCount}`);
      return resp;
    }));

    const client = new McpClient({
      wpUrl: "https://example.com",
      user: "admin",
      password: "test pass",
    });

    const result = await client.callTool<{ id: number }>("jab/get-posts", {});

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ id: 42 });

    // All 6 fetches were consumed
    expect(callCount).toBe(6);

    // The 6th request (index 5) must carry the renewed session id
    const fetchMock = vi.mocked(fetch as unknown as ReturnType<typeof vi.fn>);
    const sixthCallHeaders = (fetchMock.mock.calls[5]![1] as RequestInit)
      .headers as Record<string, string>;
    expect(sixthCallHeaders["Mcp-Session-Id"]).toBe("s2");
  });

  it("rejects with /HTTP 404/ when two consecutive 404s occur (no infinite loop)", async () => {
    // Initial handshake OK, then two consecutive 404s on tools/call.
    const responses: Response[] = [
      makeResponse(200, makeInitializeBody(1), { "mcp-session-id": "s1" }),
      makeResponse(202, ""),
      makeResponse(404, "Session not found"),
      // Second initialize after first 404
      makeResponse(200, makeInitializeBody(3), { "mcp-session-id": "s2" }),
      makeResponse(202, ""),
      // Second tools/call also 404s → should throw, not loop
      makeResponse(404, "Session not found again"),
    ];

    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      const resp = responses[callCount++];
      if (!resp) throw new Error(`Unexpected fetch call #${callCount}`);
      return resp;
    }));

    const client = new McpClient({
      wpUrl: "https://example.com",
      user: "admin",
      password: "test pass",
    });

    await expect(client.callTool("jab/get-posts", {})).rejects.toThrow(/HTTP 404/);
    // All 6 responses consumed (no extra loops)
    expect(callCount).toBe(6);
  });
});
