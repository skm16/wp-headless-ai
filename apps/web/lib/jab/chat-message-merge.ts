import type { ChatMessageView } from "@/lib/actions/workspace-chat";

/**
 * chat-message-merge — pure reconciliation between the server transcript
 * (fresh initialMessages after a router.refresh) and ChatPanel's client
 * state (which may hold optimistic/in-flight entries).
 *
 * Rules:
 *  - Server rows are authoritative: a local copy of a server id is dropped
 *    in favor of the server version (which may carry a backfilled buildId
 *    or error-patched content).
 *  - `optimistic-*` user rows survive until a server row with the same
 *    role+content exists (the persisted twin), then yield to it.
 *  - `err-*` assistant notices are client-only; they always survive.
 *  - Output sorted by createdAt ascending (ties keep server-first order).
 */
const LOCAL_ID_PREFIXES = ["optimistic-", "err-"] as const;

function isLocalOnlyId(id: string): boolean {
  return LOCAL_ID_PREFIXES.some((p) => id.startsWith(p));
}

export function mergeChatMessages(
  server: ChatMessageView[],
  local: ChatMessageView[],
): ChatMessageView[] {
  const keptLocal = local.filter((m) => {
    if (!isLocalOnlyId(m.id)) return false; // server version wins
    if (m.id.startsWith("optimistic-")) {
      return !server.some((s) => s.role === "user" && s.content === m.content);
    }
    return true; // err- notice
  });
  return [...server, ...keptLocal].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}
