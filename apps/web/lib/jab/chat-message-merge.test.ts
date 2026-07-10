import { describe, it, expect } from "vitest";
import { mergeChatMessages, chatTranscriptsEqual } from "./chat-message-merge";
import type { ChatMessageView } from "@/lib/actions/workspace-chat";

function msg(over: Partial<ChatMessageView>): ChatMessageView {
  return {
    id: "m1",
    role: "user",
    content: "hello",
    needsClarification: false,
    editId: null,
    buildId: null,
    createdAt: "2026-06-10T12:00:00.000Z",
    ...over,
    editStatus: over.editStatus ?? null,
    editError: over.editError ?? null,
    batchRemaining: over.batchRemaining ?? [],
  };
}

describe("mergeChatMessages", () => {
  it("server rows win over local copies with the same id (worker backfilled buildId)", () => {
    const local = [msg({ id: "a1", role: "assistant", content: "On it.", buildId: null })];
    const server = [msg({ id: "a1", role: "assistant", content: "On it.", editId: "e1", buildId: "b1" })];
    const merged = mergeChatMessages(server, local);
    expect(merged).toHaveLength(1);
    expect(merged[0].buildId).toBe("b1");
  });

  it("keeps an optimistic user message the server hasn't persisted yet", () => {
    const local = [msg({ id: "optimistic-1", content: "make it teal", createdAt: "2026-06-10T12:00:02.000Z" })];
    const server = [msg({ id: "u0", content: "earlier turn", createdAt: "2026-06-10T12:00:00.000Z" })];
    const merged = mergeChatMessages(server, local);
    expect(merged.map((m) => m.id)).toEqual(["u0", "optimistic-1"]);
  });

  it("drops an optimistic user message once a server row with the same content exists", () => {
    const local = [msg({ id: "optimistic-1", content: "make it teal" })];
    const server = [msg({ id: "u1", content: "make it teal" })];
    const merged = mergeChatMessages(server, local);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("u1");
  });

  it("keeps local err- notices (they exist only client-side)", () => {
    const local = [
      msg({ id: "err-1", role: "assistant", content: "Something went wrong sending that. Please try again.", needsClarification: true, createdAt: "2026-06-10T12:00:05.000Z" }),
    ];
    const server = [msg({ id: "u1", createdAt: "2026-06-10T12:00:00.000Z" })];
    const merged = mergeChatMessages(server, local);
    expect(merged.map((m) => m.id)).toEqual(["u1", "err-1"]);
  });

  it("orders the result by createdAt ascending", () => {
    const server = [
      msg({ id: "u2", createdAt: "2026-06-10T12:00:10.000Z" }),
      msg({ id: "u1", createdAt: "2026-06-10T12:00:00.000Z" }),
    ];
    const merged = mergeChatMessages(server, []);
    expect(merged.map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  it("is idempotent — merging the same inputs twice yields the same result", () => {
    const local = [msg({ id: "optimistic-1", content: "x", createdAt: "2026-06-10T12:00:02.000Z" })];
    const server = [msg({ id: "u1", content: "y", createdAt: "2026-06-10T12:00:00.000Z" })];
    const once = mergeChatMessages(server, local);
    const twice = mergeChatMessages(server, once);
    expect(twice).toEqual(once);
  });

  it("keeps a real-id local row the server snapshot hasn't caught up to (stale-snapshot race)", () => {
    // The action returned the assistant row (real id) and the client appended
    // it; a refresh whose RSC render predates the insert must not blink it away.
    const local = [msg({ id: "a9", role: "assistant", content: "On it.", editId: "e1", createdAt: "2026-06-10T12:00:03.000Z" })];
    const server = [msg({ id: "u1", createdAt: "2026-06-10T12:00:00.000Z" })];
    const merged = mergeChatMessages(server, local);
    expect(merged.map((m) => m.id)).toEqual(["u1", "a9"]);
  });
});

describe("chatTranscriptsEqual", () => {
  it("true for transcripts equal on id/content/buildId/needsClarification", () => {
    const a = [msg({ id: "u1" }), msg({ id: "a1", role: "assistant", buildId: "b1" })];
    const b = [msg({ id: "u1" }), msg({ id: "a1", role: "assistant", buildId: "b1" })];
    expect(chatTranscriptsEqual(a, b)).toBe(true);
  });

  it("false when a buildId was backfilled", () => {
    const a = [msg({ id: "a1", role: "assistant", buildId: null })];
    const b = [msg({ id: "a1", role: "assistant", buildId: "b1" })];
    expect(chatTranscriptsEqual(a, b)).toBe(false);
  });

  it("false on length or order difference", () => {
    expect(chatTranscriptsEqual([msg({ id: "u1" })], [])).toBe(false);
    expect(
      chatTranscriptsEqual(
        [msg({ id: "u1" }), msg({ id: "u2" })],
        [msg({ id: "u2" }), msg({ id: "u1" })],
      ),
    ).toBe(false);
  });
});

function baseMessage(over: Partial<ChatMessageView> = {}): ChatMessageView {
  return {
    id: "msg-1",
    role: "assistant",
    content: "Regenerate the Hero.",
    needsClarification: false,
    editId: "edit-1",
    buildId: null,
    createdAt: "2026-07-09T00:00:00.000Z",
    ...over,
    editStatus: over.editStatus ?? "queued",
    editError: over.editError ?? null,
    batchRemaining: over.batchRemaining ?? [],
  };
}

describe("chatTranscriptsEqual — editStatus/editError sensitivity", () => {
  it("treats a queued->completed editStatus change as NOT equal", () => {
    const a = [baseMessage({ editStatus: "queued" })];
    const b = [baseMessage({ editStatus: "completed" })];
    expect(chatTranscriptsEqual(a, b)).toBe(false);
  });

  it("treats a newly-populated editError as NOT equal", () => {
    const a = [baseMessage({ editStatus: "running", editError: null })];
    const b = [baseMessage({ editStatus: "failed", editError: "boom" })];
    expect(chatTranscriptsEqual(a, b)).toBe(false);
  });

  it("still treats fully identical transcripts as equal", () => {
    const a = [baseMessage()];
    const b = [baseMessage()];
    expect(chatTranscriptsEqual(a, b)).toBe(true);
  });
});
