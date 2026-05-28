-- ============================================================================
-- 0021_shell_generations.sql
-- ----------------------------------------------------------------------------
-- Per-shell cost telemetry. Phase C emits Header.tsx + Footer.tsx via two
-- LLM calls; this table records the same per-call data the block_inventory
-- cost columns carry for component generation. Keyed (site_build_id, shell_kind)
-- because shells aren't blocks.
--
-- shell_kind CHECK: literal 'header' | 'footer'.
-- RLS: tenant scoping rides on the site_builds.project_id → projects.tenant_id
-- join; project_id denormalized for query/RLS performance.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.shell_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_build_id uuid NOT NULL REFERENCES public.site_builds(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  shell_kind text NOT NULL,
  model_used text,
  provider_used text,
  input_tokens_cached integer,
  input_tokens_uncached integer,
  output_tokens integer,
  compile_status text,
  compile_attempt_count smallint,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT shell_generations_shell_kind_check CHECK (shell_kind IN ('header', 'footer'))
);

CREATE UNIQUE INDEX IF NOT EXISTS shell_generations_build_kind_idx
  ON public.shell_generations (site_build_id, shell_kind);

CREATE INDEX IF NOT EXISTS shell_generations_project_id_idx
  ON public.shell_generations (project_id);

ALTER TABLE public.shell_generations ENABLE ROW LEVEL SECURITY;

CREATE POLICY shell_generations_tenant_read ON public.shell_generations
  FOR SELECT
  USING (
    project_id IN (
      SELECT p.id
      FROM public.projects p
      JOIN public.tenant_members tm ON tm.tenant_id = p.tenant_id
      WHERE tm.user_id = auth.uid()
    )
  );

COMMENT ON TABLE public.shell_generations IS
  'Per-build, per-shell cost telemetry for the Header/Footer LLM calls in Phase C.';
