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

  it("POSTs new env var with target=[production, preview] so preview builds can read it", async () => {
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
      target: ["production", "preview"],
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

  it("PATCHes the existing env var by id with target=[production, preview]", async () => {
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
      target: ["production", "preview"],
    });
  });
});

describe("VercelClient — createDeployment", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs files inline (preview by default — no target in body) and returns deployment metadata", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: "dpl_xxx",
        url: "two-roads-brewing-new-bxk2j9.vercel.app",
        readyState: "QUEUED",
      }),
    });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    const result = await client.createDeployment({
      projectId: "prj_aaa",
      name: "two-roads-brewing-new",
      files: [
        { file: "package.json", data: '{"name":"x"}', encoding: "utf-8" },
        { file: "app/page.tsx", data: "export default function P(){}", encoding: "utf-8" },
      ],
    });
    expect(result).toEqual({
      id: "dpl_xxx",
      url: "two-roads-brewing-new-bxk2j9.vercel.app",
      readyState: "QUEUED",
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/v13/deployments");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.name).toBe("two-roads-brewing-new");
    expect(body.project).toBe("prj_aaa");
    // Preview is the default: target must NOT be in the body. Vercel
    // treats a body without `target` as a Preview deployment.
    expect(body.target).toBeUndefined();
    expect(body.projectSettings).toEqual({ framework: "nextjs" });
    expect(body.files).toHaveLength(2);
  });

  it("includes target='production' in the body only when explicitly requested", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "dpl_prod", url: "x.vercel.app", readyState: "QUEUED" }),
    });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    await client.createDeployment({
      projectId: "prj_aaa",
      name: "x",
      files: [{ file: "package.json", data: "{}", encoding: "utf-8" }],
      target: "production",
    });
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.target).toBe("production");
  });

  it("omits target when caller explicitly passes target='preview'", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "dpl_prev", url: "x.vercel.app", readyState: "QUEUED" }),
    });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    await client.createDeployment({
      projectId: "prj_aaa",
      name: "x",
      files: [{ file: "package.json", data: "{}", encoding: "utf-8" }],
      target: "preview",
    });
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.target).toBeUndefined();
  });

  it("throws when total file body exceeds 4MB", async () => {
    const big = "x".repeat(5_000_000); // 5MB
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    await expect(
      client.createDeployment({
        projectId: "prj_aaa",
        name: "huge",
        files: [{ file: "big.txt", data: big, encoding: "utf-8" }],
      }),
    ).rejects.toThrow(/4MB|SHA upload/i);
  });
});

describe("VercelClient — redeployToProduction", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs /v13/deployments with deploymentId + target=production, forceNew, auth + teamId", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: "dpl_prod",
        url: "two-roads-abc.vercel.app",
        readyState: "QUEUED",
      }),
    });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    const result = await client.redeployToProduction({
      projectId: "prj_aaa",
      name: "two-roads",
      deploymentId: "dpl_preview",
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/v13/deployments");
    expect(url).toContain("teamId=team_x");
    expect(url).toContain("forceNew=1");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer tok",
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      name: "two-roads",
      project: "prj_aaa",
      deploymentId: "dpl_preview",
      target: "production",
    });
    expect(result).toEqual({
      id: "dpl_prod",
      url: "two-roads-abc.vercel.app",
      readyState: "QUEUED",
    });
  });

  it("throws VercelApiError on non-2xx (e.g. 404 unknown deployment)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => '{"error":{"message":"Deployment not found"}}',
    });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    await expect(
      client.redeployToProduction({
        projectId: "prj_aaa",
        name: "two-roads",
        deploymentId: "dpl_bogus",
      }),
    ).rejects.toThrow(VercelApiError);
  });
});

describe("VercelClient — getDeployment", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns deployment with current readyState", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: "dpl_xxx",
        url: "x.vercel.app",
        readyState: "READY",
      }),
    });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    const result = await client.getDeployment("dpl_xxx");
    expect(result.readyState).toBe("READY");
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/v13/deployments/dpl_xxx");
  });
});

describe("VercelClient — getDeploymentEvents", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns event text concatenated chronologically (top-level shape — Vercel's actual response)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { type: "stdout", created: 1, text: "Installing dependencies" },
        { type: "stdout", created: 2, text: "Building" },
        { type: "stderr", created: 3, text: "Error: tsc failed" },
      ],
    });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    const text = await client.getDeploymentEvents("dpl_xxx");
    expect(text).toBe("Installing dependencies\nBuilding\nError: tsc failed");
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/v3/deployments/dpl_xxx/events");
  });

  it("falls back to e.payload?.text if Vercel ever switches shape", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { type: "stdout", created: 1, payload: { text: "Installing" } },
        { type: "stdout", created: 2, payload: { text: "Building" } },
      ],
    });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    const text = await client.getDeploymentEvents("dpl_xxx");
    expect(text).toBe("Installing\nBuilding");
  });

  it("strips trailing newlines from event text to avoid double blank lines", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { type: "stdout", created: 1, text: "Installing\n" },
        { type: "stdout", created: 2, text: "Building\n" },
      ],
    });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    const text = await client.getDeploymentEvents("dpl_xxx");
    expect(text).toBe("Installing\nBuilding");
  });
});
