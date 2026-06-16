import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";
import { loadWorkspaceEditHistory } from "./workspace-edit-history";

function makeChain(result: { data: unknown; error: unknown }) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadWorkspaceEditHistory", () => {
  it("uses the RLS-scoped user client (createClient), scoped to projectId", async () => {
    const chain = makeChain({ data: [], error: null });
    (createClient as ReturnType<typeof vi.fn>).mockResolvedValue(chain);

    await loadWorkspaceEditHistory("project-1", 5);

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(chain.from).toHaveBeenCalledWith("workspace_edits");
    expect(chain.eq).toHaveBeenCalledWith("project_id", "project-1");
    expect(chain.limit).toHaveBeenCalledWith(5);
  });

  it("defaults the limit to 10 when omitted", async () => {
    const chain = makeChain({ data: [], error: null });
    (createClient as ReturnType<typeof vi.fn>).mockResolvedValue(chain);

    await loadWorkspaceEditHistory("project-1");

    expect(chain.limit).toHaveBeenCalledWith(10);
  });

  it("maps DB rows to the camelCased shape callers expect", async () => {
    const chain = makeChain({
      data: [
        {
          id: "e1",
          scope: "component",
          target: "core/heading",
          prompt: "p",
          status: "completed",
          result_build_id: "b2",
          error_text: null,
          created_at: "2026-06-03T00:00:00Z",
          finished_at: "2026-06-03T00:01:00Z",
        },
      ],
      error: null,
    });
    (createClient as ReturnType<typeof vi.fn>).mockResolvedValue(chain);

    const out = await loadWorkspaceEditHistory("project-1");

    expect(out).toEqual([
      {
        id: "e1",
        scope: "component",
        target: "core/heading",
        prompt: "p",
        status: "completed",
        resultBuildId: "b2",
        errorText: null,
        createdAt: "2026-06-03T00:00:00Z",
        finishedAt: "2026-06-03T00:01:00Z",
      },
    ]);
  });

  it("returns [] when the query returns null data", async () => {
    const chain = makeChain({ data: null, error: null });
    (createClient as ReturnType<typeof vi.fn>).mockResolvedValue(chain);

    expect(await loadWorkspaceEditHistory("p")).toEqual([]);
  });

  it("rethrows the supabase error", async () => {
    const chain = makeChain({ data: null, error: { message: "boom" } });
    (createClient as ReturnType<typeof vi.fn>).mockResolvedValue(chain);

    await expect(loadWorkspaceEditHistory("p")).rejects.toMatchObject({
      message: "boom",
    });
  });
});
