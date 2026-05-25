import "server-only";
import type { ScrapeAgentResult } from "./scrape-agent";
import type { RenderIntent } from "./render-prompts";

/**
 * Output validators — the §8.3 layer of the deterministic-guardrails
 * framework (`docs/ai-prompt-modes.md`). Run on the renderer's output
 * BEFORE the row is persisted. Any failure throws; the bad HTML never
 * reaches a client URL.
 *
 * What's here today (v0):
 *   - JAB-bleed scan      — never permit JAB brand tokens in a client artifact
 *   - stop_reason gate    — surface truncated generations as failures
 *   - no-script (Faithful) — Faithful must not introduce client-side JS
 *   - hero copy verbatim (Faithful) — the source's first H1 must appear in output
 *   - CTA copy adherence (Faithful) — extracted CTA labels must appear in output
 *
 * What's not yet here (tracked in §8.6 status table):
 *   - palette adherence / typography adherence — meaningful only after the
 *     project-derived Tailwind theme generator lands (§8.1 longer-term)
 *   - section count adherence / menu adherence — needs the structured-block
 *     ground-truth from the connected-site path (step 6 of §10.0)
 *   - frozen-content scan / accessibility floor — heavier passes deferred
 *
 * The validators here are all regex / string-search — no second LLM call,
 * no headless browser. Cheap to run, fail-fast.
 */

const JAB_HEX_TOKENS = [
  "#060d16",
  "#0a1628",
  "#0f2040",
  "#1a3158",
  "#00c9a7",
  "#2563ff",
  "#ff4444",
  "#f59e0b",
  "#f0f4f8",
  "#7a9ab8",
  "#3a5070",
] as const;

const JAB_FONT_FAMILIES = ["Syne", "DM Sans", "JetBrains Mono"] as const;

export interface ValidationResult {
  ok: boolean;
  /** Stable identifier per validator — used in error codes and telemetry. */
  code: string;
  /** Human-readable failure detail; empty when ok. */
  detail: string;
}

export interface ValidateOptions {
  scrape: ScrapeAgentResult;
  intent: RenderIntent | null | undefined;
  stopReason: string | null;
}

/**
 * Run all applicable validators and return the first failure (if any).
 * Returns null when every validator passed. Fail-fast: validators are
 * cheap individually but running them all on a successful generation is
 * still a small budget; short-circuit on first miss.
 */
export function validateOutput(
  html: string,
  opts: ValidateOptions,
): ValidationResult | null {
  const stopReasonResult = validateStopReason(opts.stopReason);
  if (!stopReasonResult.ok) return stopReasonResult;

  const jabBleed = validateJabBleed(html);
  if (!jabBleed.ok) return jabBleed;

  // Faithful-only validators. Refresh / Reimagine intentionally allow
  // copy edits + non-trivial layout reshaping, so the hero-verbatim and
  // CTA-verbatim rules would generate false failures there.
  if (opts.intent === "faithful") {
    const noScript = validateNoClientScript(html);
    if (!noScript.ok) return noScript;

    const hero = validateHeroCopyVerbatim(html, opts.scrape);
    if (!hero.ok) return hero;

    const cta = validateCtaCopyVerbatim(html, opts.scrape);
    if (!cta.ok) return cta;
  }

  return null;
}

/**
 * `stop_reason !== "end_turn"` means the model was cut off mid-generation
 * (usually `max_tokens`). The renderer's `extractHtmlBlock` tolerates an
 * unclosed code fence so a truncated response degrades to a partial
 * preview, but a partial preview shouldn't ship to a project's workspace
 * as "ready." Fail explicitly here. Pre-auth wow flow has its own
 * tolerance story; that path renders to an iframe srcDoc and accepts
 * partial output — the validator gate only fires on the authenticated
 * post-onboarding path because that's what calls `validateOutput`.
 */
export function validateStopReason(stopReason: string | null): ValidationResult {
  if (stopReason === null || stopReason === "end_turn") {
    return { ok: true, code: "stop_reason", detail: "" };
  }
  return {
    ok: false,
    code: "stop_reason",
    detail: `stop_reason=${stopReason} — generation was cut short (likely max_tokens). Output is partial and must not ship.`,
  };
}

/**
 * Scan the rendered HTML for any JAB-brand bleed: the published JAB hex
 * tokens or the JAB-restricted font families (Syne, DM Sans, JetBrains
 * Mono). Sonnet drifts toward styles it has seen in the same context
 * window — if any earlier JAB-brand example slipped into the model's
 * context, the output can quietly inherit JAB's identity. This validator
 * is the §2 global rule made enforceable.
 *
 * Hex match is case-insensitive (the renderer or model may emit
 * `#FF4444` or `#ff4444`); font-family is case-sensitive on the canonical
 * brand spelling (`DM Sans`, not `dm sans`) since the brand spelling is
 * what would actually load and what we forbid.
 */
export function validateJabBleed(html: string): ValidationResult {
  const lower = html.toLowerCase();
  for (const hex of JAB_HEX_TOKENS) {
    if (lower.includes(hex)) {
      return {
        ok: false,
        code: "jab_bleed_hex",
        detail: `Output contains JAB brand hex ${hex}. JAB brand never bleeds into client artifacts (§2 of ai-prompt-modes.md).`,
      };
    }
  }
  for (const family of JAB_FONT_FAMILIES) {
    if (html.includes(family)) {
      return {
        ok: false,
        code: "jab_bleed_font",
        detail: `Output contains JAB brand font "${family}". JAB brand never bleeds into client artifacts (§2 of ai-prompt-modes.md).`,
      };
    }
  }
  return { ok: true, code: "jab_bleed", detail: "" };
}

/**
 * Faithful only: no client-side JavaScript. Sonnet sometimes inlines a
 * tiny <script> for carousel behavior or smooth scrolling — Faithful
 * shouldn't ship interactivity the source didn't have. Refresh /
 * Reimagine allowed to introduce judicious scripts in future, but v0
 * preview pipeline doesn't need it either way.
 */
export function validateNoClientScript(html: string): ValidationResult {
  // Match <script ...> opening tags — the typical injection pattern.
  // Tolerates whitespace + attributes.
  if (/<script\b/i.test(html)) {
    return {
      ok: false,
      code: "faithful_script_injected",
      detail: "Faithful output contains a <script> tag. Faithful prohibits client-side JS — §4.3 MAY upgrade does not include scripting.",
    };
  }
  return { ok: true, code: "faithful_script_injected", detail: "" };
}

/**
 * Faithful only: the source page's first H1 must appear verbatim in the
 * output. Verbatim = same text, case-sensitive, after whitespace
 * collapse. Skipped if scrape couldn't extract an H1 (no ground truth
 * to enforce against).
 */
export function validateHeroCopyVerbatim(
  html: string,
  scrape: ScrapeAgentResult,
): ValidationResult {
  const sourceHero = scrape.extract.h1[0];
  if (!sourceHero) {
    return { ok: true, code: "faithful_hero_verbatim", detail: "" };
  }
  const collapsedHtml = collapseWhitespace(stripTags(html));
  const collapsedHero = collapseWhitespace(sourceHero);
  if (!collapsedHtml.includes(collapsedHero)) {
    return {
      ok: false,
      code: "faithful_hero_verbatim",
      detail: `Faithful output is missing the source page's hero copy. Expected verbatim: ${JSON.stringify(collapsedHero)}.`,
    };
  }
  return { ok: true, code: "faithful_hero_verbatim", detail: "" };
}

/**
 * Faithful only: every extracted CTA label must appear in the output.
 * "Extracted CTA" means `design.buttonPair.primary.value` and
 * `design.buttonPair.secondary.value` — these are the LLM-classified
 * primary/secondary CTAs from the source. If either is null (no clear
 * CTA on source) or confidence is sub-0.4 (treat as null per §8.1), the
 * check is skipped for that slot.
 */
export function validateCtaCopyVerbatim(
  html: string,
  scrape: ScrapeAgentResult,
): ValidationResult {
  const collapsedHtml = collapseWhitespace(stripTags(html));

  const checkSlot = (
    slotName: "primary" | "secondary",
  ): ValidationResult | null => {
    const slot = scrape.design.buttonPair[slotName];
    // Confidence floor 0.7 (not 0.4). The LLM's buttonPair classification
    // is a "which is the primary CTA?" judgment that can disagree with
    // the rendered hero — at sub-0.7 confidence the validator would
    // false-positive when the model rendered the actual hero CTA but the
    // classifier had guessed a different button as primary. §8.1 treats
    // 0.4-0.7 as "suggestion" tier; verbatim is a stronger claim.
    if (!slot.value || slot.confidence < 0.7) return null;
    const collapsed = collapseWhitespace(slot.value);
    if (!collapsedHtml.includes(collapsed)) {
      return {
        ok: false,
        code: "faithful_cta_verbatim",
        detail: `Faithful output is missing the source's ${slotName} CTA label. Expected verbatim: ${JSON.stringify(collapsed)}.`,
      };
    }
    return null;
  };

  return checkSlot("primary") ?? checkSlot("secondary") ?? {
    ok: true,
    code: "faithful_cta_verbatim",
    detail: "",
  };
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ");
}
