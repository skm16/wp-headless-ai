import { describe, it, expect } from "vitest";
import { buildWhatChangedCard, formatElapsed } from "./chat-card-model";

describe("formatElapsed", () => {
  it("formats seconds and minutes", () => {
    expect(formatElapsed(4000)).toBe("4s");
    expect(formatElapsed(95000)).toBe("1m 35s");
    expect(formatElapsed(0)).toBe("0s");
  });
});

describe("buildWhatChangedCard", () => {
  const base = {
    projectId: "p1",
    buildId: "b2",
    editStatus: "completed",
    promoted: false,
    action: "Regenerate the Cover block — affects 3 pages",
    changedPageCount: 3,
    startedAtMs: 1000,
    nowMs: 1000 + 42000,
  };

  it("shows Building… + progress link while the linked build is active", () => {
    const card = buildWhatChangedCard({ ...base, buildStatus: "composing" });
    expect(card.statusLabel).toBe("Building…");
    expect(card.phaseLabel).toBe("Composing the site");
    expect(card.elapsed).toBe("42s");
    expect(card.progressHref).toBe("/projects/p1/builds/b2/progress");
    expect(card.reviewHref).toBeNull();
  });

  it("shows Review ready + review link + blast radius when build is ready, unpromoted", () => {
    const card = buildWhatChangedCard({ ...base, buildStatus: "ready" });
    expect(card.statusLabel).toBe("Review ready");
    expect(card.reviewHref).toBe("/projects/p1/builds/b2/review");
    expect(card.blastRadius).toBe("Changes 3 page(s)");
  });

  it("shows Live when promoted", () => {
    const card = buildWhatChangedCard({ ...base, buildStatus: "ready", promoted: true });
    expect(card.statusLabel).toBe("Live");
  });

  it("shows Failed and no links when the build failed", () => {
    const card = buildWhatChangedCard({ ...base, buildStatus: "failed", editStatus: "failed" });
    expect(card.statusLabel).toBe("Failed");
    expect(card.reviewHref).toBeNull();
    expect(card.progressHref).toBe("/projects/p1/builds/b2/progress");
  });
});
