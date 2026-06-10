import { describe, it, expect } from "vitest";
import { PNG } from "pngjs";
import {
  pixelDiffScore,
  flagForVision,
  visionScore,
  DEFAULT_VISION_FLAG_THRESHOLD,
  VISION_PER_BUILD_CAP,
  httpFailureRow,
} from "./fidelity-score";

/**
 * Build a small PNG buffer filled with a single RGBA color. Useful for
 * deterministic pixel-diff tests without needing fixture files.
 */
function solidPng(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) * 4;
      png.data[idx] = rgba[0];
      png.data[idx + 1] = rgba[1];
      png.data[idx + 2] = rgba[2];
      png.data[idx + 3] = rgba[3];
    }
  }
  return PNG.sync.write(png);
}

describe("pixelDiffScore", () => {
  it("returns score=1, diffRatio=0 for identical buffers", () => {
    const a = solidPng(10, 10, [255, 0, 0, 255]);
    const b = solidPng(10, 10, [255, 0, 0, 255]);
    const result = pixelDiffScore({ sourceBuffer: a, generatedBuffer: b });
    expect(result.diffRatio).toBe(0);
    expect(result.score).toBe(1);
    expect(result.diffPixels).toBe(0);
    expect(result.totalPixels).toBe(100);
    expect(result.sizeMismatch).toBe(false);
  });

  it("returns score=0 for fully-different buffers", () => {
    const a = solidPng(10, 10, [255, 0, 0, 255]);
    const b = solidPng(10, 10, [0, 255, 0, 255]);
    const result = pixelDiffScore({ sourceBuffer: a, generatedBuffer: b });
    // Pixelmatch with default antialias detection might count slightly
    // less than 100% — we accept anything in [0.99, 1] as fully-different.
    expect(result.diffRatio).toBeGreaterThan(0.99);
    expect(result.score).toBeLessThan(0.01);
  });

  it("handles size mismatch with sizeMismatch=true and a conservative score=0.5", () => {
    const a = solidPng(10, 10, [255, 0, 0, 255]);
    const b = solidPng(20, 20, [255, 0, 0, 255]);
    const result = pixelDiffScore({ sourceBuffer: a, generatedBuffer: b });
    expect(result.sizeMismatch).toBe(true);
    expect(result.score).toBe(0.5);
    expect(result.diffRatio).toBe(0.5);
  });
});

describe("flagForVision", () => {
  it("returns true when diffRatio exceeds the default 0.10 threshold", () => {
    expect(flagForVision(0.11)).toBe(true);
    expect(flagForVision(0.5)).toBe(true);
  });

  it("returns false when diffRatio is at or below 0.10", () => {
    expect(flagForVision(0.1)).toBe(false);
    expect(flagForVision(0.0)).toBe(false);
    expect(flagForVision(0.05)).toBe(false);
  });

  it("accepts a custom threshold", () => {
    expect(flagForVision(0.05, 0.04)).toBe(true);
    expect(flagForVision(0.05, 0.05)).toBe(false);
  });

  it("exposes the canonical default value", () => {
    expect(DEFAULT_VISION_FLAG_THRESHOLD).toBeCloseTo(0.1);
  });
});

describe("VISION_PER_BUILD_CAP", () => {
  it("is set to the plan's 15-call ceiling", () => {
    expect(VISION_PER_BUILD_CAP).toBe(15);
  });
});

describe("httpFailureRow", () => {
  it("returns null for 2xx/3xx and unknown status", () => {
    expect(httpFailureRow(200, "/about")).toBeNull();
    expect(httpFailureRow(308, "/about")).toBeNull();
    expect(httpFailureRow(null, "/about")).toBeNull();
    expect(httpFailureRow(undefined, "/about")).toBeNull();
  });

  it("returns a zero-score high-severity row for 4xx/5xx", () => {
    const row = httpFailureRow(404, "/beer/lil-heaven-ipa");
    expect(row).not.toBeNull();
    expect(row!.score).toBe(0);
    expect(row!.issues[0].severity).toBe("high");
    expect(row!.issues[0].description).toContain("HTTP 404");
    expect(row!.issues[0].description).toContain("/beer/lil-heaven-ipa");
    expect(httpFailureRow(500, "/x")!.score).toBe(0);
  });
});

describe("visionScore (v1 stub)", () => {
  it("echoes the pixel-derived score with an empty issues list", async () => {
    const result = await visionScore({ pixelDiffScore: 0.83 });
    expect(result.score).toBe(0.83);
    expect(result.issues).toEqual([]);
  });

  it("clamps scores to [0,1]", async () => {
    const tooHigh = await visionScore({ pixelDiffScore: 1.5 });
    expect(tooHigh.score).toBe(1);
    const tooLow = await visionScore({ pixelDiffScore: -0.2 });
    expect(tooLow.score).toBe(0);
  });
});
