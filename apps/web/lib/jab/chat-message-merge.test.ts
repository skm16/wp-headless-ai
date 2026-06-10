import { describe, it, expect } from "vitest";
import { mergeChatMessages } from "./chat-message-merge";
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
});
