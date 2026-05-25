-- 0013_projects_usage.sql — usage telemetry on the projects table
--
-- Each regenerateHomepage run persists per-pass token usage + model.
-- Mirrors the shape already used by anonymous_previews.usage, which has
-- been populated since the wow-preview pipeline shipped. The post-auth
-- regeneration path was previously dropping this data, leaving no cost-
-- audit visibility into Haiku→Sonnet fallback rates for authenticated
-- runs — surfaced by the holistic review after refocus step 8.
--
-- Shape: { content: Usage & {model}; design: Usage & {model}; render: Usage & {model} }
-- where Usage is Anthropic.Messages.Usage (input_tokens / output_tokens /
-- cache_creation_input_tokens / cache_read_input_tokens) and `model` is
-- the resolved AllowedModel string from lib/ai/model.ts.
--
-- Additive, idempotent. No RLS change — projects already has tenant-
-- scoped policies and this column inherits them.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS usage jsonb;

COMMENT ON COLUMN public.projects.usage IS
  'Per-pass token usage + model from the most recent regenerateHomepage run. Mirrors anonymous_previews.usage shape: { content, design, render } each with Anthropic Usage fields + model string. NULL for projects that pre-date this column or have not yet been regenerated.';
