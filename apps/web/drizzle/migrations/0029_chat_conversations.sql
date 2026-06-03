-- 0029_chat_conversations.sql — S3 (Chat Targeted-Edit), e2e-loop design §2.7.
--
-- The workspace chat panel persists every turn so a free-form edit request,
-- the planner's EditPlan (audit), and the edit it produced are all durable and
-- audit-linked. Reads go through the RLS user client (the SELECT policies below
-- are load-bearing — see spec §3.3); writes go through the server action's
-- service-role admin client after an explicit tenant-membership check, so there
-- is deliberately NO client INSERT policy.

CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL,
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_project_idx ON public.conversations (project_id, created_at DESC);

CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  plan jsonb,                         -- the EditPlan (audit), null for user rows
  needs_clarification boolean NOT NULL DEFAULT false,
  edit_id uuid REFERENCES public.workspace_edits(id) ON DELETE SET NULL,
  build_id uuid REFERENCES public.site_builds(id) ON DELETE SET NULL,
  input_tokens_cached int NOT NULL DEFAULT 0,
  input_tokens_uncached int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_conversation_idx ON public.chat_messages (conversation_id, created_at);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

-- Reads go through the RLS user client (the policies are load-bearing — §3.3).
CREATE POLICY conv_select ON public.conversations FOR SELECT
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = auth.uid()));
CREATE POLICY msg_select ON public.chat_messages FOR SELECT
  USING (project_id IN (
    SELECT p.id FROM public.projects p
    JOIN public.tenant_members tm ON tm.tenant_id = p.tenant_id
    WHERE tm.user_id = auth.uid()));
-- No client INSERT policy: all writes go through the server action (service-role
-- admin client) which performs its own tenant-membership check first.

COMMENT ON TABLE public.conversations IS
  'One row per workspace chat thread (v1: one active thread per project). RLS SELECT by tenant membership; writes via service-role server action.';
COMMENT ON TABLE public.chat_messages IS
  'User + assistant chat turns. plan jsonb carries the EditPlan audit on assistant rows; edit_id/build_id link a turn to the edit it triggered.';

-- ============================================================================
-- End 0029_chat_conversations.sql
-- ============================================================================
