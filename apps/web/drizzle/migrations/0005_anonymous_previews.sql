-- ============================================================================
-- 0005_anonymous_previews.sql — wow-before-friction preview surface
-- ----------------------------------------------------------------------------
-- One row per pre-auth /preview generation. Keyed by a session cookie (not a
-- user_id, since the user hasn't signed up yet). On signup, the row promotes
-- to a real project owned by the new tenant.
--
-- Lifecycle:
--   queued      — server action inserted the row, Inngest event sent
--   running     — Inngest worker picked it up
--   succeeded   — scrape + render finished, payload columns populated
--   failed      — any step threw (error stored in `error`)
--
-- Lifetime: 24h from creation. A scheduled job is expected to prune rows
-- where expires_at < now() AND promoted_to_project_id IS NULL (the
-- engineering cron ticket is filed in the design plan §11).
--
-- RLS: ALL ACCESS via service_role. The session-cookie keyed lookup happens
-- inside a server action that uses createAdminClient(); RLS denies every
-- other role outright. This keeps the table off the public anon surface
-- without us having to implement a session-cookie-aware RLS predicate.
-- ============================================================================

CREATE TABLE public.anonymous_previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Browser cookie value, opaque random UUID. Server action sets the cookie
  -- on first visit; subsequent requests from the same browser carry it.
  session_id TEXT NOT NULL,

  -- User input — exactly what they pasted.
  source_url TEXT NOT NULL,
  -- After fetch — the redirect-resolved URL the agent actually scraped.
  final_url TEXT,

  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,

  -- Scrape-agent outputs (see lib/ai/scrape-agent.ts).
  content_markdown TEXT,
  design JSONB,
  -- The deterministic Cheerio extract — persisted so debug / fidelity
  -- surfaces can answer "what did the model see?" without re-fetching.
  extract JSONB,

  -- Renderer output — inline HTML for the iframe srcDoc.
  generated_html TEXT,

  -- AI metadata for billing baselines + perf debugging.
  model TEXT,
  usage JSONB,
  byte_size INTEGER,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  -- 24h from creation by default; the prune cron deletes anything past
  -- this that hasn't been promoted.
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),

  -- Set when the user signs up and we link this preview to the new project.
  -- FK to projects(id) is set with ON DELETE SET NULL so deleting a project
  -- doesn't cascade through to the historical preview row.
  promoted_to_project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL
);

-- Session lookups happen on every poll + at signup-promotion time.
CREATE INDEX anonymous_previews_session_id_idx
  ON public.anonymous_previews (session_id);

-- Prune target: rows past expires_at that never got promoted.
CREATE INDEX anonymous_previews_expiry_idx
  ON public.anonymous_previews (expires_at)
  WHERE promoted_to_project_id IS NULL;

-- ---- RLS -------------------------------------------------------------------

ALTER TABLE public.anonymous_previews ENABLE ROW LEVEL SECURITY;

-- No policies. Service-role bypasses RLS; every other role (anon,
-- authenticated, even tenant owners) is denied. Server actions are the
-- only legitimate access path.

COMMENT ON TABLE public.anonymous_previews IS
  'Pre-auth /preview generations keyed by session cookie. 24h TTL. All access via service-role server actions.';
