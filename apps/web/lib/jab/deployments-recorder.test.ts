import { describe, it, expect, vi } from "vitest";
import {
  recordDeployment,
  supersedePreviousProductionDeployments,
} from "./deployments-recorder";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Builds a thin mock of the slice of the Supabase client surface that
 * deployments-recorder uses. The chainable `from().insert().select().single()`
 * and `from().update().eq()...select()` chains return shared spies so each
 * test can assert the call shape + the returned data.
 */
function mockInsertClient(result: {
  data?: { id: string } | null;
  error?: { message: string } | null;
}): {
  client: SupabaseClient;
  insertSpy: ReturnType<typeof vi.fn>;
  selectSpy: ReturnType<typeof vi.fn>;
  singleSpy: ReturnType<typeof vi.fn>;
} {
  const singleSpy = vi.fn().mockResolvedValue({
    data: result.data ?? null,
    error: result.error ?? null,
  });
  const selectSpy = vi.fn().mockReturnValue({ single: singleSpy });
  const insertSpy = vi.fn().mockReturnValue({ select: selectSpy });
  const fromSpy = vi.fn().mockReturnValue({ insert: insertSpy });
  const client = { from: fromSpy } as unknown as SupabaseClient;
  return { client, insertSpy, selectSpy, singleSpy };
}

function mockSupersedeClient(result: {
  data?: Array<{ id: string }> | null;
  error?: { message: string } | null;
}): {
  client: SupabaseClient;
  updateSpy: ReturnType<typeof vi.fn>;
  eqCalls: Array<[string, string]>;
  neqCalls: Array<[string, string]>;
} {
  const eqCalls: Array<[string, string]> = [];
  const neqCalls: Array<[string, string]> = [];
  // Chainable filter: each `.eq()` records its args and returns the same
  // object so the next link in the chain works. `.select()` resolves.
  const chain: Record<string, unknown> = {};
  chain.eq = vi.fn().mockImplementation((col: string, val: string) => {
    eqCalls.push([col, val]);
    return chain;
  });
  chain.neq = vi.fn().mockImplementation((col: string, val: string) => {
    neqCalls.push([col, val]);
    return chain;
  });
  chain.select = vi.fn().mockResolvedValue({
    data: result.data ?? null,
    error: result.error ?? null,
  });
  const updateSpy = vi.fn().mockReturnValue(chain);
  const client = {
    from: vi.fn().mockReturnValue({ update: updateSpy }),
  } as unknown as SupabaseClient;
  return { client, updateSpy, eqCalls, neqCalls };
}

describe("recordDeployment", () => {
  it("inserts a preview ready row with ready_at populated", async () => {
    const { client, insertSpy } = mockInsertClient({
      data: { id: "dep_aaa" },
    });
    const result = await recordDeployment(client, {
      buildId: "build_1",
      projectId: "proj_1",
      environment: "preview",
      status: "ready",
      providerDeploymentId: "dpl_xxx",
      url: "https://x.vercel.app",
    });
    expect(result.id).toBe("dep_aaa");
    const insertArg = insertSpy.mock.calls[0]?.[0];
    expect(insertArg).toMatchObject({
      site_build_id: "build_1",
      project_id: "proj_1",
      environment: "preview",
      status: "ready",
      provider: "vercel",
      provider_deployment_id: "dpl_xxx",
      url: "https://x.vercel.app",
      promoted_from_deployment_id: null,
      build_log_excerpt: null,
    });
    expect(typeof insertArg.ready_at).toBe("string");
    expect(insertArg.ready_at).not.toBeNull();
  });

  it("inserts a failed row with ready_at=null and tolerates missing url", async () => {
    const { client, insertSpy } = mockInsertClient({
      data: { id: "dep_bbb" },
    });
    await recordDeployment(client, {
      buildId: "build_1",
      projectId: "proj_1",
      environment: "preview",
      status: "failed",
      providerDeploymentId: "dpl_yyy",
      url: null,
    });
    const insertArg = insertSpy.mock.calls[0]?.[0];
    expect(insertArg.status).toBe("failed");
    expect(insertArg.url).toBeNull();
    expect(insertArg.ready_at).toBeNull();
  });

  it("includes promoted_from_deployment_id on the production-promote insert", async () => {
    const { client, insertSpy } = mockInsertClient({
      data: { id: "dep_prod" },
    });
    await recordDeployment(client, {
      buildId: "build_1",
      projectId: "proj_1",
      environment: "production",
      status: "ready",
      providerDeploymentId: "dpl_xxx",
      url: "https://x.vercel.app",
      promotedFromDeploymentId: "dep_aaa",
    });
    const insertArg = insertSpy.mock.calls[0]?.[0];
    expect(insertArg.environment).toBe("production");
    expect(insertArg.promoted_from_deployment_id).toBe("dep_aaa");
  });

  it("throws when supabase returns an error", async () => {
    const { client } = mockInsertClient({
      data: null,
      error: { message: "constraint violation" },
    });
    await expect(
      recordDeployment(client, {
        buildId: "b",
        projectId: "p",
        environment: "preview",
        status: "ready",
        providerDeploymentId: "dpl_x",
      }),
    ).rejects.toThrow(/constraint violation/);
  });
});

describe("supersedePreviousProductionDeployments", () => {
  it("supersedes prior production rows except the one just promoted", async () => {
    const { client, updateSpy, eqCalls, neqCalls } = mockSupersedeClient({
      data: [{ id: "old_1" }, { id: "old_2" }],
    });
    const result = await supersedePreviousProductionDeployments(client, {
      projectId: "proj_1",
      keepDeploymentId: "dep_new",
    });
    expect(result.supersededCount).toBe(2);
    expect(updateSpy).toHaveBeenCalledWith({ status: "superseded" });
    expect(eqCalls).toContainEqual(["project_id", "proj_1"]);
    expect(eqCalls).toContainEqual(["environment", "production"]);
    expect(eqCalls).toContainEqual(["status", "ready"]);
    expect(neqCalls).toContainEqual(["id", "dep_new"]);
  });

  it("returns supersededCount=0 when no prior production rows exist", async () => {
    const { client } = mockSupersedeClient({ data: [] });
    const result = await supersedePreviousProductionDeployments(client, {
      projectId: "proj_1",
      keepDeploymentId: "dep_new",
    });
    expect(result.supersededCount).toBe(0);
  });

  it("throws when supabase returns an error", async () => {
    const { client } = mockSupersedeClient({
      error: { message: "RLS denied" },
    });
    await expect(
      supersedePreviousProductionDeployments(client, {
        projectId: "p",
        keepDeploymentId: "k",
      }),
    ).rejects.toThrow(/RLS denied/);
  });
});
