import "server-only";
import { VercelClient } from "./client";

/**
 * Shared Vercel-client constructor used by every server-side caller
 * (deploy-site, build-review publish, future targeted edits). Extracted
 * to a single module so the env-var checks live in exactly one place —
 * Phase 5 of the 2026-06-02 SaaS-app completion plan adds publish, and
 * we don't want two divergent error messages for "VERCEL_TOKEN not set".
 */
export function loadVercelClient(): VercelClient {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  if (!token)
    throw new Error(
      "VERCEL_TOKEN not set. See docs/superpowers/operator/2026-05-28-vercel-platform-setup.md",
    );
  if (!teamId)
    throw new Error(
      "VERCEL_TEAM_ID not set. See docs/superpowers/operator/2026-05-28-vercel-platform-setup.md",
    );
  return new VercelClient({ token, teamId });
}
