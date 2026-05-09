-- ============================================================================
-- 0004_generation_jobs.sql — Phase D
-- ----------------------------------------------------------------------------
-- One row per AI page-generation attempt. Inngest function runs async, this
-- table is the durable record:
--
--   queued    — row inserted by /api/projects/[id]/generate, Inngest event
--               sent, function not yet started
--   running   — Inngest function picked up the job
--   succeeded — code generated AND pushed to GitHub
--   failed    — any step threw (error stored in `error` column)
--
-- Token + commit metadata captured for billing baseline + retry context.
-- generated_code is preserved even on success so we can show diffs in the
-- UI without round-tripping through GitHub.
--
-- RLS: tenant-scoped via project_id. Workers update via service_role
-- (bypasses RLS) — no UPDATE/DELETE policies for users.
-- ============================================================================

CREATE TABLE public.generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  page_path TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,

  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- AI metrics — populated by the worker for billing + perf baselines.
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,

  -- Output — what the agent produced and where we put it on GitHub.
  output_path TEXT,
  output_branch TEXT,
  output_commit_sha TEXT,
  generated_code TEXT
);

CREATE INDEX generation_jobs_project_id_idx
  ON public.generation_jobs (project_id);
CREATE INDEX generation_jobs_status_idx
  ON public.generation_jobs (status);

-- ---- RLS -------------------------------------------------------------------

ALTER TABLE public.generation_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "generation_jobs_tenant_select"
  ON public.generation_jobs
  FOR SELECT
  USING (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
  );

CREATE POLICY "generation_jobs_tenant_insert"
  ON public.generation_jobs
  FOR INSERT
  WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects
      WHERE tenant_id IN (SELECT public.current_user_tenant_ids())
    )
  );

-- No UPDATE / DELETE policies for end-users — generation_jobs is append-only
-- from the user's perspective. The Inngest worker uses service_role which
-- bypasses RLS to mark status transitions and store metrics.

COMMENT ON TABLE public.generation_jobs IS
  'AI page-generation job records. One row per Generate button click. Worker updates via service_role.';
