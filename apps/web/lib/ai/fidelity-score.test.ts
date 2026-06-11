import { describe, it, expect } from "vitest";
import { PNG } from "pngjs";
import {
  pixelDiffScore,
  flagForVision,
  visionScore,
  DEFAULT_VISION_FLAG_THRESHOLD,
  VISION_PER_BUILD_CAP,
  httpFailureRow,
  selectVisionPages,
  sizeMismatchIssue,
  visionUnavailableIssue,
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

/**
 * Build a PNG with `topRows` rows of one color and the remainder of another.
 * Proves the overlap crop is anchored at the top-left (both captures start
 * at the page top; height drift accumulates at the bottom).
 */
function bandedPng(
  width: number,
  height: number,
  topRows: number,
  topRgba: [number, number, number, number],
  bottomRgba: [number, number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const rgba = y < topRows ? topRgba : bottomRgba;
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

});

describe("pixelDiffScore — dimension mismatch (overlap crop)", () => {
  it("measures the overlapping region instead of returning a synthetic 0.5", () => {
    // Identical content where the images overlap; generated is 4px taller.
    const source = solidPng(10, 10, [255, 0, 0, 255]);
    const generated = solidPng(10, 14, [255, 0, 0, 255]);
    const result = pixelDiffScore({ sourceBuffer: source, generatedBuffer: generated });
    expect(result.sizeMismatch).toBe(true);
    expect(result.heightDeltaPx).toBe(4);
    expect(result.diffRatio).toBe(0); // measured, not the old placeholder 0.5
    expect(result.score).toBe(1);
    expect(result.diffPixels).toBe(0);
    expect(result.totalPixels).toBe(100); // 10 × min(10, 14)
  });

  it("still reports real divergence inside the overlap", () => {
    const source = solidPng(10, 10, [255, 0, 0, 255]);
    const generated = solidPng(10, 14, [0, 255, 0, 255]);
    const result = pixelDiffScore({ sourceBuffer: source, generatedBuffer: generated });
    expect(result.sizeMismatch).toBe(true);
    expect(result.diffRatio).toBeGreaterThan(0.99);
    expect(result.score).toBeLessThan(0.01);
  });

  it("crops from the top-left (page top), not an arbitrary region", () => {
    // 4×4: top 2 rows red, bottom 2 rows blue. Generated is 2 rows taller
    // with the same top-anchored content — overlap must diff to zero.
    const source = bandedPng(4, 4, 2, [255, 0, 0, 255], [0, 0, 255, 255]);
    const generated = bandedPng(4, 6, 2, [255, 0, 0, 255], [0, 0, 255, 255]);
    const result = pixelDiffScore({ sourceBuffer: source, generatedBuffer: generated });
    expect(result.sizeMismatch).toBe(true);
    expect(result.heightDeltaPx).toBe(2);
    expect(result.diffRatio).toBe(0);
  });

  it("handles width mismatches and reports heightDeltaPx=0", () => {
    const source = solidPng(10, 10, [255, 0, 0, 255]);
    const generated = solidPng(8, 10, [255, 0, 0, 255]);
    const result = pixelDiffScore({ sourceBuffer: source, generatedBuffer: generated });
    expect(result.sizeMismatch).toBe(true);
    expect(result.heightDeltaPx).toBe(0);
    expect(result.diffRatio).toBe(0);
    expect(result.totalPixels).toBe(80); // min(10,8) × 10
  });

  it("reports sizeMismatch=false and heightDeltaPx=0 for equal dimensions", () => {
    const a = solidPng(10, 10, [255, 0, 0, 255]);
    const b = solidPng(10, 10, [255, 0, 0, 255]);
    const result = pixelDiffScore({ sourceBuffer: a, generatedBuffer: b });
    expect(result.sizeMismatch).toBe(false);
    expect(result.heightDeltaPx).toBe(0);
  });

  // NOTE: the totalPixels === 0 branch in pixelDiffScore is defensive-only —
  // the PNG spec requires >=1x1 dimensions and pngjs throws on malformed
  // buffers inside PNG.sync.read before the branch can be reached, so it
  // cannot be pinned through the public buffer API.
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

describe("selectVisionPages", () => {
  it("spends the cap on the worst measured divergence, not DB order", () => {
    const candidates = [
      { pageInventoryId: "a", diffRatio: 0.12 },
      { pageInventoryId: "b", diffRatio: 0.95 },
      { pageInventoryId: "c", diffRatio: 0.4 },
    ];
    expect(selectVisionPages(candidates, 2)).toEqual(["b", "c"]);
  });

  it("excludes pages at or below the flag threshold", () => {
    const candidates = [
      { pageInventoryId: "a", diffRatio: 0.1 },
      { pageInventoryId: "b", diffRatio: 0.05 },
      { pageInventoryId: "c", diffRatio: 0.11 },
    ];
    expect(selectVisionPages(candidates)).toEqual(["c"]);
  });

  it("defaults the cap to VISION_PER_BUILD_CAP and orders worst-first", () => {
    const candidates = Array.from({ length: 40 }, (_, i) => ({
      pageInventoryId: `p${i}`,
      diffRatio: 0.2 + i * 0.001,
    }));
    const selected = selectVisionPages(candidates);
    expect(selected).toHaveLength(VISION_PER_BUILD_CAP);
    expect(selected[0]).toBe("p39"); // highest diffRatio first
  });

  it("accepts a custom threshold", () => {
    expect(selectVisionPages([{ pageInventoryId: "a", diffRatio: 0.06 }], 15, 0.05)).toEqual(["a"]);
  });
});

describe("sizeMismatchIssue / visionUnavailableIssue", () => {
  it("records the height delta as a low-severity page-level reason", () => {
    const issue = sizeMismatchIssue(742);
    expect(issue.block_name).toBe("_page");
    expect(issue.severity).toBe("low");
    expect(issue.description).toContain("viewport_size_mismatch");
    expect(issue.description).toContain("742px");
  });

  it("marks the vision fallback with the vision_unavailable marker", () => {
    const issue = visionUnavailableIssue("storage download returned null");
    expect(issue.block_name).toBe("_page");
    expect(issue.severity).toBe("low");
    expect(issue.description).toContain("vision_unavailable");
    expect(issue.description).toContain("storage download returned null");
  });
});

describe("visionScore — extended input (stub)", () => {
  it("accepts the extended VisionScoreInput and still echoes the pixel score", async () => {
    const result = await visionScore({
      pixelDiffScore: 0.4,
      sourceBuffer: Buffer.from("not-a-real-png"),
      generatedBuffer: Buffer.from("not-a-real-png"),
      routePath: "/about",
      blockNames: ["core/cover"],
    });
    expect(result.score).toBe(0.4);
    expect(result.issues).toEqual([]);
  });
});
