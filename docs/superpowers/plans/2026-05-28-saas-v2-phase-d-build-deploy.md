# SaaS v2 — Phase D: Build & Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take a completed Phase C build (project tree in Storage at `builds/<id>/project/`) and deploy it to Vercel, capturing the live preview URL on `site_builds.preview_url`.

**Architecture:** A new Inngest worker (`deploySite`) consumes `site/deploy.requested` (already dispatched by `compose-site.ts`). The worker materializes the project, lazy-creates a per-JAB-project Vercel project, syncs WP credentials as Vercel env vars, POSTs an inline-file-body deployment, polls for `readyState=READY`, then dispatches `site/verify.requested`. On any failure, it captures the Vercel build log to Storage and sets `status='failed'` + `failed_phase='building'`. v1 uses raw `*.vercel.app` URLs; the custom subdomain bind lives in Phase F.

**Tech Stack:** Next.js 15 App Router • Inngest workers (`retries: 0`) • Supabase Postgres + Storage • Vercel REST API via global `fetch` (no SDK) • Drizzle migrations + `schema.ts` mirror • vitest + `vi.stubGlobal("fetch", ...)` for unit tests.

**Predecessor reading:**
- Spec: [`docs/superpowers/specs/2026-05-28-saas-v2-phase-d-build-deploy-design.md`](../specs/2026-05-28-saas-v2-phase-d-build-deploy-design.md)
- Phase C terminal worker for pattern mirroring: [`apps/web/lib/inngest/functions/compose-site.ts`](../../../apps/web/lib/inngest/functions/compose-site.ts)
- Storage upload backoff pattern: [`apps/web/lib/ai/persist-shell-generation.ts`](../../../apps/web/lib/ai/persist-shell-generation.ts)
- Smoke-runner pattern: [`apps/web/scripts/smoke-compose-site.ts`](../../../apps/web/scripts/smoke-compose-site.ts)
- Decrypt-from-bytea pattern: [`apps/web/lib/crypto/encrypt.ts`](../../../apps/web/lib/crypto/encrypt.ts) `decryptColumnToString`

**Smoke target:** Two Roads build `982f0d57-5275-499a-92d8-5f00dc70dba1` (projectId `075e33fd-8984-4e48-b58e-a9eab54d1828`, tenantId `01d5b66f-2d9b-42a8-bc5b-109af0b62579`). Phase C wrote all 28 required project files to `builds/982f0d57…/project/`. Ready to deploy.

**Operator prerequisites (one-time setup, documented in Task 15):**
- `VERCEL_TOKEN` — personal/team access token from `https://vercel.com/account/tokens`
- `VERCEL_TEAM_ID` — team identifier visible in Vercel team settings (looks like `team_xxx`)
- Both in `apps/web/.env.local` for dev; in production worker host's env

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/web/drizzle/migrations/0022_phase_d_deploy.sql` | Schema migration adding `projects.vercel_project_id`, `projects.vercel_project_name`, `site_builds.preview_url`, `site_builds.vercel_deployment_id`, `site_builds.build_log_storage_path` |
| `apps/web/lib/db/schema.ts` | Drizzle mirror — additive only, no rewrites |
| `apps/web/lib/vercel/client.ts` | `VercelClient` class wrapping 7 REST endpoints; explicit type contracts for `VercelProject`, `VercelDeployment`, `VercelEnvVar`, `VercelDeploymentEvent` |
| `apps/web/lib/vercel/poll-deployment.ts` | `pollDeployment(client, deploymentId, opts)` — internal 10s-tick loop with 5min cap; abortable via `AbortSignal` |
| `apps/web/lib/jab/download-project-tree.ts` | Recursive Storage walk over `builds/<id>/project/**`, reverse `__catchall_X__` → `[...X]` encoding, hard-fail on missing critical files |
| `apps/web/lib/inngest/functions/deploy-site.ts` | The Inngest worker. Step boundaries: `load-project` → `ensure-vercel-project` → parallel(`sync-env-vars`, `download-project-files`) → `create-deployment` → `poll-deployment` → `on-success` or `on-failure` |
| `apps/web/scripts/smoke-deploy-site.ts` | End-to-end smoke runner — dispatches event, polls `site_builds.status`, HEAD-checks `preview_url` |
| `apps/web/scripts/debug-vercel-deploy.ts` | One-shot debug tool: load an existing build's files, deploy directly via `VercelClient`, no Inngest |
| `docs/superpowers/operator/2026-05-28-vercel-platform-setup.md` | Runbook for the one-time Vercel team + token setup |

---

## Task 1: Schema migration + Drizzle mirror

**Files:**
- Create: `apps/web/drizzle/migrations/0022_phase_d_deploy.sql`
- Modify: `apps/web/lib/db/schema.ts`

- [ ] **Step 1: Write the migration SQL**

Create `apps/web/drizzle/migrations/0022_phase_d_deploy.sql`:

```sql
-- 0022_phase_d_deploy.sql — Phase D Build & Deploy
-- Adds the Vercel-side bookkeeping the deploy-site worker needs.
--
-- projects: vercel_project_id is the durable link to the Vercel project
-- we lazy-create on the first Phase D run for this JAB project.
-- vercel_project_name stores the slug we actually registered with Vercel
-- (lowercased, dashed) so renames of projects.name don't drift.
--
-- site_builds: preview_url is the per-build vercel.app URL Phase E
-- screenshots and Phase F previews. vercel_deployment_id is the durable
-- handle for log-fetching and (Phase F) production-alias binding.
-- build_log_storage_path points at builds/<id>/build-log.txt when the
-- deployment fails — NULL on success (we don't pay storage for successful
-- builds' logs; Vercel keeps them on their side).

ALTER TABLE public.projects
  ADD COLUMN vercel_project_id TEXT,
  ADD COLUMN vercel_project_name TEXT;

ALTER TABLE public.site_builds
  ADD COLUMN preview_url TEXT,
  ADD COLUMN vercel_deployment_id TEXT,
  ADD COLUMN build_log_storage_path TEXT;
```

- [ ] **Step 2: Apply the migration**

Apply via Supabase MCP (or psql against the dev DB):

```
mcp__supabase__apply_migration with name "0022_phase_d_deploy" and the SQL body above.
```

Verify via SQL:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'projects' AND column_name LIKE 'vercel%';
-- Expect 2 rows: vercel_project_id, vercel_project_name

SELECT column_name FROM information_schema.columns
WHERE table_name = 'site_builds' AND column_name IN ('preview_url', 'vercel_deployment_id', 'build_log_storage_path');
-- Expect 3 rows.
```

- [ ] **Step 3: Update the Drizzle schema mirror**

In `apps/web/lib/db/schema.ts`, find the `projects` table definition and add the two columns. Then find the `site_builds` table definition and add the three columns. Both additions are pure-additive (no field renames or constraint changes).

Inside the `projects` table builder (look for `wpAppPasswordEncrypted: bytea("wp_app_password_encrypted")` as your anchor — add after it):

```ts
    vercelProjectId: text("vercel_project_id"),
    vercelProjectName: text("vercel_project_name"),
```

Inside the `site_builds` table builder (add near the other status-y columns):

```ts
    previewUrl: text("preview_url"),
    vercelDeploymentId: text("vercel_deployment_id"),
    buildLogStoragePath: text("build_log_storage_path"),
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd apps/web && pnpm tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/drizzle/migrations/0022_phase_d_deploy.sql apps/web/lib/db/schema.ts
git commit -m "🗃️ feat(db): migration 0022 — Phase D Vercel columns

Adds projects.vercel_project_id/vercel_project_name + site_builds.preview_url/
vercel_deployment_id/build_log_storage_path. Drizzle mirror in lib/db/schema.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Vercel client base + project ops

**Files:**
- Create: `apps/web/lib/vercel/client.ts`
- Create: `apps/web/lib/vercel/client.test.ts`

**Prerequisite verification:** Before writing the first API call, open `https://vercel.com/docs/rest-api/reference` in a browser and confirm the path for "Create a new project" is still `POST /v10/projects` and "Find projects" is still `GET /v9/projects`. If the paths changed, update the constants below accordingly — the wrapper structure is what matters; the version prefix is one-line-change.

- [ ] **Step 1: Write failing tests**

Create `apps/web/lib/vercel/client.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
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
    expect(url).toContain("/v9/projects");
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
    expect(url).toContain("/v10/projects");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      name: "two-roads-brewing-new",
      framework: "nextjs",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && pnpm vitest run lib/vercel/client.test.ts`
Expected: tests fail with "Cannot find module './client'".

- [ ] **Step 3: Implement the client base + project ops**

Create `apps/web/lib/vercel/client.ts`:

```ts
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
    const endpoint = this.url("/v9/projects", { search: name });
    const data = (await this.request(endpoint, { method: "GET" })) as {
      projects?: Array<{ id: string; name: string }>;
    };
    const match = data.projects?.find((p) => p.name === name);
    return match ? { id: match.id, name: match.name } : null;
  }

  async createProject(name: string): Promise<VercelProject> {
    const endpoint = this.url("/v10/projects");
    const data = (await this.request(endpoint, {
      method: "POST",
      body: JSON.stringify({ name, framework: "nextjs" }),
    })) as { id: string; name: string };
    return { id: data.id, name: data.name };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && pnpm vitest run lib/vercel/client.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/vercel/client.ts apps/web/lib/vercel/client.test.ts
git commit -m "✨ feat(web): VercelClient base + project ops

Construction validation (token, teamId both required), private url() +
request() helpers (Bearer auth, JSON content-type, VercelApiError on
non-2xx). Two public methods: getProjectByName (search-by-name with
client-side exact match) and createProject (POST framework:nextjs).
5 tests against vi.stubGlobal('fetch').

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Vercel client — env ops

**Files:**
- Modify: `apps/web/lib/vercel/client.ts`
- Modify: `apps/web/lib/vercel/client.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `apps/web/lib/vercel/client.test.ts`:

```ts
describe("VercelClient — listEnvVars", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && pnpm vitest run lib/vercel/client.test.ts`
Expected: 4 new tests fail with "client.listEnvVars is not a function" etc.

- [ ] **Step 3: Implement env ops**

Append to `apps/web/lib/vercel/client.ts` (inside the `VercelClient` class, after `createProject`):

```ts
export interface VercelEnvVar {
  id: string;
  key: string;
  value: string;
  type: string;
  target: string[];
}

// ↑ Add this interface above the class declaration alongside VercelProject.

// ↓ Methods inside the class:
async listEnvVars(projectId: string): Promise<VercelEnvVar[]> {
  const endpoint = this.url(`/v9/projects/${projectId}/env`);
  const data = (await this.request(endpoint, { method: "GET" })) as {
    envs?: VercelEnvVar[];
  };
  return data.envs ?? [];
}

async createEnvVar(projectId: string, key: string, value: string): Promise<void> {
  const endpoint = this.url(`/v9/projects/${projectId}/env`);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && pnpm vitest run lib/vercel/client.test.ts`
Expected: all 9 tests pass (5 from Task 2 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/vercel/client.ts apps/web/lib/vercel/client.test.ts
git commit -m "✨ feat(web): VercelClient env ops

Three methods: listEnvVars (GET /v9/projects/{id}/env), createEnvVar
(POST with target=['production'], type=encrypted), updateEnvVar (PATCH
by env id). Worker orchestrates upsert: list once, then create or
update each of WP_URL/WP_USER/WP_APP_PASSWORD.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Vercel client — deployment ops

**Files:**
- Modify: `apps/web/lib/vercel/client.ts`
- Modify: `apps/web/lib/vercel/client.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `apps/web/lib/vercel/client.test.ts`:

```ts
describe("VercelClient — createDeployment", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("POSTs files inline and returns deployment id/url/readyState", async () => {
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
    expect(body.target).toBe("production");
    expect(body.projectSettings).toEqual({ framework: "nextjs" });
    expect(body.files).toHaveLength(2);
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

describe("VercelClient — getDeployment", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
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

  it("returns event payload text concatenated chronologically", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { type: "stdout", created: 1, payload: { text: "Installing dependencies\n" } },
        { type: "stdout", created: 2, payload: { text: "Building\n" } },
        { type: "stderr", created: 3, payload: { text: "Error: tsc failed\n" } },
      ],
    });
    const client = new VercelClient({ token: "tok", teamId: "team_x" });
    const text = await client.getDeploymentEvents("dpl_xxx");
    expect(text).toBe("Installing dependencies\nBuilding\nError: tsc failed\n");
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/v3/deployments/dpl_xxx/events");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && pnpm vitest run lib/vercel/client.test.ts`
Expected: 4 new tests fail with "createDeployment is not a function" etc.

- [ ] **Step 3: Implement deployment ops**

Add the new interface above the `VercelClient` class in `apps/web/lib/vercel/client.ts`:

```ts
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
```

Then add three methods inside the class:

```ts
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
  const sorted = [...data].sort((a, b) => a.created - b.created);
  return sorted.map((e) => e.payload?.text ?? "").join("");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && pnpm vitest run lib/vercel/client.test.ts`
Expected: all 13 tests pass (9 prior + 4 new).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/vercel/client.ts apps/web/lib/vercel/client.test.ts
git commit -m "✨ feat(web): VercelClient deployment ops + 4MB inline-body guard

Three methods: createDeployment (POST /v13/deployments with inline file
body, hard-fail above 4MB pointing at SHA upload migration), getDeployment
(poll GET /v13/deployments/{id}), getDeploymentEvents (GET /v3/.../events
concatenated chronologically into a single text blob for Storage upload).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Project-tree download helper

**Files:**
- Create: `apps/web/lib/jab/download-project-tree.ts`
- Create: `apps/web/lib/jab/download-project-tree.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/web/lib/jab/download-project-tree.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { decodeNextDynamicSegments, REQUIRED_DEPLOY_FILES, assertRequiredFiles } from "./download-project-tree";

describe("decodeNextDynamicSegments", () => {
  it("reverses catch-all encoding", () => {
    expect(decodeNextDynamicSegments("app/__catchall_slug__/page.tsx")).toBe(
      "app/[...slug]/page.tsx",
    );
  });
  it("reverses optional catch-all", () => {
    expect(decodeNextDynamicSegments("app/__optcatchall_path__/page.tsx")).toBe(
      "app/[[...path]]/page.tsx",
    );
  });
  it("reverses simple dynamic segments", () => {
    expect(decodeNextDynamicSegments("app/__dynamic_id__/page.tsx")).toBe(
      "app/[id]/page.tsx",
    );
  });
  it("handles paths with no encoded segments unchanged", () => {
    expect(decodeNextDynamicSegments("package.json")).toBe("package.json");
  });
});

describe("assertRequiredFiles", () => {
  it("returns silently when all required files present", () => {
    const paths = REQUIRED_DEPLOY_FILES.map((f) => f);
    expect(() => assertRequiredFiles(paths)).not.toThrow();
  });
  it("throws listing the specific missing files", () => {
    const paths = REQUIRED_DEPLOY_FILES.filter((f) => f !== "package.json");
    expect(() => assertRequiredFiles(paths)).toThrow(/package\.json/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && pnpm vitest run lib/jab/download-project-tree.test.ts`
Expected: tests fail with "Cannot find module './download-project-tree'".

- [ ] **Step 3: Implement the helper (constants + decode + assert)**

Create `apps/web/lib/jab/download-project-tree.ts`:

```ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";

/**
 * Phase D project-tree download + dynamic-route decode helper.
 *
 * Inverse of Phase C's encodeNextDynamicSegments in compose-site.ts:
 *   __catchall_X__   ↔ [...X]
 *   __optcatchall_X__ ↔ [[...X]]
 *   __dynamic_X__    ↔ [X]
 *
 * Supabase Storage rejects bracket characters in object keys, so Phase C
 * writes the encoded names. We reverse them in-memory before sending paths
 * to Vercel — Vercel and the emitted Next.js project both need real
 * bracket-segment names on disk.
 */

export function decodeNextDynamicSegments(filePath: string): string {
  return filePath
    .replace(/__optcatchall_([A-Za-z0-9_]+)__/g, "[[...$1]]")
    .replace(/__catchall_([A-Za-z0-9_]+)__/g, "[...$1]")
    .replace(/__dynamic_([A-Za-z0-9_]+)__/g, "[$1]");
}

/**
 * The decoded paths that MUST be present in the downloaded tree.
 * If any is missing, Phase C wrote a malformed project tree — we should
 * hard-fail BEFORE calling Vercel rather than waste a deployment slot.
 *
 * Subset of smoke-compose-site.ts REQUIRED_FILES: the files whose absence
 * would cause `next build` to abort immediately. The smoke runner checks
 * a richer 28-file set; this runtime gate is the minimum-viable.
 */
export const REQUIRED_DEPLOY_FILES = [
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  "app/layout.tsx",
  "app/page.tsx",
  "components/blocks/_dispatcher.tsx",
];

export function assertRequiredFiles(paths: string[]): void {
  const present = new Set(paths);
  const missing = REQUIRED_DEPLOY_FILES.filter((f) => !present.has(f));
  if (missing.length > 0) {
    throw new Error(
      `download-project-tree: missing required file(s) — Phase C output is malformed: ${missing.join(", ")}`,
    );
  }
}
```

- [ ] **Step 4: Run pure-function tests to verify they pass**

Run: `cd apps/web && pnpm vitest run lib/jab/download-project-tree.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Add the recursive download function with a test**

Append to `apps/web/lib/jab/download-project-tree.test.ts`:

```ts
import { downloadProjectTree } from "./download-project-tree";

describe("downloadProjectTree — recursive walk + decode", () => {
  it("flattens nested folders, decodes paths, downloads contents", async () => {
    // Fake Supabase storage: two list calls (one root, one app/__catchall_slug__),
    // plus three downloads.
    const listMock = vi
      .fn()
      // root level: package.json (file), app (folder)
      .mockImplementationOnce(async () => ({
        data: [
          {
            name: "package.json",
            id: "obj_pkg",
            metadata: { size: 100, mimetype: "text/plain" },
          },
          { name: "app", id: null, metadata: null },
        ],
        error: null,
      }))
      // app/: page.tsx (file), __catchall_slug__ (folder)
      .mockImplementationOnce(async () => ({
        data: [
          {
            name: "page.tsx",
            id: "obj_root_page",
            metadata: { size: 50, mimetype: "text/plain" },
          },
          { name: "__catchall_slug__", id: null, metadata: null },
        ],
        error: null,
      }))
      // app/__catchall_slug__/: page.tsx (file)
      .mockImplementationOnce(async () => ({
        data: [
          {
            name: "page.tsx",
            id: "obj_cs_page",
            metadata: { size: 60, mimetype: "text/plain" },
          },
        ],
        error: null,
      }));
    const downloadMock = vi
      .fn()
      .mockImplementationOnce(async () => ({
        data: new Blob(['{"name":"x"}'], { type: "text/plain" }),
        error: null,
      }))
      .mockImplementationOnce(async () => ({
        data: new Blob(["export default function P() { return null }"], { type: "text/plain" }),
        error: null,
      }))
      .mockImplementationOnce(async () => ({
        data: new Blob(["export default function Slug() { return null }"], { type: "text/plain" }),
        error: null,
      }));
    const supabase = {
      storage: {
        from: () => ({ list: listMock, download: downloadMock }),
      },
    } as unknown as SupabaseClient;

    const files = await downloadProjectTree(supabase, "build-xyz");
    expect(files.map((f) => f.file).sort()).toEqual([
      "app/[...slug]/page.tsx",
      "app/page.tsx",
      "package.json",
    ]);
    const pkg = files.find((f) => f.file === "package.json");
    expect(pkg?.data).toBe('{"name":"x"}');
    expect(pkg?.encoding).toBe("utf-8");
  });

  it("propagates list errors with prefix context", async () => {
    const supabase = {
      storage: {
        from: () => ({
          list: vi.fn(async () => ({ data: null, error: { message: "boom" } })),
          download: vi.fn(),
        }),
      },
    } as unknown as SupabaseClient;
    await expect(downloadProjectTree(supabase, "build-xyz")).rejects.toThrow(/boom/);
  });
});
```

Also import `SupabaseClient` at the top of the test file:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
```

- [ ] **Step 6: Run new tests to verify they fail**

Run: `cd apps/web && pnpm vitest run lib/jab/download-project-tree.test.ts`
Expected: 2 new tests fail with "downloadProjectTree is not exported".

- [ ] **Step 7: Implement downloadProjectTree**

Append to `apps/web/lib/jab/download-project-tree.ts`:

```ts
export interface ProjectTreeFile {
  file: string;
  data: string;
  encoding: "utf-8";
}

/**
 * Walks builds/<buildId>/project/ recursively. Returns all files with
 * their (decoded) destination paths and UTF-8 contents, ready to hand to
 * VercelClient.createDeployment.
 *
 * Supabase Storage's `list` is shallow — items with `id === null` are
 * folders, items with an `id` are files. We recurse into folders.
 */
export async function downloadProjectTree(
  supabase: SupabaseClient,
  buildId: string,
): Promise<ProjectTreeFile[]> {
  const rootPrefix = `builds/${buildId}/project/`;
  const collected: ProjectTreeFile[] = [];

  async function walk(prefix: string, relPath: string): Promise<void> {
    const { data, error } = await supabase.storage
      .from(SITE_SCREENSHOTS_BUCKET)
      .list(prefix, { limit: 1000 });
    if (error) throw new Error(`download-project-tree: list '${prefix}' failed: ${error.message}`);
    for (const item of data ?? []) {
      const childRel = relPath ? `${relPath}/${item.name}` : item.name;
      if (item.id === null) {
        // folder
        await walk(`${prefix}${item.name}/`, childRel);
      } else {
        const objPath = `${prefix}${item.name}`;
        const { data: blob, error: dlErr } = await supabase.storage
          .from(SITE_SCREENSHOTS_BUCKET)
          .download(objPath);
        if (dlErr || !blob) {
          throw new Error(
            `download-project-tree: download '${objPath}' failed: ${dlErr?.message ?? "no blob"}`,
          );
        }
        const text = await blob.text();
        collected.push({
          file: decodeNextDynamicSegments(childRel),
          data: text,
          encoding: "utf-8",
        });
      }
    }
  }

  await walk(rootPrefix, "");
  return collected;
}
```

- [ ] **Step 8: Run all tests to verify they pass**

Run: `cd apps/web && pnpm vitest run lib/jab/download-project-tree.test.ts`
Expected: 8 tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/jab/download-project-tree.ts apps/web/lib/jab/download-project-tree.test.ts
git commit -m "✨ feat(web): download-project-tree — recursive Storage walk + decode

Reverses Phase C's __catchall_X__/__optcatchall_X__/__dynamic_X__ encoding
in-memory. Walks builds/<id>/project/ with id===null detection for folders.
assertRequiredFiles guards against malformed Phase C output (missing
package.json/layout.tsx/page.tsx/dispatcher) BEFORE we burn a Vercel
deployment slot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Poll-deployment helper

**Files:**
- Create: `apps/web/lib/vercel/poll-deployment.ts`
- Create: `apps/web/lib/vercel/poll-deployment.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/web/lib/vercel/poll-deployment.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { pollDeployment } from "./poll-deployment";
import type { VercelClient, VercelDeployment } from "./client";

function makeClient(states: VercelDeployment["readyState"][]): VercelClient {
  let i = 0;
  return {
    getDeployment: vi.fn(async () => ({
      id: "dpl_x",
      url: "x.vercel.app",
      readyState: states[Math.min(i++, states.length - 1)],
    })),
  } as unknown as VercelClient;
}

describe("pollDeployment", () => {
  it("returns READY outcome on first tick when already ready", async () => {
    const client = makeClient(["READY"]);
    const result = await pollDeployment({
      client,
      deploymentId: "dpl_x",
      tickMs: 1, // fast for tests
      maxMs: 1000,
    });
    expect(result.outcome).toBe("READY");
    if (result.outcome === "READY") {
      expect(result.deployment.url).toBe("x.vercel.app");
    }
  });

  it("polls until BUILDING → READY", async () => {
    const client = makeClient(["QUEUED", "BUILDING", "BUILDING", "READY"]);
    const result = await pollDeployment({
      client,
      deploymentId: "dpl_x",
      tickMs: 1,
      maxMs: 1000,
    });
    expect(result.outcome).toBe("READY");
    expect((client.getDeployment as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });

  it("returns ERROR outcome when readyState is ERROR", async () => {
    const client = makeClient(["BUILDING", "ERROR"]);
    const result = await pollDeployment({
      client,
      deploymentId: "dpl_x",
      tickMs: 1,
      maxMs: 1000,
    });
    expect(result.outcome).toBe("ERROR");
  });

  it("returns TIMEOUT outcome when maxMs is exceeded", async () => {
    const client = makeClient(["QUEUED"]);
    const result = await pollDeployment({
      client,
      deploymentId: "dpl_x",
      tickMs: 5,
      maxMs: 15, // ~3 ticks
    });
    expect(result.outcome).toBe("TIMEOUT");
    if (result.outcome === "TIMEOUT") {
      expect(result.lastReadyState).toBe("QUEUED");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && pnpm vitest run lib/vercel/poll-deployment.test.ts`
Expected: tests fail with "Cannot find module './poll-deployment'".

- [ ] **Step 3: Implement pollDeployment**

Create `apps/web/lib/vercel/poll-deployment.ts`:

```ts
import "server-only";
import type { VercelClient, VercelDeployment } from "./client";

/**
 * Internal poll loop with a configurable tick interval and hard maxMs cap.
 *
 * Inngest's step.run wraps this — each Phase D run does one step.run that
 * calls pollDeployment. We do not use step.sleep + per-tick step.run
 * because Vercel deployments typically take 60-180s and 10-20 step entries
 * per deployment bloats Inngest state for no clarity gain.
 *
 * Returns a tagged outcome so the caller branches on a single switch.
 */

export interface PollDeploymentOptions {
  client: VercelClient;
  deploymentId: string;
  tickMs: number;
  maxMs: number;
}

export type PollDeploymentResult =
  | { outcome: "READY"; deployment: VercelDeployment }
  | { outcome: "ERROR"; deployment: VercelDeployment }
  | { outcome: "CANCELED"; deployment: VercelDeployment }
  | { outcome: "TIMEOUT"; lastReadyState: string };

export async function pollDeployment(
  opts: PollDeploymentOptions,
): Promise<PollDeploymentResult> {
  const deadline = Date.now() + opts.maxMs;
  let last: VercelDeployment | null = null;
  while (Date.now() < deadline) {
    const deployment = await opts.client.getDeployment(opts.deploymentId);
    last = deployment;
    if (deployment.readyState === "READY") return { outcome: "READY", deployment };
    if (deployment.readyState === "ERROR") return { outcome: "ERROR", deployment };
    if (deployment.readyState === "CANCELED") return { outcome: "CANCELED", deployment };
    await new Promise((r) => setTimeout(r, opts.tickMs));
  }
  return { outcome: "TIMEOUT", lastReadyState: last?.readyState ?? "UNKNOWN" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && pnpm vitest run lib/vercel/poll-deployment.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/vercel/poll-deployment.ts apps/web/lib/vercel/poll-deployment.test.ts
git commit -m "✨ feat(web): pollDeployment helper

Internal loop, tickMs interval, hard maxMs cap. Returns tagged outcome
(READY | ERROR | CANCELED | TIMEOUT). Single step.run boundary in the
worker — no per-tick Inngest step entries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Worker scaffold + load-project + ensure-vercel-project

**Files:**
- Create: `apps/web/lib/inngest/functions/deploy-site.ts`

This task lays the worker shell. We'll fill in subsequent steps in tasks 8–11. After this task the worker compiles and dispatches but doesn't yet do useful work — Tasks 8–11 expand it.

The worker is end-to-end tested via the smoke runner (Task 13), not via unit tests. The helper functions it composes (Vercel client, download-tree, poll) already have unit tests from Tasks 2–6.

- [ ] **Step 1: Create worker file with the load + ensure steps**

Create `apps/web/lib/inngest/functions/deploy-site.ts`:

```ts
import "server-only";
import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase/admin";
import { VercelClient } from "@/lib/vercel/client";
import { decryptColumnToString } from "@/lib/crypto/encrypt";

/**
 * deploy-site — Phase D Inngest worker.
 *
 * Trigger: site/deploy.requested (dispatched by compose-site.ts at the end
 * of Phase C). Phase C terminal status is 'building', so we enter with
 * that status already set — no entry status transition needed.
 *
 * Sequencing:
 *   load-project → ensure-vercel-project → parallel(sync-env-vars,
 *   download-project-files) → create-deployment → poll-deployment →
 *   on-success(UPDATE + dispatch verify) OR on-failure(log + UPDATE).
 *
 * retries: 0 — same rationale as discoverSite/generateComponents/composeSite.
 * Failure surface is durable in site_builds; Inngest auto-retry would
 * create duplicate Vercel deployments.
 */

interface ProjectRow {
  id: string;
  name: string;
  wp_url: string;
  wp_username: string | null;
  wp_app_password_encrypted: unknown;
  vercel_project_id: string | null;
  vercel_project_name: string | null;
}

/**
 * Project name → Vercel project slug. Lowercase, alphanumeric + dashes
 * only, collapse runs, trim leading/trailing dashes. Must match the slug
 * compose-site-emit.ts uses in emitPackageJson so package.json `name` and
 * Vercel project name stay aligned.
 */
function slugifyProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "untitled-project";
}

function loadVercelClient(): VercelClient {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  if (!token) throw new Error("VERCEL_TOKEN not set. See docs/superpowers/operator/2026-05-28-vercel-platform-setup.md");
  if (!teamId) throw new Error("VERCEL_TEAM_ID not set. See docs/superpowers/operator/2026-05-28-vercel-platform-setup.md");
  return new VercelClient({ token, teamId });
}

export const deploySite = inngest.createFunction(
  { id: "deploy-site", retries: 0 },
  { event: "site/deploy.requested" },
  async ({ event, step }) => {
    const { projectId, tenantId, buildId } = event.data as {
      projectId: string;
      tenantId: string;
      buildId: string;
    };

    const project = await step.run("load-project", async (): Promise<ProjectRow> => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("projects")
        .select("id, name, wp_url, wp_username, wp_app_password_encrypted, vercel_project_id, vercel_project_name")
        .eq("id", projectId)
        .eq("tenant_id", tenantId)
        .single();
      if (error || !data) throw new Error(`deploy-site: load-project failed: ${error?.message ?? "no row"}`);
      return data as ProjectRow;
    });

    const vercel = loadVercelClient();
    const wantedName = project.vercel_project_name ?? slugifyProjectName(project.name);

    const vercelProject = await step.run("ensure-vercel-project", async () => {
      // Already linked?
      if (project.vercel_project_id) {
        return { id: project.vercel_project_id, name: wantedName };
      }
      // Existing by name? (Idempotency fallback if our DB diverged from Vercel.)
      const existing = await vercel.getProjectByName(wantedName);
      const created = existing ?? (await vercel.createProject(wantedName));

      const supabase = createAdminClient();
      const { error } = await supabase
        .from("projects")
        .update({ vercel_project_id: created.id, vercel_project_name: created.name })
        .eq("id", projectId)
        .eq("tenant_id", tenantId);
      if (error) throw new Error(`deploy-site: persist vercel_project_id failed: ${error.message}`);
      return created;
    });

    // Phase D worker continues in subsequent tasks — for now, surface progress.
    console.log(`[deploy-site] resolved Vercel project ${vercelProject.id} (${vercelProject.name}) for build ${buildId}`);
    return { buildId, vercelProjectId: vercelProject.id };
  },
);
```

- [ ] **Step 2: Verify tsc + build**

Run: `cd apps/web && pnpm tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/inngest/functions/deploy-site.ts
git commit -m "✨ feat(web): deploy-site worker scaffold + load + ensure-vercel-project

Inngest worker on site/deploy.requested. retries:0. Two step.run boundaries
so far: load-project and ensure-vercel-project (idempotency: by-name lookup
before create). Slugifier mirrors emitPackageJson's package.json name slug.
loadVercelClient throws with runbook pointer when env vars missing.

Rest of the pipeline lands in Tasks 8-11.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Worker — sync-env-vars step

**Files:**
- Modify: `apps/web/lib/inngest/functions/deploy-site.ts`

- [ ] **Step 1: Add the sync-env-vars step**

In `apps/web/lib/inngest/functions/deploy-site.ts`, add a helper near the top (after the `slugifyProjectName` function):

```ts
/**
 * Three env vars the emitted JAB project's lib/jab/client.ts expects at
 * build time AND runtime: WP_URL, WP_USER, WP_APP_PASSWORD. We re-sync on
 * every Phase D run so credential rotation is picked up by the next build.
 */
const SYNCED_ENV_KEYS = ["WP_URL", "WP_USER", "WP_APP_PASSWORD"] as const;

function buildEnvVarPlan(project: ProjectRow): Array<{ key: string; value: string }> {
  if (!project.wp_username) {
    throw new Error(`deploy-site: project ${project.id} has no wp_username — cannot sync env vars`);
  }
  const password = decryptColumnToString(project.wp_app_password_encrypted);
  return [
    { key: "WP_URL", value: project.wp_url },
    { key: "WP_USER", value: project.wp_username },
    { key: "WP_APP_PASSWORD", value: password },
  ];
}
```

Then add the step inside the worker (replace the temporary `console.log` + `return` at the bottom):

```ts
    // Wave 2 parallel: sync env vars, download project files
    const [, projectFiles] = await Promise.all([
      step.run("sync-env-vars", async () => {
        const plan = buildEnvVarPlan(project);
        const existing = await vercel.listEnvVars(vercelProject.id);
        const existingByKey = new Map(existing.map((e) => [e.key, e]));
        for (const item of plan) {
          const found = existingByKey.get(item.key);
          if (found) {
            await vercel.updateEnvVar(vercelProject.id, found.id, item.value);
          } else {
            await vercel.createEnvVar(vercelProject.id, item.key, item.value);
          }
        }
        return { synced: plan.length };
      }),
      step.run("download-project-files", async () => {
        // implementation in Task 9 — empty stub returns 0 files for now
        return [] as Array<{ file: string; data: string; encoding: "utf-8" }>;
      }),
    ]);

    console.log(`[deploy-site] env synced, ${projectFiles.length} files downloaded for build ${buildId}`);
    return { buildId, vercelProjectId: vercelProject.id, fileCount: projectFiles.length };
```

- [ ] **Step 2: Verify tsc + build**

Run: `cd apps/web && pnpm tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/inngest/functions/deploy-site.ts
git commit -m "✨ feat(web): deploy-site sync-env-vars step (Wave 2 parallel)

Decrypts wp_app_password_encrypted via decryptColumnToString, then upserts
WP_URL/WP_USER/WP_APP_PASSWORD on the Vercel project. List-once, then
create-or-update per key. Runs in parallel with download-project-files
(Wave 2). Throws fail-fast if project lacks wp_username.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Worker — download-files + create-deployment

**Files:**
- Modify: `apps/web/lib/inngest/functions/deploy-site.ts`

- [ ] **Step 1: Wire download-project-tree + assertRequiredFiles + createDeployment**

In `apps/web/lib/inngest/functions/deploy-site.ts`, add imports at the top:

```ts
import { downloadProjectTree, assertRequiredFiles } from "@/lib/jab/download-project-tree";
```

Replace the stub `download-project-files` step (Task 8) with the real implementation:

```ts
      step.run("download-project-files", async () => {
        const supabase = createAdminClient();
        const files = await downloadProjectTree(supabase, buildId);
        assertRequiredFiles(files.map((f) => f.file));
        return files;
      }),
```

After the `Promise.all` block (after the console.log line from Task 8), add the deployment step:

```ts
    const deployment = await step.run("create-deployment", async () => {
      return vercel.createDeployment({
        projectId: vercelProject.id,
        name: vercelProject.name,
        files: projectFiles,
      });
    });

    console.log(`[deploy-site] created Vercel deployment ${deployment.id} (${deployment.url}) for build ${buildId}`);
    return { buildId, vercelProjectId: vercelProject.id, vercelDeploymentId: deployment.id, previewUrl: deployment.url };
```

- [ ] **Step 2: Verify tsc + build**

Run: `cd apps/web && pnpm tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/inngest/functions/deploy-site.ts
git commit -m "✨ feat(web): deploy-site download-project-files + create-deployment

download-project-files uses downloadProjectTree from lib/jab + asserts the
6 required-file invariants before send. create-deployment posts inline
file body via VercelClient.createDeployment (4MB guard in client). Logs
the deployment id + URL for build-progress tracing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Worker — poll + on-success path

**Files:**
- Modify: `apps/web/lib/inngest/functions/deploy-site.ts`

- [ ] **Step 1: Wire pollDeployment + on-success step**

In `apps/web/lib/inngest/functions/deploy-site.ts`, add import:

```ts
import { pollDeployment } from "@/lib/vercel/poll-deployment";
```

Add constants near the top:

```ts
const POLL_TICK_MS = 10_000;
const POLL_MAX_MS = 5 * 60 * 1000;
```

Replace the final `console.log` + `return` from Task 9 with poll + success branch:

```ts
    const pollResult = await step.run("poll-deployment", async () => {
      return pollDeployment({
        client: vercel,
        deploymentId: deployment.id,
        tickMs: POLL_TICK_MS,
        maxMs: POLL_MAX_MS,
      });
    });

    if (pollResult.outcome === "READY") {
      await step.run("on-success", async () => {
        const supabase = createAdminClient();
        const previewUrl = pollResult.deployment.url.startsWith("http")
          ? pollResult.deployment.url
          : `https://${pollResult.deployment.url}`;
        const { error } = await supabase
          .from("site_builds")
          .update({
            status: "verifying",
            preview_url: previewUrl,
            vercel_deployment_id: deployment.id,
          })
          .eq("id", buildId)
          .eq("project_id", projectId);
        if (error) throw new Error(`deploy-site: on-success update failed: ${error.message}`);
      });

      await step.sendEvent("dispatch-verify", {
        name: "site/verify.requested",
        data: { projectId, tenantId, buildId },
      });

      return { buildId, vercelDeploymentId: deployment.id, previewUrl: pollResult.deployment.url, outcome: "ready" };
    }

    // Failure paths land in Task 11. For now, surface the failure outcome.
    console.warn(`[deploy-site] non-READY outcome: ${pollResult.outcome}`);
    return { buildId, vercelDeploymentId: deployment.id, outcome: pollResult.outcome };
```

- [ ] **Step 2: Verify tsc + build**

Run: `cd apps/web && pnpm tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/inngest/functions/deploy-site.ts
git commit -m "✨ feat(web): deploy-site poll + on-success path

10s tick interval, 5min cap on poll loop. On READY: UPDATE site_builds
SET status='verifying', preview_url, vercel_deployment_id, then
dispatch site/verify.requested. Phase E worker picks up from there.
Non-READY outcomes still fall through to a console.warn — Task 11 wires
the failure-path log capture.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Worker — on-failure path (log capture + Storage upload)

**Files:**
- Modify: `apps/web/lib/inngest/functions/deploy-site.ts`

- [ ] **Step 1: Add the on-failure step**

In `apps/web/lib/inngest/functions/deploy-site.ts`, add the import at the top:

```ts
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
```

Replace the `// Failure paths land in Task 11` block from Task 10 with the full failure handler:

```ts
    // pollResult.outcome ∈ { ERROR, CANCELED, TIMEOUT }
    const buildLogPath = `builds/${buildId}/build-log.txt`;

    await step.run("on-failure", async () => {
      let logText = `[deploy-site] outcome: ${pollResult.outcome}\n`;
      if (pollResult.outcome === "TIMEOUT") {
        logText += `[deploy-site] poll exceeded ${POLL_MAX_MS}ms; lastReadyState=${pollResult.lastReadyState}\n`;
      }

      // Fetch Vercel build events. Tolerate fetch failure — the log
      // upload itself must not block the failure-write to site_builds.
      try {
        const events = await vercel.getDeploymentEvents(deployment.id);
        logText += "\n--- Vercel build events ---\n";
        logText += events;
      } catch (err) {
        logText += `\n[deploy-site] failed to fetch Vercel events: ${err instanceof Error ? err.message : String(err)}\n`;
      }

      // Upload to Storage with 3-attempt backoff (mirror persist-shell-generation.ts).
      const supabase = createAdminClient();
      const buf = Buffer.from(logText, "utf8");
      let lastError: { message: string } | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const { error: uploadError } = await supabase.storage
          .from(SITE_SCREENSHOTS_BUCKET)
          .upload(buildLogPath, buf, { contentType: "text/plain", upsert: true });
        if (!uploadError) {
          lastError = null;
          break;
        }
        lastError = uploadError;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 200 * Math.pow(3, attempt)));
        }
      }
      if (lastError) {
        console.warn(`[deploy-site] build-log upload failed after 3 attempts: ${lastError.message}`);
      }

      const { error } = await supabase
        .from("site_builds")
        .update({
          status: "failed",
          failed_phase: "building",
          vercel_deployment_id: deployment.id,
          build_log_storage_path: lastError ? null : buildLogPath,
        })
        .eq("id", buildId)
        .eq("project_id", projectId);
      if (error) throw new Error(`deploy-site: on-failure update failed: ${error.message}`);
    });

    return {
      buildId,
      vercelDeploymentId: deployment.id,
      outcome: pollResult.outcome.toLowerCase(),
    };
```

- [ ] **Step 2: Verify tsc + build**

Run: `cd apps/web && pnpm tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/inngest/functions/deploy-site.ts
git commit -m "✨ feat(web): deploy-site on-failure log capture + Storage upload

ERROR/CANCELED/TIMEOUT all converge to: fetch Vercel events (tolerant),
upload concatenated log text to builds/<id>/build-log.txt with the
200ms/600ms/1800ms backoff pattern from persist-shell-generation, then
UPDATE site_builds SET status='failed', failed_phase='building',
vercel_deployment_id, build_log_storage_path. UI can render the log
from that storage path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Register deploySite with Inngest

**Files:**
- Modify: the Inngest functions registration site (likely `apps/web/lib/inngest/index.ts` or `apps/web/app/api/inngest/route.ts`)

- [ ] **Step 1: Find the registration site**

Run: `cd apps/web && grep -rn "composeSite" --include="*.ts" lib/inngest app/api/inngest`

Identify the file that imports the worker functions and passes them to `serve({ ... functions: [...] })` or similar. That's the registration site. It's the same file that registers `discoverSite`, `generateComponents`, `composeSite`.

- [ ] **Step 2: Add deploySite to the imports + functions array**

In the registration file you identified, add the import next to the existing worker imports:

```ts
import { deploySite } from "./functions/deploy-site";
```

(Adjust the import path to be relative to that file.)

In the `functions` array, add `deploySite`:

```ts
const functions = [
  discoverSite,
  generateComponents,
  composeSite,
  deploySite, // ← new
];
```

- [ ] **Step 3: Verify tsc + Inngest dev sees the function**

Run: `cd apps/web && pnpm tsc --noEmit`
Expected: no errors.

Restart the Next dev server (so Inngest reloads), then open the Inngest dev UI at `http://localhost:8288` and confirm `deploy-site` appears in the function list under the local app.

- [ ] **Step 4: Commit**

```bash
git add <registration-file-path>
git commit -m "🔧 chore(web): register deploySite with Inngest

Adds deploy-site to the functions array. Worker now discoverable via the
Inngest dev UI and reachable via site/deploy.requested events.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Smoke runner — smoke-deploy-site.ts

**Files:**
- Create: `apps/web/scripts/smoke-deploy-site.ts`
- Modify: `apps/web/package.json` (add `smoke:deploy` script)

- [ ] **Step 1: Create smoke runner**

Create `apps/web/scripts/smoke-deploy-site.ts`:

```ts
// apps/web/scripts/smoke-deploy-site.ts
//
// End-to-end smoke for Phase D against an already-composed build.
//   cd apps/web
//   pnpm smoke:deploy <projectId> <tenantId> <buildId>
//
// Prereqs: Inngest dev + Next dev running, .env.local has
// SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, VERCEL_TOKEN,
// VERCEL_TEAM_ID. Real Vercel deployment — ~$0.40 in build minutes.
//
// Polls site_builds.status until 'verifying' (success) or 'failed'.
// On success, HEAD-checks the preview_url returns 200 before declaring PASS.

import { createClient } from "@supabase/supabase-js";
import { Inngest } from "inngest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 8 * 60 * 1000; // Vercel build ~60-180s + slack

function loadDotEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function main() {
  loadDotEnvLocal();

  const [, , projectId, tenantId, buildId] = process.argv;
  if (!projectId || !tenantId || !buildId) {
    console.error("Usage: pnpm smoke:deploy <projectId> <tenantId> <buildId>");
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  if (!process.env.VERCEL_TOKEN || !process.env.VERCEL_TEAM_ID) {
    console.error("Missing VERCEL_TOKEN or VERCEL_TEAM_ID. See docs/superpowers/operator/2026-05-28-vercel-platform-setup.md");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const inngest = new Inngest({
    id: "smoke-deploy-site",
    eventKey: process.env.INNGEST_EVENT_KEY ?? "local-dev-key",
    baseUrl: process.env.INNGEST_BASE_URL ?? "http://localhost:8288",
    isDev: true,
  });

  console.log(`[smoke] dispatching site/deploy.requested for build ${buildId}…`);
  await inngest.send({
    name: "site/deploy.requested",
    data: { projectId, tenantId, buildId },
  });

  const t0 = Date.now();
  let lastStatus = "";
  while (Date.now() - t0 < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const { data: build } = await supabase
      .from("site_builds")
      .select("status, preview_url, build_log_storage_path")
      .eq("id", buildId)
      .single();
    if (!build) continue;
    if (build.status !== lastStatus) {
      console.log(`[smoke] status: ${build.status}`);
      lastStatus = build.status;
    }
    if (build.status === "verifying") {
      console.log(`[smoke] preview_url: ${build.preview_url}`);
      // HEAD-check the URL to confirm Vercel really served it.
      try {
        const res = await fetch(build.preview_url, { method: "HEAD" });
        if (res.status !== 200) {
          console.error(`[smoke] FAIL — HEAD ${build.preview_url} returned ${res.status}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`[smoke] FAIL — HEAD ${build.preview_url} threw: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      console.log(`[smoke] PASS — preview HEAD returned 200`);
      console.log(`[smoke] Phase D complete in ${Date.now() - t0}ms.`);
      return;
    }
    if (build.status === "failed") {
      console.error(`[smoke] FAIL — site_builds.status='failed'`);
      if (build.build_log_storage_path) {
        console.error(`[smoke] build log at: ${build.build_log_storage_path}`);
      }
      process.exit(1);
    }
  }

  console.error(`[smoke] FAIL — timed out after ${Date.now() - t0}ms (status=${lastStatus})`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the package.json script**

In `apps/web/package.json`, find the `scripts` section and add:

```json
"smoke:deploy": "tsx scripts/smoke-deploy-site.ts"
```

(Place alongside `smoke:compose` for consistency.)

- [ ] **Step 3: Verify the script entry**

Run: `cd apps/web && pnpm smoke:deploy 2>&1 | head -3`
Expected: prints the usage line (no projectId given) then exits 1. That's success — it confirms the script wiring works.

- [ ] **Step 4: Commit**

```bash
git add apps/web/scripts/smoke-deploy-site.ts apps/web/package.json
git commit -m "✨ feat(web): smoke-deploy-site — Phase D end-to-end smoke

Dispatches site/deploy.requested, polls site_builds.status until
'verifying' (success) or 'failed', HEAD-checks preview_url returns 200
before declaring PASS. 8min timeout. Surfaces build_log_storage_path
on failure for operator follow-up. Real Vercel deploy — ~\$0.40 per run.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Debug tool — debug-vercel-deploy.ts

**Files:**
- Create: `apps/web/scripts/debug-vercel-deploy.ts`
- Modify: `apps/web/package.json` (add `debug:vercel` script)

The debug tool replicates Task 13's smoke but with no Inngest in the loop — it directly calls the VercelClient against an already-composed build's files. Useful for iterating on Vercel API issues without going through the Inngest replay/memoization cycle.

- [ ] **Step 1: Create the debug tool**

Create `apps/web/scripts/debug-vercel-deploy.ts`:

```ts
// apps/web/scripts/debug-vercel-deploy.ts
//
// One-shot debug runner that talks to Vercel directly — no Inngest worker.
// Loads an existing build's project files from Storage, ensures the
// Vercel project exists, syncs env vars, creates a deployment, polls,
// reports outcome. On failure, prints the build log inline.
//
// Usage:
//   pnpm debug:vercel <projectId> <tenantId> <buildId>
//
// Prereqs: same as smoke:deploy.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function main() {
  loadDotEnvLocal();

  const [, , projectId, tenantId, buildId] = process.argv;
  if (!projectId || !tenantId || !buildId) {
    console.error("Usage: pnpm debug:vercel <projectId> <tenantId> <buildId>");
    process.exit(1);
  }

  // Late imports — these depend on env vars being loaded first.
  const { VercelClient } = await import("../lib/vercel/client");
  const { pollDeployment } = await import("../lib/vercel/poll-deployment");
  const { downloadProjectTree, assertRequiredFiles } = await import("../lib/jab/download-project-tree");
  const { decryptColumnToString } = await import("../lib/crypto/encrypt");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const vercelToken = process.env.VERCEL_TOKEN;
  const vercelTeamId = process.env.VERCEL_TEAM_ID;
  if (!supabaseUrl || !serviceKey || !vercelToken || !vercelTeamId) {
    console.error("Missing env vars (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VERCEL_TOKEN, VERCEL_TEAM_ID).");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const vercel = new VercelClient({ token: vercelToken, teamId: vercelTeamId });

  console.log(`[debug] loading project ${projectId}…`);
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, name, wp_url, wp_username, wp_app_password_encrypted, vercel_project_id, vercel_project_name")
    .eq("id", projectId)
    .eq("tenant_id", tenantId)
    .single();
  if (error || !project) {
    console.error(`load-project failed: ${error?.message ?? "no row"}`);
    process.exit(1);
  }

  const slug = project.vercel_project_name
    ?? project.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

  let vercelProject = project.vercel_project_id
    ? { id: project.vercel_project_id, name: slug }
    : null;
  if (!vercelProject) {
    console.log(`[debug] looking up or creating Vercel project '${slug}'…`);
    vercelProject = (await vercel.getProjectByName(slug)) ?? (await vercel.createProject(slug));
  }
  console.log(`[debug] Vercel project: ${vercelProject.id} (${vercelProject.name})`);

  console.log(`[debug] syncing env vars…`);
  const envPlan = [
    { key: "WP_URL", value: project.wp_url },
    { key: "WP_USER", value: project.wp_username ?? "" },
    { key: "WP_APP_PASSWORD", value: decryptColumnToString(project.wp_app_password_encrypted) },
  ];
  const existing = await vercel.listEnvVars(vercelProject.id);
  const existingByKey = new Map(existing.map((e) => [e.key, e]));
  for (const v of envPlan) {
    const found = existingByKey.get(v.key);
    if (found) {
      await vercel.updateEnvVar(vercelProject.id, found.id, v.value);
    } else {
      await vercel.createEnvVar(vercelProject.id, v.key, v.value);
    }
  }

  console.log(`[debug] downloading project tree from Storage…`);
  const files = await downloadProjectTree(supabase, buildId);
  assertRequiredFiles(files.map((f) => f.file));
  console.log(`[debug] ${files.length} files downloaded`);

  console.log(`[debug] creating Vercel deployment…`);
  const deployment = await vercel.createDeployment({
    projectId: vercelProject.id,
    name: vercelProject.name,
    files,
  });
  console.log(`[debug] deployment ${deployment.id} → ${deployment.url} (state: ${deployment.readyState})`);

  console.log(`[debug] polling deployment (10s ticks, 5min cap)…`);
  const result = await pollDeployment({
    client: vercel,
    deploymentId: deployment.id,
    tickMs: 10_000,
    maxMs: 5 * 60 * 1000,
  });
  console.log(`[debug] outcome: ${result.outcome}`);
  if (result.outcome === "READY") {
    console.log(`[debug] ✓ PASS — https://${result.deployment.url}/`);
  } else {
    console.log(`[debug] fetching events log for failure inspection…`);
    const events = await vercel.getDeploymentEvents(deployment.id);
    console.log(`\n--- Vercel build events ---\n${events}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the package.json script**

In `apps/web/package.json` scripts section:

```json
"debug:vercel": "tsx scripts/debug-vercel-deploy.ts"
```

- [ ] **Step 3: Verify the script entry**

Run: `cd apps/web && pnpm debug:vercel 2>&1 | head -3`
Expected: prints usage line then exits 1.

- [ ] **Step 4: Commit**

```bash
git add apps/web/scripts/debug-vercel-deploy.ts apps/web/package.json
git commit -m "🔧 chore(web): debug-vercel-deploy one-shot tool

Same Vercel pipeline as the worker but without Inngest in the loop — direct
client calls, immediate failure surfacing, inline build-events log on
non-READY outcomes. Useful for iterating on Vercel API issues without
burning Inngest replay cycles.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Vercel operator setup runbook

**Files:**
- Create: `docs/superpowers/operator/2026-05-28-vercel-platform-setup.md`

- [ ] **Step 1: Write the runbook**

Create `docs/superpowers/operator/2026-05-28-vercel-platform-setup.md`:

```markdown
# Vercel Platform Setup — JAB SaaS v2 Phase D Prerequisites

> **One-time operator runbook.** Required before the first Phase D build can
> deploy. Sets up the Vercel team, token, and env vars the deploy-site
> worker needs.

## Outcome

After this runbook, the following two env vars are populated in:
- `apps/web/.env.local` (local dev)
- The production worker host's env (Inngest cloud / Vercel cloud / wherever the JAB platform itself runs)

Variables:
- `VERCEL_TOKEN` — an access token with scope `Full Account` on the JAB Platform team
- `VERCEL_TEAM_ID` — the team's stable identifier (looks like `team_xxx`)

## Steps

### 1. Create or confirm the JAB Platform Vercel team

If you already have a Vercel team you'll use for customer site deployments, skip to step 2.

1. Sign in to [vercel.com](https://vercel.com).
2. Top-left team picker → **Create a Team**.
3. Name: `JAB Platform` (or whatever brand name you've landed on).
4. Pricing: the Hobby tier is fine for early customers; bump to Pro when build minutes are the constraint.
5. Save.

### 2. Capture the team ID

1. With the JAB Platform team active, go to **Settings** (left sidebar).
2. Under **General**, look for **Team ID**. It's a string like `team_xxxxxxxxxxxxxxxxxxxxxxxx`.
3. Copy it.

### 3. Generate a service token

1. From any team's context, click the avatar (top-right) → **Account Settings** → **Tokens**.
2. **Create Token**.
3. Name: `jab-platform-worker` (or include the date/host for traceability).
4. Scope: **Full Account** — necessary for `POST /v10/projects` and env-var ops.
5. Expiration: **No expiration** for v1; you can rotate manually later.
6. **Create**. Copy the token IMMEDIATELY — Vercel will not show it again.

### 4. Populate env vars

In `apps/web/.env.local`, add:

```
VERCEL_TOKEN=<paste the token>
VERCEL_TEAM_ID=team_xxxxxxxxxxxxxxxxxxxxxxxx
```

For the production worker host, set the same two env vars via that platform's secret-management UI.

### 5. Verify the token works

From `apps/web/`:

```
pnpm tsx -e "console.log(process.env.VERCEL_TEAM_ID)"
```

Expected: prints the team ID, confirming `.env.local` is loaded.

Then make one cheap API call to verify the token:

```
pnpm tsx -e "fetch('https://api.vercel.com/v9/projects?teamId=' + process.env.VERCEL_TEAM_ID, { headers: { Authorization: 'Bearer ' + process.env.VERCEL_TOKEN } }).then(r => r.json()).then(r => console.log(r.projects?.length ?? 0, 'projects')).catch(console.error)"
```

Expected: prints something like `0 projects` (or however many you have). Anything else (401, 403, malformed JSON) means the token or team ID is wrong.

## What happens if the token is missing at deploy time

The `deploy-site` worker throws `VERCEL_TOKEN not set. See docs/superpowers/operator/2026-05-28-vercel-platform-setup.md` on its first step. The Inngest dev UI surfaces this as the function error; the build sits at `status='building'` (no progress) until the env vars are restored. No partial work is committed — re-running the trigger picks up cleanly.

## Cost model

The free Hobby tier covers small numbers of customer site builds. Roughly:
- Each build: ~$0.40 in Vercel build minutes when on the Pro tier
- Storage egress: negligible for our project size (~150KB tree per build)

Move to Pro when (a) you cross the Hobby build-minute cap, or (b) you need preview environments per build (Phase F polish).

## Rotation

To rotate the token:
1. Repeat step 3 with a new token name.
2. Update `VERCEL_TOKEN` in both `.env.local` and production env.
3. Delete the old token in Vercel's UI.
4. No worker downtime required; the next Phase D run picks up the new token.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/operator/2026-05-28-vercel-platform-setup.md
git commit -m "📝 docs(operator): Vercel platform setup runbook for Phase D

One-time setup: create the JAB Platform team, generate a service token,
populate VERCEL_TOKEN + VERCEL_TEAM_ID in .env.local and production
host env, verify the token works via a curl-equivalent. Documents the
cost model and rotation flow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: CLAUDE.md + roadmap update + Phase D smoke

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md`

- [ ] **Step 1: Run the smoke against Two Roads build 982f0d57**

Two Roads has the Phase C tree composed and ready. Run:

```
cd apps/web
pnpm smoke:deploy 075e33fd-8984-4e48-b58e-a9eab54d1828 01d5b66f-2d9b-42a8-bc5b-109af0b62579 982f0d57-5275-499a-92d8-5f00dc70dba1
```

Expected output:

```
[smoke] dispatching site/deploy.requested for build 982f0d57…
[smoke] status: building
[smoke] status: verifying
[smoke] preview_url: https://two-roads-brewing-new-xxxxxx.vercel.app
[smoke] PASS — preview HEAD returned 200
[smoke] Phase D complete in <90000-180000>ms.
```

If the smoke fails:
- `status='failed'` → fetch `site_builds.build_log_storage_path` from Storage, inspect the Vercel build errors, fix root cause (most likely: WP creds invalid, or a generated component has a tsc error)
- `HEAD returned 4xx/5xx` → the deployment succeeded but Vercel didn't serve it. Usually means our domain or framework detection is wrong; check `vercel.com/dashboard` for the deployment in Vercel's UI.

When the smoke passes, capture a screenshot of `https://<preview_url>/` rendering correctly — this is the success artifact for the PR.

- [ ] **Step 2: Update CLAUDE.md Stage table**

In `CLAUDE.md`, find the Stage table (the SaaS track section) and update Stage 4's row:

```
| 4     | Phase D — Build & Deploy (Next.js project emission + Vercel deploy)                                                              | **Shipped** — validated against the Two Roads pilot smoke (build 982f0d57 deployed to `<preview_url>`).                                                                                                                                                                                                                                                                                                                                                                                                                       |
```

- [ ] **Step 3: Update the roadmap**

In `docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md`, find the Stage 4 row and mark it shipped with a date + smoke build reference. (The roadmap structure has a "status" column or similar; preserve the existing format.)

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md
git commit -m "📝 docs: Phase D — Build & Deploy shipped (Stage 4 of SaaS v2)

Smoke validated against Two Roads build 982f0d57 → live at the captured
preview_url. CLAUDE.md Stage table + roadmap updated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

Run through the spec one more time:

**1. Spec coverage:**
- §1 Goal → Task 13 smoke runner's PASS condition exactly mirrors the spec's "Done = …" criteria. ✓
- §2 Inputs → Task 7 (load-project), Task 5 (download-project-tree), Task 9 (decode + assert). ✓
- §3a Vercel side → Tasks 2-4 (create project, sync env vars), Task 9 (deployment), Task 10 (poll + persist). ✓
- §3b Schema → Task 1. ✓
- §3c Storage → Task 11 (build-log upload). ✓
- §4 Architecture → Tasks 7-11 build the worker step-by-step. ✓
- §5 Vercel API contract → Tasks 2-4 implement each endpoint with explicit tests for the URL shape. ✓
- §6 File-tree download → Task 5. ✓
- §7 Failure modes → Task 11 covers ERROR/CANCELED/TIMEOUT; missing-files is in Task 5 + Task 9; WP creds invalid surfaces as Vercel build error → handled by Task 11. Vercel API non-2xx throws via VercelApiError → Task 2. ✓
- §8 Telemetry → Tasks 10/11 log structured info via console. Future Phase G work can promote. ✓
- §9 Risks → R1 (API drift) Tasks 2-4 wrapping pattern + Task 2 docs-verify step; R2 (cost) noted in runbook; R3 (creds rotation) Task 8 re-syncs every run; R4 (4MB cap) Task 4 guard; R5 (concurrent runs) noted as v1-acceptable in spec, no code change; R6 (poll interval) Task 10 constants tunable. OQ1 (UI surface) is Phase F; OQ2 (webhooks) is v2. ✓
- §10 v1 scope cuts → no Phase F work in this plan. ✓
- §11 Task breakdown → Plan task count matches spec sketch. ✓
- §13 Done criteria → Task 13's smoke is the Done bar. ✓

**2. Placeholder scan:**
- No "TBD" / "TODO" left as gaps. The runbook has a literal example "team_xxxxxxxx" placeholder for the operator to substitute — that's a docs convention, not a plan failure.
- Every step that emits code has the actual code inline. ✓
- "Similar to Task N" — searched, none found. ✓

**3. Type consistency:**
- `VercelClient` interface used identically across Tasks 2-14. ✓
- `VercelProject` ({id, name}), `VercelDeployment` ({id, url, readyState}), `VercelEnvVar` ({id, key, value, type, target}), `ProjectTreeFile` ({file, data, encoding}) — all defined once, referenced consistently. ✓
- `pollDeployment`'s tagged-outcome shape (`READY | ERROR | CANCELED | TIMEOUT`) matches between Task 6 (helper) and Tasks 10-11 (worker branches). ✓
- `slugifyProjectName` defined in Task 7 (worker), referenced in Task 14 (debug tool, inlined for self-containment). The duplication is intentional — the debug tool is allowed to inline rather than reach into worker internals.

No issues found.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-28-saas-v2-phase-d-build-deploy.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
