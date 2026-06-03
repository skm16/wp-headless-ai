-- 0030_workspace_edit_provenance.sql — S3 + S4 MERGED, e2e-loop design §2.3.
--
-- This is the SINGLE ALTER of workspace_edits for the e2e-loop epic. Both
-- subsystems' columns land here so the status CHECK is rewritten exactly once:
--   S3: regeneration_prompt (guidance threaded into the generator),
--       message_id (the chat_messages row that triggered the edit).
--   S4: action (planner's human summary), changed_slugs (computed by
--       edit-site's compute-changed-pages step), change_reason,
--       result_promoted_deployment_id (closes the audit chain on promote).
--
-- Status gains 'discarded' (discardEditAction sets it; see §3.4). The scope
-- CHECK is UNCHANGED — scope stays ('component','shell','page') from 0024; the
-- validator + planner never produce 'page' (spec §2.6, no unreachable enum
-- widening). message_id FK references chat_messages(id) so 0029 MUST precede
-- this migration.

ALTER TABLE public.workspace_edits
  ADD COLUMN IF NOT EXISTS regeneration_prompt text,
  ADD COLUMN IF NOT EXISTS action text,
  ADD COLUMN IF NOT EXISTS message_id uuid REFERENCES public.chat_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS changed_slugs text[],
  ADD COLUMN IF NOT EXISTS change_reason text,
  ADD COLUMN IF NOT EXISTS result_promoted_deployment_id uuid REFERENCES public.deployments(id) ON DELETE SET NULL;

-- Rewrite the status CHECK exactly once to add 'discarded' (discardEditAction
-- terminal). The 0024 constraint name is the table+column+"check" default;
-- drop-if-exists then re-add so this is idempotent across both projects.
ALTER TABLE public.workspace_edits
  DROP CONSTRAINT IF EXISTS workspace_edits_status_check;
ALTER TABLE public.workspace_edits
  ADD CONSTRAINT workspace_edits_status_check
  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'discarded'));

COMMENT ON COLUMN public.workspace_edits.regeneration_prompt IS
  'Guidance threaded into the component/shell generator. Manual-form path falls back to prompt.';
COMMENT ON COLUMN public.workspace_edits.message_id IS
  'The chat_messages row that triggered this edit. NULL for the manual-form path.';
COMMENT ON COLUMN public.workspace_edits.changed_slugs IS
  'Page slugs the edit actually changed (computed from the SOURCE build block_tree). Drives the scoped review filter + approval carry-forward.';
COMMENT ON COLUMN public.workspace_edits.change_reason IS
  'component_pages | shell_all | null — why changed_slugs is what it is.';
COMMENT ON COLUMN public.workspace_edits.result_promoted_deployment_id IS
  'Production deployments.id this edit was promoted to. NULL until promote. Closes the audit chain.';

-- ============================================================================
-- End 0030_workspace_edit_provenance.sql
-- ============================================================================
