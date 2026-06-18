import { describe, it, expect, vi, afterEach } from "vitest";
import {
  VISION_SCORE_TOOL_SCHEMA,
  VISION_MAX_OUTPUT_TOKENS,
  buildVisionSystemPrompt,
  buildVisionUserText,
  parseVisionToolUse,
  isVisionScoringEnabled,
} from "./vision-prompt";

afterEach(() => vi.unstubAllEnvs());

describe("VISION_SCORE_TOOL_SCHEMA", () => {
  it("declares a report_fidelity tool with score + issues required", () => {
    expect(VISION_SCORE_TOOL_SCHEMA.name).toBe("report_fidelity");
    const props = VISION_SCORE_TOOL_SCHEMA.input_schema.properties;
    expect(props.score.type).toBe("number");
    expect(props.issues.type).toBe("array");
    expect(VISION_SCORE_TOOL_SCHEMA.input_schema.required).toEqual(["score", "issues"]);
    const itemProps = props.issues.items.properties;
    expect(itemProps.severity.enum).toEqual(["low", "medium", "high"]);
    expect(props.issues.items.required).toEqual(["block_name", "severity", "description"]);
  });
});

describe("buildVisionSystemPrompt", () => {
  it("instructs holistic faithfulness and to ignore expected content swaps", () => {
    const p = buildVisionSystemPrompt();
    expect(p.toLowerCase()).toContain("faithful");
    // The defining instruction: stock/dynamic content differences are NOT defects.
    expect(p.toLowerCase()).toMatch(/stock|photo|dynamic|content/);
    expect(p).toContain("report_fidelity");
  });
});

describe("buildVisionUserText", () => {
  it("labels original-first / generated-second, names the route, lists blocks, and gives the pixel context", () => {
    const t = buildVisionUserText({
      routePath: "/about",
      blockNames: ["core/cover", "core/columns"],
      // pixelDiffScore is the pixel-derived SIMILARITY score (1 = identical),
      // not a diff ratio — the worker passes diff.score (= 1 - diffRatio).
      pixelDiffScore: 0.42,
    });
    expect(t).toContain("/about");
    expect(t).toContain("core/cover");
    expect(t.toLowerCase()).toContain("first");
    expect(t.toLowerCase()).toContain("second");
    // 0.42 similarity → "~42% similar"; surfaced so the model understands why it's asked.
    expect(t).toMatch(/42%|pixel/i);
  });

  it("is robust to missing route/blocks", () => {
    const t = buildVisionUserText({ pixelDiffScore: 0.1 });
    expect(typeof t).toBe("string");
    expect(t.length).toBeGreaterThan(0);
  });
});

describe("parseVisionToolUse", () => {
  it("clamps a valid score and coerces issues", () => {
    const r = parseVisionToolUse(
      {
        score: 0.87,
        issues: [{ block_name: "core/cover", severity: "high", description: "hero image missing" }],
      },
      0.4,
    );
    expect(r.score).toBe(0.87);
    expect(r.issues).toEqual([
      { block_name: "core/cover", severity: "high", description: "hero image missing" },
    ]);
  });

  it("falls back to the pixel score when score is missing or NaN", () => {
    expect(parseVisionToolUse({ issues: [] }, 0.55).score).toBe(0.55);
    expect(parseVisionToolUse({ score: Number.NaN, issues: [] }, 0.55).score).toBe(0.55);
    expect(parseVisionToolUse({ score: "high", issues: [] }, 0.55).score).toBe(0.55);
  });

  it("clamps out-of-range scores", () => {
    expect(parseVisionToolUse({ score: 1.4, issues: [] }, 0.4).score).toBe(1);
    expect(parseVisionToolUse({ score: -0.2, issues: [] }, 0.4).score).toBe(0);
  });

  it("defaults a bad severity to low and a missing block_name to _page", () => {
    const r = parseVisionToolUse(
      { score: 0.5, issues: [{ severity: "catastrophic", description: "x" }] },
      0.4,
    );
    expect(r.issues[0].severity).toBe("low");
    expect(r.issues[0].block_name).toBe("_page");
  });

  it("drops issues with no description and non-object entries", () => {
    const r = parseVisionToolUse(
      { score: 0.5, issues: [{ block_name: "a", severity: "low", description: "" }, "nope", null, 7] },
      0.4,
    );
    expect(r.issues).toEqual([]);
  });

  it("drops whitespace-only descriptions", () => {
    const r = parseVisionToolUse(
      { score: 0.5, issues: [{ block_name: "a", severity: "low", description: "   \n\t " }] },
      0.4,
    );
    expect(r.issues).toEqual([]);
  });

  it("defaults a non-string (but truthy) block_name to _page", () => {
    const r = parseVisionToolUse(
      { score: 0.5, issues: [{ block_name: 123, severity: "low", description: "x" }] },
      0.4,
    );
    expect(r.issues[0].block_name).toBe("_page");
  });

  it("returns an empty issues list when issues is missing or not an array", () => {
    expect(parseVisionToolUse({ score: 0.5 }, 0.4).issues).toEqual([]);
    expect(parseVisionToolUse({ score: 0.5, issues: "x" }, 0.4).issues).toEqual([]);
  });
});

describe("isVisionScoringEnabled", () => {
  it("is true only for the exact '1' value", () => {
    expect(isVisionScoringEnabled({ JAB_VISION_SCORING: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isVisionScoringEnabled({ JAB_VISION_SCORING: "true" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isVisionScoringEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("JAB_VISION_SCORING", "1");
    expect(isVisionScoringEnabled()).toBe(true);
  });

  it("VISION_MAX_OUTPUT_TOKENS is a small fixed budget", () => {
    expect(VISION_MAX_OUTPUT_TOKENS).toBe(1024);
  });
});
