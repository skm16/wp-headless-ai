// apps/web/lib/actions/workspace-chat.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── mocks — declared before any SUT import ──────────────────────────────────
//
// vi.hoisted lifts these into the module-mock factory scope so the closures
// that vi.mock() factory functions close over the *same* references that the
// test bodies assert against.

const {
  mockCreateClient,
  mockCreateAdminClient,
  mockAssertEditBudget,
} = vi.hoisted(() => {
  // User (RLS) client — default: authenticated user, project not found (PGRST116)
  const mockSingle = vi.fn().mockResolvedValue({
    data: null,
    error: { code: "PGRST116", message: "not found" },
  });
  const mockCreateClient = vi.fn(async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: mockSingle }) }),
    }),
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
  }));

  // Admin client — not needed for tests (a)-(d) early exits, stub to no-op
  const mockCreateAdminClient = vi.fn(() => ({
    from: () => ({
      select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }),
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: "conv1" }, error: null }) }) }),
      update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
    }),
  }));

  const mockAssertEditBudget = vi.fn().mockResolvedValue(undefined);

  return { mockCreateClient, mockCreateAdminClient, mockAssertEditBudget };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: mockCreateClient,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mockCreateAdminClient,
}));

vi.mock("@/lib/ai/edit-cost-guard", () => ({
  assertEditBudget: mockAssertEditBudget,
  EditBudgetError: class EditBudgetError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "EditBudgetError";
    }
  },
  MAX_CHAT_CONTENT_CHARS: 4000,
}));

// Stub modules that are only reached after the early-exit gates under test.
// Mocking them prevents any load-time side-effects (inngest env reads, etc.)
// from polluting these targeted unit tests.
vi.mock("@/lib/jab/site-map", () => ({ buildSiteMap: vi.fn() }));
vi.mock("@/lib/ai/edit-planner", () => ({
  planEdit: vi.fn(),
  AnthropicPlannerClient: class {},
}));
vi.mock("@/lib/jab/chat-turn-outcome", () => ({ decideChatTurnOutcome: vi.fn() }));
vi.mock("@/lib/actions/workspace-edit", () => ({
  requestWorkspaceEditAction: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ── SUT import (after all mocks) ─────────────────────────────────────────────
import { sendChatMessageAction } from "./workspace-chat";

// ── helpers ───────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("sendChatMessageAction — gate + ordering", () => {
  // (a) Feature flag gate fires before any client work
  it("rejects when JAB_CHAT_EDIT is not '1' before any client work", async () => {
    vi.stubEnv("JAB_CHAT_EDIT", "");

    await expect(
      sendChatMessageAction({ projectId: "p1", content: "hi" }),
    ).rejects.toThrow(/disabled/i);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockAssertEditBudget).not.toHaveBeenCalled();
  });

  // (b) Empty content rejected before budget guard
  it("rejects empty content after trim", async () => {
    vi.stubEnv("JAB_CHAT_EDIT", "1");

    await expect(
      sendChatMessageAction({ projectId: "p1", content: "   " }),
    ).rejects.toThrow(/empty/i);

    expect(mockAssertEditBudget).not.toHaveBeenCalled();
  });

  // (c) Over-cap content rejected before budget guard
  it("rejects over-cap content", async () => {
    vi.stubEnv("JAB_CHAT_EDIT", "1");

    await expect(
      sendChatMessageAction({ projectId: "p1", content: "x".repeat(4001) }),
    ).rejects.toThrow(/too long/i);

    expect(mockAssertEditBudget).not.toHaveBeenCalled();
  });

  // (d) Membership check runs before budget guard
  //
  // resolveProject calls createClient() then does an RLS SELECT on projects.
  // When that returns PGRST116, it throws WorkspaceEditError("not_found").
  // assertEditBudget must never be called in that path.
  it("membership check runs before the budget guard", async () => {
    vi.stubEnv("JAB_CHAT_EDIT", "1");

    // mockCreateClient already defaults to PGRST116 project-not-found
    await expect(
      sendChatMessageAction({ projectId: "p1", content: "make it bolder" }),
    ).rejects.toThrow(/not found/i);

    expect(mockCreateClient).toHaveBeenCalled();
    expect(mockAssertEditBudget).not.toHaveBeenCalled();
  });
});
