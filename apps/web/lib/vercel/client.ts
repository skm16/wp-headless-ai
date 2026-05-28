import "server-only";

/**
 * VercelClient — minimal REST wrapper for Phase D Build & Deploy.
 *
 * No external SDK — direct fetch calls. Each method:
 *   - constructs the URL with /vN prefix + ?teamId query
 *   - attaches Authorization: Bearer ${token}
 *   - throws VercelApiError on non-2xx with structured body
 *
 * Surface kept narrow on purpose: 7 methods covering the exact endpoints
 * deploy-site.ts needs. Add new methods sparingly — they all add to the
 * "Vercel REST shape might drift" risk surface.
 *
 * API version notes (verified 2026-05-28 against vercel.com/docs/rest-api):
 *   - List/search projects:  GET  /v10/projects
 *   - Create project:        POST /v11/projects
 */

export interface VercelClientOptions {
  token: string;
  teamId: string;
}

export interface VercelProject {
  id: string;
  name: string;
}

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
    const headers = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
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

  async createProject(name: string): Promise<VercelProject> {
    const endpoint = this.url("/v11/projects");
    const data = (await this.request(endpoint, {
      method: "POST",
      body: JSON.stringify({ name, framework: "nextjs" }),
    })) as { id: string; name: string };
    return { id: data.id, name: data.name };
  }
}
