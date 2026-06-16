"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  sendChatMessageAction,
  type ChatMessageView,
} from "@/lib/actions/workspace-chat";
import { mergeChatMessages, chatTranscriptsEqual } from "@/lib/jab/chat-message-merge";

/**
 * ChatPanel — the workspace chat surface (spec §3.3). Optimistic send,
 * clarifying render, progress/review links once an edit is linked, aria-live
 * transcript, composer focus retention, prefers-reduced-motion. Gated behind
 * JAB_CHAT_EDIT by the page.
 */
export interface ChatPanelProps {
  projectId: string;
  initialMessages: ChatMessageView[];
  sourceBuildReady: boolean;
}

export function ChatPanel({
  projectId,
  initialMessages,
  sourceBuildReady,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessageView[]>(initialMessages);

  // Re-sync when the server transcript changes (router.refresh from the
  // preview pane's poll, or a revalidate). useState ignores prop updates —
  // without this the backfilled buildId (progress/review links) never
  // appears without a manual reload. Returning `prev` when nothing changed
  // keeps the array identity stable so the scroll-to-bottom effect doesn't
  // yank a user who scrolled up.
  useEffect(() => {
    setMessages((prev) => {
      const merged = mergeChatMessages(initialMessages, prev);
      return chatTranscriptsEqual(prev, merged) ? prev : merged;
    });
  }, [initialMessages]);

  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  function onSend(e: React.FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || pending) return;
    const optimistic: ChatMessageView = {
      id: `optimistic-${Date.now()}`,
      role: "user",
      content,
      needsClarification: false,
      editId: null,
      buildId: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);
    setDraft("");
    startTransition(async () => {
      try {
        const { assistant } = await sendChatMessageAction({ projectId, content });
        setMessages((m) => [...m, assistant]);
      } catch (err) {
        // TEMP (T11 debug): surface the real failure. A thrown server action
        // carries a `digest` (full message is in the Next server stdout); a
        // transport drop is a TypeError ("fetch failed") with no digest.
        console.error("[chat] sendChatMessageAction failed:", err, {
          digest: (err as { digest?: string } | null)?.digest,
        });
        setMessages((m) => [
          ...m,
          {
            id: `err-${Date.now()}`,
            role: "assistant",
            content: "Something went wrong sending that. Please try again.",
            needsClarification: true,
            editId: null,
            buildId: null,
            createdAt: new Date().toISOString(),
          },
        ]);
      } finally {
        inputRef.current?.focus();
      }
    });
  }

  return (
    <section className="flex h-full flex-col overflow-hidden motion-reduce:transition-none">
      <div className="border-b border-bord px-4 py-3 text-sm font-bold text-wht">
        Chat
      </div>
      <div
        aria-live="polite"
        aria-label="Conversation"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 && (
          <p className="text-[13px] text-gry">
            {sourceBuildReady
              ? 'Describe a change, e.g. "make the hero bolder".'
              : "Build the site first, then ask me to change something."}
          </p>
        )}
        {messages.map((m) => (
          <ChatBubble key={m.id} projectId={projectId} message={m} />
        ))}
        <div ref={endRef} />
      </div>
      <form onSubmit={onSend} className="border-t border-bord p-3">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!sourceBuildReady || pending}
            placeholder={
              sourceBuildReady ? "Describe a change…" : "Requires a ready build"
            }
            // keep in sync with MAX_CHAT_CONTENT_CHARS (edit-cost-guard.ts — server-only, not importable here)
            maxLength={4000}
            aria-label="Message"
            className="h-9 flex-1 rounded-md border border-bord bg-surf px-2.5 text-[13px] text-wht outline-none focus:border-teal disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!sourceBuildReady || pending || !draft.trim()}
            className="inline-flex h-9 items-center rounded-md bg-teal px-4 text-[13px] font-semibold text-bg transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
          >
            {pending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </section>
  );
}

function ChatBubble({
  projectId,
  message,
}: {
  projectId: string;
  message: ChatMessageView;
}) {
  const isUser = message.role === "user";
  return (
    <div className={isUser ? "self-end" : "self-start"}>
      <div
        className={`max-w-[300px] rounded-lg px-3 py-2 text-[13px] ${
          isUser
            ? "bg-teal/15 text-wht"
            : message.needsClarification
              ? "border border-amb/30 bg-amb/[0.06] text-wht"
              : "border border-bord bg-elev text-wht"
        }`}
      >
        <p className="whitespace-pre-wrap">{message.content}</p>
        {!isUser && message.editId && message.buildId && (
          <div className="mt-2 flex flex-wrap gap-2 font-mono text-[11px]">
            <Link
              href={`/projects/${projectId}/builds/${message.buildId}/progress`}
              className="text-teal hover:underline"
            >
              View progress →
            </Link>
            <Link
              href={`/projects/${projectId}/builds/${message.buildId}/review`}
              className="text-teal hover:underline"
            >
              Review →
            </Link>
          </div>
        )}
        {!isUser && message.editId && !message.buildId && (
          <p className="mt-2 font-mono text-[11px] text-teal/70">
            Applied to draft ✓
          </p>
        )}
      </div>
    </div>
  );
}
