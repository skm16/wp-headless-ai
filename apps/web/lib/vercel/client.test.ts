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

describe("VercelClient — listEnvVars", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the env list", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        envs: [
          { id: "env_a", key: "WP_URL", value: "https://x", type: "encrypted", target: ["production"] },
          { id: "env_b", key: "WP_USER", value: "admin", type: "encrypted", target: ["production"] },
        ],
      }),
    });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    const result = await client.listEnvVars("prj_aaa");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: "env_a", key: "WP_URL" });
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/v9/projects/prj_aaa/env");
    expect(url).toContain("teamId=team_x");
  });

  it("returns empty array when env list is empty", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ envs: [] }) });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    const result = await client.listEnvVars("prj_aaa");
    expect(result).toEqual([]);
  });
});

describe("VercelClient — createEnvVar", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs new env var with target=production", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "env_new", key: "WP_URL" }),
    });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    await client.createEnvVar("prj_aaa", "WP_URL", "https://wp.example");
    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      key: "WP_URL",
      value: "https://wp.example",
      type: "encrypted",
      target: ["production"],
    });
  });
});

describe("VercelClient — updateEnvVar", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes the existing env var by id", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "env_a", key: "WP_URL" }),
    });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    await client.updateEnvVar("prj_aaa", "env_a", "https://new.wp");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/v9/projects/prj_aaa/env/env_a");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      value: "https://new.wp",
      type: "encrypted",
      target: ["production"],
    });
  });
});
