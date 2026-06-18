import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateEditInput,
  WorkspaceEditError,
} from "@/lib/jab/workspace-edit-validation";

describe("validateEditInput", () => {
  it("accepts a valid component edit", () => {
    expect(() =>
      validateEditInput({
        scope: "component",
        target: "core/heading",
        prompt: "Make the heading larger",
      }),
    ).not.toThrow();
  });

  it("accepts a valid shell edit (header/footer)", () => {
    expect(() =>
      validateEditInput({
        scope: "shell",
        target: "header",
        prompt: "Tighten the spacing around the logo",
      }),
    ).not.toThrow();
    expect(() =>
      validateEditInput({
        scope: "shell",
        target: "footer",
        prompt: "Move the social icons to the right",
      }),
    ).not.toThrow();
  });

  it("rejects scope='page' with a clear message in v1", () => {
    try {
      validateEditInput({
        scope: "component" as "component",
        rawScope: "page",
        target: "homepage",
        prompt: "Some change",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceEditError);
      expect((err as WorkspaceEditError).code).toBe("page_scope_unsupported");
    }
  });

  it("rejects an unknown scope value", () => {
    try {
      validateEditInput({
        scope: "component" as "component",
        rawScope: "wholesite",
        target: "anything",
        prompt: "Some change",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceEditError);
      expect((err as WorkspaceEditError).code).toBe("invalid_scope");
    }
  });

  it("rejects shell target other than header/footer", () => {
    try {
      validateEditInput({
        scope: "shell",
        target: "navbar",
        prompt: "Slim down the nav",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceEditError);
      expect((err as WorkspaceEditError).code).toBe("invalid_target");
    }
  });

  it("rejects an empty component target", () => {
    try {
      validateEditInput({
        scope: "component",
        target: "   ",
        prompt: "A change",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as WorkspaceEditError).code).toBe("invalid_target");
    }
  });

  it("rejects a prompt under 5 characters", () => {
    try {
      validateEditInput({
        scope: "shell",
        target: "header",
        prompt: "tiny",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as WorkspaceEditError).code).toBe("prompt_too_short");
    }
  });
});

// ── requestWorkspaceEditAction — token_delta persistence + dispatch ──────────
//
// vi.hoisted lifts these into the module-mock factory scope so the test bodies
// assert against the SAME references the factories close over.

const {
  mockInngestSend,
  insertedPayloads,
  mockCreateClient,
  mockCreateAdminClient,
} = vi.hoisted(() => {
  const mockInngestSend = vi.fn().mockResolvedValue(undefined);
  const insertedPayloads: unknown[] = [];

  // User (RLS) client: projects select-single → row; site_builds select-single
  // → ready build; auth.getUser → user; workspace_edits insert → captures the
  // payload and returns an id.
  const mockCreateClient = vi.fn(async () => ({
    from: (table: string) => {
      if (table === "workspace_edits") {
        return {
          insert: (payload: unknown) => {
            insertedPayloads.push(payload);
            return {
              select: () => ({
                single: async () => ({ data: { id: "edit-1" }, error: null }),
              }),
            };
          },
        };
      }
      if (table === "site_builds") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: "build-1", status: "ready" },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      // projects
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: { id: "proj-1", tenant_id: "tenant-1" },
              error: null,
            }),
          }),
        }),
      };
    },
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
  }));

  // Admin client (guard reads): latest builds → empty (no active build);
  // open edits → empty (none in review).
  const mockCreateAdminClient = vi.fn(() => ({
    from: (table: string) => {
      if (table === "site_builds") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({ limit: async () => ({ data: [], error: null }) }),
            }),
          }),
        };
      }
      // workspace_edits open-edits read
      return {
        select: () => ({
          eq: () => ({
            in: () => ({ not: async () => ({ data: [], error: null }) }),
          }),
        }),
      };
    },
  }));

  return { mockInngestSend, insertedPayloads, mockCreateClient, mockCreateAdminClient };
});

vi.mock("@/lib/inngest/client", () => ({ inngest: { send: mockInngestSend } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mockCreateClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mockCreateAdminClient }));
vi.mock("@/lib/db/auto-fail-stale-build", () => ({
  autoFailStaleActiveBuild: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/db/auto-fail-stale-open-edits", () => ({
  autoFailStaleOpenEdits: vi.fn().mockResolvedValue(false),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requestWorkspaceEditAction } from "./workspace-edit";
import {
  EDIT_REQUESTED_EVENT,
  type SiteEditRequestedData,
} from "@/lib/inngest/edit-request-event";

afterEach(() => {
  insertedPayloads.length = 0;
  vi.clearAllMocks();
});

describe("requestWorkspaceEditAction — tokens", () => {
  it("persists token_delta and dispatches tokenDelta for a tokens edit", async () => {
    const tokenDelta = { colors: [{ slug: "primary", color: "#c00" }] };

    const { editId } = await requestWorkspaceEditAction({
      projectId: "proj-1",
      sourceBuildId: "build-1",
      scope: "tokens",
      target: "color:primary",
      prompt: "make the brand color red",
      tokenDelta,
    });

    expect(editId).toBe("edit-1");

    // The inserted workspace_edits row carries token_delta.
    const inserted = insertedPayloads[0] as { scope: string; token_delta: unknown };
    expect(inserted.scope).toBe("tokens");
    expect(inserted.token_delta).toEqual(tokenDelta);

    // The dispatched event carries tokenDelta.
    expect(mockInngestSend).toHaveBeenCalledTimes(1);
    const sent = mockInngestSend.mock.calls[0][0] as {
      name: string;
      data: SiteEditRequestedData;
    };
    expect(sent.name).toBe(EDIT_REQUESTED_EVENT);
    expect(sent.data.scope).toBe("tokens");
    expect(sent.data.tokenDelta).toEqual(tokenDelta);
  });

  it("persists token_delta as null when omitted (component edit)", async () => {
    await requestWorkspaceEditAction({
      projectId: "proj-1",
      sourceBuildId: "build-1",
      scope: "component",
      target: "core/heading",
      prompt: "make the heading bigger",
    });
    const inserted = insertedPayloads[0] as { token_delta: unknown };
    expect(inserted.token_delta).toBeNull();
    const sent = mockInngestSend.mock.calls[0][0] as { data: SiteEditRequestedData };
    expect(sent.data.tokenDelta).toBeNull();
  });
});
