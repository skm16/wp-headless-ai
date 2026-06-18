-- 0037_workspace_edits_token_delta.sql — 2026-06-18 global design-token editing.
--
-- A scope="tokens" edit is deterministic (no patch LLM): the planner parses the
-- NL request into a structured TokenDelta, stored here. The Live Draft worker
-- merges all active (completed, non-undone) token deltas into the base build's
-- tokens before rebuilding the draft CSS. Additive + nullable, so every existing
-- row backfills to NULL and the no-token-edit path is byte-identical.
ALTER TABLE workspace_edits ADD COLUMN IF NOT EXISTS token_delta jsonb;
COMMENT ON COLUMN workspace_edits.token_delta IS
  'Structured brand-token change for scope=tokens edits; NULL otherwise. Validated by validateTokenDelta upstream (2026-06-18 global-token-editing).';
