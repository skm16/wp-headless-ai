-- 0024_workspace_edits.sql — Phase 7 of the 2026-06-02 SaaS-app
-- internal-pilot completion plan.
--
-- The workspace UI lets users request a targeted edit ("make the hero
-- full-bleed", "tighten the footer spacing", etc.) against an approved
-- build. The edit is processed by the new edit-site Inngest worker,
-- which copies build artifacts, regenerates the targeted component or
-- shell with guidance, and re-runs the compose → deploy → verify chain.
-- workspace_edits is the durable record of each request and its
-- resulting build.
--
-- result_build_id is NULL while the edit is in flight; the worker sets
-- it after creating the new site_builds row, BEFORE artifact copy
-- begins, so the workspace UI can immediately link the user to
-- /projects/[id]/builds/[result]/progress.

CREATE TABLE public.workspace_edits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  -- Denormalized from project for RLS performance. Invariant (not
  -- DB-enforced): equals projects.tenant_id for project_id.
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  source_build_id UUID NOT NULL REFERENCES public.site_builds(id) ON DELETE CASCADE,
  -- NULL until the worker has inserted the new site_builds row. Foreign
  -- key not deferrable: the worker order is
  --   1. insert site_builds        (result_build_id target exists)
  --   2. UPDATE workspace_edits.result_build_id = <new id>
  --   3. artifact copy + regeneration
  result_build_id UUID REFERENCES public.site_builds(id) ON DELETE SET NULL,
  -- FK omitted: auth.users lives in another schema; the application
  -- records who requested at the time. User-existence is not a
  -- referential integrity concern (same posture as fidelity_reports).
  user_id UUID NOT NULL,
  -- 'page' is reserved for the future; v1 supports component + shell.
  scope TEXT NOT NULL
    CHECK (scope IN ('component', 'shell', 'page')),
  -- For scope='component': the block_name (e.g. core/heading).
  -- For scope='shell': 'header' or 'footer'.
  -- For scope='page': the page_inventory.slug (v2; v1 rejects).
  target TEXT NOT NULL,
  prompt TEXT NOT NULL,
  -- 'queued' on insert, 'running' once the worker picks up, terminal
  -- 'completed' or 'failed' on exit.
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  error_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX workspace_edits_project_id_idx ON public.workspace_edits (project_id);
CREATE INDEX workspace_edits_source_build_id_idx ON public.workspace_edits (source_build_id);
CREATE INDEX workspace_edits_result_build_id_idx ON public.workspace_edits (result_build_id);

COMMENT ON TABLE public.workspace_edits IS
  'One row per user-issued targeted edit request. Worker writes via service-role; tenant members read + insert via RLS scoped through project_id → projects.tenant_id.';

-- ── RLS ──
ALTER TABLE public.workspace_edits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_edits_tenant_select"
  ON public.workspace_edits FOR SELECT
  USING (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
  );

-- INSERT allowed for tenant members; the action also enforces
-- user_id = auth.uid() so an attacker can't impersonate another member.
CREATE POLICY "workspace_edits_tenant_insert"
  ON public.workspace_edits FOR INSERT
  WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
    AND user_id = auth.uid()
  );

-- No UPDATE / DELETE policy — the worker (service-role) is the only writer
-- to status / error_text / finished_at / result_build_id after the
-- initial insert.

-- ============================================================================
-- End 0024_workspace_edits.sql
-- ============================================================================
