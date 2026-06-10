-- 0032_chat_indexes_and_one_thread.sql — 2026-06-09 senior-review fix campaign (T10).
--
-- (a) v1's "one chat thread per project" (0029's comment) becomes DB-enforced:
--     ensureConversation's check-then-insert raced under concurrent sends and
--     split history across threads (loadConversation only reads the latest
--     thread, so earlier turns silently vanish from the UI and the planner).
--     Dedupe first: keep the OLDEST conversation per project (stable thread),
--     repoint chat_messages, then delete the extras.
-- (b) hot-path + FK indexes: assertEditBudget scans chat_messages by
--     (project_id, created_at) on EVERY chat turn; edit_id / build_id /
--     message_id / result_promoted_deployment_id are FK columns whose
--     ON DELETE SET NULL sweeps were full-table scans.

-- 1. Repoint every message to its project's oldest conversation.
UPDATE public.chat_messages m
SET conversation_id = keeper.id
FROM public.conversations cur,
     LATERAL (
       SELECT id FROM public.conversations
       WHERE project_id = cur.project_id
       ORDER BY created_at ASC
       LIMIT 1
     ) keeper
WHERE m.conversation_id = cur.id
  AND cur.id <> keeper.id;

-- 2. Delete the now-empty duplicate threads (cascade is safe: messages moved).
DELETE FROM public.conversations c
WHERE c.id NOT IN (
  SELECT DISTINCT ON (project_id) id
  FROM public.conversations
  ORDER BY project_id, created_at ASC
);

-- 3. Enforce one thread per project.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_per_project_idx
  ON public.conversations (project_id);
COMMENT ON INDEX public.conversations_one_per_project_idx IS
  'v1: one chat thread per project (e2e-loop §2.7). ensureConversation inserts against this and re-selects on 23505.';

-- 4. Hot-path + FK indexes.
CREATE INDEX IF NOT EXISTS chat_messages_project_created_idx
  ON public.chat_messages (project_id, created_at);
CREATE INDEX IF NOT EXISTS chat_messages_edit_id_idx ON public.chat_messages (edit_id);
CREATE INDEX IF NOT EXISTS chat_messages_build_id_idx ON public.chat_messages (build_id);
CREATE INDEX IF NOT EXISTS workspace_edits_message_id_idx ON public.workspace_edits (message_id);
CREATE INDEX IF NOT EXISTS workspace_edits_result_promoted_deployment_id_idx
  ON public.workspace_edits (result_promoted_deployment_id);

-- ============================================================================
-- End 0032_chat_indexes_and_one_thread.sql
-- ============================================================================
