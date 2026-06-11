// apps/web/lib/actions/workspace-chat.test.ts
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

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

// These resolve to the MOCKED modules for planEdit/buildSiteMap/
// decideChatTurnOutcome/EditBudgetError, and to the REAL SDK for Anthropic —
// which is exactly what the instanceof checks in the SUT need.
import Anthropic from "@anthropic-ai/sdk";
import { planEdit } from "@/lib/ai/edit-planner";
import { buildSiteMap } from "@/lib/jab/site-map";
import { decideChatTurnOutcome } from "@/lib/jab/chat-turn-outcome";
import { EditBudgetError } from "@/lib/ai/edit-cost-guard";

// ── helpers ───────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

/**
 * Build an admin client mock whose per-table behaviour is driven by
 * `tableHandlers` — a map of table-name → { select?, insert?, update? }.
 * Any table or operation not listed falls back to safe no-op defaults.
 *
 * This lets individual tests override exactly the table interactions they care
 * about without affecting unrelated tables in the same flow.
 *
 * Chain shapes used by the SUT:
 *
 *   conversations.select:
 *     .select("id").eq(...).order(...).limit(...).maybeSingle()  [fast-path]
 *     .select("id").eq(...).maybeSingle()                        [winner re-select]
 *
 *   conversations.insert:
 *     .insert({...}).select("id").single()
 *
 *   conversations.update:
 *     .update({...}).eq(...)                                     [touchConversation]
 *
 *   chat_messages.insert (user msg):
 *     await admin.from("chat_messages").insert({...})            [bare — destructures {error}]
 *
 *   chat_messages.update:
 *     .update({...}).eq(...)
 *
 *   site_builds.select:
 *     .select("id").eq(...).eq(...).order(...).limit(...).maybeSingle()
 */
function makeAdminMock(
  tableHandlers: Record<
    string,
    {
      select?: () => Promise<{ data: unknown; error: unknown }>;
      insert?: (payload?: unknown) => Promise<{ data: unknown; error: unknown }>;
      update?: () => Promise<{ data: unknown; error: unknown }>;
    }
  > = {},
) {
  return {
    from: (table: string) => {
      const h = tableHandlers[table] ?? {};

      // select chain — handles both:
      //   .select().eq().order().limit().maybeSingle()
      //   .select().eq().maybeSingle()
      const selectFn = h.select ?? (() => Promise.resolve({ data: null, error: null }));
      const selectChain = () => {
        // terminal node: can call maybeSingle() or single()
        const terminal = () => ({
          maybeSingle: selectFn,
          single: selectFn,
        });
        // after .limit() → terminal
        const afterLimit = terminal();
        // after .order() → can chain .limit() or go terminal
        const afterOrder = { ...terminal(), limit: () => afterLimit };
        // after second .eq() → can chain .order() or go terminal
        const afterEq2 = { ...terminal(), order: () => afterOrder };
        // after first .eq() → can chain another .eq(), .order(), or terminal
        const afterEq1 = { ...terminal(), eq: () => afterEq2, order: () => afterOrder };
        return { eq: () => afterEq1 };
      };

      // insert chain:
      //   .insert({}).select("id").single()      — conversations insert
      //   await .insert({})                       — chat_messages bare insert
      //   (the bare form works because we return a thenable object)
      // The payload is threaded to the handler so tests can assert on what
      // was persisted (e.g. the plan jsonb carrying plannerMeta).
      const insertFn = h.insert ?? (() => Promise.resolve({ data: null, error: null }));
      const insertChain = (payload: unknown) => {
        const result = {
          then: (
            resolve: (v: { data: unknown; error: unknown }) => unknown,
            reject: (e: unknown) => unknown,
          ) => insertFn(payload).then(resolve, reject),
          catch: (reject: (e: unknown) => unknown) => insertFn(payload).catch(reject),
          // chained form: .select("id").single()
          select: () => ({
            single: () => insertFn(payload),
          }),
        };
        return result;
      };

      // update chain: .update({}).eq(...)
      const updateFn = h.update ?? (() => Promise.resolve({ data: null, error: null }));
      const updateChain = (_payload: unknown) => ({ eq: () => updateFn() });

      return {
        select: selectChain,
        insert: insertChain,
        update: updateChain,
      };
    },
  };
}

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

describe("sendChatMessageAction — ensureConversation race + message persistence", () => {
  // Common setup: RLS client returns a valid project row + authenticated user.
  // Used in every test in this suite.
  function stubProjectResolved() {
    mockCreateClient.mockImplementation(async () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            single: vi.fn().mockResolvedValue({
              data: { id: "proj1", tenant_id: "tenant1" },
              error: null,
            }),
          }),
        }),
      }),
      auth: { getUser: async () => ({ data: { user: { id: "user1" } } }) },
    }));
  }

  // (a) ensureConversation returns the race winner on 23505
  //
  // Flow driven to the "no completed build" early-exit so the test stays short:
  //   conversations fast-path select → null (no existing conversation)
  //   conversations insert → 23505 duplicate-key error
  //   conversations winner re-select → { id: "conv-w" }
  //   chat_messages insert (user message) → success
  //   conversations update (touch updated_at) → success
  //   site_builds ready select → null  ← flow returns "no completed build" reply
  //     which calls writeAssistant → ensureConversation (already has id) → insertAssistant
  //     insertAssistant calls chat_messages.insert({...}).select().single() → returns assistant row
  it("ensureConversation returns the race winner on 23505 and proceeds with correct conversation_id", async () => {
    vi.stubEnv("JAB_CHAT_EDIT", "1");
    stubProjectResolved();

    let convSelectCallCount = 0;

    // The assistant row returned by insertAssistant (used in writeAssistant → "no build" path).
    const assistantRow = {
      id: "msg-asst-1",
      role: "assistant",
      content: "There's no completed build to edit yet. Build the site first, then ask me to change something.",
      needs_clarification: true,
      edit_id: null,
      build_id: null,
      created_at: new Date().toISOString(),
    };

    // chat_messages.insert must handle TWO shapes:
    //   1. bare await: `await admin.from("chat_messages").insert({role:"user",...})`
    //      → destructures `{error}` only (user message insert, step 4)
    //   2. chained: `.insert({role:"assistant",...}).select(...).single()`
    //      → used by insertAssistant (step 9 / writeAssistant path)
    // Both are routed through the same `insertFn` in makeAdminMock.
    // We use a counter: first call = user-msg (bare), second = assistant (chained .single()).
    let chatMsgInsertCallCount = 0;
    const chatMsgInsertFn = async () => {
      chatMsgInsertCallCount += 1;
      if (chatMsgInsertCallCount === 1) {
        // user message bare insert — just needs {error: null}
        return { data: null, error: null };
      }
      // assistant message chained .select().single() — needs the full row
      return { data: assistantRow, error: null };
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockCreateAdminClient as Mock<any>).mockReturnValue(
      makeAdminMock({
        conversations: {
          select: async () => {
            convSelectCallCount += 1;
            // First call = fast-path (no existing conv)
            if (convSelectCallCount === 1) return { data: null, error: null };
            // Second call = winner re-select after 23505
            // (writeAssistant's ensureConversation also fast-paths via this same select,
            //  but by then convSelectCallCount >= 2 so they all get the winner row — correct)
            return { data: { id: "conv-w" }, error: null };
          },
          insert: async () => ({
            data: null,
            error: { code: "23505", message: "duplicate key value violates unique constraint" },
          }),
          update: async () => ({ data: null, error: null }),
        },
        chat_messages: {
          insert: chatMsgInsertFn,
          update: async () => ({ data: null, error: null }),
        },
        site_builds: {
          // no ready build → flow takes the "no completed build" assistant branch
          select: async () => ({ data: null, error: null }),
        },
      }),
    );

    const result = await sendChatMessageAction({ projectId: "proj1", content: "make it green" });

    // The "no completed build" branch returns a needs_clarification assistant reply.
    expect(result.assistant.needsClarification).toBe(true);
    expect(result.assistant.content).toMatch(/no completed build/i);
    // ensureConversation must have reached the winner re-select path (at minimum 2 selects).
    expect(convSelectCallCount).toBeGreaterThanOrEqual(2);
  });

  // (b) throws loudly when the user message insert fails
  //
  // Flow: conversation already exists (fast-path hit) → user-message insert fails.
  it("throws loudly when the user message insert fails", async () => {
    vi.stubEnv("JAB_CHAT_EDIT", "1");
    stubProjectResolved();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockCreateAdminClient as Mock<any>).mockReturnValue(
      makeAdminMock({
        conversations: {
          // fast-path: existing conversation
          select: async () => ({ data: { id: "conv-existing" }, error: null }),
          update: async () => ({ data: null, error: null }),
        },
        chat_messages: {
          // user-message insert → DB error
          insert: async () => ({ data: null, error: { message: "boom" } }),
        },
      }),
    );

    await expect(
      sendChatMessageAction({ projectId: "proj1", content: "make it blue" }),
    ).rejects.toThrow(/failed to persist user message: boom/i);
  });
});

describe("sendChatMessageAction — planner failure handling (Phase 5)", () => {
  function stubProjectResolved() {
    mockCreateClient.mockImplementation(async () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            single: vi.fn().mockResolvedValue({
              data: { id: "proj1", tenant_id: "tenant1" },
              error: null,
            }),
          }),
        }),
      }),
      auth: { getUser: async () => ({ data: { user: { id: "user1" } } }) },
    }));
  }

  const minimalSiteMap = {
    blockTypes: [],
    pageSlugs: [],
    shell: { header: false, footer: false },
  };

  /**
   * Admin mock that drives the flow all the way to planEdit:
   * conversation exists → user msg insert ok → ready build present →
   * (mocked) site map → (mocked) planEdit. Captures every chat_messages
   * insert payload so tests can assert on persisted content/plan jsonb.
   */
  function adminMockReachingPlanner() {
    const chatInserts: unknown[] = [];
    const admin = makeAdminMock({
      conversations: {
        select: async () => ({ data: { id: "conv-1" }, error: null }),
        update: async () => ({ data: null, error: null }),
      },
      chat_messages: {
        insert: async (payload?: unknown) => {
          chatInserts.push(payload);
          if (chatInserts.length === 1) {
            // user message — bare insert, destructures {error} only
            return { data: null, error: null };
          }
          // assistant message — chained .select().single() needs a full row
          const p = payload as { content?: string; needs_clarification?: boolean };
          return {
            data: {
              id: `msg-asst-${chatInserts.length}`,
              role: "assistant",
              content: p?.content ?? "",
              needs_clarification: p?.needs_clarification === true,
              edit_id: null,
              build_id: null,
              created_at: new Date().toISOString(),
            },
            error: null,
          };
        },
        // loadPlannerMessages awaits .select().eq().order() with no terminal —
        // makeAdminMock's non-thenable chain node makes `data` undefined and
        // the SUT coerces to [] (empty history). planEdit is mocked, so the
        // history content is irrelevant here.
        update: async () => ({ data: null, error: null }),
      },
      site_builds: {
        select: async () => ({ data: { id: "build-1" }, error: null }),
      },
    });
    return { admin, chatInserts };
  }

  function arm() {
    vi.stubEnv("JAB_CHAT_EDIT", "1");
    stubProjectResolved();
    const { admin, chatInserts } = adminMockReachingPlanner();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockCreateAdminClient as Mock<any>).mockReturnValue(admin);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (buildSiteMap as Mock<any>).mockResolvedValue(minimalSiteMap);
    return { chatInserts };
  }

  it("converts an Anthropic RateLimitError into a persisted assistant notice — no dangling turn, no raw throw", async () => {
    const { chatInserts } = arm();
    // Construct via the prototype so instanceof Anthropic.RateLimitError (and
    // the base Anthropic.APIError) hold WITHOUT depending on the SDK error
    // constructor signature (status/error/message/headers ordering varies
    // across SDK versions).
    const rateLimitErr = Object.assign(Object.create(Anthropic.RateLimitError.prototype), {
      status: 429,
      message: "rate limited",
      name: "RateLimitError",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (planEdit as Mock<any>).mockRejectedValue(rateLimitErr);

    const result = await sendChatMessageAction({ projectId: "proj1", content: "make it bolder" });

    expect(result.assistant.needsClarification).toBe(true);
    expect(result.assistant.content).toMatch(/overloaded|busy|try again/i);
    // user message (insert 1) AND assistant notice (insert 2) both persisted
    expect(chatInserts).toHaveLength(2);
  });

  it("rethrows a non-API error (genuine fault) instead of masking it as a chat reply", async () => {
    arm();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (planEdit as Mock<any>).mockRejectedValue(new TypeError("boom"));
    await expect(
      sendChatMessageAction({ projectId: "proj1", content: "make it bolder" }),
    ).rejects.toThrow("boom");
  });

  it("converts a planner_cost_cap EditBudgetError from planEdit into an assistant notice", async () => {
    const { chatInserts } = arm();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (planEdit as Mock<any>).mockRejectedValue(
      new EditBudgetError("planner_cost_cap", "This conversation has grown too large to plan against."),
    );
    const result = await sendChatMessageAction({ projectId: "proj1", content: "make it bolder" });
    expect(result.assistant.needsClarification).toBe(true);
    expect(result.assistant.content).toMatch(/too large/i);
    expect(chatInserts).toHaveLength(2);
  });

  it("surfaces a DISTINCT notice on max_tokens truncation and stamps plannerMeta into the plan jsonb", async () => {
    const { chatInserts } = arm();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (planEdit as Mock<any>).mockResolvedValue({
      plan: {
        needsClarification: true,
        scope: "component",
        target: "",
        action: "",
        regenerationPrompt: "",
        clarifyingQuestion: "Could you describe the change in more detail?",
      },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      plannerMeta: { stopReason: "max_tokens", retriedForMaxTokens: true },
    });

    const result = await sendChatMessageAction({ projectId: "proj1", content: "redo everything" });

    // distinct truncation message — NEVER the generic clarify fallback
    expect(result.assistant.content).toMatch(/too complex/i);
    expect(result.assistant.content).not.toMatch(/describe the change in more detail/i);
    // telemetry mark inside the existing plan jsonb (no migration)
    const assistantPayload = chatInserts[1] as {
      plan?: { plannerMeta?: { stopReason?: string; retriedForMaxTokens?: boolean } };
    };
    expect(assistantPayload.plan?.plannerMeta).toEqual({
      stopReason: "max_tokens",
      retriedForMaxTokens: true,
    });
  });

  it("stamps plannerMeta on a normal clarify turn too", async () => {
    const { chatInserts } = arm();
    const plan = {
      needsClarification: true,
      scope: "component",
      target: "",
      action: "",
      regenerationPrompt: "",
      clarifyingQuestion: "Which block?",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (planEdit as Mock<any>).mockResolvedValue({
      plan,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      plannerMeta: { stopReason: "tool_use", retriedForMaxTokens: false },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (decideChatTurnOutcome as Mock<any>).mockReturnValue({
      kind: "clarify",
      message: "Which block?",
      plan,
    });

    const result = await sendChatMessageAction({ projectId: "proj1", content: "make it nicer" });

    expect(result.assistant.content).toBe("Which block?");
    const assistantPayload = chatInserts[1] as {
      plan?: { plannerMeta?: { stopReason?: string } };
    };
    expect(assistantPayload.plan?.plannerMeta?.stopReason).toBe("tool_use");
  });
});
