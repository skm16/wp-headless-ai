import Anthropic from "@anthropic-ai/sdk";

/**
 * errors.ts — typed classification of Anthropic SDK failures.
 *
 * Persistable discriminator for cost/robustness telemetry
 * (block_inventory.failure_kind, shell_generations.failure_kind — migration
 * 0034) and the retry decisions in the Phase 2 generation loops: bad_request
 * and auth failures must never burn a second full-price attempt, while
 * rate_limit / overloaded / server_error / connection may retry.
 *
 * Deliberately NOT "server-only": pure classification over SDK classes, no
 * secrets — operator scripts (tsx) may import it.
 *
 * Order matters: most-specific classes first. The overloaded check (status 529)
 * is placed before InternalServerError (>=500) because 529 is a 5xx response —
 * without this guard a 529 would fall through to server_error. The base
 * APIError catch-all comes last.
 *
 * NOTE (SDK 0.95.1 deviation): Anthropic.OverloadedError is a type-only
 * interface in this SDK version (not an error class / constructor). The
 * overloaded branch uses `err instanceof Anthropic.APIError && err.status === 529`
 * per the plan's documented fallback — functionally equivalent since the SDK
 * raises a plain APIError with status=529 for overloaded responses.
 */

export type AiFailureKind =
  | "rate_limit"
  | "overloaded"
  | "server_error"
  | "bad_request"
  | "auth"
  | "connection"
  | "unknown";

export function classifyAiError(err: unknown): AiFailureKind {
  if (err instanceof Anthropic.RateLimitError) return "rate_limit";
  // OverloadedError is not an error class in SDK 0.95.1 — detect by APIError + status 529.
  if (err instanceof Anthropic.APIError && err.status === 529) return "overloaded";
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return "auth";
  }
  if (err instanceof Anthropic.BadRequestError) return "bad_request";
  if (err instanceof Anthropic.APIConnectionError) return "connection";
  if (err instanceof Anthropic.InternalServerError) return "server_error";
  if (err instanceof Anthropic.APIError) return "unknown";
  return "unknown";
}

/** Kinds worth a second attempt; everything else fails fast. */
export function isRetryableAiFailure(kind: AiFailureKind): boolean {
  return (
    kind === "rate_limit" ||
    kind === "overloaded" ||
    kind === "server_error" ||
    kind === "connection"
  );
}
