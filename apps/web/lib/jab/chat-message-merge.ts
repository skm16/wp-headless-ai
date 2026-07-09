import type { ChatMessageView } from "@/lib/actions/workspace-chat";

/**
 * chat-message-merge — pure reconciliation between the server transcript
 * (fresh initialMessages after a router.refresh) and ChatPanel's client
 * state (which may hold optimistic/in-flight entries).
 *
 * Rules:
 *  - Server wins on id collision: a local copy of a server id is dropped
 *    in favor of the server version (which may carry a backfilled buildId
 *    or error-patched content).
 *  - Real-id local rows the snapshot hasn't caught up to survive (stale-
 *    snapshot race: the RSC render can predate an insert the client already
 *    knows about). Server still wins on id collision.
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
  const serverIds = new Set(server.map((m) => m.id));
  const keptLocal = local.filter((m) => {
    if (!isLocalOnlyId(m.id)) {
      // Real-id row the snapshot hasn't caught up to (stale-snapshot race:
      // the RSC render can predate the insert the client already knows
      // about). Server wins on id collision.
      return !serverIds.has(m.id);
    }
    if (m.id.startsWith("optimistic-")) {
      return !server.some((s) => s.role === "user" && s.content === m.content);
    }
    return true; // err- notice
  });
  return [...server, ...keptLocal].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}

/**
 * Identity-stability guard for the ChatPanel re-sync effect: when a refresh
 * changes nothing the panel must keep the SAME array reference, or the
 * scroll-to-bottom effect (keyed on [messages]) yanks a user who scrolled up
 * on every meaningful-transition refresh.
 */
export function chatTranscriptsEqual(
  a: ChatMessageView[],
  b: ChatMessageView[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => {
    const o = b[i];
    return (
      m.id === o.id &&
      m.content === o.content &&
      m.buildId === o.buildId &&
      m.editId === o.editId &&
      m.needsClarification === o.needsClarification &&
      m.editStatus === o.editStatus &&
      m.editError === o.editError
    );
  });
}
