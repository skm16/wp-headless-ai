-- 0036_fidelity_viewport_scores.sql
-- Multi-viewport mobile fidelity gate: per-viewport score breakdown.
-- Additive + defaulted, so existing rows backfill to an empty object and
-- every existing consumer (publish gate, fidelity_avg, review UI) is
-- unaffected. The canonical score / pixel_diff columns remain the desktop
-- (1280) values.

ALTER TABLE fidelity_reports
  ADD COLUMN IF NOT EXISTS viewport_scores jsonb NOT NULL DEFAULT '{}'::jsonb;
