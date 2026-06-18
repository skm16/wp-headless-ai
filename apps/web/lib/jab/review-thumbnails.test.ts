import { describe, it, expect } from "vitest";
import {
  THUMBNAIL_VIEWPORTS,
  buildThumbnailRequests,
  pickViewportScore,
  type ThumbRequest,
} from "./review-thumbnails";

describe("THUMBNAIL_VIEWPORTS", () => {
  it("renders desktop then mobile", () => {
    expect(THUMBNAIL_VIEWPORTS).toEqual(["1280", "375"]);
  });
});

describe("buildThumbnailRequests", () => {
  it("emits source + generated requests per viewport that has a path", () => {
    const pages = [
      {
        id: "p1",
        source_screenshot_paths: { source: { "1280": "s/1280/p1.png", "375": "s/375/p1.png" } },
      },
    ];
    const fidelity = new Map([
      ["p1", { generated_screenshot_paths: { source: { "1280": "g/1280/p1.png", "375": "g/375/p1.png" } } }],
    ]);
    const reqs = buildThumbnailRequests(pages, fidelity);
    const keys = reqs.map((r: ThumbRequest) => r.key).sort();
    expect(keys).toEqual([
      "p1:1280:generated",
      "p1:1280:source",
      "p1:375:generated",
      "p1:375:source",
    ]);
    expect(reqs.find((r) => r.key === "p1:1280:source")!.path).toBe("s/1280/p1.png");
  });

  it("omits requests for absent paths (no fabricated entries)", () => {
    const pages = [{ id: "p1", source_screenshot_paths: { source: { "1280": "s/1280/p1.png" } } }];
    const fidelity = new Map([["p1", { generated_screenshot_paths: { source: {} } }]]);
    const reqs = buildThumbnailRequests(pages, fidelity);
    expect(reqs.map((r) => r.key)).toEqual(["p1:1280:source"]);
  });

  it("tolerates a page with no fidelity row and null screenshot paths", () => {
    const pages = [{ id: "p1", source_screenshot_paths: null }];
    const fidelity = new Map<string, { generated_screenshot_paths: { source?: Record<string, string> } | null }>();
    expect(buildThumbnailRequests(pages, fidelity)).toEqual([]);
  });
});

describe("pickViewportScore", () => {
  it("returns the score and non-blocking for a healthy viewport", () => {
    const vs = { "375": { score: 0.92, pixel_diff: 0.08, http_status: 200, skipped: false } };
    expect(pickViewportScore(vs, "375")).toEqual({ score: 0.92, blocking: false });
  });
  it("flags blocking when score is 0 and not skipped", () => {
    const vs = { "375": { score: 0, pixel_diff: 0.7, http_status: 200, skipped: false } };
    expect(pickViewportScore(vs, "375")).toEqual({ score: 0, blocking: true });
  });
  it("flags blocking on a 4xx/5xx http_status", () => {
    const vs = { "375": { score: null, pixel_diff: null, http_status: 500, skipped: true } };
    expect(pickViewportScore(vs, "375")!.blocking).toBe(true);
  });
  it("flags blocking via the entry.blocking flag with a NON-zero score (the catastrophic-divergence shape the worker actually writes)", () => {
    // Catastrophic mobile divergence: the worker zeroes only the CANONICAL page
    // score; this per-viewport entry keeps its real measured score (e.g. 0.3)
    // + http 200, and is stamped blocking=true. The badge must light off the
    // flag, not the (non-zero) score.
    const vs = { "375": { score: 0.3, pixel_diff: 0.7, http_status: 200, skipped: false, blocking: true } };
    expect(pickViewportScore(vs, "375")).toEqual({ score: 0.3, blocking: true });
  });
  it("does NOT flag blocking for a mediocre-but-unflagged viewport (proves the flag, not the score, drives the badge)", () => {
    const vs = { "375": { score: 0.3, pixel_diff: 0.7, http_status: 200, skipped: false } };
    expect(pickViewportScore(vs, "375")).toEqual({ score: 0.3, blocking: false });
  });
  it("returns null when the viewport is absent", () => {
    expect(pickViewportScore({ "1280": {} }, "375")).toBeNull();
    expect(pickViewportScore(null, "375")).toBeNull();
    expect(pickViewportScore(undefined, "375")).toBeNull();
  });
});
