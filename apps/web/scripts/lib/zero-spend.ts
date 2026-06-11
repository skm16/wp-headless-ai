/**
 * zero-spend.ts — pure detector behind the smoke scripts' "verified Cost: $0"
 * invariant (AI-call optimization campaign, Phase 7).
 *
 * Mock mode (JAB_GENERATE_MOCK=1) writes zero-token telemetry by design
 * (MockModelClient). The flag that actually controls the worker lives in the
 * Inngest/Next dev server's process env — NOT the smoke script's — so the
 * scripts verify the claim against the DB telemetry instead of trusting
 * their own env.
 */

export interface SpendRow {
  /** Human label for the offending row (block_name or shell_kind). */
  label: string;
  /** Token-count columns; null = column never written (passthrough/skipped rows). */
  tokens: Array<number | null>;
}

/** Rows that recorded real token spend (any strictly-positive count). */
export function findNonZeroSpend(rows: SpendRow[]): SpendRow[] {
  return rows.filter((r) => r.tokens.some((t) => typeof t === "number" && t > 0));
}
