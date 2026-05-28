import "server-only";

/**
 * VercelClient — minimal REST wrapper for Phase D Build & Deploy.
 *
 * No external SDK — direct fetch calls. Each method:
 *   - constructs the URL with /vN prefix + ?teamId query
 *   - attaches Authorization: Bearer ${token}
 *   - throws VercelApiError on non-2xx with structured body
 *
 * Surface kept narrow on purpose: covers the exact endpoints deploy-site.ts
 * needs (project ops in Task 2, env ops in Task 3, deployment ops in Task 4).
 * Add new methods sparingly — they all add to the "Vercel REST shape might
 * drift" risk surface.
 *
 * API version notes (verified 2026-05-28 against vercel.com/docs/rest-api):
 *   - List/search projects:  GET  /v10/projects
 *   - Create project:        POST /v11/projects
 *   - List env vars:         GET  /v9/projects/{id}/env
 *   - Create env var:        POST /v10/projects/{id}/env  (plan said /v9; drifted)
 *   - Edit env var:          PATCH /v9/projects/{id}/env/{envId}
 *   - Create deployment:     POST /v13/deployments         (matches plan — confirmed)
 *   - Get deployment:        GET  /v13/deployments/{id}    (matches plan — confirmed)
 *   - Get deployment events: GET  /v3/deployments/{id}/events (matches plan — confirmed)
 *
 */

export interface VercelClientOptions {
  token: string;
  teamId: string;
}

export interface VercelProject {
  id: string;
  name: string;
}

export interface VercelEnvVar {
  id: string;
  key: string;
  value: string;
  type: string;
  target: string[];
}

export interface VercelDeployment {
  id: string;
  url: string;
  readyState: "QUEUED" | "BUILDING" | "READY" | "ERROR" | "CANCELED" | "INITIALIZING";
}

export interface VercelDeploymentFile {
  file: string;
  data: string;
  encoding: "utf-8";
}

export interface CreateDeploymentOptions {
  projectId: string;
  name: string;
  files: VercelDeploymentFile[];
}

const MAX_DEPLOYMENT_BODY_BYTES = 4_000_000;

export class VercelApiError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`vercel-api: ${endpoint} → ${status}: ${body.slice(0, 200)}`);
    this.name = "VercelApiError";
  }
}

const VERCEL_API_BASE = "https://api.vercel.com";

export class VercelClient {
  private readonly token: string;
  private readonly teamId: string;

  constructor(opts: VercelClientOptions) {
    if (!opts.token) throw new Error("VercelClient: token is required");
    if (!opts.teamId) throw new Error("VercelClient: teamId is required");
    this.token = opts.token;
    this.teamId = opts.teamId;
  }

  private url(path: string, extraQuery: Record<string, string> = {}): string {
    const params = new URLSearchParams({ teamId: this.teamId, ...extraQuery });
    return `${VERCEL_API_BASE}${path}?${params.toString()}`;
  }

  private async request(
    endpoint: string,
    init: RequestInit,
  ): Promise<unknown> {
    const callerHeaders =
      init.headers instanceof Headers
        ? Object.fromEntries(init.headers.entries())
        : Array.isArray(init.headers)
          ? Object.fromEntries(init.headers)
          : ((init.headers as Record<string, string>) ?? {});
    const isBodyRequest = init.body !== undefined && init.body !== null;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      ...(isBodyRequest ? { "Content-Type": "application/json" } : {}),
      ...callerHeaders,
    };
    const res = await fetch(endpoint, { ...init, headers });
    if (!res.ok) {
      const body = await res.text();
      throw new VercelApiError(endpoint, res.status, body);
    }
    return res.json();
  }

  async getProjectByName(name: string): Promise<VercelProject | null> {
    const endpoint = this.url("/v10/projects", { search: name });
    const data = (await this.request(endpoint, { method: "GET" })) as {
      projects?: Array<{ id: string; name: string }>;
    };
    const match = data.projects?.find((p) => p.name === name);
    return match ? { id: match.id, name: match.name } : null;
  }

  /**
   * POST /v11/projects to create a new Vercel project.
   *
   * Vercel returns 409 if a project with this name already exists in the
   * team. Callers should call `getProjectByName` first; if two concurrent
   * deploys race past that check, the loser surfaces a VercelApiError with
   * status=409. The deploy-site worker's ensure-vercel-project step
   * follows the look-then-create pattern.
   */
  async createProject(name: string): Promise<VercelProject> {
    const endpoint = this.url("/v11/projects");
    const data = (await this.request(endpoint, {
      method: "POST",
      body: JSON.stringify({ name, framework: "nextjs" }),
    })) as { id: string; name: string };
    return { id: data.id, name: data.name };
  }

  async listEnvVars(projectId: string): Promise<VercelEnvVar[]> {
    const endpoint = this.url(`/v9/projects/${projectId}/env`);
    const data = (await this.request(endpoint, { method: "GET" })) as {
      envs?: VercelEnvVar[];
    };
    return data.envs ?? [];
  }

  /**
   * POST /v10/projects/{id}/env — create a new env var.
   *
   * Note: Vercel docs show this at /v10 (plan said /v9 — drifted).
   * Verified 2026-05-28 against vercel.com/docs/rest-api/projects/
   * create-one-or-more-environment-variables.
   */
  async createEnvVar(projectId: string, key: string, value: string): Promise<void> {
    const endpoint = this.url(`/v10/projects/${projectId}/env`);
    await this.request(endpoint, {
      method: "POST",
      body: JSON.stringify({
        key,
        value,
        type: "encrypted",
        target: ["production"],
      }),
    });
  }

  async updateEnvVar(projectId: string, envId: string, value: string): Promise<void> {
    const endpoint = this.url(`/v9/projects/${projectId}/env/${envId}`);
    await this.request(endpoint, {
      method: "PATCH",
      body: JSON.stringify({
        value,
        type: "encrypted",
        target: ["production"],
      }),
    });
  }

  async createDeployment(opts: CreateDeploymentOptions): Promise<VercelDeployment> {
    const totalBytes = opts.files.reduce(
      (acc, f) => acc + Buffer.byteLength(f.data, "utf8"),
      0,
    );
    if (totalBytes > MAX_DEPLOYMENT_BODY_BYTES) {
      throw new Error(
        `vercel-deploy: total file body is ${totalBytes} bytes (> ${MAX_DEPLOYMENT_BODY_BYTES} 4MB cap). Switch to SHA upload via POST /v2/files before sending — see https://vercel.com/docs/rest-api/reference/endpoints/deployments/create-a-new-deployment.`,
      );
    }
    const endpoint = this.url("/v13/deployments");
    const data = (await this.request(endpoint, {
      method: "POST",
      body: JSON.stringify({
        name: opts.name,
        project: opts.projectId,
        files: opts.files,
        target: "production",
        projectSettings: { framework: "nextjs" },
      }),
    })) as { id: string; url: string; readyState: VercelDeployment["readyState"] };
    return { id: data.id, url: data.url, readyState: data.readyState };
  }

  async getDeployment(deploymentId: string): Promise<VercelDeployment> {
    const endpoint = this.url(`/v13/deployments/${deploymentId}`);
    const data = (await this.request(endpoint, { method: "GET" })) as {
      id: string;
      url: string;
      readyState: VercelDeployment["readyState"];
    };
    return { id: data.id, url: data.url, readyState: data.readyState };
  }

  async getDeploymentEvents(deploymentId: string): Promise<string> {
    const endpoint = this.url(`/v3/deployments/${deploymentId}/events`);
    const data = (await this.request(endpoint, { method: "GET" })) as Array<{
      type: string;
      payload?: { text?: string };
      created: number;
    }>;
    const sorted = [...data].sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
    return sorted.map((e) => e.payload?.text ?? "").join("\n");
  }
}
