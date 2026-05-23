-- ============================================================================
-- 0006_rate_limits.sql — generic Postgres-backed rate-limit buckets
-- ----------------------------------------------------------------------------
-- Hourly fixed-window counter, keyed by an opaque string the caller picks.
-- The wow-preview surface uses two keys per request: one per session cookie,
-- one per client IP. Other surfaces can reuse this table with their own
-- key namespaces — see `lib/rate-limit.ts` for the convention.
--
-- Why not Upstash/Redis? Avoids a new external dependency for v1. Postgres
-- can handle low-RPS counting fine; if this becomes hot enough to matter
-- (>50 RPS sustained against a single key), swap to a real bucket service.
--
-- RLS: ALL ACCESS via service_role. The rate-limit check happens inside
-- server actions using createAdminClient(); anon/authenticated/tenant
-- roles are denied to prevent the table being abused as a side-channel
-- to enumerate session cookies or IPs.
-- ============================================================================

CREATE TABLE public.rate_limits (
  -- Opaque caller-chosen key. Namespacing convention: "<surface>:<dimension>:<value>"
  -- e.g. "preview:ip:1.2.3.4" or "preview:session:abc-123".
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Used by the prune job — engineering ticket to schedule it. Without
-- pruning, the table grows unbounded as IPs change.
CREATE INDEX rate_limits_updated_at_idx
  ON public.rate_limits (updated_at);

-- ---- RLS -------------------------------------------------------------------

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

-- No policies. Service-role bypasses; everyone else is denied.

COMMENT ON TABLE public.rate_limits IS
  'Hourly fixed-window rate-limit counters. All access via service-role server actions.';

-- ---- Atomic increment ------------------------------------------------------

-- One round-trip increment: bumps `hits`, or resets to 1 if the window
-- expired. Returns the row post-update so the caller knows whether they're
-- over the limit (handled in lib/rate-limit.ts; the function itself does
-- NOT enforce a limit — that's caller responsibility).
--
-- NOT SECURITY DEFINER. The function runs as the caller; only service_role
-- has INSERT/UPDATE access (RLS denies everyone else). This avoids the
-- footgun pattern documented in 0002_lock_down_security_definer_functions.sql.
CREATE OR REPLACE FUNCTION public.rate_limit_increment(
  p_key TEXT,
  p_window_seconds INTEGER
)
RETURNS TABLE (hits INTEGER, window_started_at TIMESTAMPTZ)
LANGUAGE sql
AS $$
  INSERT INTO public.rate_limits (key, hits, window_started_at, updated_at)
  VALUES (p_key, 1, NOW(), NOW())
  ON CONFLICT (key) DO UPDATE
  SET
    hits = CASE
      WHEN public.rate_limits.window_started_at < NOW() - (p_window_seconds || ' seconds')::INTERVAL
        THEN 1
      ELSE public.rate_limits.hits + 1
    END,
    window_started_at = CASE
      WHEN public.rate_limits.window_started_at < NOW() - (p_window_seconds || ' seconds')::INTERVAL
        THEN NOW()
      ELSE public.rate_limits.window_started_at
    END,
    updated_at = NOW()
  RETURNING public.rate_limits.hits, public.rate_limits.window_started_at;
$$;
