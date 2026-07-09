import type { ChatMessageView } from "@/lib/actions/workspace-chat";

/**
 * chat-bubble-status — pure mapping from a chat message's linked-edit state
 * to the bubble's footer line. Split out from ChatBubble so the branching
 * logic is unit-testable without mounting React.
 *
 * Kept separate from the buildId-linked footer (progress/review links,
 * rendered directly in ChatBubble): once a full-build edit exists (buildId
 * set), that link pair replaces this footer entirely — this function
 * returns null in that case so the two footers never both render.
 */
export type ChatBubbleFooterTone = "neutral" | "pending" | "amber";

export interface ChatBubbleFooter {
  text: string;
  tone: ChatBubbleFooterTone;
}

export function chatBubbleFooterFor(
  message: Pick<ChatMessageView, "editId" | "buildId" | "editStatus" | "editError" | "needsClarification">,
): ChatBubbleFooter | null {
  if (!message.editId || message.buildId || message.needsClarification) return null;

  switch (message.editStatus) {
    case "queued":
    case "running":
      return { text: "Applying to draft…", tone: "pending" };
    case "completed":
      return { text: "Applied to draft ✓", tone: "neutral" };
    case "failed":
      return {
        text: message.editError?.trim() || "Something went wrong applying that edit.",
        tone: "amber",
      };
    case "discarded":
    case null:
    default:
      return null;
  }
}
