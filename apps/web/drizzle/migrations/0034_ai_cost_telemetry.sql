-- 0034_ai_cost_telemetry.sql — 2026-06-10 AI-call-optimization campaign (Phase 1).
--
-- (1) input_tokens_cache_creation: usage.cache_creation_input_tokens is billed
--     at 1.25x but was accumulated in code and never persisted — the cache
--     write premium was invisible. Token identity going forward:
--       total prompt tokens = input + cache_creation + cache_read
--       cost = 1.0x input + 1.25x creation + 0.1x read
--     (and input_tokens_uncached now stores the API's input_tokens AS-IS —
--     the old code double-subtracted cache reads; fixed in the same phase.)
-- (2) failure_kind: typed Anthropic error classification (lib/ai/errors.ts
--     AiFailureKind: rate_limit | overloaded | server_error | bad_request |
--     auth | connection | unknown — plus "max_tokens" written by the Phase 2
--     truncation handling). Distinguishes "model wrote invalid TSX" from
--     "API unreachable" on degraded rows. Plumbed nullable in Phase 1;
--     populated by the Phase 2 generation loops.
-- (3) prompt_inputs_hash + reused_from_build_id: Phase 4 cross-build
--     component carry-forward (sha256 hex of the prompt inputs; provenance
--     pointer to the build the .tsx was copied from). Nullable, unwritten
--     until Phase 4.
-- (4) projects.design_scrape_usage: scrape-agent design-pass usage telemetry
--     ({ primary, fallback?, fallbackUsed, at }) including the WASTED primary
--     call when the Haiku→Sonnet fallback fires. Written by Phase 6.
--
-- Apply to BOTH Supabase projects — local "JAB WP" (ajfurojjxthhzkjqttri)
-- AND prod "jab-prod" (celzwcxkrmsbwiswkxug). NOTE: 0032 + 0033 were
-- committed but still pending application at write time — apply in order
-- 0032 → 0033 → 0034 on any project that is behind.

ALTER TABLE public.block_inventory
  ADD COLUMN IF NOT EXISTS input_tokens_cache_creation integer NOT NULL DEFAULT 0;
ALTER TABLE public.block_inventory
  ADD COLUMN IF NOT EXISTS failure_kind text;
ALTER TABLE public.block_inventory
  ADD COLUMN IF NOT EXISTS prompt_inputs_hash text;
ALTER TABLE public.block_inventory
  ADD COLUMN IF NOT EXISTS reused_from_build_id uuid REFERENCES public.site_builds(id);

ALTER TABLE public.shell_generations
  ADD COLUMN IF NOT EXISTS input_tokens_cache_creation integer NOT NULL DEFAULT 0;
ALTER TABLE public.shell_generations
  ADD COLUMN IF NOT EXISTS failure_kind text;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS design_scrape_usage jsonb;

COMMENT ON COLUMN public.block_inventory.input_tokens_cache_creation IS
  'Anthropic cache_creation_input_tokens (billed 1.25x). Total prompt = uncached + creation + cached.';
COMMENT ON COLUMN public.block_inventory.failure_kind IS
  'Typed failure class (lib/ai/errors.ts AiFailureKind, plus max_tokens). NULL = no classified failure.';
COMMENT ON COLUMN public.block_inventory.prompt_inputs_hash IS
  'sha256 hex of the generation prompt inputs (Phase 4 carry-forward key). NULL until Phase 4 writes it.';
COMMENT ON COLUMN public.block_inventory.reused_from_build_id IS
  'When set, this row''s .tsx was copied from the referenced prior ready build (zero-token reuse).';
COMMENT ON COLUMN public.shell_generations.input_tokens_cache_creation IS
  'Anthropic cache_creation_input_tokens (billed 1.25x) for this shell call.';
COMMENT ON COLUMN public.shell_generations.failure_kind IS
  'Typed failure class (lib/ai/errors.ts AiFailureKind, plus max_tokens). NULL = no classified failure.';
COMMENT ON COLUMN public.projects.design_scrape_usage IS
  'Design-pass usage telemetry: { primary: {model,inputTokens,outputTokens}, fallback?, fallbackUsed, at }.';
