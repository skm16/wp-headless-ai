/**
 * smoke-banners.ts — pure text builders for the smoke scripts' operator
 * cost signaling (AI-call optimization campaign, Phase 7).
 *
 * Kept pure (no env reads, no I/O) so the wording is unit-tested; the
 * scripts read their own env and pass flags in.
 */

export function spendModeBanner(opts: { mockMode: boolean; skipShellRegen: boolean }): string[] {
  if (opts.mockMode) {
    return [
      "[smoke] DRY RUN — JAB_GENERATE_MOCK=1 detected in this script's env.",
      "[smoke] MockModelClient is controlled by the Inngest/Next dev server's process env, not this script's — restart `pnpm dev` after editing .env.local.",
      "[smoke] Expected cost: $0 (shell LLM calls mocked).",
    ];
  }
  return [
    "[smoke] LIVE RUN — Header + Footer fire real Sonnet-tier calls (~$0.08; x2 if the compile gate retries).",
    "[smoke] Set JAB_GENERATE_MOCK=1 in .env.local (and restart `pnpm dev`) for a zero-cost dry run.",
    opts.skipShellRegen
      ? "[smoke] JAB_SKIP_SHELL_REGEN=1 — existing Header.tsx/Footer.tsx are reused; both shell LLM calls are skipped ($0)."
      : "[smoke] Tip: JAB_SKIP_SHELL_REGEN=1 reuses the build's existing Header.tsx/Footer.tsx and skips both shell LLM calls on a re-compose.",
  ];
}

export function pipelineContinuesNote(after: "components" | "compose"): string {
  return after === "components"
    ? "[smoke] NOTE: pipeline continues (compose shells + deploy) AFTER this PASS — 2 Sonnet-tier shell calls, a Vercel deploy, and the verify pass still run. Watch /projects/<id>/builds/<buildId>/progress before re-running."
    : "[smoke] NOTE: pipeline continues (deploy + verify) AFTER this PASS — a Vercel deploy and the verify pass still run. Watch /projects/<id>/builds/<buildId>/progress before re-running.";
}
