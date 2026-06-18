// PURE module (deliberately NOT "server-only"): the vision tool schema, prompt
// builders, defensive tool-input parser, and the feature-flag reader. Mirrors
// lib/jab/edit-plan.ts (schema) ↔ lib/ai/edit-planner.ts (server-only client):
// keeping these here means they unit-test with no SDK and the server-only
// client (vision-scorer.ts) stays a thin wire.

import { clamp01, type VisionScoreResult } from "./fidelity-score";

/** Small output budget: a score + a handful of short issues. */
export const VISION_MAX_OUTPUT_TOKENS = 1024;

/**
 * Forced tool-use schema for the vision scorer. The model's ONLY output channel
 * is this tool (tool_choice forces it), so we never regex a number out of prose.
 */
export const VISION_SCORE_TOOL_SCHEMA = {
  name: "report_fidelity",
  description:
    "Report how faithfully the generated clone reproduces the original WordPress page.",
  input_schema: {
    type: "object",
    properties: {
      score: {
        type: "number",
        description:
          "Fidelity in [0,1]. 1 = a visually faithful clone (same layout, section order, branding, typography, colors, and the same KINDS of content present). 0 = unrecognizable or broken. Judge structure and branding, NOT exact pixels: different stock/hero photos, different dynamic content (latest posts, product lists), and minor text reflow are EXPECTED and must NOT lower the score. Penalize missing sections, broken/overlapping layout, wrong colors or fonts, collapsed/empty regions, and images absent where the original clearly had content imagery.",
      },
      issues: {
        type: "array",
        description:
          "Concrete visual defects in the clone. Empty array when the clone is faithful.",
        items: {
          type: "object",
          properties: {
            block_name: {
              type: "string",
              description:
                'The affected block name from the provided list, or "_page" for a whole-page issue.',
            },
            severity: {
              type: "string",
              enum: ["low", "medium", "high"],
              description:
                "high = the area is broken/unusable; medium = clearly wrong but legible; low = minor cosmetic.",
            },
            description: {
              type: "string",
              description: "What is visually wrong, in one short sentence.",
            },
          },
          required: ["block_name", "severity", "description"],
        },
      },
    },
    required: ["score", "issues"],
  },
} as const;

export function buildVisionSystemPrompt(): string {
  return `You are the JAB fidelity reviewer. You compare two full-page screenshots of the SAME web page: the ORIGINAL WordPress site and a GENERATED clone of it. Decide how faithfully the clone reproduces the original, then call the ${VISION_SCORE_TOOL_SCHEMA.name} tool with a score and any issues.

What "faithful" means:
- Same overall layout and section order, same branding (logo, colors, fonts), same typography scale, the same KINDS of content present in each region.

What is EXPECTED and must NOT lower the score:
- Different stock/hero photographs or illustrations (the clone hotlinks live media and dynamic content; exact images legitimately differ).
- Different dynamic content (latest posts, product/event lists, counts) and minor text reflow or wrapping.

What DOES lower the score:
- Missing or empty sections, broken or overlapping layout, content spilling off-canvas.
- Wrong brand colors or fonts, obviously unstyled / default-looking regions.
- Images absent where the original clearly showed content imagery (not decorative swaps).

Be critical but fair: a clone that is structurally and visually equivalent with only expected media/content differences deserves a high score (0.9+). Reserve low scores for genuine breakage. Attribute each issue to a block_name from the provided list when you can, otherwise "_page".`;
}

export function buildVisionUserText(args: {
  routePath?: string;
  blockNames?: string[];
  /** Pixel-derived SIMILARITY score in [0,1] (1 = identical) — the worker passes
   *  diff.score (= 1 - diffRatio), so this is NOT a diff ratio. */
  pixelDiffScore: number;
}): string {
  const pct = Math.round(clamp01(args.pixelDiffScore) * 100);
  const blocks =
    args.blockNames && args.blockNames.length
      ? args.blockNames.join(", ")
      : "(block list unavailable — attribute issues to _page)";
  return `The FIRST image is the ORIGINAL WordPress page. The SECOND image is the GENERATED clone.
Route: ${args.routePath ?? "(unknown)"}
Blocks present on this page: ${blocks}

Context: an automated pixel-diff scored this clone ~${pct}% similar. That number is often deflated by EXPECTED photo/dynamic-content differences, which is exactly why your visual judgment is needed. Score the clone's structural and brand fidelity and report any real defects via the ${VISION_SCORE_TOOL_SCHEMA.name} tool.`;
}

const SEVERITIES = ["low", "medium", "high"] as const;
type Severity = (typeof SEVERITIES)[number];

function coerceSeverity(v: unknown): Severity {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v)
    ? (v as Severity)
    : "low";
}

/**
 * Coerce arbitrary tool-call JSON to a typed VisionScoreResult (defensive —
 * NEVER throws). A missing/NaN/non-number score falls back to the pixel-derived
 * score so a malformed tool call degrades to today's behavior rather than a
 * zero. Malformed issue entries are dropped, not surfaced.
 */
export function parseVisionToolUse(
  input: Record<string, unknown>,
  pixelDiffScore: number,
): VisionScoreResult {
  const rawScore = input.score;
  const score =
    typeof rawScore === "number" && Number.isFinite(rawScore)
      ? clamp01(rawScore)
      : clamp01(pixelDiffScore);

  const rawIssues = Array.isArray(input.issues) ? input.issues : [];
  const issues = rawIssues
    .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
    .map((i) => ({
      block_name:
        typeof i.block_name === "string" && i.block_name.length ? i.block_name : "_page",
      severity: coerceSeverity(i.severity),
      description: typeof i.description === "string" ? i.description : "",
    }))
    // Drop empty AND whitespace-only descriptions — a blank issue is noise on
    // the review screen, never a real defect.
    .filter((i) => i.description.trim().length > 0);

  return { score, issues };
}

/** Default-off feature flag for the real vision call. Exact "1" only. */
export function isVisionScoringEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JAB_VISION_SCORING === "1";
}
