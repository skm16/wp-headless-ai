-- ============================================================================
-- 0010_make_promote_fk_deferrable.sql — unblock promote_anonymous_preview
-- ----------------------------------------------------------------------------
-- The promote_anonymous_preview() function (migration 0007) deliberately
-- UPDATEs anonymous_previews.promoted_to_project_id BEFORE INSERTing into
-- projects, so the UPDATE's `WHERE promoted_to_project_id IS NULL` predicate
-- serves as the atomic serialization point for concurrent promotion
-- attempts. Race losers fail at the UPDATE cheaply, never reaching the
-- INSERT.
--
-- But Postgres checks FK constraints per-statement, not at transaction
-- commit, unless the constraint is DEFERRABLE INITIALLY DEFERRED. With
-- the default (NOT DEFERRABLE) FK from migration 0005, the UPDATE fails
-- the FK check immediately because the projects row doesn't exist yet:
--   "Key (promoted_to_project_id)=(...) is not present in table 'projects'"
--
-- Fix: redefine the FK as DEFERRABLE INITIALLY DEFERRED. The constraint
-- still fires at transaction commit (so we still catch genuinely-dangling
-- promoted_to_project_id values), but the function's UPDATE-then-INSERT
-- ordering becomes valid because both statements complete before commit.
--
-- This also fixes the auto-promote codepath: lib/actions/promote-preview.ts
-- was hitting the same FK error inside the RPC call and silently logging
-- it as `rpc failed`, which surfaced to the user as "No projects yet"
-- in the dashboard.
-- ============================================================================

ALTER TABLE public.anonymous_previews
  DROP CONSTRAINT IF EXISTS anonymous_previews_promoted_to_project_id_fkey;

ALTER TABLE public.anonymous_previews
  ADD CONSTRAINT anonymous_previews_promoted_to_project_id_fkey
  FOREIGN KEY (promoted_to_project_id)
  REFERENCES public.projects(id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;
