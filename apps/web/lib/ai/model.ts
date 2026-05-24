import "server-only";

/**
 * Centralized model selection for all Anthropic calls (scrape-agent,
 * preview-renderer, generation agent). Default is Sonnet 4.6 — the
 * production-quality choice. Override via `JAB_AI_MODEL` env var when
 * running smoke tests against cheaper models without a code change.
 *
 * Allowed values are pinned so a typo in Vercel's env-var UI fails fast
 * instead of silently dispatching to a non-existent model.
 */
const ALLOWED = [
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-7",
] as const;
type AllowedModel = (typeof ALLOWED)[number];

function readModelFromEnv(): AllowedModel {
  const raw = process.env.JAB_AI_MODEL;
  if (!raw) return "claude-sonnet-4-6";
  if ((ALLOWED as readonly string[]).includes(raw)) {
    return raw as AllowedModel;
  }
  throw new Error(
    `JAB_AI_MODEL="${raw}" is not in the allowed list (${ALLOWED.join(", ")}). Fix the env var or remove it to default to claude-sonnet-4-6.`,
  );
}

export const MODEL: AllowedModel = readModelFromEnv();
