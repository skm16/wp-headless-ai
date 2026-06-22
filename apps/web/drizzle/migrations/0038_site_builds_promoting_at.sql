-- 0038_site_builds_promoting_at.sql — 2026-06-22 publish-bridge hardening (C1).
--
-- Atomic publish/cancel claim. publishBuildAction stamps promoting_at out of
-- 'ready' (CAS: status='ready' AND promoting_at IS NULL) BEFORE the irreversible
-- Vercel production redeploy; cancelPublishAction CAS-cancels an in-flight publish
-- build only while promoting_at IS NULL. The single column is the mutex between
-- the two server actions — whoever sets/checks it first forces the other to a
-- no-op, so a cancel can never free a draft whose site is already being promoted,
-- and a publish can never promote a build a cancel already took. A failed publish
-- (redeploy threw / never went READY) clears promoting_at so a retry can re-claim.
-- Additive + nullable: every existing row backfills to NULL and the non-publish
-- path is byte-identical.
ALTER TABLE site_builds ADD COLUMN IF NOT EXISTS promoting_at timestamptz;
COMMENT ON COLUMN site_builds.promoting_at IS
  'Set when publishBuildAction has claimed this build for production promotion; the publish/cancel mutex (2026-06-22 publish-bridge-hardening C1).';
