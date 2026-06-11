-- 0035_live_draft.sql
-- Live Draft system (spec docs/superpowers/specs/2026-06-10-live-draft-system-design.md §5)
-- drafts: one active draft per project; draft_unit_versions: immutable per-unit
-- TSX snapshots (the undo history); workspace_edits gains draft linkage.
--
-- Apply to BOTH Supabase projects:
--   local "JAB WP"  (ajfurojjxthhzkjqttri)
--   prod "jab-prod" (celzwcxkrmsbwiswkxug)

CREATE TABLE IF NOT EXISTS public.drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  base_build_id uuid NOT NULL REFERENCES public.site_builds(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'publishing', 'published', 'discarded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One live draft per project ('publishing' included so a new draft can't
-- spawn mid-publish). Same pattern as 0031's one-active-build index.
CREATE UNIQUE INDEX IF NOT EXISTS drafts_one_active_per_project_idx
  ON public.drafts (project_id)
  WHERE status IN ('active', 'publishing');

CREATE TABLE IF NOT EXISTS public.draft_unit_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES public.drafts(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_key text NOT NULL,
  version_no integer NOT NULL,
  tsx text NOT NULL,
  created_by_edit_id uuid REFERENCES public.workspace_edits(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, unit_key, version_no)
);

CREATE INDEX IF NOT EXISTS draft_unit_versions_draft_idx
  ON public.draft_unit_versions (draft_id);

CREATE INDEX IF NOT EXISTS drafts_project_id_idx
  ON public.drafts (project_id);

CREATE INDEX IF NOT EXISTS draft_unit_versions_project_id_idx
  ON public.draft_unit_versions (project_id);

ALTER TABLE public.workspace_edits
  ADD COLUMN IF NOT EXISTS draft_id uuid REFERENCES public.drafts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unit_version_id uuid REFERENCES public.draft_unit_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS undone_at timestamptz;

CREATE INDEX IF NOT EXISTS workspace_edits_draft_idx
  ON public.workspace_edits (draft_id);

-- RLS: read-only for tenant members (mirrors 0024's select policy); all
-- writes go through the service-role admin client.
ALTER TABLE public.drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_unit_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "drafts_tenant_select"
  ON public.drafts FOR SELECT
  USING (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
  );

CREATE POLICY "draft_unit_versions_tenant_select"
  ON public.draft_unit_versions FOR SELECT
  USING (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
  );
