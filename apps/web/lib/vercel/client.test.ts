import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VercelClient, VercelApiError } from "./client";

describe("VercelClient — constructor", () => {
  it("throws when token is empty", () => {
    expect(() => new VercelClient({ token: "", teamId: "team_x" })).toThrow(/token/);
  });
  it("throws when teamId is empty", () => {
    expect(() => new VercelClient({ token: "t", teamId: "" })).toThrow(/teamId/);
  });
});

describe("VercelClient — getProjectByName", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the matching project when one exists", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        projects: [
          { id: "prj_aaa", name: "two-roads-brewing-new", framework: "nextjs" },
        ],
      }),
    });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    const result = await client.getProjectByName("two-roads-brewing-new");
    expect(result).toEqual({ id: "prj_aaa", name: "two-roads-brewing-new" });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/v10/projects");
    expect(url).toContain("search=two-roads-brewing-new");
    expect(url).toContain("teamId=team_x");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("returns null when no projects match", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ projects: [] }) });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    const result = await client.getProjectByName("nope");
    expect(result).toBeNull();
  });

  it("throws VercelApiError on non-2xx", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '{"error":{"message":"Unauthorized"}}',
    });
    const client = new VercelClient({ token: "bad", teamId: "team_x" });
    await expect(client.getProjectByName("x")).rejects.toThrow(VercelApiError);
  });
});

describe("VercelClient — createProject", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the new project and returns id+name", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "prj_new", name: "two-roads-brewing-new" }),
    });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    const result = await client.createProject("two-roads-brewing-new");
    expect(result).toEqual({ id: "prj_new", name: "two-roads-brewing-new" });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/v11/projects");
    expect(url).toContain("teamId=team_x");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      name: "two-roads-brewing-new",
      framework: "nextjs",
    });
  });
});
