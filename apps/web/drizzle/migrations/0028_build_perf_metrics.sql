-- 0028_build_perf_metrics.sql — S1 (Dashboard & Project Data), e2e-loop design §2.3.
--
-- Measured navigation-timing perf for the home route of each build, captured
-- inside the existing verify-fidelity Playwright pass (Phase 2 coordinated
-- change to verify-fidelity.ts). Additive, nullable, no backfill: builds that
-- predate this migration leave these columns NULL and the dashboard simply
-- omits the corresponding stats (build-quick-stats omits null-valued stats).
--
-- NO perf_score composite (deliberately dropped — see spec §3.1 / §7). We ship
-- measured TTFB / Load / transfer only, each labeled as raw timing.

ALTER TABLE public.site_builds
  ADD COLUMN IF NOT EXISTS ttfb_ms      INTEGER,
  ADD COLUMN IF NOT EXISTS load_ms      INTEGER,
  ADD COLUMN IF NOT EXISTS transfer_bytes BIGINT;

COMMENT ON COLUMN public.site_builds.ttfb_ms IS
  'Home-route time-to-first-byte in ms (navigation timing responseStart - requestStart). NULL for pre-0028 builds or when perf capture failed (fail-soft).';
COMMENT ON COLUMN public.site_builds.load_ms IS
  'Home-route load time in ms (navigation timing loadEventEnd - startTime). NULL when uncaptured.';
COMMENT ON COLUMN public.site_builds.transfer_bytes IS
  'Home-route transfer size in bytes (navigation timing transferSize). BIGINT — large pages exceed INT range. NULL when uncaptured.';

-- ============================================================================
-- End 0028_build_perf_metrics.sql
-- ============================================================================
